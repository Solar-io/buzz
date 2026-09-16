import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/theme/theme_provider.dart';

/// Agent thinking visibility (D-029 parity checklist §5): whether
/// `agent_thought_chunk` items render in the agent activity sheet's
/// transcript.
///
/// Web parity shape: the web hides thinking behind a per-DM 🧠 toggle and
/// defaults hidden; the checklist's chosen mobile shape is this one
/// settings-level switch (one toggle, honors the same default).
final thinkingVisibilityProvider =
    NotifierProvider<ThinkingVisibilityNotifier, bool>(
      ThinkingVisibilityNotifier.new,
    );

class ThinkingVisibilityNotifier extends Notifier<bool> {
  static const _prefsKey = 'display.showAgentThinking';

  @override
  bool build() {
    // savedPrefsProvider throws until main() wires the real instance; in
    // tests (no override) that must read as the default, not explode the
    // observer tree that now watches this provider.
    try {
      return ref.watch(savedPrefsProvider).getBool(_prefsKey) ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> set({required bool value}) async {
    state = value;
    try {
      await ref.read(savedPrefsProvider).setBool(_prefsKey, value);
    } catch (_) {
      // Persistence is best-effort; the in-memory state already flipped.
    }
  }
}
