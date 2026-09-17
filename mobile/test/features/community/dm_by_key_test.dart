/// iOS parity smoke: creating a DM to a person by pasted key.
///
/// GAP: by-key DM creation is absent on mobile. The New DM sheet
/// (`_NewDirectMessageSheet`, opened from the channel quick actions) only
/// adds recipients from relay directory search results — there is no paste
/// field and no npub/hex decoding. A pasted key of a non-directory person
/// matches nobody, so it cannot be selected and no kind:41010 openDm can be
/// issued for it from the UI.
///
/// These tests pin the current behavior at the layers the widget harness can
/// reach (the sheet's widget tests are in the known-failing D-032 baseline:
/// the buzz-sheet-surface ListTile assert breaks any sheet pump), prove the
/// action layer itself supports by-key DMs — isolating the gap to the missing
/// UI affordance — and carry the skipped test describing the missing paste
/// flow.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/features/channels/channels_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;

const _signingSecret =
    '22b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f11';
final _testNsec = nostr.Keys(_signingSecret).nsec;

final _directoryPubkey = '1234abcd5678ef90' * 4;

/// A person with no kind:0 profile on the relay — reachable only by key.
final _nonDirectoryHex = 'ff22ee33dd44cc55' * 4;
final _nonDirectoryNpub = nostr.Nip19.encode(
  prefix: nostr.Nip19Prefix.npub,
  data: _nonDirectoryHex,
);

NostrEvent _profileEvent({required String pubkey, required String name}) =>
    NostrEvent(
      id: 'profile-$pubkey',
      pubkey: pubkey,
      createdAt: 1000,
      kind: 0,
      tags: const [],
      content: '{"display_name":"$name"}',
      sig: 'test-sig',
    );

void main() {
  late _RecordingRelaySession session;
  late ProviderContainer container;

  setUp(() {
    session = _RecordingRelaySession([
      _profileEvent(pubkey: _directoryPubkey, name: 'Alice Liddell'),
    ]);
    container = ProviderContainer(
      overrides: [
        relaySessionProvider.overrideWith(() => session),
        currentPubkeyProvider.overrideWith((ref) => 'self-pubkey'),
        channelActionsProvider.overrideWith(
          (ref) => ChannelActions(
            ref: ref,
            session: session,
            signedEventRelay: SignedEventRelay(
              session: session,
              nsec: _testNsec,
            ),
            currentPubkey: 'self-pubkey',
          ),
        ),
        channelsProvider.overrideWith(
          () => _FakeChannelsNotifier([
            Channel(
              id: 'dm-channel-1',
              name: 'DM',
              channelType: 'dm',
              visibility: 'private',
              description: '',
              createdBy: 'self-pubkey',
              createdAt: DateTime(2025),
              memberCount: 2,
              isMember: true,
            ),
          ]),
        ),
      ],
    );
    addTearDown(container.dispose);
  });

  group('DM creation by pasted key', () {
    // GAP: pins the current directory-only behavior that makes by-key DM
    // creation impossible from the New DM sheet. The sheet builds its
    // selectable recipients exclusively from relayDirectoryUsersProvider /
    // relayDirectorySearchProvider results, so an empty search result for a
    // pasted key means the person is unselectable and no DM can be opened.
    test(
      'pasted npub/hex of a non-directory person matches nobody in the directory search',
      () async {
        final npubResults = await container.read(
          relayDirectorySearchProvider(_nonDirectoryNpub).future,
        );
        final hexResults = await container.read(
          relayDirectorySearchProvider(_nonDirectoryHex).future,
        );

        expect(npubResults, isEmpty);
        expect(hexResults, isEmpty);
      },
    );

    test(
      'openDm action layer accepts a pasted key the UI cannot reach',
      () async {
        // The capability exists below the sheet: a kind:41010 with the pasted
        // key opens (or finds) the DM channel. The gap is the missing paste
        // affordance, not the protocol path.
        final channel = await container
            .read(channelActionsProvider)
            .openDm(pubkeys: [_nonDirectoryHex]);

        expect(session.published, hasLength(1));
        expect(session.published.single.kind, 41010);
        expect(session.published.single.getTagValue('p'), _nonDirectoryHex);
        expect(channel.id, 'dm-channel-1');
      },
    );

    test(
      'openDm action layer carries both an npub and a hex key as p-tags',
      () async {
        // Group-DM shape: every pasted identity lands in the command verbatim.
        await container
            .read(channelActionsProvider)
            .openDm(pubkeys: [_nonDirectoryNpub, _nonDirectoryHex]);

        expect(session.published.single.kind, 41010);
        final pTags = [
          for (final tag in session.published.single.tags)
            if (tag.length >= 2 && tag[0] == 'p') tag[1],
        ];
        expect(pTags, [_nonDirectoryNpub, _nonDirectoryHex]);
      },
    );

    // GAP: this is the test that SHOULD exist once parity lands — pasting a
    // key into the New DM sheet must surface a selectable recipient for the
    // non-directory person and open the DM. Skipped, not deleted, so the
    // missing behavior stays enumerated. (testWidgets only accepts a boolean
    // skip flag, so the reason rides in the description.)
    testWidgets(
      'creating a DM by pasting a key (parity gap: by-key DM creation absent — filed)',
      skip: true,
      (tester) async {
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              relaySessionProvider.overrideWith(() => session),
              currentPubkeyProvider.overrideWith((ref) => 'self-pubkey'),
            ],
            child: const MaterialApp(home: Scaffold(body: SizedBox.shrink())),
          ),
        );

        // Paste the npub into the sheet's recipient field.
        await tester.enterText(
          find.byKey(const Key('new-dm-search')),
          _nonDirectoryNpub,
        );
        await tester.pumpAndSettle();

        // The non-directory person becomes selectable by key…
        await tester.tap(find.byKey(Key('new-dm-person-$_nonDirectoryHex')));
        await tester.pumpAndSettle();

        // …and submitting opens the DM with the decoded hex key.
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pumpAndSettle();

        expect(session.published.single.kind, 41010);
        expect(session.published.single.getTagValue('p'), _nonDirectoryHex);
      },
    );
  });
}

/// Relay session stub that records every signed event handed to [publish].
class _RecordingRelaySession extends RelaySessionNotifier {
  _RecordingRelaySession(this._events);

  final List<NostrEvent> _events;
  final List<NostrEvent> published = [];

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<List<NostrEvent>> fetchHistory(
    NostrFilter filter, {
    Duration timeout = const Duration(seconds: 8),
  }) async => const [];

  @override
  Future<List<NostrEvent>> queryRelay(
    List<NostrFilter> filters, {
    Duration timeout = const Duration(seconds: 8),
  }) async => [
    // Prefix search over kind:0 profiles, mirroring the relay's
    // `search_mode: prefix` bridge extension used by searchUsers.
    for (final filter in filters)
      for (final event in _events)
        if (filter.kinds.contains(event.kind) &&
            (filter.search == null ||
                _profileName(event).startsWith(filter.search!)))
          event,
  ];

  String _profileName(NostrEvent event) {
    try {
      final meta = jsonDecode(event.content) as Map<String, dynamic>;
      return ((meta['display_name'] as String?) ?? '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  @override
  Future<NostrEvent> publish(
    NostrEvent event, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    published.add(event);
    // Relay OK response carrying the new DM channel id.
    return NostrEvent(
      id: 'ok-${event.id}',
      pubkey: 'relay',
      createdAt: 0,
      kind: 0,
      tags: const [],
      content: 'response:{"channel_id":"dm-channel-1"}',
      sig: 'test-sig',
    );
  }
}

/// Channels stub so openDm's post-submit refresh resolves the new DM.
class _FakeChannelsNotifier extends ChannelsNotifier {
  _FakeChannelsNotifier(this._channels);

  final List<Channel> _channels;

  @override
  Future<List<Channel>> build() => SynchronousFuture(_channels);

  @override
  Future<void> refresh({bool fetchDirectory = false}) async {}
}
