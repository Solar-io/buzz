// D-029 audio-pass rig: the OTHER end of the huddle for the hardware gate.
//
// Runs on crichton against the dev relay over loopback:
//   1. watches the parent channel for the phone's kind-48100 huddle-start,
//   2. joins that huddle's audio room through the app's own HuddleAuthV2 +
//      HuddleWireV2 code (no protocol reimplementation),
//   3. streams the pre-encoded 440 Hz Opus tone at real-time pace,
//   4. logs every received frame — the phone's mic echo of our tone is the
//      out-of-device proof that its speaker kept playing through lock.
//
// Configure with --dart-define (all required):
//   RIG_NSEC, RIG_PARENT, RIG_TONE_PATH, RIG_OUT_PATH,
//   RIG_WS_BASE (default ws://127.0.0.1:6350), RIG_SECONDS (default 660).
//
// Run: flutter test tool/huddle_rig_peer_test.dart --dart-define=...

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:web_socket_channel/io.dart';

import 'package:buzz/shared/huddle/huddle_auth.dart';
import 'package:buzz/shared/huddle/huddle_wire.dart';

const _nsec = String.fromEnvironment('RIG_NSEC');
const _parent = String.fromEnvironment('RIG_PARENT');
const _tonePath = String.fromEnvironment('RIG_TONE_PATH');
const _outPath = String.fromEnvironment('RIG_OUT_PATH');
const _wsBase = String.fromEnvironment('RIG_WS_BASE', defaultValue: 'ws://127.0.0.1:6350');
const _seconds = int.fromEnvironment('RIG_SECONDS', defaultValue: 660);

/// Extracts raw Opus packets from an Ogg Opus file (lacing-value framing).
List<Uint8List> parseOggPackets(List<int> bytes) {
  final packets = <Uint8List>[];
  var current = BytesBuilder();
  var pos = 0;
  var audioPacketsSeen = 0;
  while (pos + 27 <= bytes.length) {
    if (String.fromCharCodes(bytes.sublist(pos, pos + 4)) != 'OggS') {
      throw FormatException('missing OggS capture at $pos');
    }
    final numSegs = bytes[pos + 26];
    final segTable = bytes.sublist(pos + 27, pos + 27 + numSegs);
    var dataStart = pos + 27 + numSegs;
    for (final lacing in segTable) {
      final remaining = bytes.length - dataStart;
      final take = lacing > remaining ? remaining : lacing;
      current.add(bytes.sublist(dataStart, dataStart + take));
      dataStart += take;
      if (lacing < 255) {
        final packet = current.takeBytes();
        audioPacketsSeen++;
        if (audioPacketsSeen > 2) packets.add(Uint8List.fromList(packet));
        // Packets 1 and 2 are OpusHead and OpusTags.
      }
    }
    pos = dataStart;
  }
  if (current.isNotEmpty && audioPacketsSeen <= 2) {
    throw FormatException('stream ended inside a header packet');
  }
  return packets;
}

void main() {
  test(
    'huddle rig peer: tone in, phone echo logged',
    () async {
      expect(_nsec, isNotEmpty, reason: 'RIG_NSEC define required');
      expect(_parent, isNotEmpty, reason: 'RIG_PARENT define required');
      expect(_tonePath, isNotEmpty, reason: 'RIG_TONE_PATH define required');
      expect(_outPath, isNotEmpty, reason: 'RIG_OUT_PATH define required');

      final out = File(_outPath).openWrite();
      void logLine(Map<String, Object?> value) {
        final line = jsonEncode({
          't': DateTime.now().toUtc().toIso8601String(),
          ...value,
        });
        out.writeln(line);
        // ignore: avoid_print
        print('RIG $line');
      }

      final tone = parseOggPackets(File(_tonePath).readAsBytesSync());
      logLine({'kind': 'rig-start', 'tonePackets': tone.length, 'wsBase': _wsBase});
      expect(tone, isNotEmpty);
      // 20 ms frames at 48 kHz.
      expect(tone.length, greaterThan(50 * 60), reason: 'need at least a minute of tone');

      // ── Phase A: main relay socket, wait for the phone's kind-48100. ──
      final mainWs = IOWebSocketChannel.connect(Uri.parse(_wsBase));
      await mainWs.ready;

      var ephemeralId = Completer<String>();
      final mainSub = mainWs.stream.listen((rawMessage) async {
        final message = rawMessage as List<dynamic>;
        if (message.isEmpty) return;
        switch (message[0]) {
          case 'AUTH':
            final secretKey = _nsec.startsWith('nsec')
                ? nostr.Nip19.decode(payload: _nsec).data
                : _nsec;
            final event = nostr.Event.from(
              kind: 22242,
              content: '',
              tags: [
                ['relay', _wsBase],
                ['challenge', message[1].toString()],
              ],
              secretKey: secretKey,
            );
            mainWs.sink.add(jsonEncode(['EVENT', event.toMap()]));
          case 'EVENT':
            final event = message[2] as Map<String, dynamic>;
            if (event['kind'] == 48100 && !ephemeralId.isCompleted) {
              final content = jsonDecode(event['content'] as String)
                  as Map<String, dynamic>;
              final id = content['ephemeral_channel_id'] as String;
              logLine({'kind': 'huddle-start-seen', 'ephemeral': id, 'by': event['pubkey']});
              ephemeralId.complete(id);
            }
          case 'NOTICE':
            logLine({'kind': 'notice', 'message': message[1]});
        }
      });

      mainWs.sink.add(jsonEncode([
        'REQ',
        'rig-watch',
        {
          'kinds': [48100],
          '#h': [_parent],
          'limit': 1,
        },
      ]));

      final ephemeral = await ephemeralId.future.timeout(
        const Duration(minutes: 8),
        onTimeout: () => throw TimeoutException('phone never announced a huddle'),
      );

      // ── Phase B: join the audio room with the app's real auth code. ──
      final parameters = HuddleConnectionParameters(
        relayWebSocketUrl: _wsBase,
        nsec: _nsec,
        parentChannelId: _parent,
        ephemeralChannelId: ephemeral,
      );
      final audioUri = parameters.audioWebSocketUri;
      logLine({'kind': 'audio-connect', 'uri': audioUri.toString()});

      final audioWs = IOWebSocketChannel.connect(audioUri);
      await audioWs.ready;

      var joined = Completer<void>();
      var recvFrames = 0;
      var recvLevelMax = -127;
      var recvVoiceFrames = 0; // non-DTX, above the -55 dBov speech floor
      var sentFrames = 0;

      final audioSub = audioWs.stream.listen((message) {
        if (message is String) {
          final decoded = jsonDecode(message);
          if (decoded is List) {
            logLine({'kind': 'audio-control', 'message': decoded});
            return;
          }
          final control = decoded as Map<String, dynamic>;
          switch (control['type']) {
            case 'challenge':
              final auth = HuddleAuthV2.buildMessage(
                parameters: parameters,
                challenge: control['challenge'] as String,
              );
              audioWs.sink.add(jsonEncode(auth));
              logLine({'kind': 'auth-sent'});
            case 'joined':
              logLine({'kind': 'joined', 'peer': control['peer_index']});
              if (!joined.isCompleted) joined.complete();
            case 'error':
              logLine({'kind': 'audio-error', 'message': control['message']});
            default:
              logLine({'kind': 'audio-control', 'message': control});
          }
          return;
        }
        final frame = HuddleWireV2.decodeRelayFrame(message as Uint8List);
        recvFrames++;
        final level = frame.header.levelDbov;
        if (level > recvLevelMax) recvLevelMax = level;
        if (!frame.header.isDtx && level > -55) recvVoiceFrames++;
      });

      await joined.future.timeout(
        const Duration(seconds: 20),
        onTimeout: () => throw TimeoutException('audio room join never confirmed'),
      );

      // ── Phase C: stream the tone at real-time pace. ──
      final sendTimer = Timer.periodic(HuddleWireV2.frameDuration, (tick) {
        final index = tick.tick - 1;
        if (index >= tone.length) return;
        final header = HuddleAudioHeader(
          sequence: index & 0xffff,
          timestamp48k: (index * HuddleWireV2.frameSamples) & 0xffffffff,
          levelDbov: -9, // measured RMS of the encoded sine
          flags: 0,
        );
        audioWs.sink.add(HuddleWireV2.encodeClientFrame(header, tone[index]));
        sentFrames++;
      });

      logLine({'kind': 'tone-streaming', 'plannedSeconds': _seconds});
      final perSecond = Timer.periodic(const Duration(seconds: 1), (_) {
        logLine({
          'kind': 'second',
          'sent': sentFrames,
          'recv': recvFrames,
          'recvLevelMax': recvLevelMax,
          'voice': recvVoiceFrames,
        });
      });

      await Future<void>.delayed(Duration(seconds: _seconds));

      sendTimer.cancel();
      perSecond.cancel();
      logLine({
        'kind': 'rig-done',
        'sent': sentFrames,
        'recv': recvFrames,
        'recvLevelMax': recvLevelMax,
        'voice': recvVoiceFrames,
      });
      expect(sentFrames, greaterThan(50 * 60), reason: 'at least a minute of tone sent');
      expect(recvFrames, greaterThan(0), reason: 'phone frames never arrived');

      await audioSub.cancel();
      await mainSub.cancel();
      await audioWs.sink.close();
      await mainWs.sink.close();
      out.close();
    },
    timeout: Timeout(Duration(minutes: 25)),
  );
}
