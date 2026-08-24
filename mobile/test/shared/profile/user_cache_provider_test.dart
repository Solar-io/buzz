import 'package:buzz/shared/profile/user_cache_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

void main() {
  test('preload reports a profile batch failure', () async {
    final container = ProviderContainer(
      overrides: [
        relaySessionProvider.overrideWith(_FailingProfileSession.new),
      ],
    );
    addTearDown(container.dispose);

    final succeeded = await container.read(userCacheProvider.notifier).preload(
      const ['agent'],
    );

    expect(succeeded, isFalse);
  });
}

class _FailingProfileSession extends RelaySessionNotifier {
  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<List<NostrEvent>> fetchHistory(
    NostrFilter filter, {
    Duration timeout = const Duration(seconds: 8),
  }) => Future.error('profile unavailable');
}
