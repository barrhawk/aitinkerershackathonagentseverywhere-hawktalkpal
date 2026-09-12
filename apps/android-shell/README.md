# Hey Hawk — Android shell

A thin Flutter wrapper around the `/voice` page so the demo runs as an app on a phone:

- full-screen WebView with the mic granted and a self-signed dev certificate accepted,
- a **native wake word** ("hey hawk") via the Android speech recognizer, because a WebView has no Web Speech API; on detection it dispatches a `hawk-wake` event into the page,
- a **mic handoff**: the page posts `mic:busy` / `mic:free` on the `HawkNative` channel and the native listener steps aside while the page records or speaks (Android gives the mic to one client),
- edge-to-edge system UI with the nav bar kept visible; Back steps back in the page or exits.

The page itself lives in `apps/web`. This shell only points at it.

```bash
cd apps/android-shell
flutter pub get
flutter build apk --release \
  --dart-define=HAWK_URL=https://<laptop-lan-ip>:3443/voice \
  --dart-define=HAWK_URL_ALT=https://<laptop-tailnet-ip>:3443/voice
adb install -r build/app/outputs/flutter-apk/app-release.apk
```

`:3443` is any local HTTPS terminator in front of the Next dev server on `127.0.0.1:3100` (the mic needs HTTPS). Not in the repo.
