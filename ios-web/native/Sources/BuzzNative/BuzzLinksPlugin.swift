import Capacitor
import UIKit

@objc(BuzzLinksPlugin)
public final class BuzzLinksPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BuzzLinksPlugin"
    public let jsName = "BuzzLinks"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise)]
    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              let scheme = url.scheme, ["https", "http", "mailto", "tel"].contains(scheme),
              url.user == nil, url.password == nil else { call.reject("Unsupported external URL."); return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("No application can open this link.") }
            }
        }
    }
}
