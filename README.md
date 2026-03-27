# VPlayer

VPlayer is an Android-first app that does two things:

- hosts a local HTTP server so you can upload files from a browser on the same Wi-Fi
- plays local video files on the device

## Features

- Local HTTP upload server running on the phone.
- Browser-based uploads from another device on the same Wi-Fi network.
- Local video playback on the device.
- Automatic landscape playback for videos.
- Portrait library screens on phones, with landscape playback only while a video is open.
- Background playback gestures in the player:
  - single tap to show or hide controls
  - one-finger double tap to play or pause
  - two-finger double tap to lock or unlock the player controls
- Locked player mode that hides the control chrome except the lock button.
- Continuous scrub preview popup above the seek bar while seeking.

## Local development

```bash
npm install
npx expo start
```

Because the project uses a native HTTP server module, use a custom development build instead of Expo Go.

## Android APK builds

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build -p android --profile preview
```

- `development`: installable dev client APK
- `preview`: installable APK for testers
- `production`: Play Store AAB

### Local Gradle build

Build a local release APK from the Android project:

```bash
cd android
./gradlew assembleRelease
```

Output file:

- `android/app/build/outputs/apk/release/vplayer.apk`

Build an ARM64-only APK:

```bash
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Before running Gradle locally, make sure Android SDK and JDK 17 are configured. You can either set `ANDROID_HOME` / `ANDROID_SDK_ROOT`, or create `android/local.properties` with:

```properties
sdk.dir=/Users/<your-user>/Library/Android/sdk
```

## App flow

1. Launch the app on an Android phone.
2. Open the Upload tab and note the local URL.
3. Visit that URL from a browser on the same Wi-Fi network and upload a video.
4. Open Library and play the uploaded file.

## Player controls

- `Back`: leave the player and save playback progress.
- `Next`: jump to the next video in the queue when available.
- `-10` / `+10`: seek backward or forward by ten seconds.
- Scrub the progress bar to preview frames in a popup before releasing.
- Tap the center lock button to hide the rest of the controls.
- When the device sleeps and wakes again, playback stays paused and the player returns to unlocked mode.

## Notes

- Current work is focused on Android first.
- iOS local network permissions and packaging can be added later.
