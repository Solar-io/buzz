import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'dev/audio_selftest.dart';
import 'features/invites/invite_join_provider.dart';
import 'shared/huddle/huddle_media.dart';
import 'shared/huddle/huddle_session.dart';
import 'shared/theme/theme_provider.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Pre-load preferences so the first frame uses the saved theme/accent.
  final prefs = await SharedPreferences.getInstance();

  // Debug-only D-029 audio-pass rig; a no-op in every other build.
  await bootstrapAudioSelftestIdentity();

  runApp(
    ProviderScope(
      overrides: [
        savedPrefsProvider.overrideWithValue(prefs),
        inviteJoinRecoveryProvider.overrideWith(
          (ref) =>
              (scope) => buildMobileInviteJoinRecovery(ref, scope),
        ),
        if (AudioSelftestConfig.enabled)
          huddleMediaFactoryProvider.overrideWithValue(
            wrapWithTelemetry(MethodChannelHuddleMedia.new),
          ),
      ],
      child: AudioSelftestConfig.enabled
          ? AudioSelftestShell(child: const App())
          : const App(),
    ),
  );
}
