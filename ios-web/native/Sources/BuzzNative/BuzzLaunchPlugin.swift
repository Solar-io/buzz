import Capacitor
import Foundation

/// The slice of `UserDefaults` the pending launch intent uses. Production is
/// `UserDefaults.standard`; tests pass an in-memory store, because a scratch
/// `UserDefaults` suite leaves its `.plist` in the test host even after
/// `removePersistentDomain` (cfprefsd rewrites it empty; QA 2026-10-01, D4).
public protocol LaunchIntentStore: AnyObject {
    func dictionary(forKey defaultName: String) -> [String: Any]?
    func set(_ value: Any?, forKey defaultName: String)
    func removeObject(forKey defaultName: String)
}

extension UserDefaults: LaunchIntentStore {}

/// `buzzweb://` launch links (the "Buzz Voice" dock button).
///
/// Accepted shapes, nothing else:
/// - `buzzweb://` and `buzzweb://open` — just open the app.
/// - `buzzweb://call` — call the last agent called.
/// - `buzzweb://call?agent=<name|npub|hex>` — call that agent.
///
/// Native only checks shape and persists the newest intent; the web client
/// re-parses the URL and decides which agent (if any) it names. The intent
/// survives a cold start in UserDefaults and is consumed once: the web reads
/// it with `getIntent` and clears it with `acknowledgeIntent`, mirroring
/// `BuzzPushPlugin`'s `getWake`/`acknowledgeWake`.
@objc(BuzzLaunchPlugin)
public final class BuzzLaunchPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BuzzLaunchPlugin"
    public let jsName = "BuzzLaunch"
    public let pluginMethods: [CAPPluginMethod] = ["getIntent", "acknowledgeIntent"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    public static let scheme = "buzzweb"
    static let intentKey = "buzz.pending-launch.v1"
    static let maxAgentLength = 128
    private static weak var instance: BuzzLaunchPlugin?
    public override func load() { Self.instance = self }

    public enum Action: String { case open, call }

    /// What a launch link asks for: the action and, for a call, the agent.
    public struct Request: Equatable {
        public let action: Action
        public let agent: String?
    }

    /// The validated action for a launch URL, or nil when it is not one.
    /// Judged on `absoluteString` — exactly the string stored for, and later
    /// re-parsed by, the web — so the two sides read the same characters.
    public static func action(for url: URL) -> Action? {
        request(forRaw: url.absoluteString)?.action
    }

    private static let agentPrefix = "agent="
    private static let queryCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~!$'()*+,;:@/?%=&-")

    /// The launch-link grammar on the RAW string, never via `URL`/`URLComponents`:
    /// Foundation and WHATWG disagree on `c%61ll`, `+`, `@call` and an empty
    /// `#` (QA 2026-10-01). Same grammar, line for line, as web
    /// `launchIntent.ts` `parseLaunchUrl`; both suites run the shared corpus
    /// `test-fixtures/launch-links/cases.json`.
    public static func request(forRaw raw: String) -> Request? {
        guard raw.unicodeScalars.allSatisfy({ (0x21...0x7E).contains($0.value) }) else { return nil }
        let prefix = scheme + "://"
        guard raw.lowercased().hasPrefix(prefix) else { return nil }
        var rest = Substring(raw.dropFirst(prefix.count))
        var query: Substring = ""
        if let mark = rest.firstIndex(of: "?") {
            query = rest[rest.index(after: mark)...]
            rest = rest[..<mark]
        }
        if rest.hasSuffix("/") { rest = rest.dropLast() }
        guard query.unicodeScalars.allSatisfy({ queryCharacters.contains($0) }) else { return nil }
        switch rest.lowercased() {
        case "", "open":
            return query.isEmpty ? Request(action: .open, agent: nil) : nil
        case "call":
            if query.isEmpty { return Request(action: .call, agent: nil) }
            // `+` is a space (as web `decodeURIComponent` after the same
            // replacement); a malformed escape refuses the whole link.
            guard !query.contains("&"), query.hasPrefix(agentPrefix),
                  let decoded = String(query.dropFirst(agentPrefix.count))
                    .replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let agent = cleanAgentSelector(decoded)
            else { return nil }
            return Request(action: .call, agent: agent)
        default:
            return nil
        }
    }

    /// Same rule as web `cleanAgentSelector`: trim Zs + tab, refuse Cc/Cf,
    /// count Unicode scalars (JS code points) — not graphemes, not UTF-16 units.
    static func cleanAgentSelector(_ raw: String) -> String? {
        let agent = raw.trimmingCharacters(in: .whitespaces)
        guard !agent.isEmpty, agent.unicodeScalars.count <= maxAgentLength,
              agent.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else { return nil }
        return agent
    }

    /// Record a launch URL. A malformed URL is ignored and leaves any pending
    /// intent alone. An `open` link supersedes a pending call (newest tap
    /// wins), so a stale call never fires after the user just opened the app.
    @discardableResult
    public static func receive(_ url: URL, defaults: LaunchIntentStore = UserDefaults.standard, now: Date = Date()) -> Bool {
        guard let action = action(for: url) else { return false }
        guard action == .call else {
            defaults.removeObject(forKey: intentKey)
            return true
        }
        let intent: [String: Any] = [
            "id": UUID().uuidString,
            "url": url.absoluteString,
            "createdAt": (now.timeIntervalSince1970 * 1000).rounded(),
        ]
        defaults.set(intent, forKey: intentKey)
        instance?.notifyListeners("launch", data: intent)
        return true
    }

    /// The pending intent, if one is stored and well formed.
    public static func pending(defaults: LaunchIntentStore = UserDefaults.standard) -> [String: Any]? {
        guard let stored = defaults.dictionary(forKey: intentKey),
              let id = stored["id"] as? String, UUID(uuidString: id) != nil,
              let raw = stored["url"] as? String,
              request(forRaw: raw)?.action == .call,
              let createdAt = stored["createdAt"] as? Double else { return nil }
        return ["id": id, "url": raw, "createdAt": createdAt]
    }

    /// Clear the pending intent iff it is still the one acknowledged; a newer
    /// tap that landed meanwhile survives.
    public static func acknowledge(_ id: String?, defaults: LaunchIntentStore = UserDefaults.standard) {
        guard let id, (defaults.dictionary(forKey: intentKey)?["id"] as? String) == id else { return }
        defaults.removeObject(forKey: intentKey)
    }

    @objc func getIntent(_ call: CAPPluginCall) {
        call.resolve(["intent": Self.pending() as Any? ?? NSNull()])
    }
    @objc func acknowledgeIntent(_ call: CAPPluginCall) {
        Self.acknowledge(call.getString("id"))
        call.resolve()
    }
}
