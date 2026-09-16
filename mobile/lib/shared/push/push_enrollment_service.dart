import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart' as crypto;
import 'package:http/http.dart' as http;

import 'push_attest_channel.dart';
import 'push_wire.dart';

/// Drives the D-029 native push enrollment:
///
///   1. NIP-11 discovery on the relay (`/info`) — origin, executor key id,
///      relay pubkey, app profiles, class support, limits.
///   2. Gateway enrollment: challenge -> App Attest key -> attest the
///      byte-exact enroll transcript -> POST /v1/installations.
///   3. Gateway delegation: fresh challenge -> assert the delegate
///      transcript -> POST /v1/delegations -> opaque endpoint grant.
///   4. Relay lease: publish signed kind:30350 whose content carries the
///      grant plus the mention subscriptions the matcher evaluates.
///
/// Every remote call and the publisher are injectable; the service holds no
/// global state besides the generation watermark accessor it is given.
class PushEnrollmentService {
  PushEnrollmentService({
    required this.relayHttpOrigin,
    required this.gatewayBaseUrl,
    required this.attest,
    required this.publish,
    required this.readLeaseState,
    required this.writeLeaseState,
    http.Client? httpClient,
    DateTime Function()? now,
  }) : _httpClient = httpClient ?? http.Client(),
       _now = now ?? DateTime.now;

  /// HTTPS origin of the relay (scheme-swapped from its ws URL), used for
  /// the NIP-11 `/info` fetch.
  final String relayHttpOrigin;

  /// Base URL of the self-hosted buzz-push-gateway.
  final String gatewayBaseUrl;

  final PushAttestApi attest;

  /// Publishes a signed event on the relay ws session; signature matches
  /// SignedEventRelay.submit so the real one binds directly.
  final Future<void> Function({
    required int kind,
    required String content,
    required List<List<String>> tags,
  })
  publish;

  /// Durable lease state (identity-scoped prefs): the generation watermark
  /// every publish must exceed, and the installation address the active
  /// lease lives at. Deactivation reuses the same address — a fresh d-tag
  /// would create a second lease and leave the active one standing.
  final Future<PushLeaseState?> Function() readLeaseState;
  final Future<void> Function(PushLeaseState state) writeLeaseState;

  final http.Client _httpClient;
  final DateTime Function() _now;

  static const wireVersion = 1;
  static const leaseKind = 30350;

  /// NIP-11 audience strings are fixed by the gateway protocol.
  static const _installationsAudience = 'https://push.buzz.xyz/v1/installations';
  static const _delegationsAudience = 'https://push.buzz.xyz/v1/delegations';

  /// Discover the relay's push descriptor. Returns null when the relay
  /// advertises no push support (descriptor absent from NIP-11).
  Future<PushDescriptor?> discover() async {
    final response = await _httpClient
        .get(Uri.parse('$relayHttpOrigin/info'), headers: {'accept': 'application/json'})
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) return null;
    final document = jsonDecode(response.body) as Map<String, dynamic>;
    final descriptor = document['push'] as Map<String, dynamic>?;
    if (descriptor == null) return null;
    return PushDescriptor.fromJson(descriptor);
  }

  /// End-to-end enable: authorization + token, then the three protocol
  /// legs. [subscriptions] defaults to a mention subscription for
  /// [userPubkey] (kind 9 messages p-tagging the user), which is the
  /// Friday-gate demo shape.
  Future<EnrollmentResult> enable({
    required String userPubkey,
    String? appProfile,
    List<Map<String, Object?>>? subscriptions,
  }) async {
    final descriptor = await discover();
    if (descriptor == null) {
      throw const PushEnrollmentException('relay_push_unsupported', 'relay publishes no push descriptor');
    }
    final profile = appProfile ?? defaultAppProfile();
    if (!descriptor.supportsProfile(profile)) {
      throw PushEnrollmentException(
        'app_profile_not_supported',
        'relay does not advertise app profile $profile',
      );
    }

    await attest.requestAuthorizationAndRegister();
    final token = await attest.apnsToken();
    if (token == null || token.isEmpty) {
      throw const PushEnrollmentException('no_apns_token', 'APNs registration produced no token');
    }
    if (!await attest.isSupported()) {
      throw const PushEnrollmentException(
        'app_attest_unsupported',
        'device does not support App Attest; enrollment impossible',
      );
    }

    final now = _now().millisecondsSinceEpoch ~/ 1000;
    final installationTtl = _boundedTtl(descriptor.maxLeaseTtl);
    final grantTtl = _boundedTtl(descriptor.maxLeaseTtl);

    // Leg 2: install this device.
    final challenge = await _fetchChallenge();
    final keyId = await attest.generateKey();
    final enrollTranscriptText = enrollTranscript(
      v: wireVersion,
      audience: _installationsAudience,
      challengeId: challenge.id,
      challenge: challenge.value,
      keyId: keyId,
      appProfile: profile,
      endpoint: token,
      endpointEpoch: 1,
      expiresAt: now + installationTtl,
    );
    final attestation = await attest.attest(keyId, _sha256Bytes(enrollTranscriptText));
    final installation = await _postJson(
      '/v1/installations',
      {
        'v': wireVersion,
        'challenge_id': challenge.id,
        'challenge': challenge.value,
        'key_id': keyId,
        'attestation': attestation,
        'app_profile': profile,
        'endpoint': token,
        'endpoint_epoch': 1,
        'expires_at': now + installationTtl,
      },
    );
    final installationHandle = installation['installation_handle'] as String;

    // Leg 3: delegate delivery authority for this relay.
    final delegateChallenge = await _fetchChallenge();
    final delegateTranscriptText = delegateTranscript(
      v: wireVersion,
      audience: _delegationsAudience,
      challengeId: delegateChallenge.id,
      challenge: delegateChallenge.value,
      installationHandle: installationHandle,
      endpointEpoch: 1,
      generation: 1,
      relayPubkey: descriptor.relayPubkey,
      notBefore: now,
      expiresAt: now + grantTtl,
    );
    final assertion = await attest.assertKey(keyId, _sha256Bytes(delegateTranscriptText));
    final delegation = await _postJson(
      '/v1/delegations',
      {
        'v': wireVersion,
        'challenge_id': delegateChallenge.id,
        'challenge': delegateChallenge.value,
        'installation_handle': installationHandle,
        'endpoint_epoch': 1,
        'generation': 1,
        'relay_pubkey': descriptor.relayPubkey,
        'not_before': now,
        'expires_at': now + grantTtl,
        'assertion': assertion,
      },
    );
    final endpointGrant = delegation['endpoint_grant'] as String;

    // Leg 4: publish the active lease binding grant + subscriptions.
    final generation = (((await readLeaseState())?.generation) ?? 0) + 1;
    final content = activeLeasePlaintext(
      v: wireVersion,
      origin: descriptor.origin,
      generation: generation,
      appProfile: profile,
      transport: descriptor.transportFor(profile),
      endpoint: endpointGrant,
      subscriptions:
          subscriptions ??
          [
            {
              'filter': {'kinds': [9], '#p': [userPubkey]},
              'class': 'default',
            },
          ],
    );
    await publish(
      kind: leaseKind,
      content: content,
      tags: [
        ['d', installationHandle],
        ['expiration', '${now + descriptor.maxLeaseTtl}'],
        ['exec', descriptor.executorKeyId],
        ['alt', 'push lease'],
      ],
    );
    await writeLeaseState(PushLeaseState(generation: generation, installationHandle: installationHandle));

    return EnrollmentResult(
      installationHandle: installationHandle,
      endpointGrant: endpointGrant,
      generation: generation,
      expiresAt: now + descriptor.maxLeaseTtl,
    );
  }

  /// Publishes the minimal inactive lease under the stored installation
  /// address, revoking delivery at watermark+1. No-op when no lease state
  /// exists (nothing enabled to revoke).
  Future<void> disable() async {
    final state = await readLeaseState();
    if (state == null) return;
    final handle = state.installationHandle;
    if (handle == null) return;
    final descriptor = await discover();
    if (descriptor == null) {
      throw const PushEnrollmentException('relay_push_unsupported', 'relay publishes no push descriptor');
    }
    final generation = state.generation + 1;
    await publish(
      kind: leaseKind,
      content: inactiveLeasePlaintext(
        v: wireVersion,
        origin: descriptor.origin,
        generation: generation,
      ),
      tags: [
        ['d', handle],
        ['expiration', '${_now().millisecondsSinceEpoch ~/ 1000 + descriptor.maxLeaseTtl}'],
        ['exec', descriptor.executorKeyId],
        ['alt', 'push lease'],
      ],
    );
    await writeLeaseState(PushLeaseState(generation: generation, installationHandle: handle));
  }

  /// Dev-signed builds live in the APNs sandbox environment; App
  /// Store/TestFlight builds use production. Matches the app profiles the
  /// relay advertises (nip11.rs push_descriptor).
  static String defaultAppProfile() {
    const productMode = bool.fromEnvironment('dart.vm.product_mode');
    return productMode ? 'buzz-ios-production' : 'buzz-ios-sandbox';
  }

  /// A lease/grant/installation TTL that never exceeds the relay's
  /// advertised max_lease_ttl (NIP-11 limitation.max_lease_ttl, currently
  /// 30 days). Keeps enroll + delegate + lease expiration aligned.
  int _boundedTtl(int relayMaxTtl) {
    const requested = 30 * 24 * 60 * 60;
    return requested < relayMaxTtl ? requested : relayMaxTtl;
  }

  Future<GatewayChallenge> _fetchChallenge() async {
    final body = await _postJson('/v1/installations/challenges', {'v': wireVersion});
    return GatewayChallenge(
      id: body['challenge_id'] as String,
      value: body['challenge'] as String,
      expiresAt: body['expires_at'] as int,
    );
  }

  Future<Map<String, dynamic>> _postJson(String path, Map<String, Object?> body) async {
    final response = await _httpClient
        .post(
          Uri.parse('$gatewayBaseUrl$path'),
          headers: {'content-type': 'application/json'},
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return jsonDecode(response.body) as Map<String, dynamic>;
    }
    String code = 'http_${response.statusCode}';
    try {
      code = (jsonDecode(response.body) as Map<String, dynamic>)['error'] as String? ?? code;
    } catch (_) {}
    throw PushEnrollmentException(code, 'gateway $path failed: ${response.statusCode} ${response.body}');
  }

  List<int> _sha256Bytes(String input) => crypto.sha256.convert(utf8.encode(input)).bytes;
}

/// Parsed `push` member of the relay's NIP-11 document (nip11.rs
/// push_descriptor shape).
class PushDescriptor {
  PushDescriptor.fromJson(Map<String, dynamic> json)
    : origin = json['origin'] as String,
      executorKeyId = (json['keys'] as List).cast<Map<String, dynamic>>().first['id'] as String,
      relayPubkey = (json['keys'] as List).cast<Map<String, dynamic>>().first['pubkey'] as String,
      maxLeaseTtl = ((json['limitation'] as Map<String, dynamic>)['max_lease_ttl'] as num).toInt(),
      _profiles = {
        for (final profile in (json['app_profiles'] as List).cast<Map<String, dynamic>>())
          profile['id'] as String: profile['transport'] as String,
      };

  final String origin;
  final String executorKeyId;
  final String relayPubkey;
  final int maxLeaseTtl;
  final Map<String, String> _profiles;

  bool supportsProfile(String id) => _profiles.containsKey(id);

  String transportFor(String id) => _profiles[id] ?? 'apns';
}

/// Durable per-identity lease state.
class PushLeaseState {
  PushLeaseState({required this.generation, required this.installationHandle});

  /// Last published generation watermark.
  final int generation;

  /// Gateway installation handle serving as the kind:30350 d-tag address.
  final String? installationHandle;
}

class GatewayChallenge {
  GatewayChallenge({required this.id, required this.value, required this.expiresAt});

  final String id;
  final String value;
  final int expiresAt;
}

class EnrollmentResult {
  EnrollmentResult({
    required this.installationHandle,
    required this.endpointGrant,
    required this.generation,
    required this.expiresAt,
  });

  final String installationHandle;
  final String endpointGrant;
  final int generation;
  final int expiresAt;
}

class PushEnrollmentException implements Exception {
  const PushEnrollmentException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'PushEnrollmentException($code): $message';
}
