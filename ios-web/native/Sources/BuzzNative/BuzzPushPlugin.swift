import Capacitor
import DeviceCheck
import UserNotifications
import UIKit

@objc(BuzzPushPlugin)
public final class BuzzPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BuzzPushPlugin"
    public let jsName = "BuzzPush"
    public let pluginMethods: [CAPPluginMethod] = ["requestAuthorizationAndRegister", "apnsToken", "isSupported", "generateKey", "attest", "assertKey", "readState", "writeState", "getWake", "acknowledgeWake"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private static weak var instance: BuzzPushPlugin?
    private static var token: String?
    private static let wakeKey = "buzz.pending-wake.v2"
    public override func load() { Self.instance = self }

    public static func receiveToken(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        Self.token = token
        Self.instance?.notifyListeners("token", data: ["token": token])
    }
    public static func receiveWake(_ userInfo: [AnyHashable: Any]) {
        guard let buzz = userInfo["buzz"] as? [String: Any],
              (buzz["v"] as? Int) == 2,
              let id = buzz["wake_id"] as? String, UUID(uuidString: id) != nil else { return }
        UserDefaults.standard.set(id, forKey: wakeKey)
        instance?.notifyListeners("wake", data: ["wakeId": id])
    }
    @objc func requestAuthorizationAndRegister(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            DispatchQueue.main.async {
                if let error { call.reject(error.localizedDescription); return }
                if granted { UIApplication.shared.registerForRemoteNotifications() }
                call.resolve(["granted": granted])
            }
        }
    }
    @objc func apnsToken(_ call: CAPPluginCall) { call.resolve(["token": Self.token as Any? ?? NSNull()]) }
    @objc func isSupported(_ call: CAPPluginCall) {
        #if DEBUG
        let profile = "buzz-capacitor-ios-sandbox"
        #else
        let profile = "buzz-capacitor-ios-production"
        #endif
        call.resolve(["supported": DCAppAttestService.shared.isSupported, "appProfile": profile])
    }
    @objc func generateKey(_ call: CAPPluginCall) {
        DCAppAttestService.shared.generateKey { id, error in
            if let id { call.resolve(["keyId": id]) } else { call.reject(error?.localizedDescription ?? "App Attest key unavailable.") }
        }
    }
    private func hashArguments(_ call: CAPPluginCall) -> (String, Data)? {
        guard let id = call.getString("keyId"), !id.isEmpty,
              let encoded = call.getString("clientDataHash"),
              let hash = Data(base64Encoded: encoded), hash.count == 32 else {
            call.reject("Expected keyId and base64 SHA256 digest."); return nil
        }
        return (id, hash)
    }
    @objc func attest(_ call: CAPPluginCall) {
        guard let (id, hash) = hashArguments(call) else { return }
        DCAppAttestService.shared.attestKey(id, clientDataHash: hash) { data, error in
            if let data { call.resolve(["attestation": data.base64EncodedString()]) }
            else { call.reject(error?.localizedDescription ?? "App attestation failed.") }
        }
    }
    @objc func assertKey(_ call: CAPPluginCall) {
        guard let (id, hash) = hashArguments(call) else { return }
        DCAppAttestService.shared.generateAssertion(id, clientDataHash: hash) { data, error in
            if let data { call.resolve(["assertion": data.base64EncodedString()]) }
            else { call.reject(error?.localizedDescription ?? "App assertion failed.") }
        }
    }
    @objc func readState(_ call: CAPPluginCall) {
        do {
            let data = try NativeIdentity.read("push." + (call.getString("scope") ?? ""))
            call.resolve(["value": data.flatMap { String(data: $0, encoding: .utf8) } as Any? ?? NSNull()])
        } catch { call.reject(error.localizedDescription) }
    }
    @objc func writeState(_ call: CAPPluginCall) {
        do {
            try NativeIdentity.write("push." + (call.getString("scope") ?? ""), data: call.getString("value").map { Data($0.utf8) })
            call.resolve()
        } catch { call.reject(error.localizedDescription) }
    }
    @objc func getWake(_ call: CAPPluginCall) { call.resolve(["wakeId": UserDefaults.standard.string(forKey: Self.wakeKey) as Any? ?? NSNull()]) }
    @objc func acknowledgeWake(_ call: CAPPluginCall) {
        if call.getString("wakeId") == UserDefaults.standard.string(forKey: Self.wakeKey) {
            UserDefaults.standard.removeObject(forKey: Self.wakeKey)
        }
        call.resolve()
    }
}
