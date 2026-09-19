import Foundation
import Security
import LocalAuthentication
import NostrSDK

enum NativeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

/// No export/read-secret method crosses the bridge. Keys are held natively
/// during an active call so a locked-screen reconnect does not read Keychain.
final class NativeIdentity {
    static let shared = NativeIdentity()
    private var keys: Keys?
    private var explicitlyLocked = false
    private let account = "identity.v1"
    private init() {}

    static func read(_ account: String) throws -> Data? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Bundle.main.bundleIdentifier ?? "com.buzz.web",
            kSecAttrAccount: account, kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ] as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeError.message("Secure storage unavailable (\(status)).") }
        return item as? Data
    }

    static func write(_ account: String, data: Data?) throws {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
            kSecAttrService: Bundle.main.bundleIdentifier ?? "com.buzz.web", kSecAttrAccount: account]
        if let data {
            let attributes: [CFString: Any] = [kSecValueData: data,
                kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
            var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw NativeError.message("Secure storage write failed (\(status)).") }
        } else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw NativeError.message("Secure storage removal failed (\(status)).")
            }
        }
    }

    func signer() throws -> Keys {
        if explicitlyLocked { throw NativeError.message("Unlock this identity first.") }
        if let keys { return keys }
        guard let bytes = try Self.read(account), let hex = String(data: bytes, encoding: .utf8) else {
            throw NativeError.message("Pair or import an identity first.")
        }
        let loaded = try Keys.parse(secretKey: hex)
        keys = loaded
        return loaded
    }

    func state() -> [String: Any] {
        let key = try? signer()
        return ["pubkey": key.map { $0.publicKey().toHex() } as Any? ?? NSNull(), "locked": explicitlyLocked]
    }

    func enroll(_ secret: String) throws -> [String: Any] {
        guard secret.count == 64, secret.allSatisfy({ $0.isHexDigit }) else { throw NativeError.message("Invalid identity key.") }
        let parsed = try Keys.parse(secretKey: secret)
        try Self.write(account, data: Data(secret.utf8))
        keys = parsed
        explicitlyLocked = false
        return state()
    }

    func unlock() async throws -> [String: Any] {
        let context = LAContext()
        let accepted = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock your Buzz identity")
        guard accepted else { throw NativeError.message("Identity remains locked.") }
        explicitlyLocked = false
        _ = try signer()
        return state()
    }

    func lock() { keys = nil; explicitlyLocked = true }
    func forget() throws { try Self.write(account, data: nil); keys = nil; explicitlyLocked = false }

    func sign(_ template: [String: Any]) throws -> [String: Any] {
        let keys = try signer()
        var unsigned = template
        unsigned["pubkey"] = keys.publicKey().toHex()
        unsigned["created_at"] = template["created_at"] ?? Int(Date().timeIntervalSince1970)
        let bytes = try JSONSerialization.data(withJSONObject: unsigned, options: [.sortedKeys])
        guard let json = String(data: bytes, encoding: .utf8) else { throw NativeError.message("Invalid event.") }
        let event = try keys.signEvent(unsignedEvent: UnsignedEvent.fromJson(json: json))
        guard let result = try JSONSerialization.jsonObject(with: Data(event.asJson().utf8)) as? [String: Any] else {
            throw NativeError.message("Invalid signed event.")
        }
        return result
    }
}
