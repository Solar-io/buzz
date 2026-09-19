import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const simulator = process.env.BUZZ_IOS_TEST_SIMULATOR;
if (!simulator || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(simulator)) {
  process.stderr.write("Set BUZZ_IOS_TEST_SIMULATOR to the UUID of your dedicated test simulator. This script never creates, erases, or selects a user's device automatically.\n");
  process.exit(2);
}
const result = spawnSync("xcodebuild", [
  "-project", "ios/App/App.xcodeproj", "-scheme", "BuzzNativeTests",
  "-destination", `platform=iOS Simulator,id=${simulator}`,
  "-derivedDataPath", "build-qa", "CODE_SIGN_IDENTITY=-", "test",
], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" });
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exit(result.status ?? 1);
