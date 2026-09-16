import 'dart:async';

import 'package:flutter/services.dart';

/// The App Attest + APNs registration surface bridged from iOS.
///
/// Swift side lives in mobile/ios/Runner/PushAttestPlugin.swift; the channel
/// name is `buzz/push_attest`. Every method returns typed errors (code
/// prefix `push_attest/`) rather than throwing platform exceptions raw, so
/// callers can branch on the failure the way the enrollment flow does.
abstract class PushAttestApi {
  /// Requests alert/sound/badge notification authorization and registers for
  /// remote notifications. Completes when authorization resolves; the APNs
  /// token (if granted) arrives asynchronously via [tokenStream].
  Future<void> requestAuthorizationAndRegister();

  /// The current APNs device token as lowercase hex, or null if none has
  /// been delivered yet.
  Future<String?> apnsToken();

  /// Whether this device+build supports App Attest (DCAppAttestService).
  /// Simulators and unsupported hardware report false; enrollment treats
  /// that as a terminal, user-visible condition rather than retrying.
  Future<bool> isSupported();

  /// Generates a new App Attest key; returns its base64 key id.
  Future<String> generateKey();

  /// Attests [keyId] against the sha256 of the enrollment transcript.
  /// [clientDataHash] is the raw 32-byte digest. Returns base64 attestation.
  Future<String> attest(String keyId, List<int> clientDataHash);

  /// Produces a base64 assertion over the sha256 of a delegation transcript.
  /// Apple's API takes no challenge: the gateway binds its challenge through
  /// the transcript hash the device signs.
  Future<String> assertKey(String keyId, List<int> clientDataHash);
}

class PushAttestChannel implements PushAttestApi {
  PushAttestChannel({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('buzz/push_attest') {
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  final MethodChannel _channel;
  final StreamController<String> _tokenController = StreamController<String>.broadcast();

  /// Emits the APNs token hex each time iOS delivers one (registration can
  /// refresh tokens, so this is a stream, not a one-shot future).
  Stream<String> get tokenStream => _tokenController.stream;

  Future<dynamic> _handleNativeCall(MethodCall call) async {
    if (call.method == 'apnsToken') {
      final token = call.arguments as String?;
      if (token != null && token.isNotEmpty) {
        _tokenController.add(token);
      }
    }
    return null;
  }

  @override
  Future<void> requestAuthorizationAndRegister() async {
    await _guard(() => _channel.invokeMethod<void>('requestAuthorizationAndRegister'));
  }

  @override
  Future<String?> apnsToken() async {
    return _guard(() => _channel.invokeMethod<String>('apnsToken'));
  }

  @override
  Future<bool> isSupported() async {
    final bool? supported = await _guard(() => _channel.invokeMethod<bool>('isSupported'));
    return supported ?? false;
  }

  @override
  Future<String> generateKey() async {
    return _requireString(
      await _guard(() => _channel.invokeMethod<String>('generateKey')),
      'generateKey',
    );
  }

  @override
  Future<String> attest(String keyId, List<int> clientDataHash) async {
    return _requireString(
      await _guard(
        () => _channel.invokeMethod<String>('attest', {
          'keyId': keyId,
          'clientDataHash': clientDataHash,
        }),
      ),
      'attest',
    );
  }

  @override
  Future<String> assertKey(String keyId, List<int> clientDataHash) async {
    return _requireString(
      await _guard(
        () => _channel.invokeMethod<String>('assertKey', {
          'keyId': keyId,
          'clientDataHash': clientDataHash,
        }),
      ),
      'assertKey',
    );
  }

  String _requireString(String? value, String method) {
    if (value == null || value.isEmpty) {
      throw PushAttestException('null_response', '$method returned no value');
    }
    return value;
  }

  /// Normalizes platform errors into [PushAttestException] with the native
  /// error code preserved (e.g. `unsupported`, `attestation_failed`).
  Future<T?> _guard<T>(Future<T?> Function() body) async {
    try {
      return await body();
    } on PlatformException catch (e) {
      throw PushAttestException(e.code, e.message ?? 'unknown push attest failure');
    }
  }
}

class PushAttestException implements Exception {
  PushAttestException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'PushAttestException($code): $message';
}
