import 'package:flutter/material.dart';

import '../animated_avatar.dart';
import 'avatar_image.dart';
import 'progressive_animated_avatar.dart';

/// A circular avatar that opts into playback for animated profile descriptors.
class PlayingAvatarImage extends StatelessWidget {
  const PlayingAvatarImage({
    super.key,
    required this.imageUrl,
    required this.radius,
    required this.fallback,
    this.backgroundColor,
  });

  final String? imageUrl;
  final double radius;
  final Color? backgroundColor;
  final Widget fallback;

  @override
  Widget build(BuildContext context) {
    final descriptor = parseAnimatedAvatarUrl(imageUrl);
    if (descriptor == null) {
      return AvatarImage(
        imageUrl: imageUrl,
        radius: radius,
        backgroundColor: backgroundColor,
        fallback: fallback,
      );
    }

    return CircleAvatar(
      radius: radius,
      backgroundColor: Colors.transparent,
      child: ClipOval(
        child: SizedBox.square(
          dimension: radius * 2,
          child: ProgressiveAnimatedAvatar(
            descriptor: descriptor,
            fallback: fallback,
          ),
        ),
      ),
    );
  }
}
