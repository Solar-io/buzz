import type { CapacitorConfig } from "@capacitor/cli";

// Bundle the UI. A remote server.url would give network content the bridge.
const config: CapacitorConfig = {
  appId: process.env.BUZZ_IOS_BUNDLE_ID || "com.buzz.web",
  appName: "Buzz Web",
  webDir: "../web/dist",
  ios: { scheme: "App", contentInset: "never" },
  server: { hostname: "localhost", iosScheme: "capacitor" },
};
export default config;
