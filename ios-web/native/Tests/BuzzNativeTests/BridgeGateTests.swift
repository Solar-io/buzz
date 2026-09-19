import XCTest
import WebKit
import UIKit
@testable import BuzzNative

private final class MessageCapture: NSObject, WKScriptMessageHandler {
    var values: [String] = []
    let receipt: XCTestExpectation
    init(_ receipt: XCTestExpectation) { self.receipt = receipt }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        values.append(message.body as? String ?? "invalid")
        receipt.fulfill()
    }
}

private final class FixtureScheme: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url!
        let label = url.path == "/main" ? "main" : url.host == "localhost" ? "same-origin-frame" : "foreign-frame"
        let frames = url.path == "/main" ? "<iframe src='capacitor://localhost/frame'></iframe><iframe src='capacitor://foreign.invalid/frame'></iframe>" : ""
        let html = "<html><body><script>window.webkit.messageHandlers.bridge.postMessage('\(label)');window.webkit.messageHandlers.witness.postMessage('\(label)');</script>\(frames)</body></html>"
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: html.utf8.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(Data(html.utf8))
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

final class BridgeGateTests: XCTestCase {
    @MainActor
    func testBundledApplicationRendersSetupAndRegistersNativeIdentityBridge() async throws {
        try XCTSkipUnless(Bundle.main.bundleURL.pathExtension == "app", "Requires the app-hosted scheme and its actual bundled UI.")
        func findWebView(_ view: UIView) -> WKWebView? {
            if let webView = view as? WKWebView { return webView }
            return view.subviews.compactMap { findWebView($0) }.first
        }
        var appWebView: WKWebView?
        var rendered = false
        for _ in 0..<100 {
            appWebView = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows).compactMap { findWebView($0) }.first
            if let webView = appWebView,
               let ready = try? await webView.evaluateJavaScript("document.querySelector('h1')?.textContent === 'Connect Buzz' && !!document.querySelector('input[aria-label=Relay]') && !!window.Capacitor?.isNativePlatform()") as? Bool,
               ready {
                rendered = true; break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(rendered, "The actual bundled app must render its native first-launch setup controls")
        let webView = try XCTUnwrap(appWebView)
        XCTAssertEqual(webView.url?.scheme, "capacitor")
        XCTAssertEqual(webView.url?.host, "localhost")
        let plugin = try await webView.evaluateJavaScript("window.Capacitor.isPluginAvailable('BuzzIdentity')")
        XCTAssertEqual(plugin as? Bool, true)
    }

    @MainActor
    func testRealWebKitRejectsBothIframeOriginsButDeliversTrustedMainFrame() async throws {
        let accepted = expectation(description: "trusted main bridge message")
        accepted.assertForOverFulfill = true
        let attempted = expectation(description: "all actual script attempts")
        attempted.expectedFulfillmentCount = 3
        let sink = MessageCapture(accepted)
        let witness = MessageCapture(attempted)
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(FixtureScheme(), forURLScheme: "capacitor")
        config.userContentController.add(MainFrameBridgeGate(sink), name: "bridge")
        config.userContentController.add(witness, name: "witness")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.load(URLRequest(url: URL(string: "capacitor://localhost/main")!))
        await fulfillment(of: [accepted, attempted], timeout: 15)
        XCTAssertEqual(sink.values, ["main"])
        XCTAssertEqual(Set(witness.values), Set(["main", "same-origin-frame", "foreign-frame"]))
        webView.stopLoading()
        config.userContentController.removeAllScriptMessageHandlers()
    }

    @MainActor
    func testRealWebKitRejectsForeignTopLevelBridgeOrigin() async throws {
        let rejected = expectation(description: "foreign main is rejected")
        rejected.isInverted = true
        let attempted = expectation(description: "foreign main script executed")
        let sink = MessageCapture(rejected)
        let witness = MessageCapture(attempted)
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(FixtureScheme(), forURLScheme: "capacitor")
        config.userContentController.add(MainFrameBridgeGate(sink), name: "bridge")
        config.userContentController.add(witness, name: "witness")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.load(URLRequest(url: URL(string: "capacitor://foreign.invalid/frame")!))
        await fulfillment(of: [attempted], timeout: 15)
        await fulfillment(of: [rejected], timeout: 0.25)
        XCTAssertTrue(sink.values.isEmpty)
        XCTAssertEqual(witness.values, ["foreign-frame"])
        webView.stopLoading()
        config.userContentController.removeAllScriptMessageHandlers()
    }
}
