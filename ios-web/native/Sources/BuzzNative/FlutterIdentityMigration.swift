import Foundation
import Security
import NostrSDK

/// Reads the legacy app's own Keychain namespace only during an in-place
/// upgrade. Secret material stays within Swift; Flutter records are preserved.
enum FlutterIdentityMigration {
    struct Candidate {
        let id: String
        let name: String
        let relay: String
        let keys: Keys
        var descriptor: [String: String] {
            ["id": id, "name": name, "relayUrl": relay, "pubkey": keys.publicKey().toHex()]
        }
    }

    static func read(_ account: String) throws -> Data? {
        var value: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "flutter_secure_storage_service",
            kSecAttrAccount: account,
            kSecAttrSynchronizable: false,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ] as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeError.message("Unlock the iPhone to restore the previous Buzz login.") }
        return value as? Data
    }

    static func secureRelay(_ raw: String) throws -> String {
        guard var url = URLComponents(string: raw),
              let scheme = url.scheme?.lowercased(), ["wss", "https"].contains(scheme),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw NativeError.message("The previous Buzz community has an invalid secure relay.")
        }
        url.scheme = "wss"
        url.path = ""
        guard let result = url.string else { throw NativeError.message("Invalid previous relay.") }
        return result
    }

    static func candidates(_ data: Data, activeId: String?) throws -> [Candidate] {
        guard data.count <= 1_048_576,
              let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              rows.count <= 64 else {
            throw NativeError.message("The previous Buzz community list is invalid.")
        }
        var result: [Candidate] = []
        for row in rows {
            guard let id = row["id"] as? String, !id.isEmpty else { continue }
            do {
                guard let secret = row["nsec"] as? String, !secret.isEmpty,
                      let relay = row["relayUrl"] as? String else {
                    if id == activeId { throw NativeError.message("The previous active community has no saved login.") }
                    continue
                }
                let keys = try Keys.parse(secretKey: secret)
                if let stored = row["pubkey"] as? String, !stored.isEmpty {
                    guard try PublicKey.parse(publicKey: stored).toHex() == keys.publicKey().toHex() else {
                        throw NativeError.message("The previous Buzz identity does not match its public key.")
                    }
                }
                result.append(Candidate(id: id, name: row["name"] as? String ?? "Buzz", relay: try secureRelay(relay), keys: keys))
            } catch {
                if id == activeId { throw NativeError.message("The previous active login could not be verified. Pair or import your identity instead.") }
            }
        }
        guard Set(result.map(\.id)).count == result.count else {
            throw NativeError.message("The previous Buzz community identifiers are ambiguous.")
        }
        return result
    }

    static func choose(_ candidates: [Candidate], activeId: String?, selectedId: String?) throws -> Candidate? {
        if let selectedId {
            guard let match = candidates.first(where: { $0.id == selectedId }) else {
                throw NativeError.message("The selected previous community is unavailable.")
            }
            return match
        }
        if let activeId, let match = candidates.first(where: { $0.id == activeId }) { return match }
        return candidates.count == 1 ? candidates.first : nil
    }

    static func restore(selectedId: String?) throws -> [String: Any] {
        if try NativeIdentity.read("identity.v1") != nil {
            var response: [String: Any] = ["status": "existing"]
            if let relay = UserDefaults.standard.string(forKey: "buzz.migrated-flutter-relay") { response["relayUrl"] = relay }
            return response
        }
        // Keeping Flutter records for rollback must not resurrect a key that
        // the user has since explicitly replaced or forgotten in this app.
        if UserDefaults.standard.bool(forKey: "buzz.flutter-migration-completed") {
            return ["status": "none"]
        }
        let primary = try read("buzz_communities")
        let old = primary == nil ? try read("buzz_workspaces") : nil
        let activeName = primary == nil ? "buzz_active_workspace_id" : "buzz_active_community_id"
        let active = try read(activeName).flatMap { String(data: $0, encoding: .utf8) }
        var rows = primary ?? old
        if rows == nil,
           let relayData = try read("buzz_relay_url"), let relay = String(data: relayData, encoding: .utf8),
           let secretData = try read("buzz_nsec"), let secret = String(data: secretData, encoding: .utf8) {
            var row: [String: Any] = ["id":"legacy", "name":"Previous Buzz", "relayUrl":relay, "nsec":secret]
            if let publicData = try read("buzz_pubkey"), let pubkey = String(data: publicData, encoding: .utf8) { row["pubkey"] = pubkey }
            rows = try JSONSerialization.data(withJSONObject: [row])
        }
        guard let rows else { return ["status": "none"] }
        let valid = try candidates(rows, activeId: active)
        guard !valid.isEmpty else { return ["status": "none"] }
        guard let chosen = try choose(valid, activeId: active, selectedId: selectedId) else {
            return ["status": "choice", "choices": valid.map(\.descriptor)]
        }
        _ = try NativeIdentity.shared.enroll(chosen.keys.secretKey().toHex())
        guard let stored = try NativeIdentity.read("identity.v1"),
              let secret = String(data: stored, encoding: .utf8),
              try Keys.parse(secretKey: secret).publicKey().toHex() == chosen.keys.publicKey().toHex() else {
            throw NativeError.message("The restored login could not be verified in secure storage.")
        }
        UserDefaults.standard.set(chosen.relay, forKey: "buzz.migrated-flutter-relay")
        return ["status":"migrated", "relayUrl":chosen.relay, "pubkey":chosen.keys.publicKey().toHex()]
    }
}
