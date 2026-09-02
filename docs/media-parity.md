# RWANG desktop media-parity harness

`/desktop-diagnostics.html` is a local-only diagnostic page for the Wave 2
Tauri/WebView2 slice. It is intentionally separate from the main assistant UI
so a desktop build can be checked without changing the browser fallback.

## What is checked automatically

On page load the harness reads capability properties only. It does not call a
permission API, start speech, create a WebRTC peer connection, register a
service worker, or compile WebAssembly. The result table covers:

- loopback origin and `window.isSecureContext`;
- `navigator.mediaDevices.getUserMedia` and `getDisplayMedia` presence;
- `RTCPeerConnection`, `SpeechRecognition`/`webkitSpeechRecognition`, and
  `speechSynthesis` presence;
- WebAssembly and service-worker API presence; and
- the local MediaPipe module, six WASM files, and gesture/face model URLs.

MediaPipe probes are same-origin `HEAD` requests with omitted credentials,
redirect rejection, and no response body download. The optional hand model may
report `WARN` when it is not packaged. A required asset failure is `FAIL`.

## Active checks

The three active checks are separate user buttons: `TEST CAMERA`, `TEST
MICROPHONE`, and `TEST DISPLAY`. A button click is the only path that calls
`getUserMedia` or `getDisplayMedia`; dismissing a browser prompt is a valid
diagnostic outcome. When a stream is returned, every track is stopped
immediately before the result is shown. The page never assigns a stream to a
video element, records samples, persists media, or sends media anywhere.

Run the page from the sidecar origin, for example:

```text
http://127.0.0.1:<port>/desktop-diagnostics.html
```

Do not use a LAN URL or an untrusted remote host for this page. The origin check
will mark it for review and skip asset probes.

## Manual Tauri / WebView2 gate

The checkboxes at the bottom are an operator gate, not an automated security
claim. In a packaged Windows build:

1. Launch the Tauri app and open the diagnostics path on the exact sidecar
   loopback origin. Confirm `isSecureContext` is `true` and the passive table
   has no unexpected required-asset failures.
2. Confirm the app is using the supported WebView2 runtime and that the normal
   RWANG page still loads from the same sidecar origin.
3. Click each active media button one at a time. Approve a real device/window
   only for the duration of the check, then confirm the result says that all
   tracks were stopped immediately. Canceling the prompt should not leave a
   stream running.
4. Inspect DevTools Network while repeating the checks. Requests should remain
   same-origin local asset probes; there must be no CDN, upload, beacon,
   WebSocket, or telemetry request.
5. Close and relaunch the packaged app. Confirm the sidecar exits with the app,
   no orphan process remains, and no permission or capture indicator remains
   after the page is closed.
6. Tick all five attestations and press `RECORD LOCAL GATE`. The result is held
   in the current page only and is never persisted or uploaded.

If a capability is `WARN`, record the browser/WebView2 version and the exact
button behavior in the release notes. A missing secure context or required
MediaPipe asset is a release-blocking `FAIL` until the packaged origin or
resource bundle is corrected.

## Static checks

From the repository root:

```powershell
node --check public/desktop-diagnostics.js
node tests/media-parity.mjs
pnpm check
git diff --check
```

The static harness verifies same-origin resource references, no inline event
handlers or embedded remote surfaces, explicit user buttons, immediate track
cleanup, no upload/telemetry APIs, local-only MediaPipe paths, and the presence
of this manual Tauri/WebView2 gate.
