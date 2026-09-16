part of '../settings_page.dart';

/// Agent-facing display toggles. D-029 §5: thinking visibility — the web
/// carries its per-DM 🧠 reveal; mobile's chosen shape is this single
/// switch, default hidden like the web.
class _ActivitySection extends ConsumerWidget {
  const _ActivitySection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final showThinking = ref.watch(thinkingVisibilityProvider);

    return AppListCard(
      label: 'Activity',
      verticalPadding: Grid.twelve,
      children: [
        AppListRowRaw(
          leading: Icon(
            LucideIcons.brain,
            color: context.colors.onSurfaceVariant,
          ),
          title: Text(
            'Show agent thinking',
            style: context.textTheme.bodyMedium,
          ),
          subtitle: Text(
            'Thinking steps appear in an agent\'s activity sheet. Off by '
            'default, like the web.',
            style: context.textTheme.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          trailing: Switch(
            key: const Key('settings-show-agent-thinking'),
            value: showThinking,
            onChanged: (value) => ref
                .read(thinkingVisibilityProvider.notifier)
                .set(value: value),
          ),
        ),
      ],
    );
  }
}
