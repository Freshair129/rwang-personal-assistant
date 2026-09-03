---
version: "0.2.0b"
created_at: "2026-09-03T02:33:20+07:00,RWANG,3a6657caf0519f54b8bee05658f3047856e64b65"
last_update: "2026-09-04T06:02:32+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "desktop-diagnostics"
  scope: "WebView2 media parity"
  doc_type: "core-directive"
  target_product_version: "0.5.0"
---

# RWANG desktop media-parity harness

`/desktop-diagnostics.html` is the on-device, no-telemetry diagnostic page for
the Tauri/WebView2 media slice. “Local” describes data handling: results stay
in page memory, streams are stopped, and nothing is persisted or uploaded. It
is not an access-control claim. In browser/PWA mode the server binding still
determines who can request this static page.

The release gate is valid only on the packaged desktop's exact sidecar origin:

```text
http://127.0.0.1:<selected-port>/desktop-diagnostics.html
```

Do not use a LAN or untrusted remote origin as desktop release evidence. A
non-loopback origin is marked `FAIL` and asset probes are skipped, but that UI
check does not replace server-side access control.

## Passive checks

On page load the harness reads capability properties only. It does not request
permission, start speech, create a peer connection, register a service worker,
or compile WebAssembly. The table covers:

- loopback origin and `window.isSecureContext`;
- `getUserMedia`, `getDisplayMedia`, `RTCPeerConnection`, speech recognition,
  and speech synthesis availability;
- WebAssembly and service-worker API availability; and
- the same-origin MediaPipe module, WASM files, and gesture/face model URLs.

MediaPipe probes are credential-free same-origin `HEAD` requests with redirect
rejection and no response body download. The optional hand model may be
`WARN`; a required asset failure is `FAIL`.

## Active checks

`TEST CAMERA`, `TEST MICROPHONE`, and `TEST DISPLAY` are separate user-gesture
buttons. Only those handlers call `getUserMedia` or `getDisplayMedia`.
Dismissing a permission prompt is a valid diagnostic outcome. When a stream is
returned, every track is stopped immediately before a result is rendered.

The page never attaches a stream to media output, records samples, retains a
stream reference, writes `localStorage`/`sessionStorage`/IndexedDB, or sends
results through telemetry, beacon, XHR, WebSocket, or EventSource APIs. The
manual attestation also exists only in current page memory.

## Manual Tauri / WebView2 gate

The checkboxes are operator attestations, not automated security claims. In a
packaged Windows build:

1. Open the diagnostic page on the exact selected loopback sidecar origin.
   Confirm `isSecureContext` is true and required assets have no unexpected
   failure.
2. Confirm the supported WebView2 runtime is active and the normal RWANG page
   still loads on the same origin.
3. Run camera, microphone, and display one at a time. Approve a real target
   only for the test, then confirm all returned tracks stop immediately.
4. Inspect DevTools Network. Only same-origin local asset probes are expected;
   there must be no CDN, upload, beacon, WebSocket, or telemetry request.
5. Tick all attestations and press `RECORD LOCAL GATE`. Confirm no result is
   written to disk or uploaded.
6. Close the window with **X** and confirm RWANG remains available in the tray;
   this intentionally does not stop the sidecar. Then choose **Tray > Quit**
   and confirm the sidecar exits, no orphan process remains, and no capture
   indicator remains.

A missing secure context or required MediaPipe asset is release-blocking. For
a `WARN`, record the WebView2 version and exact behavior in release evidence.

## Static checks

```powershell
node --check public/desktop-diagnostics.js
node tests/media-parity.mjs
pnpm check
git diff --check
```

The static harness verifies local resources, explicit media gestures,
immediate track cleanup, no persistence/telemetry primitives, same-origin
header-only asset probes, accurate loopback wording, and the real tray
lifecycle gate.

## VERSION DIFF

| From | To | Change |
|---|---|---|
| 0.1.0b beta | 0.2.0b beta | Defined local as no-telemetry rather than route access control and corrected the hide-to-tray/Quit gate |
| Product 0.5.0 | Product 0.5.0 | No product version change |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-03 | beta | Initial WebView2 media parity harness | 3a6657c | RWANG |
| 0.2.0b | 2026-09-04 | beta | Clarify no-telemetry scope and align manual checks with tray lifecycle | ba1200d | RWANG |
