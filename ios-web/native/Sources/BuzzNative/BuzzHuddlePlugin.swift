import Capacitor

@objc(BuzzHuddlePlugin)
public final class BuzzHuddlePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BuzzHuddlePlugin"
    public let jsName = "BuzzHuddle"
    public let pluginMethods: [CAPPluginMethod] = ["snapshot", "join", "leave", "configure"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    public override func load() {
        NativeHuddle.shared.onState = { [weak self] state in self?.notifyListeners("state", data: state) }
    }
    @objc func snapshot(_ call: CAPPluginCall) { call.resolve(NativeHuddle.shared.snapshot()) }
    @objc func join(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try NativeHuddle.shared.join(relay: call.getString("relayUrl") ?? "", channel: call.getString("channelId") ?? "", parent: call.getString("parentChannelId") ?? "", stt: call.getString("sttUrl") ?? "", tts: call.getString("ttsUrl") ?? "")
                call.resolve(NativeHuddle.shared.snapshot())
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func leave(_ call: CAPPluginCall) { DispatchQueue.main.async { NativeHuddle.shared.leave(); call.resolve() } }
    @objc func configure(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try NativeHuddle.shared.configure(muted: call.getBool("muted"), speaker: call.getBool("speaker"), voiceEnabled: call.getBool("voiceEnabled"), speechEnabled: call.getBool("speechEnabled"), held: call.getBool("held"))
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }
}
