import XCTest
@testable import BuzzNative

/// `buzzweb://` launch links: URL shape and the consume-once pending intent.
/// The web half of the contract is `web/src/features/huddle/lib/launchIntent.ts`.
final class LaunchPluginTests: XCTestCase {
    /// In memory, so no test leaves a preferences file in the host (QA D4: a
    /// fresh `UserDefaults` suite per test left one `.plist` per test per run,
    /// even after `removePersistentDomain`).
    private final class MemoryStore: LaunchIntentStore {
        var values: [String: Any] = [:]
        func dictionary(forKey key: String) -> [String: Any]? { values[key] as? [String: Any] }
        func set(_ value: Any?, forKey key: String) { values[key] = value }
        func removeObject(forKey key: String) { values[key] = nil }
    }

    private var defaults: MemoryStore!

    override func setUp() {
        super.setUp()
        defaults = MemoryStore()
    }

    override func tearDown() {
        defaults = nil
        super.tearDown()
    }

    /// The one real `UserDefaults` round trip (plist types survive). A FIXED
    /// suite name: cfprefsd may still leave one empty file, but it is the same
    /// file every run instead of a new one per test.
    func testIntentRoundTripsThroughRealUserDefaults() throws {
        let suite = "buzz.launch.tests"
        let real = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { real.removePersistentDomain(forName: suite) }
        let created = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertTrue(BuzzLaunchPlugin.receive(try url("buzzweb://call?agent=Gilfoyle"), defaults: real, now: created))
        let pending = try XCTUnwrap(BuzzLaunchPlugin.pending(defaults: real))
        XCTAssertEqual(pending["url"] as? String, "buzzweb://call?agent=Gilfoyle")
        XCTAssertEqual(pending["createdAt"] as? Double, 1_700_000_000_000)
        BuzzLaunchPlugin.acknowledge(pending["id"] as? String, defaults: real)
        XCTAssertNil(BuzzLaunchPlugin.pending(defaults: real))
    }

    private func url(_ raw: String) throws -> URL { try XCTUnwrap(URL(string: raw), raw) }

    func testAcceptsOnlyTheLaunchShapes() throws {
        let accepted: [(String, BuzzLaunchPlugin.Action)] = [
            ("buzzweb://", .open), ("buzzweb://open", .open), ("BUZZWEB://OPEN/", .open),
            ("buzzweb://call", .call), ("buzzweb://call/", .call),
            ("buzzweb://call?agent=Acid%20Burn", .call),
            ("buzzweb://call?agent=npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m", .call),
            ("buzzweb://call?agent=\(String(repeating: "a", count: 128))", .call),
            ("buzzweb://call?agent=\(String(repeating: "%F0%9F%98%80", count: 128))", .call),
        ]
        for (raw, action) in accepted {
            XCTAssertEqual(BuzzLaunchPlugin.action(for: try url(raw)), action, raw)
        }
        let refused = [
            "buzz://call", "https://call?agent=x", "capacitor://localhost/call", "buzzweb:call",
            "buzzweb://dial", "buzzweb://call/now", "buzzweb://call#x", "buzzweb://user:pw@call",
            "buzzweb://user@call", "buzzweb://@call", "buzzweb://call#", "buzzweb://c%61ll?agent=Gilfoyle",
            "buzzweb://call:8080", "buzzweb://open?agent=Gilfoyle", "buzzweb://?agent=Gilfoyle",
            "buzzweb://call?who=Gilfoyle", "buzzweb://call?agent=Gilfoyle&agent=Acid",
            "buzzweb://call?agent=Gilfoyle&x=1", "buzzweb://call?agent=", "buzzweb://call?agent=%20%20",
            "buzzweb://call?agent=Gil%0Afoyle", "buzzweb://call?agent=Gil%E2%80%8Bfoyle",
            "buzzweb://call?agent=\(String(repeating: "a", count: 129))",
            "buzzweb://call?agent=\(String(repeating: "%F0%9F%98%80", count: 129))",
        ]
        for raw in refused {
            XCTAssertNil(BuzzLaunchPlugin.action(for: try url(raw)), raw)
        }
    }

    /// Same file web `launchIntent.test.mjs` reads: `<repo>/test-fixtures/launch-links/`.
    func testMatchesTheSharedWebCorpusCaseForCase() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../test-fixtures/launch-links/cases.json").standardized
        let corpus = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let cases = try XCTUnwrap(corpus["cases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, corpus["count"] as? Int)
        XCTAssertGreaterThanOrEqual(cases.count, 70, "the corpus did not load its cases")
        for entry in cases {
            let raw = try XCTUnwrap(entry["url"] as? String)
            let got = BuzzLaunchPlugin.request(forRaw: raw)
            guard let expect = entry["expect"] as? [String: Any] else {
                XCTAssertNil(got, raw)
                continue
            }
            let action = try XCTUnwrap(BuzzLaunchPlugin.Action(rawValue: try XCTUnwrap(expect["action"] as? String)))
            XCTAssertEqual(got, BuzzLaunchPlugin.Request(action: action, agent: expect["agent"] as? String), raw)
        }
    }

    /// What native stores is what the web re-parses: the stored string reads
    /// as the same agent (QA D3: `Big+Head` was a plus here and a space there).
    func testStoredLinkReadsAsTheSameAgent() throws {
        BuzzLaunchPlugin.receive(try url("buzzweb://call?agent=Big+Head"), defaults: defaults)
        let stored = try XCTUnwrap(BuzzLaunchPlugin.pending(defaults: defaults)?["url"] as? String)
        XCTAssertEqual(BuzzLaunchPlugin.request(forRaw: stored), .init(action: .call, agent: "Big Head"))
        XCTAssertFalse(BuzzLaunchPlugin.receive(try url("buzzweb://c%61ll?agent=Gilfoyle"), defaults: defaults))
        XCTAssertEqual(BuzzLaunchPlugin.pending(defaults: defaults)?["url"] as? String, stored,
                       "a percent-encoded host is refused, not stored")
    }

    func testCallPersistsAMalformedLinkIsIgnoredAndOpenSupersedes() throws {
        let created = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertTrue(BuzzLaunchPlugin.receive(try url("buzzweb://call?agent=Gilfoyle"), defaults: defaults, now: created))
        let pending = try XCTUnwrap(BuzzLaunchPlugin.pending(defaults: defaults))
        let id = try XCTUnwrap(pending["id"] as? String)
        XCTAssertNotNil(UUID(uuidString: id))
        XCTAssertEqual(pending["url"] as? String, "buzzweb://call?agent=Gilfoyle")
        XCTAssertEqual(pending["createdAt"] as? Double, 1_700_000_000_000)

        XCTAssertFalse(BuzzLaunchPlugin.receive(try url("buzzweb://call?agent="), defaults: defaults))
        XCTAssertFalse(BuzzLaunchPlugin.receive(try url("https://evil.test/call"), defaults: defaults))
        XCTAssertEqual(BuzzLaunchPlugin.pending(defaults: defaults)?["id"] as? String, id,
                       "a malformed link leaves the pending call alone")

        XCTAssertTrue(BuzzLaunchPlugin.receive(try url("buzzweb://open"), defaults: defaults))
        XCTAssertNil(BuzzLaunchPlugin.pending(defaults: defaults), "the newest tap (open) wins")
    }

    func testAcknowledgeClearsOnlyTheIntentItNames() throws {
        BuzzLaunchPlugin.receive(try url("buzzweb://call"), defaults: defaults)
        let first = try XCTUnwrap(BuzzLaunchPlugin.pending(defaults: defaults)?["id"] as? String)
        BuzzLaunchPlugin.receive(try url("buzzweb://call?agent=Acid"), defaults: defaults)
        let second = try XCTUnwrap(BuzzLaunchPlugin.pending(defaults: defaults)?["id"] as? String)
        XCTAssertNotEqual(first, second)

        BuzzLaunchPlugin.acknowledge(first, defaults: defaults)
        BuzzLaunchPlugin.acknowledge(nil, defaults: defaults)
        XCTAssertEqual(BuzzLaunchPlugin.pending(defaults: defaults)?["id"] as? String, second,
                       "acknowledging a superseded tap must not drop the newer one")
        BuzzLaunchPlugin.acknowledge(second, defaults: defaults)
        XCTAssertNil(BuzzLaunchPlugin.pending(defaults: defaults))
    }

    func testTamperedStorageReadsAsNoIntent() {
        let key = BuzzLaunchPlugin.intentKey
        let good: [String: Any] = ["id": UUID().uuidString, "url": "buzzweb://call", "createdAt": 1.0]
        defaults.set(good, forKey: key)
        XCTAssertNotNil(BuzzLaunchPlugin.pending(defaults: defaults))
        for bad: [String: Any] in [
            good.merging(["id": "not-a-uuid"]) { $1 },
            good.merging(["url": "buzzweb://open"]) { $1 },
            good.merging(["url": "https://evil.test/call"]) { $1 },
            good.merging(["createdAt": "soon"]) { $1 },
        ] {
            defaults.set(bad, forKey: key)
            XCTAssertNil(BuzzLaunchPlugin.pending(defaults: defaults), "\(bad)")
        }
        defaults.set("buzzweb://call", forKey: key)
        XCTAssertNil(BuzzLaunchPlugin.pending(defaults: defaults))
    }
}
