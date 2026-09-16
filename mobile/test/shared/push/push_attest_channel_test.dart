
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/shared/push/push_attest_channel.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // The Swift side casts clientDataHash with `as? FlutterStandardTypedData`.
  // Over the standard codec that means the value must ENCODE as a typed
  // byte array, which on the Dart side requires Uint8List — a plain
  // List<int> encodes as a number array and the cast fails on hardware.
  // These tests decode the real codec output, the same decode a mock
  // handler sees, so they fail if the channel ever regresses to List<int>.
  group('clientDataHash codec', () {
    Future<Object?> captureArg(String method) async {
      Object? received;
      final channel = const MethodChannel('buzz/push_attest');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            if (call.method == method) {
              received = (call.arguments as Map)['clientDataHash'];
            }
            return 'ok';
          });
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      });

      final api = PushAttestChannel(channel: channel);
      const hash = [1, 2, 3, 255, 0, 128];
      switch (method) {
        case 'attest':
          await api.attest('key-id', hash);
        case 'assertKey':
          await api.assertKey('key-id', hash);
      }
      return received;
    }

    test('attest sends clientDataHash as Uint8List across the codec', () async {
      final received = await captureArg('attest');
      expect(received, isA<Uint8List>());
      expect(received, [1, 2, 3, 255, 0, 128]);
    });

    test('assertKey sends clientDataHash as Uint8List across the codec', () async {
      final received = await captureArg('assertKey');
      expect(received, isA<Uint8List>());
      expect(received, [1, 2, 3, 255, 0, 128]);
    });
  });

  group('typed errors', () {
    test('platform exceptions surface as PushAttestException with code', () async {
      final channel = const MethodChannel('buzz/push_attest');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            throw PlatformException(code: 'attestation_failed', message: 'nope');
          });
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      });
      final api = PushAttestChannel(channel: channel);
      await expectLater(
        api.generateKey(),
        throwsA(
          isA<PushAttestException>()
              .having((e) => e.code, 'code', 'attestation_failed')
              .having((e) => e.message, 'message', 'nope'),
        ),
      );
    });

    test('empty responses are typed null_response errors', () async {
      final channel = const MethodChannel('buzz/push_attest');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async => '');
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      });
      final api = PushAttestChannel(channel: channel);
      await expectLater(
        api.generateKey(),
        throwsA(
          isA<PushAttestException>().having((e) => e.code, 'code', 'null_response'),
        ),
      );
    });
  });

  test('native apnsToken pushes arrive on the token stream', () async {
    final channel = const MethodChannel('buzz/push_attest');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'apnsToken') return null;
          return null;
        });
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });
    final api = PushAttestChannel(channel: channel);
    final tokens = <String>[];
    api.tokenStream.listen(tokens.add);

    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final data = const StandardMethodCodec()
        .encodeMethodCall(const MethodCall('apnsToken', 'aabb'));
    await messenger.handlePlatformMessage('buzz/push_attest', data, (_) {});

    expect(tokens, ['aabb']);
    expect(await api.apnsToken(), isNull); // push-only cache lives in Swift
  });
}
