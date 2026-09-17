/// Gate smoke for the #alerts forum pipeline (iOS parity).
///
/// buzz-services signs digest/alert threads into the #alerts channel (a
/// forum-typed channel, kind:39000 t=forum) as kind:45001 posts and
/// kind:45003 replies, and the channel carries kind-9 legacy thread roots
/// from the pre-forum-signing era. These tests feed the real forum providers
/// fake relay events — the 45001 content and kind-9 roots must flow through
/// [ForumPostsResponse.fromEvents] into rendered post cards. If it ever stops
/// flowing, these tests fail: that is their whole point.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/forum/forum_post_card.dart';
import 'package:buzz/features/forum/forum_posts_view.dart';
import 'package:buzz/features/forum/forum_thread_page.dart';
import 'package:buzz/features/profile/profile_provider.dart';
import 'package:buzz/shared/profile/user_cache_provider.dart';
import 'package:buzz/shared/profile/user_profile.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _channelId = 'alerts';

final _digestAuthor = 'aa11bb22cc33dd44' * 4;
final _alertAuthor = 'fe01dc23ba456789' * 4;
final _replyAuthor = '9988776655443322' * 4;

const _digestContent =
    'Daily digest 2026-09-16\n\n'
    'Shipped\n'
    '- D-035 decision cards live\n'
    '- Voice window e2e green\n\n'
    'Open\n'
    '- keycloak pod restart pending';

const _alertContent =
    '🔇 watcher: buzz-services scrape failed 3x in 10m — relay latency above 2s';

const _alertReplyContent =
    'ack — backlog cleared, scrape recovered at 14:02 UTC';

NostrEvent _forumEvent({
  required String id,
  required String pubkey,
  required int kind,
  required int createdAt,
  required String content,
  List<List<String>> tags = const [
    ['h', _channelId],
  ],
}) => NostrEvent(
  id: id,
  pubkey: pubkey,
  createdAt: createdAt,
  kind: kind,
  tags: tags,
  content: content,
  sig: 'test-sig',
);

/// kind:45001 digest thread (older root).
final _digestRoot = _forumEvent(
  id: 'digest-root-1',
  pubkey: _digestAuthor,
  kind: 45001,
  createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000 - 900,
  content: _digestContent,
);

/// kind:45001 alert thread (newer root — must sort above the digest).
final _alertRoot = _forumEvent(
  id: 'alert-root-1',
  pubkey: _alertAuthor,
  kind: 45001,
  createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000 - 300,
  content: _alertContent,
);

/// kind:45003 reply under the alert root (renders in the thread view).
final _alertReply = _forumEvent(
  id: 'alert-reply-1',
  pubkey: _replyAuthor,
  kind: 45003,
  createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000 - 240,
  content: _alertReplyContent,
  tags: const [
    ['h', _channelId],
    ['e', 'alert-root-1', '', 'reply'],
  ],
);

/// kind:9 legacy thread root (pre-forum-signing history — must render).
final _legacyRoot = _forumEvent(
  id: 'legacy-root-1',
  pubkey: _replyAuthor,
  kind: 9,
  createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000 - 1800,
  content: 'legacy thread: relay migration postmortem, pre-forum-signing era',
);

/// kind:9 reply with a BARE e tag — the legacy append shape. Web read
/// semantics treat any e tag as in-thread, so it must NOT surface as a root.
final _legacyBareReply = _forumEvent(
  id: 'legacy-reply-1',
  pubkey: _digestAuthor,
  kind: 9,
  createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000 - 1750,
  content: 'ack on the legacy thread',
  tags: const [
    ['h', _channelId],
    ['e', 'legacy-root-1'],
  ],
);

final _forumChannel = Channel(
  id: _channelId,
  name: 'alerts',
  channelType: 'forum',
  visibility: 'open',
  description: '',
  createdBy: _digestAuthor,
  createdAt: DateTime(2025),
  memberCount: 5,
  isMember: true,
);

final _users = <String, UserProfile>{
  _digestAuthor: UserProfile(
    pubkey: _digestAuthor,
    displayName: 'buzz-services',
  ),
  _alertAuthor: UserProfile(pubkey: _alertAuthor, displayName: 'watchdog'),
  _replyAuthor: UserProfile(pubkey: _replyAuthor, displayName: 'Lord Nikon'),
};

late SharedPreferences _testPrefs;

Widget _buildApp({required List<NostrEvent> events}) {
  return ProviderScope(
    overrides: [
      relaySessionProvider.overrideWith(() => _FakeRelaySession(events)),
      userCacheProvider.overrideWith(() => _FakeUserCacheNotifier(_users)),
      profileProvider.overrideWith(() => _FakeProfileNotifier()),
      relayClientProvider.overrideWithValue(
        RelayClient(baseUrl: 'http://localhost:3000'),
      ),
      savedPrefsProvider.overrideWithValue(_testPrefs),
    ],
    child: MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: ForumPostsView(channel: _forumChannel, currentPubkey: 'self'),
      ),
    ),
  );
}

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    _testPrefs = await SharedPreferences.getInstance();
  });

  group('#alerts forum gate smoke', () {
    testWidgets(
      'renders digest and alert threads as forum post cards, newest first',
      (tester) async {
        await tester.pumpWidget(
          _buildApp(events: [_digestRoot, _alertRoot, _alertReply]),
        );
        await tester.pumpAndSettle();

        // Both kind:45001 roots render as post cards…
        expect(find.byType(ForumPostCard), findsNWidgets(2));
        expect(find.textContaining('Daily digest 2026-09-16'), findsOneWidget);
        expect(find.textContaining('watcher: buzz-services'), findsOneWidget);

        // …with real author profiles resolved.
        expect(find.text('buzz-services'), findsOneWidget);

        // Newest-first ordering: the alert root sits above the digest root.
        final alertTop = tester
            .getTopLeft(find.textContaining('watcher: buzz-services'))
            .dy;
        final digestTop = tester
            .getTopLeft(find.textContaining('Daily digest 2026-09-16'))
            .dy;
        expect(alertTop, lessThan(digestTop));
      },
    );

    testWidgets('renders the alert reply inline under its root thread', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildApp(events: [_digestRoot, _alertRoot, _alertReply]),
      );
      await tester.pumpAndSettle();

      // Open the alert thread.
      await tester.tap(
        find.ancestor(
          of: find.textContaining('watcher: buzz-services'),
          matching: find.byType(ForumPostCard),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(ForumThreadPage), findsOneWidget);

      // The kind:45003 reply renders under its kind:45001 root.
      final rootTop = tester
          .getTopLeft(find.textContaining('watcher: buzz-services'))
          .dy;
      final replyTop = tester
          .getTopLeft(find.textContaining('backlog cleared, scrape recovered'))
          .dy;
      expect(replyTop, greaterThan(rootTop));
    });

    testWidgets(
      'renders kind-9 legacy roots alongside 45001 posts, newest first',
      (tester) async {
        await tester.pumpWidget(
          _buildApp(
            events: [_legacyBareReply, _legacyRoot, _digestRoot, _alertRoot],
          ),
        );
        await tester.pumpAndSettle();

        // The kind-9 legacy root renders as a post card alongside BOTH
        // kind:45001 roots — the web read-superset — while the bare-e kind-9
        // reply stays inside its thread and never surfaces as a card.
        expect(find.byType(ForumPostCard), findsNWidgets(3));
        expect(
          find.textContaining('relay migration postmortem'),
          findsOneWidget,
        );

        // Newest-first across kinds: alert (45001, -300s) above digest
        // (45001, -900s) above the kind-9 legacy root (-1800s).
        final alertTop = tester
            .getTopLeft(find.textContaining('watcher: buzz-services'))
            .dy;
        final digestTop = tester
            .getTopLeft(find.textContaining('Daily digest 2026-09-16'))
            .dy;
        final legacyTop = tester
            .getTopLeft(find.textContaining('relay migration postmortem'))
            .dy;
        expect(alertTop, lessThan(digestTop));
        expect(digestTop, lessThan(legacyTop));
      },
    );
  });
}

/// Relay session stub serving a fixed event store to the real forum providers.
class _FakeRelaySession extends RelaySessionNotifier {
  _FakeRelaySession(this._events);

  final List<NostrEvent> _events;

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  bool _matches(NostrFilter filter, NostrEvent event) {
    if (!filter.kinds.contains(event.kind)) return false;
    if (filter.ids != null && !filter.ids!.contains(event.id)) return false;
    for (final entry in filter.tags.entries) {
      final tagKey = entry.key.startsWith('#')
          ? entry.key.substring(1)
          : entry.key;
      final values = [
        for (final tag in event.tags)
          if (tag.length >= 2 && tag[0] == tagKey) tag[1],
      ];
      if (!entry.value.any(values.contains)) return false;
    }
    final search = filter.search;
    if (search != null && search.isNotEmpty) {
      if (!event.content.toLowerCase().contains(search.toLowerCase())) {
        return false;
      }
    }
    return true;
  }

  @override
  Future<List<NostrEvent>> fetchHistory(
    NostrFilter filter, {
    Duration timeout = const Duration(seconds: 8),
  }) async => [
    for (final event in _events)
      if (_matches(filter, event)) event,
  ];

  @override
  Future<List<NostrEvent>> queryRelay(
    List<NostrFilter> filters, {
    Duration timeout = const Duration(seconds: 8),
  }) async => [
    for (final event in _events)
      if (filters.any((filter) => _matches(filter, event))) event,
  ];

  @override
  Future<void Function()> subscribe(
    NostrFilter filter,
    void Function(NostrEvent) onEvent, {
    void Function(String message)? onClosed,
  }) async => () {};

  @override
  Future<void Function()> subscribeWithStatus(
    NostrFilter filter,
    void Function(NostrEvent) onEvent, {
    void Function(String message)? onClosed,
    required void Function(RelaySubscriptionStatus status) onStatusChanged,
  }) async {
    onStatusChanged(RelaySubscriptionStatus.ready);
    return () {};
  }
}

class _FakeUserCacheNotifier extends UserCacheNotifier {
  final Map<String, UserProfile> _users;
  _FakeUserCacheNotifier(this._users);

  @override
  Map<String, UserProfile> build() => _users;

  @override
  UserProfile? get(String pubkey) => _users[pubkey.toLowerCase()];
}

class _FakeProfileNotifier extends ProfileNotifier {
  @override
  Future<UserProfile?> build() async =>
      const UserProfile(pubkey: 'self', displayName: 'Self');
}
