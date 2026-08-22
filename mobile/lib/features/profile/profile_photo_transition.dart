import 'package:flutter/material.dart';

PageRoute<void> profilePhotoEditorRoute({required WidgetBuilder builder}) =>
    PageRouteBuilder<void>(
      transitionDuration: Duration.zero,
      reverseTransitionDuration: Duration.zero,
      pageBuilder: (context, _, _) => builder(context),
      // The editor animates its avatar and controls in place. Keeping the route
      // still prevents a competing full-page push transition.
      transitionsBuilder: (_, _, _, child) => child,
    );
