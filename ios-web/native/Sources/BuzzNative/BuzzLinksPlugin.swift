import Capacitor
import SafariServices
import UIKit

@objc(BuzzLinksPlugin)
public final class BuzzLinksPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BuzzLinksPlugin"
    public let jsName = "BuzzLinks"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openInApp", returnType: CAPPluginReturnPromise),
    ]

    private static func allowedURL(_ call: CAPPluginCall, schemes: [String]) -> URL? {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              let scheme = url.scheme, schemes.contains(scheme),
              url.user == nil, url.password == nil else { return nil }
        return url
    }

    @objc func openExternal(_ call: CAPPluginCall) {
        guard let url = Self.allowedURL(call, schemes: ["https", "http", "mailto", "tel"]) else {
            call.reject("Unsupported external URL."); return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("No application can open this link.") }
            }
        }
    }

    /// Web-panel sites (Files, shortcuts) in an in-app Safari sheet. An iframe
    /// in the app's WKWebView is third-party to them, and WebKit drops their
    /// session cookies there, so cookie-auth sites loop on sign-in. The sheet
    /// is first-party and shares Safari's cookies.
    @objc func openInApp(_ call: CAPPluginCall) {
        guard let url = Self.allowedURL(call, schemes: ["https", "http"]) else {
            call.reject("Unsupported URL."); return
        }
        DispatchQueue.main.async { [weak self] in
            guard var presenter = self?.bridge?.viewController else {
                call.reject("No view to present from."); return
            }
            while let next = presenter.presentedViewController { presenter = next }
            presenter.present(SFSafariViewController(url: url), animated: true) { call.resolve() }
        }
    }
}
