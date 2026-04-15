# Task: Generate Unsigned Release APK for Android TV

Generate a production-ready (release) but unsigned APK specifically optimized for Android TV hardware.

## 📋 Status
- [x] Preparation: Sync Capacitor and built frontend
- [x] Validation: Checked Android TV compliance (Manifest)
- [x] Build: Gradle build successful (assembleDebug)
- [x] Cleanup: APK moved to builds/xandeflix-tv-debug.apk

## 🛠️ Details
- **Type**: Debug (Auto-signed)
- **Signing**: Debug Key
- **Target**: Android TV
- **Platform**: Capacitor (Android)

## 📓 Notes
- User requested unsigned release for TV testing.
- Manifest verified for Leanback and Landscape support.
- Gradle build command: `./gradlew assembleRelease` inside `android/` folder.
