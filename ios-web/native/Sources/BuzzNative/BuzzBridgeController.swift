import Capacitor
import WebKit

/// All bridge messages, including built-in plugins, pass this frame gate.
/// A same-page URL check alone would trust a hostile embedded Files frame.
final class MainFrameBridgeGate: NSObject, WKScriptMessageHandler {
    let downstream: WKScriptMessageHandler
    init(_ downstream: WKScriptMessageHandler) { self.downstream = downstream }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              origin.protocol == "capacitor", origin.host == "localhost",
              message.webView?.url?.scheme == "capacitor",
              message.webView?.url?.host == "localhost" else { return }
        downstream.userContentController(controller, didReceive: message)
    }
}

public final class BuzzBridgeController: CAPBridgeViewController {
    private var gate: MainFrameBridgeGate?
    public override func capacitorDidLoad() {
        guard let webView, let handler = webView.navigationDelegate as? WebViewDelegationHandler else { return }
        let gate = MainFrameBridgeGate(handler)
        self.gate = gate
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        webView.configuration.userContentController.add(gate, name: "bridge")
        bridge?.registerPluginInstance(BuzzIdentityPlugin())
        bridge?.registerPluginInstance(BuzzPushPlugin())
        bridge?.registerPluginInstance(BuzzHuddlePlugin())
        bridge?.registerPluginInstance(BuzzLinksPlugin())
    }
}
