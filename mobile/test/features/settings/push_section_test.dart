import 'dart:convert';

import 'package:buzz/features/settings/settings_page.dart';
import 'package:buzz/shared/auth/auth.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:buzz/shared/theme/theme.dart';

import '../../helpers/widget_helpers.dart';

void main() {
  testWidgets('signed-in row renders with idle subtitle and switch off', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    await tester.pumpWidget(
      WidgetHelpers.testable(
        overrides: [
          relayConfigProvider.overrideWith(_RelayConfigNotifier.new),
          authProvider.overrideWith(_AuthNotifier.new),
          savedPrefsProvider.overrideWithValue(prefs),
        ],
        child: SettingsPage(
          profileHeader: const SizedBox.shrink(),
          invitePageBuilder: (_) => const SizedBox.shrink(),
          identityRecoveryPageBuilder: (_) => const SizedBox.shrink(),
        ),
      ),
    );
    await tester.pump();
    await tester.ensureVisible(find.text('Push notifications'));
    await tester.pumpAndSettle();

    expect(find.text('Mention and alert banners on this device'), findsOneWidget);
    expect(
      tester.widget<Switch>(find.byType(Switch).last),
      isA<Switch>().having((s) => s.value, 'value', false),
    );
  });

  testWidgets('restored active lease shows generation and switch on', (tester) async {
    SharedPreferences.setMockInitialValues({
      'buzz.push-lease.v1:https%3A%2F%2Frelay.test': jsonEncode({
        'active': true,
        'generation': 3,
        'installation_handle': 'handle-1',
      }),
    });
    final prefs = await SharedPreferences.getInstance();
    await tester.pumpWidget(
      WidgetHelpers.testable(
        overrides: [
          relayConfigProvider.overrideWith(_RelayConfigNotifier.new),
          authProvider.overrideWith(_AuthNotifier.new),
          savedPrefsProvider.overrideWithValue(prefs),
        ],
        child: SettingsPage(
          profileHeader: const SizedBox.shrink(),
          invitePageBuilder: (_) => const SizedBox.shrink(),
          identityRecoveryPageBuilder: (_) => const SizedBox.shrink(),
        ),
      ),
    );
    await tester.pump();
    await tester.ensureVisible(find.text('Push notifications'));
    await tester.pumpAndSettle();

    expect(find.textContaining('generation 3'), findsOneWidget);
    expect(
      tester.widget<Switch>(find.byType(Switch).last),
      isA<Switch>().having((s) => s.value, 'value', true),
    );
  });
}

class _AuthNotifier extends AuthNotifier {
  @override
  Future<AuthState> build() async => AuthState(
    status: AuthStatus.authenticated,
    community: Community(
      id: 'community',
      name: 'Test',
      relayUrl: 'https://relay.test',
      nsec: _RelayConfigNotifier.testNsec,
      addedAt: DateTime.utc(2026),
    ),
  );
}

class _RelayConfigNotifier extends RelayConfigNotifier {
  static final testNsec = nostr.Keys(
    '1111111111111111111111111111111111111111111111111111111111111111',
  ).nsec;

  @override
  RelayConfig build() => RelayConfig(baseUrl: 'https://relay.test', nsec: testNsec);
}
