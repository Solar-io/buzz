import 'dart:convert';

import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/shared/push/push_attest_channel.dart';
import 'package:buzz/shared/push/push_enrollment_service.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http;

// Fixed protocol values the fakes return; every hand-written transcript
// literal below is fully determined by them plus fixedNow.
const fixedNowMillis = 1789574400000; // 2026-09-16T16:00:00Z
const fixedNowSeconds = fixedNowMillis ~/ 1000;
const tokenHex =
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const keyIdB64 = 'a2V5LWlkLWJhc2U2NA==';
const attestationB64 = 'YXR0ZXN0YXRpb24tY2Jvcg==';
const assertionB64 = 'YXNzZXJ0aW9uLWNib3I=';
const enrollChallenge = 'cHJvYmUtY2hhbGxlbmdl';
const enrollChallengeId = '0a1b2c3d-4e5f-4a5b-8c9d-0e1f2a3b4c5d';
const delegateChallenge = 'ZGVsZWdhdGUtY2hhbGxlbmdl';
const delegateChallengeId = '11111111-2222-3333-4444-555555555555';
const installationHandle = '99999999-8888-7777-6666-555555555555';
const endpointGrant = 'Z3JhbnQtb3BhcXVlLXRva2Vu';
const userPubkey = 'b8a37e4c18af8417919ba6417279d7e4510e2a7a32601f4d7d545e230197828f';

const nip11Descriptor = {
  'origin': 'wss://relay.test',
  'keys': [
    {'id': 'exec-key-1', 'pubkey': userPubkey, 'current': true},
  ],
  'app_profiles': [
    {'id': 'buzz-ios-production', 'transport': 'apns'},
    {'id': 'buzz-ios-sandbox', 'transport': 'apns'},
  ],
  'push_kinds': [7, 9, 1059, 40007, 46010],
  'urgent_kinds': <int>[],
  'class_support': {'apns': ['silent', 'default', 'time_sensitive']},
  'limitation': {'max_lease_ttl': 2592000},
};

/// Hand-written enroll transcript for the fixed values above — derived from
/// the Rust EnrollTranscript member order, not from push_wire.dart.
const expectedEnrollTranscript =
    'buzz.push.enroll.v1\n'
    '{"v":1,"audience":"https://push.buzz.xyz/v1/installations",'
    '"challenge_id":"$enrollChallengeId",'
    '"challenge":"$enrollChallenge",'
    '"key_id":"$keyIdB64",'
    '"app_profile":"buzz-ios-sandbox",'
    '"endpoint":"$tokenHex",'
    '"endpoint_epoch":1,'
    '"expires_at":${fixedNowSeconds + 2592000}}';

const expectedDelegateTranscript =
    'buzz.push.delegate.v1\n'
    '{"v":1,"audience":"https://push.buzz.xyz/v1/delegations",'
    '"challenge_id":"$delegateChallengeId",'
    '"challenge":"$delegateChallenge",'
    '"installation_handle":"$installationHandle",'
    '"endpoint_epoch":1,'
    '"generation":1,'
    '"relay_pubkey":"$userPubkey",'
    '"not_before":$fixedNowSeconds,'
    '"expires_at":${fixedNowSeconds + 2592000}}';

List<int> sha256Bytes(String input) => crypto.sha256.convert(utf8.encode(input)).bytes;

class FakeAttest implements PushAttestApi {
  final List<List<int>> attestHashes = [];
  final List<List<int>> assertHashes = [];
  bool supported = true;
  String? token = tokenHex;

  @override
  Future<String> attest(String keyId, List<int> clientDataHash) async {
    attestHashes.add(clientDataHash);
    return attestationB64;
  }

  @override
  Future<String> assertKey(String keyId, List<int> clientDataHash) async {
    assertHashes.add(clientDataHash);
    return assertionB64;
  }

  @override
  Future<String> generateKey() async => keyIdB64;

  @override
  Future<String?> apnsToken() async => token;

  @override
  Future<bool> isSupported() async => supported;

  @override
  Future<void> requestAuthorizationAndRegister() async {}
}

class RecordedLease {
  RecordedLease(this.kind, this.content, this.tags);
  final int kind;
  final String content;
  final List<List<String>> tags;
}

void main() {
  test('enable drives the full protocol with byte-exact transcript hashes', () async {
    final attest = FakeAttest();
    final leases = <RecordedLease>[];
    PushLeaseState? stored;
    Map<String, dynamic>? enrollBody;
    Map<String, dynamic>? delegateBody;

    var challengeCall = 0;
    final client = http.MockClient((request) async {
      if (request.url.path == '/info') {
        return http.Response(jsonEncode({'push': nip11Descriptor}), 200);
      }
      if (request.url.path == '/v1/installations/challenges') {
        expect(request.method, 'POST');
        expect(request.body, '{"v":1}');
        challengeCall += 1;
        final id = challengeCall == 1 ? enrollChallengeId : delegateChallengeId;
        final value = challengeCall == 1 ? enrollChallenge : delegateChallenge;
        return http.Response(
          jsonEncode({
            'challenge_id': id,
            'challenge': value,
            'expires_at': fixedNowSeconds + 300,
          }),
          200,
        );
      }
      if (request.url.path == '/v1/installations') {
        enrollBody = jsonDecode(request.body) as Map<String, dynamic>;
        // The hash the hardware would sign must cover exactly the bytes the
        // gateway reconstructs server-side.
        expect(attest.attestHashes.single, sha256Bytes(expectedEnrollTranscript));
        return http.Response(
          jsonEncode({
            'installation_handle': installationHandle,
            'endpoint_epoch': 1,
            'expires_at': fixedNowSeconds + 2592000,
          }),
          201,
        );
      }
      if (request.url.path == '/v1/delegations') {
        delegateBody = jsonDecode(request.body) as Map<String, dynamic>;
        expect(attest.assertHashes.single, sha256Bytes(expectedDelegateTranscript));
        return http.Response(jsonEncode({'endpoint_grant': endpointGrant}), 201);
      }
      fail('unexpected gateway request: ${request.url.path}');
    });

    final service = PushEnrollmentService(
      relayHttpOrigin: 'https://relay.test',
      gatewayBaseUrl: 'https://relay.test',
      attest: attest,
      publish: ({required kind, required content, required tags}) async {
        leases.add(RecordedLease(kind, content, tags));
      },
      readLeaseState: () async => stored,
      writeLeaseState: (state) async => stored = state,
      httpClient: client,
      now: () => DateTime.fromMillisecondsSinceEpoch(fixedNowMillis),
    );

    final result = await service.enable(userPubkey: userPubkey);

    // Enrollment request shape.
    expect(enrollBody, {
      'v': 1,
      'challenge_id': enrollChallengeId,
      'challenge': enrollChallenge,
      'key_id': keyIdB64,
      'attestation': attestationB64,
      'app_profile': 'buzz-ios-sandbox',
      'endpoint': tokenHex,
      'endpoint_epoch': 1,
      'expires_at': fixedNowSeconds + 2592000,
    });
    expect(delegateBody, {
      'v': 1,
      'challenge_id': delegateChallengeId,
      'challenge': delegateChallenge,
      'installation_handle': installationHandle,
      'endpoint_epoch': 1,
      'generation': 1,
      'relay_pubkey': userPubkey,
      'not_before': fixedNowSeconds,
      'expires_at': fixedNowSeconds + 2592000,
      'assertion': assertionB64,
    });

    // Lease event shape.
    expect(leases.single.kind, 30350);
    final content = jsonDecode(leases.single.content) as Map<String, dynamic>;
    expect(content['active'], true);
    expect(content['origin'], 'wss://relay.test');
    expect(content['generation'], 1);
    expect(content['app_profile'], 'buzz-ios-sandbox');
    expect(content['transport'], 'apns');
    expect(content['endpoint'], endpointGrant);
    final subscription = (content['subscriptions'] as List).single as Map<String, dynamic>;
    expect(subscription['class'], 'default');
    expect((subscription['filter'] as Map<String, dynamic>)['#p'], [userPubkey]);
    expect((subscription['filter'] as Map<String, dynamic>)['kinds'], [9]);
    final tagMap = {
      for (final tag in leases.single.tags) tag[0]: tag[1],
    };
    expect(tagMap['d'], installationHandle);
    expect(tagMap['exec'], 'exec-key-1');
    expect(int.parse(tagMap['expiration']!), fixedNowSeconds + 2592000);

    // Durable state written for the next enable/disable.
    expect(stored?.generation, 1);
    expect(stored?.installationHandle, installationHandle);
    expect(result.endpointGrant, endpointGrant);
  });

  test('challenge rotation between enroll and delegate is honored', () async {
    // The gateway issues a DIFFERENT challenge for the delegation leg; the
    // service must not reuse the enrollment challenge.
    final attest = FakeAttest();
    var challengeCall = 0;
    final client = http.MockClient((request) async {
      if (request.url.path == '/info') {
        return http.Response(jsonEncode({'push': nip11Descriptor}), 200);
      }
      if (request.url.path == '/v1/installations/challenges') {
        challengeCall += 1;
        final id = challengeCall == 1 ? enrollChallengeId : delegateChallengeId;
        final value = challengeCall == 1 ? enrollChallenge : delegateChallenge;
        return http.Response(
          jsonEncode({'challenge_id': id, 'challenge': value, 'expires_at': fixedNowSeconds + 300}),
          200,
        );
      }
      if (request.url.path == '/v1/installations') {
        return http.Response(
          jsonEncode({'installation_handle': installationHandle, 'endpoint_epoch': 1, 'expires_at': 0}),
          201,
        );
      }
      if (request.url.path == '/v1/delegations') {
        return http.Response(jsonEncode({'endpoint_grant': endpointGrant}), 201);
      }
      fail('unexpected request');
    });

    final service = PushEnrollmentService(
      relayHttpOrigin: 'https://relay.test',
      gatewayBaseUrl: 'https://relay.test',
      attest: attest,
      publish: ({required kind, required content, required tags}) async {},
      readLeaseState: () async => null,
      writeLeaseState: (_) async {},
      httpClient: client,
      now: () => DateTime.fromMillisecondsSinceEpoch(fixedNowMillis),
    );
    await service.enable(userPubkey: userPubkey);
    expect(challengeCall, 2);
    // The delegate transcript hash carries the second challenge, proving the
    // fresh challenge reached the signed bytes.
    expect(attest.assertHashes.single, sha256Bytes(expectedDelegateTranscript));
  });

  test('enable surfaces gateway rejections without publishing a lease', () async {
    final attest = FakeAttest();
    var published = 0;
    final client = http.MockClient((request) async {
      if (request.url.path == '/info') {
        return http.Response(jsonEncode({'push': nip11Descriptor}), 200);
      }
      if (request.url.path == '/v1/installations/challenges') {
        return http.Response(
          jsonEncode({'challenge_id': enrollChallengeId, 'challenge': enrollChallenge, 'expires_at': 0}),
          200,
        );
      }
      // The hardware-only rejection the simulator path will hit Thursday.
      return http.Response(jsonEncode({'error': 'invalid_attestation'}), 401);
    });

    final service = PushEnrollmentService(
      relayHttpOrigin: 'https://relay.test',
      gatewayBaseUrl: 'https://relay.test',
      attest: attest,
      publish: ({required kind, required content, required tags}) async {
        published += 1;
      },
      readLeaseState: () async => null,
      writeLeaseState: (_) async {},
      httpClient: client,
      now: () => DateTime.fromMillisecondsSinceEpoch(fixedNowMillis),
    );

    await expectLater(
      service.enable(userPubkey: userPubkey),
      throwsA(
        isA<PushEnrollmentException>().having((e) => e.code, 'code', 'invalid_attestation'),
      ),
    );
    expect(published, 0);
  });

  test('disable republishes the same installation address at watermark+1', () async {
    final leases = <RecordedLease>[];
    PushLeaseState? stored = PushLeaseState(generation: 3, installationHandle: installationHandle);
    final client = http.MockClient((request) async {
      expect(request.url.path, '/info');
      return http.Response(jsonEncode({'push': nip11Descriptor}), 200);
    });

    final service = PushEnrollmentService(
      relayHttpOrigin: 'https://relay.test',
      gatewayBaseUrl: 'https://relay.test',
      attest: FakeAttest(),
      publish: ({required kind, required content, required tags}) async {
        leases.add(RecordedLease(kind, content, tags));
      },
      readLeaseState: () async => stored,
      writeLeaseState: (state) async => stored = state,
      httpClient: client,
      now: () => DateTime.fromMillisecondsSinceEpoch(fixedNowMillis),
    );

    await service.disable();

    final lease = leases.single;
    expect(lease.kind, 30350);
    final content = jsonDecode(lease.content) as Map<String, dynamic>;
    expect(content['active'], false);
    expect(content['generation'], 4);
    // Minimal schema: relay rejects any optional member on inactive leases.
    expect(content.containsKey('app_profile'), isFalse);
    expect(content.containsKey('transport'), isFalse);
    expect(content.containsKey('endpoint'), isFalse);
    expect(content.containsKey('subscriptions'), isFalse);
    final tagMap = {for (final tag in lease.tags) tag[0]: tag[1]};
    expect(tagMap['d'], installationHandle);
    expect(stored?.generation, 4);
  });

  test('disable with no prior lease state publishes nothing', () async {
    var published = 0;
    final client = http.MockClient((request) async {
      return http.Response(jsonEncode({'push': nip11Descriptor}), 200);
    });
    final service = PushEnrollmentService(
      relayHttpOrigin: 'https://relay.test',
      gatewayBaseUrl: 'https://relay.test',
      attest: FakeAttest(),
      publish: ({required kind, required content, required tags}) async {
        published += 1;
      },
      readLeaseState: () async => null,
      writeLeaseState: (_) async {},
      httpClient: client,
    );
    await service.disable();
    expect(published, 0);
  });

  test('relay without a push descriptor is a typed failure', () async {
    final client = http.MockClient(
      (request) async => http.Response(jsonEncode({'name': 'no push here'}), 200),
    );
    final service = PushEnrollmentService(
      relayHttpOrigin: 'https://relay.test',
      gatewayBaseUrl: 'https://relay.test',
      attest: FakeAttest(),
      publish: ({required kind, required content, required tags}) async {},
      readLeaseState: () async => null,
      writeLeaseState: (_) async {},
      httpClient: client,
    );
    await expectLater(
      service.enable(userPubkey: userPubkey),
      throwsA(
        isA<PushEnrollmentException>().having((e) => e.code, 'code', 'relay_push_unsupported'),
      ),
    );
  });
}
