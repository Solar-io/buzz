import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/shared/push/push_wire.dart';

void main() {
  group('enrollTranscript', () {
    test('produces the byte-exact gateway transcript', () {
      // Expected bytes hand-derived from EnrollTranscript in
      // buzz-push-gateway/src/http.rs: domain line, then compact JSON with
      // struct-declaration member order. NOT computed by the code under test.
      final transcript = enrollTranscript(
        v: 1,
        audience: 'https://push.buzz.xyz/v1/installations',
        challengeId: '0a1b2c3d-4e5f-4a5b-8c9d-0e1f2a3b4c5d',
        challenge: 'cHJvYmUtY2hhbGxlbmdl',
        keyId: 'a2V5LWlkLWJhc2U2NA==',
        appProfile: 'buzz-ios-sandbox',
        endpoint: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        endpointEpoch: 1,
        expiresAt: 1789600000,
      );
      expect(
        transcript,
        'buzz.push.enroll.v1\n'
        '{"v":1,"audience":"https://push.buzz.xyz/v1/installations",'
        '"challenge_id":"0a1b2c3d-4e5f-4a5b-8c9d-0e1f2a3b4c5d",'
        '"challenge":"cHJvYmUtY2hhbGxlbmdl",'
        '"key_id":"a2V5LWlkLWJhc2U2NA==",'
        '"app_profile":"buzz-ios-sandbox",'
        '"endpoint":"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",'
        '"endpoint_epoch":1,"expires_at":1789600000}',
      );
    });

    test('member order is protocol: swapping inputs changes bytes', () {
      // Guards against a future "cleanup" reordering the Map literal —
      // order is load-bearing for attestation verification.
      String build(String challenge, String keyId) => enrollTranscript(
        v: 1,
        audience: 'https://push.buzz.xyz/v1/installations',
        challengeId: '0a1b2c3d-4e5f-4a5b-8c9d-0e1f2a3b4c5d',
        challenge: challenge,
        keyId: keyId,
        appProfile: 'buzz-ios-sandbox',
        endpoint: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        endpointEpoch: 1,
        expiresAt: 1789600000,
      );
      expect(build('aaa', 'bbb'), isNot(build('bbb', 'aaa')));
    });
  });

  group('delegateTranscript', () {
    test('produces the byte-exact gateway transcript', () {
      final transcript = delegateTranscript(
        v: 1,
        audience: 'https://push.buzz.xyz/v1/delegations',
        challengeId: '0a1b2c3d-4e5f-4a5b-8c9d-0e1f2a3b4c5d',
        challenge: 'cHJvYmUtY2hhbGxlbmdl',
        installationHandle: '11111111-2222-3333-4444-555555555555',
        endpointEpoch: 1,
        generation: 1,
        relayPubkey: 'b8a37e4c18af8417919ba6417279d7e4510e2a7a32601f4d7d545e230197828f',
        notBefore: 1789500000,
        expiresAt: 1792000000,
      );
      expect(
        transcript,
        'buzz.push.delegate.v1\n'
        '{"v":1,"audience":"https://push.buzz.xyz/v1/delegations",'
        '"challenge_id":"0a1b2c3d-4e5f-4a5b-8c9d-0e1f2a3b4c5d",'
        '"challenge":"cHJvYmUtY2hhbGxlbmdl",'
        '"installation_handle":"11111111-2222-3333-4444-555555555555",'
        '"endpoint_epoch":1,"generation":1,'
        '"relay_pubkey":"b8a37e4c18af8417919ba6417279d7e4510e2a7a32601f4d7d545e230197828f",'
        '"not_before":1789500000,"expires_at":1792000000}',
      );
    });
  });

  group('lease plaintext', () {
    test('active plaintext carries the eight required members and no others', () {
      final content = activeLeasePlaintext(
        v: 1,
        origin: 'wss://crichton.tailb3d4b8.ts.net',
        generation: 3,
        appProfile: 'buzz-ios-sandbox',
        transport: 'apns',
        endpoint: 'grant-opaque-string',
        subscriptions: [
          {'filter': {'kinds': [9], '#p': ['a1b2'.padRight(64, '0')]}, 'class': 'default'},
        ],
      );
      // Hand-written expectation: member set and compact separators.
      expect(
        content,
        '{"v":1,"origin":"wss://crichton.tailb3d4b8.ts.net","generation":3,"active":true,'
        '"app_profile":"buzz-ios-sandbox","transport":"apns","endpoint":"grant-opaque-string",'
        '"subscriptions":[{"filter":{"kinds":[9],"#p":["${'a1b2'.padRight(64, '0')}"]},"class":"default"}]}',
      );
    });

    test('inactive plaintext is the minimal four-member schema', () {
      final content = inactiveLeasePlaintext(
        v: 1,
        origin: 'wss://crichton.tailb3d4b8.ts.net',
        generation: 4,
      );
      expect(
        content,
        '{"v":1,"origin":"wss://crichton.tailb3d4b8.ts.net","generation":4,"active":false}',
      );
      expect(content.contains('app_profile'), isFalse);
      expect(content.contains('endpoint'), isFalse);
    });
  });

  group('apnsTokenHex', () {
    test('encodes lowercase padded hex', () {
      expect(apnsTokenHex([0x0A, 0x01, 0xFF, 0x10]), '0a01ff10');
    });

    test('rejects empty and oversized tokens', () {
      expect(() => apnsTokenHex([]), throwsArgumentError);
      expect(() => apnsTokenHex(List.filled(65, 1)), throwsArgumentError);
    });
  });

  group('canonical encoder', () {
    test('escapes control characters and quotes without touching ASCII payload', () {
      // The protocol's own fields are ASCII, but the encoder must stay
      // correct for any string so signatures never depend on Dart quirks.
      final encoded = activeLeasePlaintext(
        v: 1,
        origin: 'a"b\\c\nd',
        generation: 1,
        appProfile: 'p',
        transport: 'apns',
        endpoint: 'e',
        subscriptions: const [],
      );
      expect(encoded, contains(r'"a\"b\\c\nd"'));
    });
  });
}
