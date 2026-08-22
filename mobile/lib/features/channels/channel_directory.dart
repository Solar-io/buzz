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

/// Carries one directory-triggered refresh's scope across every later await.
///
/// The loader's own fence only covers the directory query. The refresh that
/// query feeds keeps crossing awaits for DM profiles, hidden DMs, member
/// counts, latest messages and live subscription sync, and each one is another
/// chance for the user to switch community or identity. This token is captured
/// once at the start of the refresh and re-checked after every await, so a
/// response that outlived its scope cannot reach shared state.
class _DirectoryRefreshFence {
  /// Relay-and-identity scope that started the refresh.
  final String scope;

  final _ChannelDirectoryLoader _loader;
  final int _generation;

  _DirectoryRefreshFence(this._loader, this.scope, this._generation);

  /// Whether the refresh still owns the active scope and generation.
  bool get isCurrent =>
      _generation == _loader.generation && scope == _loader.currentScope();

  /// Throws [_StaleDirectoryRequest] once this refresh has been retired.
  ///
  /// Call after every await and immediately before every write to metadata,
  /// cache, load status, subscriptions or provider state.
  void ensureCurrent() {
    if (!isCurrent) throw const _StaleDirectoryRequest();
  }
}

/// Awaits [future], then rejects the result if the refresh was retired.
///
/// One helper keeps every await site on the fenced path identical, so a new
/// await cannot be added without deciding whether it needs the fence.
///
/// The error path is fenced too. Without it a retired refresh that fails would
/// surface an ordinary exception, and `retryDirectory` would treat it as a
/// failure of the current scope: it would mark the wrong scope's status and
/// reinstall the channel list it captured before the switch.
Future<T> _fenced<T>(_DirectoryRefreshFence? fence, Future<T> future) async {
  final T value;
  try {
    value = await future;
  } catch (_) {
    if (fence != null && !fence.isCurrent) throw const _StaleDirectoryRequest();
    rethrow;
  }
  fence?.ensureCurrent();
  return value;
}

/// Resolves display labels for the other participants in every DM meta.
///
/// The relay stores DM channels with the literal name "DM", and the pure-Nostr
/// architecture puts name resolution in the client. So collect the non-self
/// participant pubkeys across all DM metas and batch-fetch their kind:0
/// profiles in one round-trip. Returns lowercase pubkey to label.
///
/// Lives in this part file because `channels_provider.dart` sits against the
/// repository-wide 1000-line file ceiling enforced by `just file-size-check`.
Future<Map<String, String>> _resolveDmDisplayNames(
  RelaySessionNotifier session,
  _DirectoryRefreshFence? fence,
  Iterable<NostrEvent> dedupedMetas,
  String myPk,
) async {
  final dmParticipants = <String>{};
  final myPkLower = myPk.toLowerCase();
  for (final event in dedupedMetas) {
    final data = ChannelData.fromEvent(event);
    if (data.channelType != 'dm') continue;
    for (final pk in data.participantPubkeys) {
      final lower = pk.toLowerCase();
      if (lower != myPkLower) dmParticipants.add(lower);
    }
  }
  if (dmParticipants.isEmpty) return const {};

  final profileEvents = await _fenced(
    fence,
    session.fetchHistory(NostrFilters.profilesBatch(dmParticipants.toList())),
  );
  final displayNames = <String, String>{};
  for (final event in profileEvents) {
    if (event.kind != 0) continue;
    final profile = ProfileData.fromEvent(event);
    final label = profile.displayName?.trim().isNotEmpty == true
        ? profile.displayName!.trim()
        : profile.nip05?.trim().isNotEmpty == true
        ? profile.nip05!.trim()
        : shortPubkey(profile.pubkey);
    displayNames[profile.pubkey.toLowerCase()] = label;
  }
  return displayNames;
}

/// Counts distinct `p`-tagged members per channel from kind:39002 events.
///
/// Lives in this part file to keep `channels_provider.dart` under the
/// repository-wide 1000-line ceiling enforced by `just file-size-check`.
Map<String, int> _memberCountsByChannelId(Iterable<NostrEvent> memberEvents) {
  final memberCounts = <String, int>{};
  for (final event in memberEvents) {
    final channelId = event.getTagValue('d');
    if (channelId == null) continue;
    final pTags = <String>{};
    for (final tag in event.tags) {
      if (tag.isNotEmpty && tag[0] == 'p' && tag.length > 1) {
        pTags.add(tag[1].toLowerCase());
      }
    }
    memberCounts[channelId] = pTags.length;
  }
  return memberCounts;
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

  /// Generation of the most recently issued or retired request.
  int get generation => _generation;

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

  /// Starts a fenced refresh without issuing the directory query.
  ///
  /// Used by callers that must carry the scope across later awaits even when
  /// they do not refresh discovery, so a membership-only refresh cannot install
  /// an old scope's list either.
  _DirectoryRefreshFence beginRefresh() {
    final scope = currentScope();
    final generation = ++_generation;
    return _DirectoryRefreshFence(this, scope, generation);
  }

  /// Fetches the directory under [fence], or throws if the fence is retired.
  ///
  /// Returns null when the request failed inside the current scope, which means
  /// "retain the cached discovery". The fence is re-checked after the await and
  /// before every write, on both the success and the failure path.
  Future<List<NostrEvent>?> load(
    RelaySessionNotifier session,
    _DirectoryRefreshFence fence,
  ) async {
    loadStatus().markLoading(fence.scope);
    final List<NostrEvent> metas;
    try {
      metas = await _fetchChannelDirectoryMetas(session);
    } catch (error, stackTrace) {
      fence.ensureCurrent();
      loadStatus().markError(fence.scope);
      debugPrint(
        '[ChannelsNotifier] channel directory refresh failed; retaining '
        'cached discovery: $error\n$stackTrace',
      );
      return null;
    }
    fence.ensureCurrent();
    loadStatus().markLoaded(fence.scope);
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
