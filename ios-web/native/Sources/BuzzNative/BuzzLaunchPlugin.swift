import Capacitor
import Foundation

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

    /// The validated action for a launch URL, or nil when it is not one.
    public static func action(for url: URL) -> Action? {
        guard url.scheme?.lowercased() == scheme, url.user == nil, url.password == nil,
              url.port == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        let host = (url.host ?? "").lowercased()
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        switch host {
        case "", "open":
            return items.isEmpty ? .open : nil
        case "call":
            if items.isEmpty { return .call }
            guard items.count == 1, items[0].name == "agent",
                  // Same rule as web `launchIntent.ts` (`cleanAgentSelector`):
                  // trim Zs + tab, refuse Cc/Cf, count Unicode scalars (JS code
                  // points) — not graphemes, not UTF-16 units.
                  let agent = items[0].value?.trimmingCharacters(in: .whitespaces),
                  !agent.isEmpty, agent.unicodeScalars.count <= maxAgentLength,
                  agent.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
            else { return nil }
            return .call
        default:
            return nil
        }
    }

    /// Record a launch URL. A malformed URL is ignored and leaves any pending
    /// intent alone. An `open` link supersedes a pending call (newest tap
    /// wins), so a stale call never fires after the user just opened the app.
    @discardableResult
    public static func receive(_ url: URL, defaults: UserDefaults = .standard, now: Date = Date()) -> Bool {
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
    public static func pending(defaults: UserDefaults = .standard) -> [String: Any]? {
        guard let stored = defaults.dictionary(forKey: intentKey),
              let id = stored["id"] as? String, UUID(uuidString: id) != nil,
              let raw = stored["url"] as? String, let url = URL(string: raw),
              action(for: url) == .call,
              let createdAt = stored["createdAt"] as? Double else { return nil }
        return ["id": id, "url": raw, "createdAt": createdAt]
    }

    /// Clear the pending intent iff it is still the one acknowledged; a newer
    /// tap that landed meanwhile survives.
    public static func acknowledge(_ id: String?, defaults: UserDefaults = .standard) {
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
