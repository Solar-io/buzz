part of '../channels_page.dart';

class _BrowseChannelsSheet extends ConsumerWidget {
  const _BrowseChannelsSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channelsAsync = ref.watch(channelsProvider);
    final channels = channelsAsync.asData?.value
        .where((channel) => channel.canJoin)
        .toList();

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          Grid.gutter,
          0,
          Grid.gutter,
          Grid.xs,
        ),
        child: ListView(
          shrinkWrap: true,
          children: [
            Text(
              'Join an open channel to add it to your conversations.',
              style: context.textTheme.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: Grid.xs),
            if (channelsAsync.isLoading && channels == null)
              const Padding(
                padding: EdgeInsets.all(Grid.sm),
                child: Center(child: BuzzLoadingIndicator()),
              )
            else if (channelsAsync.hasError && channels == null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: Grid.sm),
                child: Text(
                  'Could not load open channels.',
                  textAlign: TextAlign.center,
                  style: context.textTheme.bodyMedium?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              )
            else if (channels == null || channels.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: Grid.sm),
                child: Text(
                  'No open channels available to join.',
                  textAlign: TextAlign.center,
                  style: context.textTheme.bodyMedium?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              )
            else
              _JoinableChannelList(channels: channels, closeAfterJoin: true),
          ],
        ),
      ),
    );
  }
}

class _JoinableChannelList extends StatelessWidget {
  final List<Channel> channels;
  final bool closeAfterJoin;

  const _JoinableChannelList({
    required this.channels,
    this.closeAfterJoin = false,
  });

  @override
  Widget build(BuildContext context) {
    final sortedChannels = List<Channel>.of(channels)
      ..sort(
        (left, right) =>
            left.name.toLowerCase().compareTo(right.name.toLowerCase()),
      );
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final channel in sortedChannels)
          _JoinableChannelTile(
            channel: channel,
            closeAfterJoin: closeAfterJoin,
          ),
      ],
    );
  }
}

class _JoinableChannelTile extends HookConsumerWidget {
  final Channel channel;
  final bool closeAfterJoin;

  const _JoinableChannelTile({
    required this.channel,
    required this.closeAfterJoin,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isJoining = useState(false);
    final actionError = useState<String?>(null);

    Future<void> join() async {
      if (isJoining.value) return;
      isJoining.value = true;
      actionError.value = null;
      try {
        await ref.read(channelActionsProvider).joinChannel(channel.id);
        if (closeAfterJoin && context.mounted) Navigator.of(context).pop();
      } catch (error) {
        actionError.value = error.toString();
      } finally {
        isJoining.value = false;
      }
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ListTile(
          key: Key('browse-channel-${channel.id}'),
          contentPadding: EdgeInsets.zero,
          leading: Icon(channelIcon(channel)),
          title: Text(channel.name),
          subtitle: channel.description.trim().isEmpty
              ? null
              : Text(
                  channel.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
          trailing: FilledButton.tonal(
            key: Key('browse-channel-join-${channel.id}'),
            onPressed: isJoining.value ? null : () => unawaited(join()),
            child: Text(isJoining.value ? 'Joining…' : 'Join'),
          ),
        ),
        if (actionError.value case final error?)
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              error,
              key: Key('browse-channel-error-${channel.id}'),
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.error,
              ),
            ),
          ),
      ],
    );
  }
}
