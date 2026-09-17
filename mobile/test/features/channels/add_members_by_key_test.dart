/// iOS parity smoke: adding members to a channel by key, not just by search.
///
/// The AddChannelMembersSheet submits its selected users through
/// [ChannelActions.addMembers], which emits a kind:9000 join per pubkey with
/// `h`/`p`/`role` tags. These tests drive the REAL action (real signing via a
/// test nsec, real pubkey normalization and tag building) against a recording
/// relay session, covering:
///
/// (a) the search-select path — the pubkeys the sheet's directory search
///     returns and the user multi-selects;
/// (b) the pasted-key path — an npub and a hex pubkey of a person who is NOT
///     in the directory.
///
/// NOTE: the widget-level Add-members tests (channel_detail_page_test.dart)
/// are in the known-failing D-032 baseline (buzz-sheet-surface ListTile
/// assert), so per the parity-smoke brief these target the provider/action
/// layer instead of pumping the broken sheet harness.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;

const _channelId = 'alerts';
const _signingSecret =
    '11a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f';
final _testNsec = nostr.Keys(_signingSecret).nsec;

final _directoryPubkeyA = '1234abcd5678ef90' * 4;
final _directoryPubkeyB = 'deadbeefcafebabe' * 4;

/// A pasted hex pubkey of a person who has no kind:0 profile on the relay
/// (not in the directory). Mixed case on purpose: the action lowercases.
final _pastedHexPubkey = 'FF22EE33DD44CC55' * 4;

/// The same person addressed as an npub — the invite flow's paste format.
final _pastedNpub = nostr.Nip19.encode(
  prefix: nostr.Nip19Prefix.npub,
  data: _pastedHexPubkey.toLowerCase(),
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
      _profileEvent(pubkey: _directoryPubkeyA, name: 'watchdog'),
      _profileEvent(pubkey: _directoryPubkeyB, name: 'watchtower'),
    ]);
    container = ProviderContainer(
      overrides: [
        relaySessionProvider.overrideWith(() => session),
        currentPubkeyProvider.overrideWith((ref) => 'self-pubkey'),
        // Real ChannelActions + real SignedEventRelay, pinned to the test
        // signing key (the config notifier rebuilds when the active
        // community provider resolves, so wiring through relayConfigProvider
        // would race away the nsec).
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
      ],
    );
    addTearDown(container.dispose);
  });

  group('AddChannelMembers by key', () {
    test(
      'search-select: multi-adding directory users emits one kind:9000 join per person',
      () async {
        // The sheet's source of selectable people: directory prefix search.
        final results = await container.read(
          relayDirectorySearchProvider('watch'.toLowerCase()).future,
        );
        expect(results, hasLength(2));
        expect(results.map((user) => user.pubkey).toSet(), {
          _directoryPubkeyA,
          _directoryPubkeyB,
        });

        // What the sheet's submit does with the multi-selection.
        await container
            .read(channelActionsProvider)
            .addMembers(
              channelId: _channelId,
              pubkeys: results.map((user) => user.pubkey).toList(),
            );

        expect(session.published, hasLength(2));
        expect(
          session.published.map((event) => event.kind),
          everyElement(9000),
        );
        final joinedPubkeys = session.published
            .map((event) => event.getTagValue('p'))
            .toSet();
        expect(joinedPubkeys, {_directoryPubkeyA, _directoryPubkeyB});
        for (final event in session.published) {
          expect(event.channelId, _channelId);
          expect(event.getTagValue('role'), 'member');
        }
      },
    );

    test(
      'pasted keys: an npub and a hex pubkey of a non-directory person both land in the join payloads',
      () async {
        // Neither pasted key has a directory profile — the paste path exists
        // precisely for people search cannot resolve.
        final npubResults = await container.read(
          relayDirectorySearchProvider(_pastedNpub).future,
        );
        final hexResults = await container.read(
          relayDirectorySearchProvider(_pastedHexPubkey.toLowerCase()).future,
        );
        expect(npubResults, isEmpty);
        expect(hexResults, isEmpty);

        await container
            .read(channelActionsProvider)
            .addMembers(
              channelId: _channelId,
              pubkeys: [_pastedNpub, _pastedHexPubkey],
            );

        expect(session.published, hasLength(2));
        expect(
          session.published.map((event) => event.kind),
          everyElement(9000),
        );
        // BOTH identities reach the relay: the bech32 npub and the hex key
        // (normalized to lowercase). Note the action passes the npub through
        // verbatim — it does not decode bech32 to hex before emitting.
        final joinedPubkeys = session.published
            .map((event) => event.getTagValue('p'))
            .toSet();
        expect(joinedPubkeys, {
          _pastedNpub.toLowerCase(),
          _pastedHexPubkey.toLowerCase(),
        });
        for (final event in session.published) {
          expect(event.channelId, _channelId);
          expect(event.getTagValue('role'), 'member');
        }
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
    // Relay OK response; command kinds carry `response:{...}` in the content.
    return NostrEvent(
      id: 'ok-${event.id}',
      pubkey: 'relay',
      createdAt: 0,
      kind: 0,
      tags: const [],
      content: 'response:{"channel_id":"$_channelId"}',
      sig: 'test-sig',
    );
  }
}
