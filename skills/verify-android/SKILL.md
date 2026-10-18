---
name: verify-android
description: "The verify kit for Android targets: AndroidBuildMCP or adb-mcp, Gradle, the emulator, logcat and screen recording. Load when proving an Android change."
---

# Verify kit: Android

Needs the Android SDK, JDK 17+ and an emulator with KVM (a Devin session with Android emulation, or the local host).

| Tool | Use |
|---|---|
| AndroidBuildMCP or adb-mcp | Gradle build, emulator, UI tree, taps and typing, logcat, screen recording |
| `./gradlew` | `assembleDebug`, unit tests, instrumented tests |
| `adb` | install, launch, `logcat`, `screenrecord` |

Steps:
1. Build and run the task's tests and the suite.
2. Boot the emulator, install, launch; drive each criterion and assert on the UI tree and logcat or network effects.
3. Record the screen (`adb shell screenrecord`, 3 minutes maximum per clip) and pull the file; take numbered screenshots.
