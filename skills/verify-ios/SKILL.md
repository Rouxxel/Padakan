---
name: verify-ios
description: "The verify kit for iOS targets: MobileBuildMCP or xcodebuild and simctl on a macOS sandbox, simulator recording. Load when proving an iOS change."
---

# Verify kit: iOS

Runs on a macOS sandbox (Devin `platform: macos`, or the local Mac host).

| Tool | Use |
|---|---|
| MobileBuildMCP (getsentry) | build, run and test on the simulator, UI automation, logs |
| `xcodebuild` | build and run tests: `xcodebuild -scheme <S> -destination 'platform=iOS Simulator,name=iPhone 17' test` |
| `xcrun simctl` | boot, install, launch, record: `xcrun simctl io booted recordVideo run.mp4` |

Steps:
1. Build for the simulator and run the task's tests and the suite.
2. Install and launch the app; drive each criterion and assert on the UI tree and on the app's stored state or network calls.
3. Record the simulator screen for the whole flow; take numbered screenshots.
