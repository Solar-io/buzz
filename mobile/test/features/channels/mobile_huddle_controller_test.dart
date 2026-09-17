import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import 'package:buzz/features/channels/mobile_huddle_controller.dart';
import 'package:buzz/shared/community/community_provider.dart';
import 'package:buzz/shared/huddle/huddle_session.dart';
import 'package:buzz/shared/relay/app_lifecycle_provider.dart';

class _FakeAppLifecycleNotifier extends AppLifecycleNotifier {
  @override
  AppLifecycleState build() => AppLifecycleState.resumed;
}

/// Records leave() calls without running the real teardown.
class _SpySessionNotifier extends HuddleSessionNotifier {
  int leaveCalls = 0;

  @override
  Future<void> leave() async {
    leaveCalls++;
  }
}

void main() {
  test('locking the phone (paused) does not tear down the huddle', () async {
    final lifecycle = _FakeAppLifecycleNotifier();
    final session = _SpySessionNotifier();
    final container = ProviderContainer(
      overrides: [
        appLifecycleProvider.overrideWith(() => lifecycle),
        huddleSessionProvider.overrideWith(() => session),
        communityTransitionProvider.overrideWithValue(
          CommunityTransitionCoordinator(),
        ),
      ],
    );
    addTearDown(container.dispose);

    container.read(mobileHuddleControllerProvider.notifier);
    await Future<void>.delayed(Duration.zero);

    lifecycle.state = AppLifecycleState.inactive;
    lifecycle.state = AppLifecycleState.paused;
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(
      session.leaveCalls,
      0,
      reason: 'a locked/backgrounded phone must keep the audio session — '
          'the D-029 hardware gate (audio survives lock) depends on it',
    );

    lifecycle.state = AppLifecycleState.detached;
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(
      session.leaveCalls,
      1,
      reason: 'terminal detachment still ends the huddle cleanly',
    );
  });
}
