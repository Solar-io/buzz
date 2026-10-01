import XCTest
@testable import BuzzNative

/// `buzzweb://` launch links: URL shape and the consume-once pending intent.
/// The web half of the contract is `web/src/features/huddle/lib/launchIntent.ts`.
final class LaunchPluginTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "buzz.launch.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
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
