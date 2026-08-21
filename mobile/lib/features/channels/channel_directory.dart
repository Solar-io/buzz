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

/// Thrown when a directory request is retired before its response lands.
///
/// Callers must treat this as "write nothing": the scope that issued the
/// request is no longer active, so both its data and its load status belong to
/// a community the user has left.
class _StaleDirectoryRequest implements Exception {
  const _StaleDirectoryRequest();

  @override
  String toString() =>
      'Channel directory request retired by a community or identity switch';
}

/// Loads the open-channel directory fenced to the scope that requested it.
///
/// A community or identity switch changes the scope, and a newer request bumps
/// the generation. Either one retires an in-flight request, so a delayed
/// response can never populate the current community's state. This is the
/// tenant boundary described in VISION.md: isolation is the boundary, not a
/// filter, so a retired response is discarded rather than merged.
///
/// Lives in this part file because `channels_provider.dart` sits against the
/// repository-wide 1000-line file ceiling enforced by `just file-size-check`.
class _ChannelDirectoryLoader {
  /// Resolves the relay-and-identity scope that is active right now.
  final String Function() currentScope;

  /// Owns the externally observable directory load status.
  final ChannelDirectoryLoadNotifier Function() loadStatus;

  int _generation = 0;

  _ChannelDirectoryLoader({
    required this.currentScope,
    required this.loadStatus,
  });

  /// Binds the fence to a notifier's [Ref] so the provider needs one line.
  ///
  /// Both closures read rather than watch: the fence asks what the scope is
  /// right now, and must not make the notifier depend on it.
  factory _ChannelDirectoryLoader.forRef(Ref ref) => _ChannelDirectoryLoader(
    currentScope: () => channelDirectoryScope(
      ref.read(relayConfigProvider).baseUrl,
      ref.read(myPubkeyProvider),
    ),
    loadStatus: () => ref.read(channelDirectoryLoadStatusProvider.notifier),
  );

  /// Retires any in-flight request without starting a new one.
  ///
  /// Called when the relay or identity changes so a response already on the
  /// wire cannot be written into the new scope.
  void retireInFlight() => _generation++;

  /// Fetches the directory, or throws [_StaleDirectoryRequest] if retired.
  ///
  /// Returns null when the request failed inside the current scope, which means
  /// "retain the cached discovery". The fence is re-checked after the await and
  /// before every write, on both the success and the failure path.
  Future<List<NostrEvent>?> load(RelaySessionNotifier session) async {
    final scope = currentScope();
    final generation = ++_generation;
    bool isCurrent() => generation == _generation && scope == currentScope();

    loadStatus().markLoading(scope);
    final List<NostrEvent> metas;
    try {
      metas = await _fetchChannelDirectoryMetas(session);
    } catch (error, stackTrace) {
      if (!isCurrent()) throw const _StaleDirectoryRequest();
      loadStatus().markError(scope);
      debugPrint(
        '[ChannelsNotifier] channel directory refresh failed; retaining '
        'cached discovery: $error\n$stackTrace',
      );
      return null;
    }
    if (!isCurrent()) throw const _StaleDirectoryRequest();
    loadStatus().markLoaded(scope);
    return metas;
  }
}

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
