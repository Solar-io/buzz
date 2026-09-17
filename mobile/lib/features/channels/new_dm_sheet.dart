import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../shared/theme/theme.dart';
import '../../shared/widgets/avatar_image.dart';
import '../../shared/widgets/buzz_loading_indicator.dart';
import 'channel_management_provider.dart';

/// Searchable recipient picker for opening a new DM channel.
///
/// Recipients are selected from the relay directory, or pasted directly: a
/// 64-char hex pubkey or npub typed into the search field surfaces a
/// selectable key recipient even when the person has no kind:0 profile on the
/// relay (directory search alone can never reach them).
class NewDirectMessageSheet extends HookConsumerWidget {
  final String? currentPubkey;

  const NewDirectMessageSheet({super.key, required this.currentPubkey});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final queryController = useTextEditingController();
    final queryFocusNode = useFocusNode();
    final query = useState('');
    final debouncedQuery = useState('');
    final selectedUsers = useState<List<DirectoryUser>>([]);
    final isSubmitting = useState(false);
    final submitError = useState<String?>(null);
    final previewDirectoryActive = ref.watch(dmDirectoryPreviewEnabledProvider);

    useEffect(() {
      final timer = Timer(const Duration(milliseconds: 250), () {
        debouncedQuery.value = query.value.trim().toLowerCase();
      });
      return timer.cancel;
    }, [query.value]);

    final normalizedQuery = previewDirectoryActive
        ? query.value.trim().toLowerCase()
        : debouncedQuery.value;
    final isSearchTransitionPending =
        !previewDirectoryActive &&
        query.value.trim().toLowerCase() != normalizedQuery;
    final directoryAsync = previewDirectoryActive
        ? AsyncValue.data(dmDirectoryPreviewUsers)
        : normalizedQuery.isEmpty
        ? ref.watch(relayDirectoryUsersProvider)
        : ref.watch(relayDirectorySearchProvider(normalizedQuery));

    final selectedPubkeys = selectedUsers.value
        .map((user) => user.pubkey.toLowerCase())
        .toSet();

    // Paste affordance: a query that parses as a 64-char hex pubkey or npub
    // surfaces a selectable recipient directly from the raw search text —
    // decoded to clean hex at entry so openDm never receives a bech32 npub,
    // and visible even while the directory search for the same text is still
    // in flight, comes back empty, or fails. A malformed npub-shaped paste is
    // rejected with a validation message.
    final rawQuery = query.value.trim();
    final pastedKeyUser = directoryUserFromPastedKey(rawQuery);
    final pasteKeyMalformed =
        rawQuery.startsWith('npub') && pastedKeyUser == null;
    final pasteKeyEntry =
        pastedKeyUser != null &&
            !selectedPubkeys.contains(pastedKeyUser.pubkey) &&
            pastedKeyUser.pubkey != currentPubkey?.toLowerCase()
        ? pastedKeyUser
        : null;
    final pastedPubkey = pastedKeyUser?.pubkey.toLowerCase();

    final availableResults =
        directoryAsync.asData?.value.where((user) {
          final normalizedPubkey = user.pubkey.toLowerCase();
          if (selectedPubkeys.contains(normalizedPubkey) ||
              normalizedPubkey == currentPubkey?.toLowerCase() ||
              normalizedPubkey == pastedPubkey) {
            return false;
          }
          if (normalizedQuery.isEmpty) {
            return true;
          }
          return user.label.toLowerCase().contains(normalizedQuery) ||
              user.secondaryLabel.toLowerCase().contains(normalizedQuery) ||
              normalizedPubkey.contains(normalizedQuery);
        }).toList() ??
        const <DirectoryUser>[];
    final results = [?pasteKeyEntry, ...availableResults];
    final canSubmit = !isSubmitting.value && selectedUsers.value.isNotEmpty;

    Future<void> submit() async {
      if (selectedUsers.value.isEmpty || isSubmitting.value) {
        return;
      }
      if (previewDirectoryActive) {
        submitError.value = 'Preview only — mock people cannot be messaged.';
        return;
      }

      isSubmitting.value = true;
      submitError.value = null;
      try {
        final channel = await ref
            .read(channelActionsProvider)
            .openDm(
              pubkeys: selectedUsers.value.map((user) => user.pubkey).toList(),
            );
        if (context.mounted) {
          Navigator.of(context).pop(channel);
        }
      } catch (error) {
        submitError.value = error.toString();
      } finally {
        isSubmitting.value = false;
      }
    }

    return Padding(
      padding: EdgeInsets.fromLTRB(
        Grid.gutter,
        0,
        Grid.gutter,
        MediaQuery.viewInsetsOf(context).bottom + Grid.xs,
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              GestureDetector(
                behavior: HitTestBehavior.translucent,
                onTap: isSubmitting.value ? null : queryFocusNode.requestFocus,
                child: SizedBox(
                  width: double.infinity,
                  child: ConstrainedBox(
                    key: const Key('new-dm-recipient-field'),
                    constraints: const BoxConstraints(minHeight: Grid.xl),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: context.colors.surface,
                        border: Border.all(
                          color: context.colors.outlineVariant,
                        ),
                        borderRadius: BorderRadius.circular(Radii.lg),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: Grid.twelve,
                          vertical: Grid.xxs,
                        ),
                        child: LayoutBuilder(
                          builder: (context, constraints) {
                            final hasSelectedUsers =
                                selectedUsers.value.isNotEmpty;
                            final searchFieldWidth = hasSelectedUsers
                                ? 96.0
                                : (constraints.maxWidth - 32).clamp(
                                    96.0,
                                    constraints.maxWidth,
                                  );

                            return Wrap(
                              key: const Key('new-dm-recipient-wrap'),
                              spacing: 6,
                              runSpacing: 6,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                Padding(
                                  padding: const EdgeInsets.symmetric(
                                    vertical: Grid.half,
                                  ),
                                  child: Text(
                                    'To:',
                                    style: context.textTheme.bodyLarge
                                        ?.copyWith(fontWeight: FontWeight.w600),
                                  ),
                                ),
                                for (final user in selectedUsers.value)
                                  _SelectedDmRecipientChip(
                                    user: user,
                                    enabled: !isSubmitting.value,
                                    onDeleted: () {
                                      selectedUsers.value = [
                                        for (final candidate
                                            in selectedUsers.value)
                                          if (candidate.pubkey != user.pubkey)
                                            candidate,
                                      ];
                                      queryFocusNode.requestFocus();
                                    },
                                  ),
                                SizedBox(
                                  width: searchFieldWidth,
                                  child: TextField(
                                    key: const Key('new-dm-search'),
                                    controller: queryController,
                                    focusNode: queryFocusNode,
                                    autofocus: true,
                                    autocorrect: false,
                                    enableSuggestions: false,
                                    enabled: !isSubmitting.value,
                                    onChanged: (value) => query.value = value,
                                    onSubmitted: (_) {
                                      if (canSubmit) {
                                        unawaited(submit());
                                      }
                                    },
                                    decoration: InputDecoration(
                                      hintText: hasSelectedUsers
                                          ? null
                                          : 'Search for a person',
                                      border: InputBorder.none,
                                      enabledBorder: InputBorder.none,
                                      focusedBorder: InputBorder.none,
                                      isDense: true,
                                      contentPadding:
                                          const EdgeInsets.symmetric(
                                            vertical: Grid.half,
                                          ),
                                      suffixIcon: isSubmitting.value
                                          ? const Padding(
                                              padding: EdgeInsets.all(
                                                Grid.half,
                                              ),
                                              child: SizedBox.square(
                                                dimension: 16,
                                                child: BuzzLoadingIndicator(
                                                  size: 16,
                                                  semanticLabel:
                                                      'Creating conversation',
                                                ),
                                              ),
                                            )
                                          : null,
                                      suffixIconConstraints:
                                          const BoxConstraints(
                                            minHeight: 32,
                                            minWidth: 32,
                                          ),
                                    ),
                                    textInputAction: TextInputAction.done,
                                  ),
                                ),
                              ],
                            );
                          },
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: Grid.xs),
              Builder(
                key: const Key('new-dm-results'),
                builder: (context) {
                  if (selectedUsers.value.length >= 8) {
                    return const SizedBox(
                      height: 96,
                      child: Center(
                        child: Text(
                          'DMs support up to nine people, including you.',
                        ),
                      ),
                    );
                  }
                  // A pasted key stays selectable even while the directory
                  // is loading or unreachable — by-key addressing must not
                  // depend on a healthy directory.
                  if (pasteKeyEntry == null &&
                      (directoryAsync.isLoading &&
                              directoryAsync.asData == null ||
                          isSearchTransitionPending)) {
                    return const SizedBox(
                      height: 280,
                      child: Center(
                        child: BuzzLoadingIndicator(
                          size: 44,
                          semanticLabel: 'Loading people',
                        ),
                      ),
                    );
                  }
                  if (pasteKeyEntry == null && directoryAsync.hasError) {
                    return SizedBox(
                      height: 280,
                      child: Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Text(
                              'Could not load people from this relay.',
                            ),
                            const SizedBox(height: Grid.half),
                            TextButton(
                              onPressed: () {
                                if (normalizedQuery.isEmpty) {
                                  ref.invalidate(relayDirectoryUsersProvider);
                                } else {
                                  ref.invalidate(
                                    relayDirectorySearchProvider(
                                      normalizedQuery,
                                    ),
                                  );
                                }
                              },
                              child: const Text('Retry'),
                            ),
                          ],
                        ),
                      ),
                    );
                  }
                  if (results.isEmpty) {
                    return SizedBox(
                      height: 280,
                      child: Center(
                        child: Text(
                          normalizedQuery.isEmpty
                              ? 'No people or agents available to message.'
                              : 'No matching users.',
                        ),
                      ),
                    );
                  }
                  return ListView.separated(
                    physics: const NeverScrollableScrollPhysics(),
                    shrinkWrap: true,
                    itemCount: results.length,
                    separatorBuilder: (_, _) =>
                        const Divider(height: 1, indent: 56),
                    itemBuilder: (context, index) {
                      final user = results[index];
                      return ListTile(
                        key: Key('new-dm-person-${user.pubkey}'),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: Grid.half,
                        ),
                        leading: AvatarImage(
                          imageUrl: user.avatarUrl,
                          radius: 20,
                          backgroundColor: context.colors.primaryContainer,
                          fallback: Text(
                            user.initial,
                            style: context.textTheme.labelLarge?.copyWith(
                              color: context.colors.onPrimaryContainer,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        title: Text(
                          user.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: Text(
                          user.secondaryLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        trailing: Icon(
                          LucideIcons.plus,
                          size: 18,
                          color: context.colors.onSurfaceVariant,
                        ),
                        onTap: isSubmitting.value
                            ? null
                            : () {
                                selectedUsers.value = [
                                  ...selectedUsers.value,
                                  user,
                                ];
                                queryController.clear();
                                query.value = '';
                                debouncedQuery.value = '';
                                submitError.value = null;
                                queryFocusNode.requestFocus();
                              },
                      );
                    },
                  );
                },
              ),
              if (pasteKeyMalformed) ...[
                const SizedBox(height: Grid.xxs),
                Text(
                  'Paste a valid npub or hex pubkey.',
                  style: context.textTheme.bodySmall?.copyWith(
                    color: context.colors.error,
                  ),
                ),
              ],
              if (submitError.value case final error?) ...[
                const SizedBox(height: Grid.xxs),
                Text(
                  error,
                  style: context.textTheme.bodySmall?.copyWith(
                    color: context.colors.error,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _SelectedDmRecipientChip extends StatelessWidget {
  final DirectoryUser user;
  final bool enabled;
  final VoidCallback onDeleted;

  const _SelectedDmRecipientChip({
    required this.user,
    required this.enabled,
    required this.onDeleted,
  });

  @override
  Widget build(BuildContext context) {
    final foreground = context.colors.onSurfaceVariant;

    return ConstrainedBox(
      key: Key('new-dm-selected-${user.pubkey}'),
      constraints: const BoxConstraints(maxWidth: 224),
      child: SizedBox(
        height: 40,
        child: Material(
          color: context.colors.surfaceContainerHighest,
          shape: const StadiumBorder(),
          clipBehavior: Clip.antiAlias,
          child: Semantics(
            button: true,
            enabled: enabled,
            excludeSemantics: true,
            label: 'Remove ${user.label}',
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: enabled ? onDeleted : null,
              child: Padding(
                padding: const EdgeInsets.only(
                  left: Grid.half,
                  right: Grid.twelve,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    AvatarImage(
                      imageUrl: user.avatarUrl,
                      radius: 16,
                      backgroundColor: context.colors.primaryContainer,
                      fallback: Text(
                        user.initial,
                        style: context.textTheme.labelMedium?.copyWith(
                          color: context.colors.onPrimaryContainer,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    const SizedBox(width: Grid.xxs),
                    Flexible(
                      child: Text(
                        user.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.textTheme.bodyLarge?.copyWith(
                          color: foreground,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
