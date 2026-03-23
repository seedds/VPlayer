# VPlayer

Expo React Native app for Android-first local video transfers and playback.

## Features

- Starts a local HTTP server on the phone.
- Lets a computer browser upload video files over the same Wi-Fi network.
- Stores uploaded videos in the app sandbox.
- Plays local videos with automatic landscape mode.

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

## App flow

1. Launch the app on an Android phone.
2. Open the Upload tab and note the local URL.
3. Visit that URL from a computer browser on the same Wi-Fi network.
4. Upload a video.
5. Open Library and tap Play.

## Notes

- Current work is focused on Android first.
- iOS local network permissions and packaging can be added later.
