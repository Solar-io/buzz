part of 'channels_provider.dart';

const _channelDirectoryPageSize = 500;
const _maxChannelDirectoryPages = 100;

Future<List<NostrEvent>> _fetchChannelDirectoryMetas(
  RelaySessionNotifier session,
) async {
  final directoryMetas = <NostrEvent>[];
  final seenDirectoryChannelIds = <String>{};
  int? directoryUntil;
  String? directoryBeforeId;
  for (var pageIndex = 0; pageIndex < _maxChannelDirectoryPages; pageIndex++) {
    final page = await session.queryRelay([
      NostrFilter(
        kinds: const [39000],
        limit: _channelDirectoryPageSize,
        until: directoryUntil,
        extensions: {'before_id': ?directoryBeforeId},
      ),
    ]);
    directoryMetas.addAll(page);

    var madeProgress = false;
    for (final event in page) {
      final channelId = event.getTagValue('d');
      if (channelId != null && seenDirectoryChannelIds.add(channelId)) {
        madeProgress = true;
      }
    }
    if (!madeProgress || page.length < _channelDirectoryPageSize) break;

    final last = page.last;
    directoryUntil = last.createdAt;
    directoryBeforeId = last.id;
    if (pageIndex == _maxChannelDirectoryPages - 1) {
      throw StateError(
        'Channel directory exceeded $_maxChannelDirectoryPages pages',
      );
    }
  }
  return directoryMetas;
}
