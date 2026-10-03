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
    /// Regression (2026-10-01): native agent voice read NIP-11 `pubkey`, which
    /// the Buzz relay serves as null; the 39002 snapshot signer is `self`.
    /// Discovery failed on every call, so no `[voice]` line was ever published.
    func testRelaySigningKeyReadsSelfNotNullPubkey() throws {
        let signer = "3a4988c6a4759ebe80f47686bd5af9b611a3ad4aacca63cc1e852140fc35f3f1"
        // Shape of the live wss://crichton…:6351/info document.
        let live = try JSONSerialization.jsonObject(with: Data(#"{"name":"Buzz Relay","pubkey":null,"contact":null,"self":"\#(signer)"}"#.utf8)) as! [String: Any]
        XCTAssertEqual(NativeVoicePolicy.relaySigningKey(live), signer)
        XCTAssertEqual(NativeVoicePolicy.relaySigningKey(["self": signer.uppercased()]), signer)
        // `pubkey` is the operator contact, never the snapshot signer.
        XCTAssertNil(NativeVoicePolicy.relaySigningKey(["pubkey": signer]))
        XCTAssertNil(NativeVoicePolicy.relaySigningKey(["self": String(signer.dropLast())]))
        XCTAssertNil(NativeVoicePolicy.relaySigningKey(["self": String(signer.dropLast()) + "z"]))
    }

    /// The shipped discovery path, end to end: NativeAgentVoice.start() reads
    /// /info and must adopt `self` instead of failing closed on null `pubkey`.
    func testAgentVoiceStartDiscoversRelaySelfFromLiveShapedInfo() throws {
        let signer = "3a4988c6a4759ebe80f47686bd5af9b611a3ad4aacca63cc1e852140fc35f3f1"
        RelayInfoStub.body = Data(#"{"name":"Buzz Relay","pubkey":null,"contact":null,"self":"\#(signer)"}"#.utf8)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RelayInfoStub.self]
        let voice = try NativeAgentVoice(relay: URL(string: "wss://relay.invalid")!, channel: UUID().uuidString.lowercased(),
                                         stt: "wss://stt.invalid/stt", tts: "https://tts.invalid/tts",
                                         onChange: {}, onSpeaking: { _ in }, audioPeers: { [] })
        voice.infoSession = URLSession(configuration: config)
        defer { voice.stop() }
        voice.start()
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in voice.relayPubkey != nil || voice.error != nil }, object: nil)
        wait(for: [settled], timeout: 5)
        XCTAssertNil(voice.error)
        XCTAssertNil(voice.offReason)
        XCTAssertEqual(voice.relayPubkey, signer)
        XCTAssertEqual(RelayInfoStub.lastPath, "/info")
    }

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

    func testVoiceSelectionAcceptsChatterboxKeysOnTheRelayGrammar() {
        let tags = [["d", "agent-voice"]]
        let body = { (key: String) in #"{"engine":"chatterbox","key":"\#(key)","label":"Evie","version":1}"# }
        XCTAssertEqual(NativeVoicePolicy.voiceSelection(content: body("chatterbox:evie"), tags: tags)?.engine, "chatterbox")
        XCTAssertEqual(NativeVoicePolicy.voiceSelection(content: body("chatterbox:my_voice-2"), tags: tags)?.key, "chatterbox:my_voice-2")
        for invalid in ["chatterbox:", "chatterbox:Evie", "chatterbox:-x", "chatterbox:" + String(repeating: "a", count: 49), "pocket:evie"] {
            XCTAssertNil(NativeVoicePolicy.voiceSelection(content: body(invalid), tags: tags), invalid)
        }
    }

    func testVoiceAssignmentRequiresOneLowercaseAgentDTag() {
        let agent = String(repeating: "ab", count: 32)
        let content = #"{"engine":"chatterbox","key":"chatterbox:evie","label":"Evie","version":1}"#
        let row = NativeVoicePolicy.voiceAssignment(content: content, tags: [["d", agent]])
        XCTAssertEqual(row?.agent, agent)
        XCTAssertEqual(row?.key, "chatterbox:evie")
        XCTAssertNil(NativeVoicePolicy.voiceAssignment(content: content, tags: [["d", agent.uppercased()]]))
        XCTAssertNil(NativeVoicePolicy.voiceAssignment(content: content, tags: [["d", "agent-voice"]]))
        XCTAssertNil(NativeVoicePolicy.voiceAssignment(content: content, tags: [["d", agent], ["d", agent]]))
        XCTAssertNil(NativeVoicePolicy.voiceAssignment(content: #"{"engine":"chatterbox","key":"chatterbox:evie","label":"Evie","version":2}"#, tags: [["d", agent]]))
    }

    func testFishVoiceGrammarAcceptsSharedVectors() throws {
        try checkVoiceGrammar(engine: "fish", accepted: true, expectedCount: 4)
    }

    func testFishVoiceGrammarRejectsSharedVectors() throws {
        try checkVoiceGrammar(engine: "fish", accepted: false, expectedCount: 19)
    }

    func testElevenVoiceGrammarAcceptsSharedVectors() throws {
        try checkVoiceGrammar(engine: "eleven", accepted: true, expectedCount: 4)
    }

    func testElevenVoiceGrammarRejectsSharedVectors() throws {
        try checkVoiceGrammar(engine: "eleven", accepted: false, expectedCount: 18)
    }

    private func checkVoiceGrammar(engine: String, accepted: Bool, expectedCount: Int) throws {
        // Same raw keys as relay ingest_agent_voice_tests and web agentVoiceSelection tests.
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../test-fixtures/voice/voice-key-grammar.json").standardized
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: [String: [String]]])
        XCTAssertEqual(fixture.count, 2)
        let keys = try XCTUnwrap(fixture[engine]?[accepted ? "accept" : "reject"])
        XCTAssertEqual(keys.count, expectedCount)
        let agent = String(repeating: "ab", count: 32)
        for key in keys {
            // Serialize raw keys so newline/Unicode reject vectors reach the real parser.
            let data = try JSONSerialization.data(withJSONObject: ["version": 1, "label": "Voice", "engine": engine, "key": key])
            let content = try XCTUnwrap(String(data: data, encoding: .utf8))
            let selection = NativeVoicePolicy.voiceSelection(content: content, tags: [["d", "agent-voice"]])
            let assignment = NativeVoicePolicy.voiceAssignment(content: content, tags: [["d", agent]])
            if accepted {
                let row = try XCTUnwrap(selection, key)
                let ownerRow = try XCTUnwrap(assignment, key)
                XCTAssertEqual(row.engine, engine, key)
                XCTAssertEqual(row.key, key, key)
                XCTAssertEqual(ownerRow.agent, agent, key)
                XCTAssertEqual(ownerRow.engine, engine, key)
                XCTAssertEqual(ownerRow.key, key, key)
                let voice = NativeVoicePolicy.split(row)
                for route in [
                    NativeVoicePolicy.bridgeVoice(pubkey: agent, override: nil, assignment: nil, selection: voice),
                    NativeVoicePolicy.bridgeVoice(pubkey: agent, override: nil, assignment: NativeVoicePolicy.split((ownerRow.engine, ownerRow.key)), selection: ("pocket", "anna"))
                ] {
                    XCTAssertEqual(route.engine, engine, key)
                    XCTAssertEqual(route.voice, String(key.dropFirst(engine.count + 1)), key)
                }
            } else {
                XCTAssertNil(selection, key)
                XCTAssertNil(assignment, key)
            }
        }
    }

    func testFishChannelOverrideUsesNativeBridgeRouteAndClears() throws {
        let agent = String(repeating: "ab", count: 32)
        let voice = try NativeAgentVoice(relay: XCTUnwrap(URL(string: "wss://relay.invalid")), channel: "test",
                                         stt: "wss://stt.invalid/stt", tts: "https://tts.invalid/tts",
                                         onChange: {}, onSpeaking: { _ in }, audioPeers: { [] })
        // Exercise the actual setter and the route playNext uses, without starting sockets/audio.
        voice.setVoiceOverride(["engine": "fish", "key": "fish:0123456789abcdef0123456789abcdef"])
        XCTAssertEqual(voice.bridgeVoice(for: agent).engine, "fish")
        XCTAssertEqual(voice.bridgeVoice(for: agent).voice, "0123456789abcdef0123456789abcdef")
        voice.setVoiceOverride(["engine": "fish", "key": "eleven:T720RsqorTx4ZZWohrNN"])
        XCTAssertEqual(voice.bridgeVoice(for: agent).engine, "chatterbox")
        voice.setVoiceOverride(["engine": "eleven", "key": "eleven:T720RsqorTx4ZZWohrNN"])
        XCTAssertEqual(voice.bridgeVoice(for: agent).engine, "eleven")
        XCTAssertEqual(voice.bridgeVoice(for: agent).voice, "T720RsqorTx4ZZWohrNN")
        voice.setVoiceOverride([:])
        XCTAssertEqual(voice.bridgeVoice(for: agent).engine, "chatterbox")
        XCTAssertEqual(voice.bridgeVoice(for: agent).voice, NativeVoicePolicy.derivedVoice(agent).voice)
    }

    func testFishVoiceUsesTheExistingPrecedenceLayers() {
        let agent = String(repeating: "ab", count: 32)
        let fish = (engine: "fish", voice: "0123456789abcdef0123456789abcdef")
        let eleven = (engine: "eleven", voice: "T720RsqorTx4ZZWohrNN")
        let override = NativeVoicePolicy.bridgeVoice(pubkey: agent, override: fish, assignment: eleven, selection: eleven)
        XCTAssertEqual(override.engine, "fish")
        XCTAssertEqual(override.voice, "0123456789abcdef0123456789abcdef")
        let assigned = NativeVoicePolicy.bridgeVoice(pubkey: agent, override: nil, assignment: fish, selection: eleven)
        XCTAssertEqual(assigned.engine, "fish")
        XCTAssertEqual(assigned.voice, "0123456789abcdef0123456789abcdef")
        let selected = NativeVoicePolicy.bridgeVoice(pubkey: agent, override: nil, assignment: nil, selection: fish)
        XCTAssertEqual(selected.engine, "fish")
        XCTAssertEqual(selected.voice, "0123456789abcdef0123456789abcdef")
        let higher = NativeVoicePolicy.bridgeVoice(pubkey: agent, override: eleven, assignment: fish, selection: fish)
        XCTAssertEqual(higher.engine, "eleven")
        XCTAssertEqual(higher.voice, "T720RsqorTx4ZZWohrNN")
    }

    func testBridgeVoicePrecedenceOverrideOwnerAgentDerived() {
        let pk = String(repeating: "a", count: 64)
        let override = (engine: "eleven", voice: "T720RsqorTx4ZZWohrNN")
        let owner = (engine: "chatterbox", voice: "evie")
        let own = (engine: "pocket", voice: "anna")
        func pick(_ o: (engine: String, voice: String)?, _ a: (engine: String, voice: String)?, _ s: (engine: String, voice: String)?) -> String {
            let v = NativeVoicePolicy.bridgeVoice(pubkey: pk, override: o, assignment: a, selection: s); return v.engine + ":" + v.voice
        }
        XCTAssertEqual(pick(override, owner, own), "eleven:T720RsqorTx4ZZWohrNN", "channel override wins")
        XCTAssertEqual(pick(nil, owner, own), "chatterbox:evie", "owner 30183 beats agent 30182")
        XCTAssertEqual(pick(nil, nil, own), "pocket:anna", "agent 30182 beats derived")
        let derived = NativeVoicePolicy.derivedVoice(pk)
        XCTAssertEqual(derived.engine, "chatterbox")
        XCTAssertEqual(pick(nil, nil, nil), "chatterbox:" + derived.voice, "derived is chatterbox")
        XCTAssertEqual(pick(nil, (engine: "pocket", voice: "imported:" + String(repeating: "0", count: 64)), own), "chatterbox:" + derived.voice, "an unrunnable imported key speaks derived")
    }

    func testDerivedVoiceMatchesTheSharedWebFixture() throws {
        // Same file web bridgeSpeech.test.mjs reads: <repo>/test-fixtures/voice/.
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../test-fixtures/voice/derived-agent-voices.json").standardized
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(fixture["slugs"] as? [String], NativeVoicePolicy.derivedVoiceSlugs)
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: String]])
        XCTAssertGreaterThanOrEqual(cases.count, 20)
        for entry in cases {
            let pubkey = try XCTUnwrap(entry["pubkey"])
            let derived = NativeVoicePolicy.derivedVoice(pubkey)
            XCTAssertEqual(derived.engine, entry["engine"], pubkey)
            XCTAssertEqual(derived.voice, entry["voice"], pubkey)
        }
        XCTAssertEqual(Set(cases.compactMap { $0["voice"] }).count, 11)
    }
}

/// Serves a fixed relay NIP-11 document for NativeAgentVoice's /info read.
final class RelayInfoStub: URLProtocol {
    static var body = Data()
    static var lastPath: String?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastPath = request.url?.path
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
