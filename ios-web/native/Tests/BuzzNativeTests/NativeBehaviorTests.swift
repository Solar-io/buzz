import XCTest
import AVFoundation
import NostrSDK
import Security
@testable import BuzzNative

func requireIdentityFixtureSimulator() throws {
#if targetEnvironment(simulator)
    try XCTSkipUnless(Bundle.main.bundleURL.pathExtension == "app", "Identity fixtures require the app-hosted simulator scheme.")
    try XCTSkipUnless(ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"]?.contains("Buzz Capacitor QA") == true,
                      "Identity fixtures require the dedicated Buzz Capacitor QA simulator.")
#else
    throw XCTSkip("Identity fixture tests never run on a physical device.")
#endif
}

final class NativeBehaviorTests: XCTestCase {
    func testNativeOpusRoundTripProducesAudiblePCMAndRejectsMalformedLengths() throws {
        let encoder = try HuddleOpusEncoder()
        let decoder = try HuddleOpusDecoder()
        XCTAssertThrowsError(try encoder.encode(Array(repeating: 0.1, count: 959)))
        XCTAssertThrowsError(try decoder.decode(Data()))
        XCTAssertThrowsError(try decoder.decode(Data(repeating: 0, count: 4089)))
        var sampleCount = 0
        var energy: Double = 0
        for frame in 0..<8 {
            let pcm = (0..<960).map { Float(sin(Double(frame * 960 + $0) * 2 * .pi * 440 / 48_000) * 0.3) }
            let packet = try encoder.encode(pcm)
            XCTAssertGreaterThan(packet.count, 0)
            XCTAssertLessThanOrEqual(packet.count, 4088)
            let decoded = try decoder.decode(packet)
            XCTAssertEqual(decoded.format.sampleRate, 48_000)
            XCTAssertEqual(decoded.format.channelCount, 1)
            XCTAssertGreaterThan(decoded.frameLength, 0)
            let values = try XCTUnwrap(decoded.floatChannelData?.pointee)
            for index in 0..<Int(decoded.frameLength) { energy += Double(values[index] * values[index]) }
            sampleCount += Int(decoded.frameLength)
        }
        XCTAssertGreaterThan(sampleCount, 6_000)
        XCTAssertGreaterThan(energy / Double(sampleCount), 0.005, "A silent decoder is not successful audio")
    }

    func testJitterQueueOrdersWraparoundAndRejectsDuplicatesAndLatePackets() {
        func packet(_ sequence: Int) -> HuddleRemoteOpusPacket {
            HuddleRemoteOpusPacket(peerIndex: 3, sequence: sequence, timestamp48k: 960, levelDbov: -12, opus: Data([1]))
        }
        var queue = HuddlePacketJitterQueue(capacity: 8, startPackets: 3)
        queue.enqueue(packet(65535))
        queue.enqueue(packet(1))
        XCTAssertNil(queue.drainOne())
        queue.enqueue(packet(0))
        queue.enqueue(packet(0))
        XCTAssertEqual(queue.packets.count, 3)
        XCTAssertEqual(queue.drainOne()?.sequence, 65535)
        XCTAssertEqual(queue.drainOne()?.sequence, 0)
        queue.enqueue(packet(65535))
        queue.enqueue(packet(0))
        XCTAssertEqual(queue.drainOne()?.sequence, 1)
        XCTAssertNil(queue.drainOne())
    }

    func testTalkerCapacityDoesNotChurnOnSilenceAndReclaimsExpiredPeer() {
        var clock = 0.0
        var selector = HuddleActiveTalkerSelector(capacity: 2, now: { clock }, inactivityTimeout: 1)
        XCTAssertTrue(selector.activate(peerIndex: 1, levelDbov: -127).accepted)
        XCTAssertTrue(selector.activate(peerIndex: 2, levelDbov: -127).accepted)
        XCTAssertFalse(selector.activate(peerIndex: 3, levelDbov: -127).accepted)
        XCTAssertEqual(selector.active.count, 2)
        clock = 2
        let admitted = selector.activate(peerIndex: 3, levelDbov: -127)
        XCTAssertTrue(admitted.accepted)
        XCTAssertEqual(admitted.evictedPeerIndex, 1)
        XCTAssertEqual(Set(selector.active.keys), Set([2, 3]))
    }

    @MainActor
    func testNativeIdentityVectorSignsAndLocksWithoutRememberedKeyBypass() throws {
        try requireIdentityFixtureSimulator()
        let identity = NativeIdentity.shared
        try identity.forget()
        defer { try? identity.forget() }
        let state = try identity.enroll(String(repeating: "0", count: 63) + "1")
        XCTAssertEqual(state["pubkey"] as? String, "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
        let template: [String: Any] = ["kind": 22242, "created_at": 1_700_000_000, "content": "", "tags": [["relay", "wss://qa.invalid"], ["challenge", "independent-challenge"]]]
        let signed = try identity.sign(template)
        XCTAssertEqual(signed["kind"] as? Int, 22242)
        XCTAssertEqual(signed["tags"] as? [[String]], [["relay", "wss://qa.invalid"], ["challenge", "independent-challenge"]])
        let json = String(data: try JSONSerialization.data(withJSONObject: signed), encoding: .utf8)!
        XCTAssertTrue(try Event.fromJson(json: json).verify())
        var tampered = signed
        tampered["content"] = "tampered"
        let changed = String(data: try JSONSerialization.data(withJSONObject: tampered), encoding: .utf8)!
        XCTAssertFalse(try Event.fromJson(json: changed).verify())
        XCTAssertThrowsError(try identity.enroll("not-a-key"))
        XCTAssertEqual(identity.state()["pubkey"] as? String, state["pubkey"] as? String)
        identity.lock()
        XCTAssertEqual(identity.state()["locked"] as? Bool, true)
        XCTAssertThrowsError(try identity.sign(template))
        XCTAssertTrue(identity.state()["pubkey"] is NSNull)
        try identity.forget()
        XCTAssertNil(try NativeIdentity.read("identity.v1"))
        XCTAssertThrowsError(try identity.sign(template))
    }

    @MainActor
    func testNativeNip44RoundTripAuthenticatesCiphertext() throws {
        try requireIdentityFixtureSimulator()
        let identity = NativeIdentity.shared
        try identity.forget()
        defer { try? identity.forget() }
        _ = try identity.enroll(String(repeating: "0", count: 63) + "1")
        let peer = try Keys.parse(secretKey: String(repeating: "0", count: 63) + "2")
        let own = try identity.signer()
        let encrypted = try own.nip44Encrypt(publicKey: peer.publicKey(), content: "private push lease")
        XCTAssertNotEqual(encrypted, "private push lease")
        XCTAssertEqual(try peer.nip44Decrypt(publicKey: own.publicKey(), payload: encrypted), "private push lease")
        let stranger = try Keys.parse(secretKey: String(repeating: "0", count: 63) + "3")
        XCTAssertThrowsError(try stranger.nip44Decrypt(publicKey: own.publicKey(), payload: encrypted))
        var bytes = try XCTUnwrap(Data(base64Encoded: encrypted))
        bytes[bytes.count - 1] ^= 1
        XCTAssertThrowsError(try peer.nip44Decrypt(publicKey: own.publicKey(), payload: bytes.base64EncodedString()))
    }
}

final class FlutterIdentityMigrationTests: XCTestCase {
    private let secretOne = String(repeating: "0", count: 63) + "1"
    private let secretTwo = String(repeating: "0", count: 63) + "2"
    private let publicOne = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    private let accounts = ["buzz_communities", "buzz_active_community_id", "buzz_workspaces", "buzz_active_workspace_id", "buzz_relay_url", "buzz_nsec", "buzz_pubkey"]

    private func row(_ id: String, secret: String? = nil, relay: String = "wss://migration-qa.invalid") throws -> [String: Any] {
        let keys = try Keys.parse(secretKey: secret ?? secretOne)
        return ["id": id, "name": "QA \(id)", "relayUrl": relay,
                "nsec": try keys.secretKey().toBech32(), "pubkey": keys.publicKey().toHex()]
    }
    private func data(_ rows: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: rows) }

    func testActiveSingleExplicitAndAmbiguousSelection() throws {
        let entries = try FlutterIdentityMigration.candidates(data([row("one"), row("two", secret: secretTwo)]), activeId: "two")
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(try FlutterIdentityMigration.choose(entries, activeId: "two", selectedId: nil)?.id, "two")
        XCTAssertEqual(try FlutterIdentityMigration.choose(entries, activeId: "two", selectedId: "one")?.id, "one")
        XCTAssertNil(try FlutterIdentityMigration.choose(entries, activeId: nil, selectedId: nil))
        XCTAssertNil(try FlutterIdentityMigration.choose(entries, activeId: "missing", selectedId: nil))
        XCTAssertEqual(try FlutterIdentityMigration.choose([entries[0]], activeId: nil, selectedId: nil)?.id, "one")
        XCTAssertThrowsError(try FlutterIdentityMigration.choose(entries, activeId: nil, selectedId: "missing"))
        XCTAssertThrowsError(try FlutterIdentityMigration.candidates(data([row("one"), row("one", secret: secretTwo)]), activeId: nil))
    }

    func testPublicDescriptorsContainNoSecretAndInvalidActiveIdentityFailsClosed() throws {
        let entry = try XCTUnwrap(FlutterIdentityMigration.candidates(data([row("one")]), activeId: "one").first)
        XCTAssertEqual(Set(entry.descriptor.keys), Set(["id", "name", "relayUrl", "pubkey"]))
        XCTAssertEqual(entry.descriptor["pubkey"], publicOne)
        let encoded = String(data: try JSONSerialization.data(withJSONObject: entry.descriptor), encoding: .utf8)!
        XCTAssertFalse(encoded.contains(secretOne))
        XCTAssertFalse(encoded.contains("nsec1"))
        var mismatch = try row("one")
        mismatch["pubkey"] = try Keys.parse(secretKey: secretTwo).publicKey().toHex()
        XCTAssertThrowsError(try FlutterIdentityMigration.candidates(data([mismatch]), activeId: "one"))
        XCTAssertTrue(try FlutterIdentityMigration.candidates(data([mismatch]), activeId: nil).isEmpty)
        var absent = try row("one")
        absent.removeValue(forKey: "nsec")
        XCTAssertThrowsError(try FlutterIdentityMigration.candidates(data([absent]), activeId: "one"))
    }

    func testMigrationAcceptsOnlySecureBareRelayOriginsAndBoundsInput() throws {
        XCTAssertEqual(try FlutterIdentityMigration.secureRelay("https://migration-qa.invalid:9443/"), "wss://migration-qa.invalid:9443")
        for relay in ["ws://migration-qa.invalid", "http://migration-qa.invalid", "wss://user:pass@migration-qa.invalid", "wss://migration-qa.invalid/path", "wss://migration-qa.invalid?x=1", "wss://migration-qa.invalid#x", "file:///tmp/relay", ""] {
            XCTAssertThrowsError(try FlutterIdentityMigration.secureRelay(relay), relay)
            XCTAssertThrowsError(try FlutterIdentityMigration.candidates(data([row("one", relay: relay)]), activeId: "one"), relay)
        }
        XCTAssertThrowsError(try FlutterIdentityMigration.candidates(data((0..<65).map { try row("\($0)") }), activeId: nil))
        XCTAssertThrowsError(try FlutterIdentityMigration.candidates(Data(repeating: 32, count: 1_048_577), activeId: nil))
    }

    @MainActor
    private func withLegacyFixture(_ operation: () throws -> Void) throws {
        try requireIdentityFixtureSimulator()
        guard try NativeIdentity.read("identity.v1") == nil else { throw XCTSkip("Refusing to replace an existing simulator identity.") }
        for account in accounts {
            guard try FlutterIdentityMigration.read(account) == nil else { throw XCTSkip("Refusing to replace existing legacy simulator records.") }
        }
        let defaults = UserDefaults.standard
        let names = ["buzz.flutter-migration-completed", "buzz.migrated-flutter-relay", "buzz.identity.locked"]
        let original = names.map { defaults.object(forKey: $0) }
        defer {
            try? NativeIdentity.shared.forget()
            for account in accounts {
                let result = SecItemDelete(legacyQuery(account) as CFDictionary)
                XCTAssertTrue(result == errSecSuccess || result == errSecItemNotFound)
            }
            for (index, name) in names.enumerated() {
                if let value = original[index] { defaults.set(value, forKey: name) }
                else { defaults.removeObject(forKey: name) }
            }
        }
        defaults.removeObject(forKey: "buzz.flutter-migration-completed")
        defaults.removeObject(forKey: "buzz.migrated-flutter-relay")
        try operation()
    }
    private func legacyQuery(_ account: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: "flutter_secure_storage_service",
         kSecAttrAccount: account, kSecAttrSynchronizable: false]
    }
    private func insertLegacy(_ account: String, _ data: Data) throws {
        var query = legacyQuery(account)
        query[kSecValueData] = data
        query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let result = SecItemAdd(query as CFDictionary, nil)
        guard result == errSecSuccess else { throw NativeError.message("QA fixture Keychain write failed (\(result)).") }
    }

    @MainActor
    func testActualLegacyKeychainMigrationRetainsRowsAndForgetCannotResurrect() throws {
        try withLegacyFixture {
            let old = try data([row("one"), row("two", secret: secretTwo)])
            try insertLegacy("buzz_communities", old)
            try insertLegacy("buzz_active_community_id", Data("one".utf8))
            let result = try FlutterIdentityMigration.restore(selectedId: nil)
            XCTAssertEqual(result["status"] as? String, "migrated")
            XCTAssertEqual(result["pubkey"] as? String, publicOne)
            XCTAssertEqual(result["relayUrl"] as? String, "wss://migration-qa.invalid")
            XCTAssertEqual(Set(result.keys), Set(["status", "pubkey", "relayUrl"]))
            XCTAssertEqual(try NativeIdentity.read("identity.v1"), Data(secretOne.utf8))
            XCTAssertEqual(try FlutterIdentityMigration.read("buzz_communities"), old)
            XCTAssertEqual(try FlutterIdentityMigration.read("buzz_active_community_id"), Data("one".utf8))
            try NativeIdentity.shared.forget()
            XCTAssertEqual(try FlutterIdentityMigration.restore(selectedId: nil)["status"] as? String, "none")
            XCTAssertNil(try NativeIdentity.read("identity.v1"))
            XCTAssertEqual(try FlutterIdentityMigration.read("buzz_communities"), old)
        }
    }

    @MainActor
    func testExistingNativeIdentityIsNeverOverwrittenByLegacySelection() throws {
        try withLegacyFixture {
            let old = try data([row("legacy-two", secret: secretTwo)])
            try insertLegacy("buzz_communities", old)
            _ = try NativeIdentity.shared.enroll(secretOne)
            let result = try FlutterIdentityMigration.restore(selectedId: "legacy-two")
            XCTAssertEqual(result["status"] as? String, "existing")
            XCTAssertEqual(try NativeIdentity.read("identity.v1"), Data(secretOne.utf8))
            XCTAssertEqual(NativeIdentity.shared.state()["pubkey"] as? String, publicOne)
            XCTAssertEqual(try FlutterIdentityMigration.read("buzz_communities"), old)
        }
    }

    @MainActor
    func testAmbiguousLegacyRowsExposeOnlyPublicChoicesUntilExplicitSelection() throws {
        try withLegacyFixture {
            let old = try data([row("one"), row("two", secret: secretTwo)])
            try insertLegacy("buzz_communities", old)
            let result = try FlutterIdentityMigration.restore(selectedId: nil)
            XCTAssertEqual(result["status"] as? String, "choice")
            let choices = try XCTUnwrap(result["choices"] as? [[String: String]])
            XCTAssertEqual(choices.count, 2)
            XCTAssertTrue(choices.allSatisfy { Set($0.keys) == Set(["id", "name", "relayUrl", "pubkey"]) })
            XCTAssertNil(try NativeIdentity.read("identity.v1"))
            let restored = try FlutterIdentityMigration.restore(selectedId: "two")
            XCTAssertEqual(restored["status"] as? String, "migrated")
            XCTAssertEqual(try NativeIdentity.read("identity.v1"), Data(secretTwo.utf8))
            XCTAssertEqual(try FlutterIdentityMigration.read("buzz_communities"), old)
        }
    }

    @MainActor
    func testWorkspaceAndSingleCommunityLegacyFormatsRemainReadable() throws {
        try withLegacyFixture {
            let old = try data([row("workspace")])
            try insertLegacy("buzz_workspaces", old)
            try insertLegacy("buzz_active_workspace_id", Data("workspace".utf8))
            XCTAssertEqual(try FlutterIdentityMigration.restore(selectedId: nil)["status"] as? String, "migrated")
            XCTAssertEqual(try NativeIdentity.read("identity.v1"), Data(secretOne.utf8))
            XCTAssertEqual(try FlutterIdentityMigration.read("buzz_workspaces"), old)
        }
        try withLegacyFixture {
            try insertLegacy("buzz_relay_url", Data("https://migration-qa.invalid/".utf8))
            let nsec = try Keys.parse(secretKey: secretOne).secretKey().toBech32()
            try insertLegacy("buzz_nsec", Data(nsec.utf8))
            try insertLegacy("buzz_pubkey", Data(publicOne.utf8))
            XCTAssertEqual(try FlutterIdentityMigration.restore(selectedId: nil)["status"] as? String, "migrated")
            XCTAssertEqual(try NativeIdentity.read("identity.v1"), Data(secretOne.utf8))
            XCTAssertEqual(try FlutterIdentityMigration.read("buzz_nsec"), Data(nsec.utf8))
        }
    }
}

final class NativeVoicePolicyTests: XCTestCase {
    func testFinalGateNormalizesRejectsShortAndDeduplicatesOnlyLastThree() {
        var gate = NativeFinalGate()
        XCTAssertNil(gate.receive("  x  ", now: 0, speaking: false))
        XCTAssertEqual(gate.receive("  hello\n there  ", now: 0, speaking: false), "hello there")
        XCTAssertNil(gate.receive("hello there", now: 1, speaking: false))
        XCTAssertEqual(gate.receive("two", now: 2, speaking: false), "two")
        XCTAssertEqual(gate.receive("three", now: 3, speaking: false), "three")
        XCTAssertEqual(gate.receive("four", now: 4, speaking: false), "four")
        XCTAssertEqual(gate.receive("hello there", now: 5, speaking: false), "hello there")
    }

    func testFinalGateHoldsExactlyThroughEchoTailAndDropsEchoOnly() {
        var gate = NativeFinalGate()
        gate.record("alpha bravo charlie delta", at: 0)
        XCTAssertNil(gate.receive("Alpha, bravo charlie delta!", now: 0.5, speaking: false))
        XCTAssertNil(gate.receive("please change the subject", now: 0.6, speaking: false))
        XCTAssertTrue(gate.hasPending)
        XCTAssertEqual(gate.drain(now: 1.499, speaking: false), [])
        XCTAssertEqual(gate.drain(now: 1.5, speaking: true), [])
        XCTAssertEqual(gate.drain(now: 1.5, speaking: false), ["please change the subject"])
        XCTAssertFalse(gate.hasPending)
        XCTAssertEqual(gate.drain(now: 2, speaking: false), [])
    }

    func testEarlierSentenceEchoIsRejectedAfterLaterSentencesFinish() {
        var gate = NativeFinalGate()
        gate.record("The first sentence is echoed by the microphone", at: 1)
        XCTAssertNil(gate.receive("the first sentence is echoed by the microphone", now: 1.2, speaking: true))
        for time in 2...5 { gate.record("unrelated sentence number \(time)", at: Double(time)) }
        XCTAssertEqual(gate.drain(now: 6.5, speaking: false), [])
        XCTAssertFalse(gate.hasPending)
    }

    func testEchoThresholdAndChunkCeilingAreLiteralContracts() {
        XCTAssertTrue(NativeVoicePolicy.isEcho("a b c", of: ["a b c d e"]))
        XCTAssertFalse(NativeVoicePolicy.isEcho("a b", of: ["a b c d e"]))
        XCTAssertFalse(NativeVoicePolicy.isEcho("", of: ["a b c d e"]))
        let source = String(repeating: "x", count: 401)
        let chunks = NativeVoicePolicy.chunks(source)
        XCTAssertEqual(chunks.map(\.count), [200, 200, 1])
        XCTAssertEqual(chunks.joined(), source)
        XCTAssertEqual(NativeVoicePolicy.chunks("  First sentence. Second sentence!  "), ["First sentence. Second sentence!"])
        XCTAssertEqual(NativeVoicePolicy.chunks(" "), [])
    }

    func testVoiceSelectionRequiresExactVersionTagAndValidEngineKey() {
        let tags = [["d", "agent-voice"]]
        let valid = #"{"version":1,"label":"Alice","engine":"pocket","key":"pocket:alba"}"#
        XCTAssertEqual(NativeVoicePolicy.voiceSelection(content: valid, tags: tags)?.key, "pocket:alba")
        XCTAssertNil(NativeVoicePolicy.voiceSelection(content: valid, tags: tags + tags))
        XCTAssertNil(NativeVoicePolicy.voiceSelection(content: valid, tags: [["d", "other"]]))
        for invalid in [
            #"{"version":true,"label":"Alice","engine":"pocket","key":"pocket:alba"}"#,
            #"{"version":2,"label":"Alice","engine":"pocket","key":"pocket:alba"}"#,
            #"{"version":1,"label":"","engine":"pocket","key":"pocket:alba"}"#,
            #"{"version":1,"label":"Alice","engine":"pocket","key":"pocket:eve"}"#,
            #"{"version":1,"label":"Alice","engine":"pocket","key":"../voice"}"#,
            #"{"version":1,"label":"Alice","engine":"eleven","key":"eleven:short"}"#
        ] { XCTAssertNil(NativeVoicePolicy.voiceSelection(content: invalid, tags: tags), invalid) }
    }
}
