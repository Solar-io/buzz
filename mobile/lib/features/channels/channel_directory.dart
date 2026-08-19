part of 'channels_provider.dart';

const _channelDirectoryPageSize = 500;
const _maxChannelDirectoryPages = 100;

/// Describes whether the open-channel directory is ready to browse.
enum ChannelDirectoryLoadStatus {
  /// No directory request has completed for the active identity and relay.
  idle,

  /// A directory request is currently in flight.
  loading,

  /// The directory request completed, including when it returned no channels.
  loaded,

  /// The most recent directory request could not complete.
  error,
}

/// Directory loading state scoped to one relay and signing identity.
class ChannelDirectoryLoadState {
  /// Relay-and-identity scope that produced [status].
  final String? scope;

  /// Current loading status for [scope].
  final ChannelDirectoryLoadStatus status;

  /// Creates directory loading state.
  const ChannelDirectoryLoadState({required this.scope, required this.status});

  /// Initial state before any directory request has started.
  const ChannelDirectoryLoadState.idle()
    : scope = null,
      status = ChannelDirectoryLoadStatus.idle;
}

/// Returns the stable directory scope for a relay and signing identity.
String channelDirectoryScope(String relayBaseUrl, String? pubkey) =>
    '$relayBaseUrl:${pubkey?.toLowerCase() ?? ''}';

/// Owns the independently observable channel-directory loading state.
class ChannelDirectoryLoadNotifier extends Notifier<ChannelDirectoryLoadState> {
  @override
  ChannelDirectoryLoadState build() => const ChannelDirectoryLoadState.idle();

  /// Marks the directory as loading.
  void markLoading(String scope) => state = ChannelDirectoryLoadState(
    scope: scope,
    status: ChannelDirectoryLoadStatus.loading,
  );

  /// Marks the directory as successfully loaded.
  void markLoaded(String scope) => state = ChannelDirectoryLoadState(
    scope: scope,
    status: ChannelDirectoryLoadStatus.loaded,
  );

  /// Marks the directory request as unsuccessful.
  void markError(String scope) => state = ChannelDirectoryLoadState(
    scope: scope,
    status: ChannelDirectoryLoadStatus.error,
  );
}

/// Loading state for open-channel discovery, separate from membership loading.
final channelDirectoryLoadStatusProvider =
    NotifierProvider<ChannelDirectoryLoadNotifier, ChannelDirectoryLoadState>(
      ChannelDirectoryLoadNotifier.new,
    );

Future<List<NostrEvent>> _fetchChannelMemberships(
  RelaySessionNotifier session,
  String pubkey,
) => _fetchPaginatedChannelEvents(
  session,
  kind: 39002,
  tags: {
    '#p': [pubkey],
  },
  operation: 'Channel memberships',
);

Future<List<NostrEvent>> _fetchChannelDirectoryMetas(
  RelaySessionNotifier session,
) => _fetchPaginatedChannelEvents(
  session,
  kind: 39000,
  operation: 'Channel directory',
);

Future<List<NostrEvent>> _fetchPaginatedChannelEvents(
  RelaySessionNotifier session, {
  required int kind,
  required String operation,
  Map<String, List<String>> tags = const {},
}) async {
  final events = <NostrEvent>[];
  final seenEventIds = <String>{};
  int? until;
  String? beforeId;
  for (var pageIndex = 0; pageIndex < _maxChannelDirectoryPages; pageIndex++) {
    final page = await session.queryRelay([
      NostrFilter(
        kinds: [kind],
        tags: tags,
        limit: _channelDirectoryPageSize,
        until: until,
        extensions: {'before_id': ?beforeId},
      ),
    ]);
    if (page.isEmpty) break;
    var madeProgress = false;
    for (final event in page) {
      if (seenEventIds.add(event.id)) {
        events.add(event);
        madeProgress = true;
      }
    }
    if (!madeProgress) break;

    final last = page.last;
    until = last.createdAt;
    beforeId = last.id;
    if (pageIndex == _maxChannelDirectoryPages - 1) {
      throw StateError('$operation exceeded $_maxChannelDirectoryPages pages');
    }
  }
  return events;
}
