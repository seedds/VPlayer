# VPlayer

VPlayer is an Android-first app that does two things:

- hosts a local HTTP server so you can upload files from a browser on the same Wi-Fi
- plays local video files on the device

## Features

- Local HTTP upload server running on the phone.
- Browser-based uploads from another device on the same Wi-Fi network.
- Local video playback on the device.
- Automatic landscape playback for videos.

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
3. Visit that URL from a browser on the same Wi-Fi network and upload a video.
4. Open Library and play the uploaded file.

## Notes

- Current work is focused on Android first.
- iOS local network permissions and packaging can be added later.
