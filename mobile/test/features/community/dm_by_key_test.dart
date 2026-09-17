/// iOS parity smoke: creating a DM to a person by pasted key.
///
/// PARITY (D-029 §2): the New DM sheet (`_NewDirectMessageSheet`, opened from
/// the channel quick actions) accepts a pasted hex pubkey OR npub in its
/// recipient field. The paste decodes at entry through the invites flow's
/// single bech32 decode path (`directoryUserFromPastedKey`), surfaces a
/// selectable recipient row for a person who has no kind:0 profile on the
/// relay, and submits the clean hex key to the kind:41010 openDm action —
/// a pasted npub never reaches the relay un-decoded.
///
/// The tests cover both layers the gap once lived in: the sheet widget itself
/// (paste row appears, selectable, submit carries the decoded key) and the
/// action layer beneath it (kind:41010 with the pasted key as p-tag).
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/features/channels/channels_provider.dart';
import 'package:buzz/features/channels/new_dm_sheet.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:hooks_riverpod/misc.dart';
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

/// A malformed npub-shaped paste — valid bech32 charset, broken checksum.
const _malformedNpub = 'npub1zzzzzzzz';

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
      overrides: _baseOverrides(session: session, currentPubkey: 'self-pubkey'),
    );
    addTearDown(container.dispose);
  });

  group('DM creation by pasted key', () {
    test(
      'a pasted npub/hex of a non-directory person matches nobody in the directory search',
      () async {
        // The paste path exists precisely because search cannot resolve a
        // key: directory search is a NIP-50 prefix match over kind:0 names.
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

    test('openDm action layer accepts a pasted key verbatim', () async {
      // The protocol path below the sheet accepts the key as-is; the sheet
      // is what decodes npub to hex at entry (tested below at the widget
      // layer).
      final channel = await container
          .read(channelActionsProvider)
          .openDm(pubkeys: [_nonDirectoryHex]);

      expect(session.published, hasLength(1));
      expect(session.published.single.kind, 41010);
      expect(session.published.single.getTagValue('p'), _nonDirectoryHex);
      expect(channel.id, 'dm-channel-1');
    });

    test(
      'openDm action layer carries both an npub and a hex key as p-tags',
      () async {
        // Group-DM shape: every identity lands in the command verbatim. The
        // decode-at-entry contract lives in the SHEETS
        // (directoryUserFromPastedKey); the action stays decode-agnostic.
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

    testWidgets(
      'pasting an npub into the New DM sheet opens the DM with the decoded hex key',
      (tester) async {
        await _pumpDmSheet(tester, session);

        await tester.enterText(
          find.byKey(const Key('new-dm-search')),
          _nonDirectoryNpub,
        );
        await tester.pump(const Duration(milliseconds: 300));
        await tester.pumpAndSettle();

        // The non-directory person becomes selectable by key, keyed by the
        // DECODED hex identity…
        final pasteRow = find.byKey(Key('new-dm-person-$_nonDirectoryHex'));
        expect(pasteRow, findsOneWidget);

        await tester.tap(pasteRow);
        await tester.pumpAndSettle();
        expect(
          find.byKey(Key('new-dm-selected-$_nonDirectoryHex')),
          findsOneWidget,
        );

        // …and submitting opens the DM with the decoded hex key (never the
        // raw bech32 npub).
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pumpAndSettle();

        expect(session.published, hasLength(1));
        expect(session.published.single.kind, 41010);
        expect(session.published.single.getTagValue('p'), _nonDirectoryHex);
      },
    );

    testWidgets(
      'pasting a hex pubkey into the New DM sheet opens the DM with the normalized key',
      (tester) async {
        await _pumpDmSheet(tester, session);

        await tester.enterText(
          find.byKey(const Key('new-dm-search')),
          _nonDirectoryHex.toUpperCase(),
        );
        await tester.pump(const Duration(milliseconds: 300));
        await tester.pumpAndSettle();

        final pasteRow = find.byKey(Key('new-dm-person-$_nonDirectoryHex'));
        expect(pasteRow, findsOneWidget);
        await tester.tap(pasteRow);
        await tester.pumpAndSettle();

        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pumpAndSettle();

        expect(session.published, hasLength(1));
        expect(session.published.single.kind, 41010);
        expect(session.published.single.getTagValue('p'), _nonDirectoryHex);
      },
    );

    testWidgets(
      'a malformed npub paste is rejected with a validation message',
      (tester) async {
        await _pumpDmSheet(tester, session);

        await tester.enterText(
          find.byKey(const Key('new-dm-search')),
          _malformedNpub,
        );
        await tester.pump(const Duration(milliseconds: 300));
        await tester.pumpAndSettle();

        expect(find.text('Paste a valid npub or hex pubkey.'), findsOneWidget);
        expect(find.byKey(Key('new-dm-person-$_malformedNpub')), findsNothing);
      },
    );

    testWidgets('pasting your own key yields no selectable entry', (
      tester,
    ) async {
      await _pumpDmSheet(tester, session, currentPubkey: _nonDirectoryHex);

      await tester.enterText(
        find.byKey(const Key('new-dm-search')),
        _nonDirectoryNpub,
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();

      expect(find.byKey(Key('new-dm-person-$_nonDirectoryHex')), findsNothing);
    });
  });
}

List<Override> _baseOverrides({
  required _RecordingRelaySession session,
  required String currentPubkey,
}) => [
  relaySessionProvider.overrideWith(() => session),
  currentPubkeyProvider.overrideWith((ref) => currentPubkey),
  channelActionsProvider.overrideWith(
    (ref) => ChannelActions(
      ref: ref,
      session: session,
      signedEventRelay: SignedEventRelay(session: session, nsec: _testNsec),
      currentPubkey: currentPubkey,
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
];

/// Pumps the REAL NewDirectMessageSheet against a recording relay session.
/// The sheet content is pumped directly under a plain MaterialApp: the
/// quick-actions → showBuzzModalBottomSheet path trips the known-failing
/// D-032 baseline assert (ListTile inside the buzz-sheet-surface ColoredBox),
/// which the sheet's own content does not.
Future<void> _pumpDmSheet(
  WidgetTester tester,
  _RecordingRelaySession session, {
  String currentPubkey = 'self-pubkey',
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        ..._baseOverrides(session: session, currentPubkey: currentPubkey),
        dmDirectoryPreviewEnabledProvider.overrideWith((ref) => false),
      ],
      child: MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: NewDirectMessageSheet(currentPubkey: currentPubkey),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
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
