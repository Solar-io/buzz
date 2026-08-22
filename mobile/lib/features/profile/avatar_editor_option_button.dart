import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../shared/theme/theme.dart';

/// A labelled circular option used by the profile avatar editor rails.
class AvatarEditorOptionButton extends StatelessWidget {
  const AvatarEditorOptionButton({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
    this.labelMaxWidth,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final double? labelMaxWidth;

  @override
  Widget build(BuildContext context) => InkResponse(
    radius: 34,
    onTap: onTap == null
        ? null
        : () {
            unawaited(HapticFeedback.selectionClick());
            onTap!();
          },
    child: SizedBox(
      width: double.infinity,
      child: Column(
        children: [
          AnimatedContainer(
            duration: MediaQuery.disableAnimationsOf(context)
                ? Duration.zero
                : const Duration(milliseconds: 150),
            curve: Curves.easeOutCubic,
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: selected
                  ? context.colors.onSurface
                  : context.colors.surfaceContainerHighest,
            ),
            child: Icon(
              icon,
              size: 26,
              color: selected
                  ? context.colors.surface
                  : context.colors.onSurface,
            ),
          ),
          const SizedBox(height: Grid.quarter),
          if (labelMaxWidth case final width?)
            SizedBox(
              height: 20,
              child: OverflowBox(
                maxWidth: width,
                maxHeight: 20,
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.labelSmall?.copyWith(
                    color: selected
                        ? context.colors.onSurface
                        : context.colors.onSurfaceVariant,
                  ),
                ),
              ),
            )
          else
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.textTheme.labelSmall?.copyWith(
                color: selected
                    ? context.colors.onSurface
                    : context.colors.onSurfaceVariant,
              ),
            ),
        ],
      ),
    ),
  );
}
