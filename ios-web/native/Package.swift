// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BuzzNative",
    platforms: [.iOS(.v15)],
    products: [.library(name: "BuzzNative", targets: ["BuzzNative"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2"),
        .package(url: "https://github.com/rust-nostr/nostr-sdk-swift.git", exact: "0.45.1")
    ],
    targets: [.target(name: "BuzzNative", dependencies: [
        .product(name: "Capacitor", package: "capacitor-swift-pm"),
        .product(name: "NostrSDK", package: "nostr-sdk-swift")
    ])]
)
