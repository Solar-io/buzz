import XCTest
import WebKit
import UIKit
import UserNotifications
import CryptoKit
import Capacitor
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
    func testZZBundledAppRestoresNativeIdentityIntoAuthenticatedPhoneShell() async throws {
        try requireIdentityFixtureSimulator()
        func findWebView(_ view: UIView) -> WKWebView? {
            if let webView = view as? WKWebView { return webView }
            return view.subviews.compactMap { findWebView($0) }.first
        }
        let webView = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).compactMap { findWebView($0) }.first)
        let original = try await webView.evaluateJavaScript("localStorage.getItem('buzz.native-services.v1')")
        XCTAssertTrue(original is NSNull, "This journey requires a clean, dedicated QA app installation")
        let enrolled = try await webView.callAsyncJavaScript(
            "return await window.Capacitor.nativePromise('BuzzIdentity', 'enroll', {secretHex: secret});",
            arguments: ["secret": String(repeating: "0", count: 63) + "1"], in: nil, contentWorld: .page)
        XCTAssertEqual((enrolled as? [String: Any])?["pubkey"] as? String, "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
        _ = try await webView.evaluateJavaScript("localStorage.setItem('buzz.native-services.v1', JSON.stringify({relayUrl:'wss://capacitor-qa.invalid',sttUrl:'',ttsUrl:'',pushGatewayUrl:''})); window.location.replace('/repos');")
        var shell = false
        for _ in 0..<100 {
            if let ready = try? await webView.evaluateJavaScript("!!document.querySelector('button[aria-label=\"Open channels\"]') && !document.body.innerText.includes('Enter key manually')") as? Bool, ready {
                shell = true; break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let text = (try? await webView.evaluateJavaScript("document.body.innerText.slice(0,700)")) as? String ?? "no rendered text"
        XCTAssertTrue(shell, "Native AuthProvider did not reach phone shell: \(text)")
        if shell {
            _ = try await webView.evaluateJavaScript("document.querySelector('button[aria-label=\"Open channels\"]').click()")
            let opened = try await webView.evaluateJavaScript("!!document.querySelector('button[aria-label=\"Close channels\"]')")
            XCTAssertEqual(opened as? Bool, true, "Phone channel drawer action must work")
        }
        // Only this disposable app's public config and deterministic fixture key are removed.
        _ = try await webView.evaluateJavaScript("localStorage.removeItem('buzz.native-services.v1')")
        try NativeIdentity.shared.forget()
        _ = try await webView.evaluateJavaScript("window.location.replace('/repos')")
    }

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

/// No fixture setup, enrollment, migration invocation, logout, permission
/// request, audio start, or device control belongs in this class.
final class DeviceReadOnlySmokeTests: XCTestCase {
    @MainActor
    func testRestoredIdentityAndAuthenticatedConnection() async throws {
#if targetEnvironment(simulator)
        throw XCTSkip("Physical read-only smoke is run separately with an exact -only-testing filter.")
#else
        try await inspectRestoredApplication()
#endif
    }

    @MainActor
    private func inspectRestoredApplication() async throws {
        func findWebView(_ view: UIView) -> WKWebView? {
            if let webView = view as? WKWebView { return webView }
            return view.subviews.compactMap { findWebView($0) }.first
        }
        var applicationWebView: WKWebView?
        for _ in 0..<100 {
            applicationWebView = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows).compactMap { findWebView($0) }.first
            if let webView = applicationWebView,
               let ready = try? await webView.evaluateJavaScript("!!window.Capacitor?.isPluginAvailable('BuzzIdentity')") as? Bool, ready { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let webView = try XCTUnwrap(applicationWebView, "The installed application has no WebView")
        XCTAssertEqual(webView.url?.scheme, "capacitor")
        XCTAssertEqual(webView.url?.host, "localhost")
        let result = try await webView.callAsyncJavaScript(
            "return await window.Capacitor.nativePromise('BuzzIdentity', 'state', {});",
            arguments: [:], in: nil, contentWorld: .page)
        let state = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(Set(state.keys), Set(["pubkey", "locked"]))
        XCTAssertEqual(state["locked"] as? Bool, false, "Unlock normally before running smoke; this test does not unlock anything")
        let pubkey = try XCTUnwrap(state["pubkey"] as? String, "No restored signed-in identity")
        XCTAssertEqual(pubkey.count, 64)
        if let expected = ProcessInfo.processInfo.environment["BUZZ_SMOKE_EXPECTED_PUBKEY"], !expected.isEmpty {
            XCTAssertEqual(pubkey, expected, "Restored public identity differs from the expected pre-upgrade identity")
        }
        let configValue = try await webView.evaluateJavaScript("localStorage.getItem('buzz.native-services.v1')")
        let raw = try XCTUnwrap(configValue as? String)
        let services = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: String])
        let relay = try XCTUnwrap(services["relayUrl"])
        let relayURL = try XCTUnwrap(URL(string: relay))
        XCTAssertEqual(relayURL.scheme, "wss")
        XCTAssertNotNil(relayURL.host)
        XCTAssertFalse(relayURL.host?.hasSuffix(".invalid") ?? true, "A fixture relay is not a physical connectivity receipt")
        var connected = false
        for _ in 0..<300 {
            if let ready = try? await webView.evaluateJavaScript("!!document.querySelector('button[aria-label=\"Open channels\"]') && !!document.querySelector('[title=\"Connected\"]')") as? Bool, ready { connected = true; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(connected, "Authenticated phone shell did not report a connected relay")
        // One signed read of this identity's public profile, never messages.
        var queryURL = try XCTUnwrap(URLComponents(url: relayURL, resolvingAgainstBaseURL: false))
        queryURL.scheme = "https"; queryURL.path = "/query"; queryURL.query = nil; queryURL.fragment = nil
        let endpoint = try XCTUnwrap(queryURL.url)
        let body = try JSONSerialization.data(withJSONObject: [["kinds": [0], "authors": [pubkey], "limit": 1]], options: [.sortedKeys])
        let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let auth = try NativeIdentity.shared.sign(["kind": 27235, "content": "", "tags": [
            ["u", endpoint.absoluteString], ["method", "POST"], ["payload", digest], ["nonce", UUID().uuidString]
        ]])
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Nostr \(try JSONSerialization.data(withJSONObject: auth).base64EncodedString())", forHTTPHeaderField: "Authorization")
        let (responseBody, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "Signed profile query was not accepted")
        let profiles = try XCTUnwrap(try JSONSerialization.jsonObject(with: responseBody) as? [[String: Any]])
        XCTAssertLessThanOrEqual(profiles.count, 1)
        XCTAssertTrue(profiles.allSatisfy { $0["pubkey"] as? String == pubkey && $0["kind"] as? Int == 0 })
        // Call the getter directly with a local result sink. The normal debug
        // JS bridge logs complete responses, which would expose the APNs token.
        var tokenPresent: Bool?
        let call = try XCTUnwrap(CAPPluginCall(callbackId: "readonly-smoke", methodName: "apnsToken", options: [:], success: { result, _ in
            tokenPresent = !((result?.data?["token"] as? String)?.isEmpty ?? true)
        }, error: { _ in tokenPresent = nil }))
        BuzzPushPlugin().apnsToken(call)
        let hasToken = try XCTUnwrap(tokenPresent, "Native token getter did not return")
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        let receipt = XCTAttachment(string: "Public identity: \(pubkey)\nRelay: \(relay)\nNotification authorization raw value: \(notificationSettings.authorizationStatus.rawValue)\nAPNs token present: \(hasToken)\nConnected shell: \(connected)\nSigned public-profile query: HTTP 200")
        receipt.name = "Read-only device metadata; no message content or secrets"
        receipt.lifetime = .keepAlways
        add(receipt)
    }
}
