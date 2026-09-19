import Capacitor
import NostrSDK

@objc(BuzzIdentityPlugin)
public final class BuzzIdentityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BuzzIdentityPlugin"
    public let jsName = "BuzzIdentity"
    public let pluginMethods: [CAPPluginMethod] = ["state", "enroll", "unlock", "lock", "forget", "signEvent", "encrypt", "decrypt"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private func perform(_ call: CAPPluginCall, _ work: () throws -> [String: Any]) {
        do { call.resolve(try work()) } catch { call.reject(error.localizedDescription) }
    }
    @objc func state(_ call: CAPPluginCall) { call.resolve(NativeIdentity.shared.state()) }
    @objc func enroll(_ call: CAPPluginCall) {
        perform(call) {
            guard NativeHuddle.shared.isIdle else { throw NativeError.message("Leave the call before changing identity.") }
            return try NativeIdentity.shared.enroll(call.getString("secretHex") ?? "")
        }
    }
    @objc func unlock(_ call: CAPPluginCall) {
        Task { @MainActor in
            do { call.resolve(try await NativeIdentity.shared.unlock()) } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func lock(_ call: CAPPluginCall) {
        NativeHuddle.shared.leave()
        NativeIdentity.shared.lock()
        call.resolve()
    }
    @objc func forget(_ call: CAPPluginCall) {
        NativeHuddle.shared.leave()
        perform(call) { try NativeIdentity.shared.forget(); return [:] }
    }
    @objc func signEvent(_ call: CAPPluginCall) {
        perform(call) {
            guard let event = call.getObject("event") else { throw NativeError.message("Event is required.") }
            return ["event": try NativeIdentity.shared.sign(event)]
        }
    }
    @objc func encrypt(_ call: CAPPluginCall) {
        perform(call) {
            let peer = try PublicKey.parse(publicKey: call.getString("peer") ?? "")
            return ["ciphertext": try NativeIdentity.shared.signer().nip44Encrypt(publicKey: peer, content: call.getString("plaintext") ?? "")]
        }
    }
    @objc func decrypt(_ call: CAPPluginCall) {
        perform(call) {
            let peer = try PublicKey.parse(publicKey: call.getString("peer") ?? "")
            return ["plaintext": try NativeIdentity.shared.signer().nip44Decrypt(publicKey: peer, payload: call.getString("ciphertext") ?? "")]
        }
    }
}
