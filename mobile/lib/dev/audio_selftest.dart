import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../features/channels/mobile_huddle_controller.dart';
import '../shared/community/community.dart';
import '../shared/community/community_storage.dart';
import '../shared/huddle/huddle_media.dart';
import '../shared/huddle/huddle_session.dart';
import '../shared/huddle/huddle_wire.dart';
import '../shared/relay/relay_provider.dart';

/// Debug-only audio-pass rig for the D-029 hardware gate.
///
/// Active only when all three `--dart-define` values are set AND the build is
/// a debug build:
///
/// - `BUZZ_SELFTEST_NSEC` — scratch rig identity (never a real account key).
/// - `BUZZ_SELFTEST_RELAY_URL` — relay origin the device can reach.
/// - `BUZZ_SELFTEST_PARENT_CHANNEL` — UUID of the rig's parent channel.
///
/// What it does, through the app's normal code paths only:
///
/// 1. Bootstraps the scratch identity as the active community (the same
///    `CommunityStorage` records pairing writes).
/// 2. Once the relay config resolves, starts a huddle in the parent channel
///    via `MobileHuddleController.start` — the same call the huddle sheet
///    makes (backing channel, kind-48100 announce, join).
/// 3. Wraps the media factory with a counting decorator and appends one
///    telemetry line per second to `<Documents>/audio-selftest-telemetry.jsonl`
///    alongside app-lifecycle transitions.
///
/// The audio stack itself is untouched — capture, transport, and playback run
/// exactly as they do for a user-started huddle.
abstract final class AudioSelftestConfig {
  static const nsec = String.fromEnvironment('BUZZ_SELFTEST_NSEC');
  static const relayUrl = String.fromEnvironment('BUZZ_SELFTEST_RELAY_URL');
  static const parentChannel = String.fromEnvironment(
    'BUZZ_SELFTEST_PARENT_CHANNEL',
  );

  static bool get enabled =>
      kDebugMode && nsec.isNotEmpty && relayUrl.isNotEmpty && parentChannel.isNotEmpty;
}

/// Writes the rig identity as the active community. Called from `main()`
/// before `runApp` so the first provider read already sees it.
Future<void> bootstrapAudioSelftestIdentity() async {
  if (!AudioSelftestConfig.enabled) return;
  final storage = CommunityStorage();
  final community = Community.create(
    name: 'audio-rig',
    relayUrl: AudioSelftestConfig.relayUrl,
  );
  await storage.save(community.copyWith(nsec: AudioSelftestConfig.nsec));
  await storage.saveActiveId(community.id);
  debugPrint('[audio-selftest] identity bootstrapped for ${community.id}');
}

/// Per-second aggregates gathered by [TelemetryHuddleMedia].
final class AudioSelftestTelemetry {
  AudioSelftestTelemetry._();

  static final AudioSelftestTelemetry instance = AudioSelftestTelemetry._();

  int sentFrames = 0;
  int sentLevelMax = -127;
  int recvFrames = 0;
  int recvLevelMax = -127;
  int recvDtxFrames = 0;
  String phase = 'idle';
  bool interrupted = false;
  final List<String> _events = [];

  void recordSend(int levelDbov) {
    sentFrames++;
    if (levelDbov > sentLevelMax) sentLevelMax = levelDbov;
  }

  void recordRecv(HuddleRemoteAudioFrame frame) {
    recvFrames++;
    if (frame.header.isDtx) {
      recvDtxFrames++;
    } else if (frame.header.levelDbov > recvLevelMax) {
      recvLevelMax = frame.header.levelDbov;
    }
  }

  void event(String message) {
    _events.add(message);
  }

  /// One JSONL line for the current second, then reset the counters.
  String drain(int uptimeSeconds, AppLifecycleState lifecycle) {
    final line =
        '{"t":${DateTime.now().toUtc().toIso8601String()},"uptime":$uptimeSeconds,'
        '"phase":"$phase","interrupted":$interrupted,'
        '"lifecycle":"${lifecycle.name}",'
        '"sent":$sentFrames,"sentDbovMax":$sentLevelMax,'
        '"recv":$recvFrames,"recvDbovMax":$recvLevelMax,"recvDtx":$recvDtxFrames'
        '${_events.isEmpty ? '' : ',"events":${jsonEncodeStringList(_events)}'}}';
    sentFrames = 0;
    sentLevelMax = -127;
    recvFrames = 0;
    recvLevelMax = -127;
    recvDtxFrames = 0;
    _events.clear();
    return line;
  }

  static String jsonEncodeStringList(List<String> values) =>
      '[${values.map((v) => '"${v.replaceAll('"', r'\"')}"').join(',')}]';
}

/// Logging decorator over the platform-channel media engine. Counts frames in
/// both directions without touching capture, transport, or playback.
class TelemetryHuddleMedia implements HuddleMedia {
  TelemetryHuddleMedia(this._inner) {
    _stateSub = _inner.states.listen((state) {
      AudioSelftestTelemetry.instance
        ..phase = state.phase.name
        ..interrupted = state.isInterrupted;
    });
    _frameSub = _inner.localAudioFrames.listen((frame) {
      AudioSelftestTelemetry.instance.recordSend(frame.header.levelDbov);
    });
  }

  final HuddleMedia _inner;
  late final StreamSubscription<HuddleMediaState> _stateSub;
  late final StreamSubscription<HuddleLocalAudioFrame> _frameSub;

  @override
  Future<void> dispose() async {
    await _frameSub.cancel();
    await _stateSub.cancel();
    await _inner.dispose();
  }

  @override
  Future<HuddleMediaCapabilities> discoverCapabilities() =>
      _inner.discoverCapabilities();

  @override
  Stream<HuddleLocalAudioFrame> get localAudioFrames => _inner.localAudioFrames;

  @override
  Future<HuddleMicrophonePermission> requestMicrophonePermission() =>
      _inner.requestMicrophonePermission();

  @override
  Future<bool> openSystemSettings() => _inner.openSystemSettings();

  @override
  Future<void> prepare() => _inner.prepare();

  @override
  Future<void> playRemoteFrame(HuddleRemoteAudioFrame frame) {
    AudioSelftestTelemetry.instance.recordRecv(frame);
    return _inner.playRemoteFrame(frame);
  }

  @override
  Future<void> removeRemotePeer(int peerIndex) => _inner.removeRemotePeer(peerIndex);

  @override
  Future<void> setMuted(bool muted) => _inner.setMuted(muted);

  @override
  Future<void> setSpeakerEnabled(bool enabled) =>
      _inner.setSpeakerEnabled(enabled);

  @override
  Future<void> start() => _inner.start();

  @override
  HuddleMediaState get state => _inner.state;

  @override
  Stream<HuddleMediaState> get states => _inner.states;

  @override
  Future<void> stop() => _inner.stop();
}

/// Mounted above the app only in selftest builds: starts the huddle once the
/// identity resolves, records lifecycle transitions, and ticks the telemetry
/// file every second.
class AudioSelftestShell extends ConsumerStatefulWidget {
  const AudioSelftestShell({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<AudioSelftestShell> createState() => _AudioSelftestShellState();
}

class _AudioSelftestShellState extends ConsumerState<AudioSelftestShell>
    with WidgetsBindingObserver {
  static const _tick = Duration(seconds: 1);

  IOSink? _sink;
  Timer? _ticker;
  Timer? _startRetry;
  int _uptime = 0;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    AudioSelftestTelemetry.instance.event('shell-mounted');
    _openLog();
    _ticker = Timer.periodic(_tick, (_) => _writeTick());
    _startRetry = Timer.periodic(const Duration(seconds: 2), (_) => _tryStart());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    AudioSelftestTelemetry.instance.event('lifecycle:${state.name}');
  }

  Future<void> _openLog() async {
    try {
      final dir = await getApplicationDocumentsDirectory();
      final file = File('${dir.path}/audio-selftest-telemetry.jsonl');
      _sink = file.openWrite(mode: FileMode.append);
      AudioSelftestTelemetry.instance.event('log-opened:${file.path}');
    } catch (error) {
      debugPrint('[audio-selftest] could not open telemetry file: $error');
    }
  }

  void _tryStart() {
    if (_started) return;
    // Wait until the bootstrapped identity resolves through the provider
    // cascade — starting earlier fails fast on "A paired identity is
    // required" and would never retry.
    final nsec = ref.read(relayConfigProvider).nsec;
    if (nsec == null || nsec.isEmpty) return;

    final notifier = ref.read(mobileHuddleControllerProvider.notifier);
    unawaited(
      notifier
          .start(parentChannelId: AudioSelftestConfig.parentChannel)
          .then((_) {
        AudioSelftestTelemetry.instance.event('huddle-start-returned');
      }).catchError((Object error) {
        AudioSelftestTelemetry.instance.event('huddle-start-error:$error');
      }),
    );
    _started = true;
    _startRetry?.cancel();
  }

  void _writeTick() {
    final telemetry = AudioSelftestTelemetry.instance;
    final line = telemetry.drain(
      _uptime++,
      WidgetsBinding.instance.lifecycleState ?? AppLifecycleState.detached,
    );
    _sink?.writeln(line);
  }

  @override
  Widget build(BuildContext context) => widget.child;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _startRetry?.cancel();
    _ticker?.cancel();
    _sink?.close();
    super.dispose();
  }
}

/// Override for `huddleMediaFactoryProvider` that wraps the real engine in the
/// counting decorator.
HuddleMediaFactory wrapWithTelemetry(HuddleMediaFactory inner) =>
    () => TelemetryHuddleMedia(inner());
