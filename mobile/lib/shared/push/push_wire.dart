// Wire encoding for the D-029 native push enrollment protocol.
//
// The gateway (crates/buzz-push-gateway) verifies App Attest artifacts
// against a byte-exact transcript string, and the relay
// (handlers/push_lease.rs) parses lease plaintext with duplicate-key and
// unknown-field rejection. Both sides are strict, so the encoders here are
// deterministic: fixed field order matching the Rust struct declarations,
// compact JSON separators, and no optional fields on the wire.
//
// Transcript layout is `"<domain>\n<compact json>"` where the JSON member
// order equals the Rust struct field order in http.rs (serde_json preserves
// declaration order on serialize). Any reordering changes the bytes and
// invalidates the attestation, so the order in the Map literals below is
// protocol, not style.

/// Builds the enrollment transcript signed by Apple's `attestKey`.
///
/// Domain `buzz.push.enroll.v1`; members follow `EnrollTranscript` in
/// buzz-push-gateway/src/http.rs.
String enrollTranscript({
  required int v,
  required String audience,
  required String challengeId,
  required String challenge,
  required String keyId,
  required String appProfile,
  required String endpoint,
  required int endpointEpoch,
  required int expiresAt,
}) {
  final json = {
    'v': v,
    'audience': audience,
    'challenge_id': challengeId,
    'challenge': challenge,
    'key_id': keyId,
    'app_profile': appProfile,
    'endpoint': endpoint,
    'endpoint_epoch': endpointEpoch,
    'expires_at': expiresAt,
  };
  return _transcript('buzz.push.enroll.v1', json);
}

/// Builds the delegation transcript signed by Apple's `generateAssertion`.
///
/// Domain `buzz.push.delegate.v1`; members follow `DelegateTranscript` in
/// buzz-push-gateway/src/http.rs.
String delegateTranscript({
  required int v,
  required String audience,
  required String challengeId,
  required String challenge,
  required String installationHandle,
  required int endpointEpoch,
  required int generation,
  required String relayPubkey,
  required int notBefore,
  required int expiresAt,
}) {
  final json = {
    'v': v,
    'audience': audience,
    'challenge_id': challengeId,
    'challenge': challenge,
    'installation_handle': installationHandle,
    'endpoint_epoch': endpointEpoch,
    'generation': generation,
    'relay_pubkey': relayPubkey,
    'not_before': notBefore,
    'expires_at': expiresAt,
  };
  return _transcript('buzz.push.delegate.v1', json);
}

String _transcript(String domain, Map<String, Object?> json) {
  return '$domain\n${_encode(json)}';
}

/// Builds the kind:30350 lease event content for an active lease.
///
/// Schema per `LeasePlaintext` in buzz-relay/src/handlers/push_lease.rs:
/// exactly these members, no extras; `endpoint` carries the opaque
/// endpoint_grant string minted by the gateway, never the raw APNs token.
String activeLeasePlaintext({
  required int v,
  required String origin,
  required int generation,
  required String appProfile,
  required String transport,
  required String endpoint,
  required List<Map<String, Object?>> subscriptions,
}) {
  return _encode({
    'v': v,
    'origin': origin,
    'generation': generation,
    'active': true,
    'app_profile': appProfile,
    'transport': transport,
    'endpoint': endpoint,
    'subscriptions': subscriptions,
  });
}

/// Builds the minimal kind:30350 deactivation content.
///
/// Inactive leases must omit every optional member (validate_plaintext
/// rejects `app_profile`/`transport`/`endpoint`/`subscriptions` when
/// `active` is false).
String inactiveLeasePlaintext({
  required int v,
  required String origin,
  required int generation,
}) {
  return _encode({'v': v, 'origin': origin, 'generation': generation, 'active': false});
}

/// Canonical compact JSON. [Object.encode] produces the same bytes as
/// serde_json's compact formatter for the value shapes this protocol uses
/// (ASCII strings, integers, booleans, nested maps/lists).
String _encode(Object? value) {
  final buffer = StringBuffer();
  _write(value, buffer);
  return buffer.toString();
}

void _write(Object? value, StringBuffer buffer) {
  switch (value) {
    case null:
      buffer.write('null');
    case bool():
      buffer.write(value ? 'true' : 'false');
    case int():
      buffer.write(value.toString());
    case String():
      _writeString(value, buffer);
    case List():
      buffer.write('[');
      for (var i = 0; i < value.length; i++) {
        if (i > 0) buffer.write(',');
        _write(value[i], buffer);
      }
      buffer.write(']');
    case Map():
      buffer.write('{');
      var first = true;
      value.forEach((key, val) {
        if (!first) buffer.write(',');
        first = false;
        _writeString(key.toString(), buffer);
        buffer.write(':');
        _write(val, buffer);
      });
      buffer.write('}');
    default:
      throw ArgumentError('Unsupported JSON value: ${value.runtimeType}');
  }
}

const _jsonEscapeMap = {'"': r'\"', '\\': r'\\', '\b': r'\b', '\f': r'\f', '\n': r'\n', '\r': r'\r', '\t': r'\t'};

void _writeString(String value, StringBuffer buffer) {
  buffer.write('"');
  for (final codeUnit in value.codeUnits) {
    final escaped = _jsonEscapeMap[String.fromCharCode(codeUnit)];
    if (escaped != null) {
      buffer.write(escaped);
    } else if (codeUnit < 0x20) {
      buffer.write(r'\u');
      buffer.write(codeUnit.toRadixString(16).padLeft(4, '0'));
    } else {
      buffer.writeCharCode(codeUnit);
    }
  }
  buffer.write('"');
}

/// Encodes the raw APNs device token bytes as the lowercase hex string the
/// gateway expects in `endpoint` (valid_endpoint demands lowercase hex,
/// even length, at most 64 bytes).
String apnsTokenHex(List<int> deviceToken) {
  if (deviceToken.isEmpty || deviceToken.length > 64) {
    throw ArgumentError('APNs token must be 1..64 bytes, got ${deviceToken.length}');
  }
  final buffer = StringBuffer();
  for (final byte in deviceToken) {
    buffer.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return buffer.toString();
}
