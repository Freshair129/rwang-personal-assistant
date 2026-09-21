---
version: "0.3.0b"
created_at: "2026-09-21T00:00:00+07:00,RWANG,UNCOMMITTED"
last_update: "2026-09-21T08:35:25+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "voice-command"
  scope: "rwang-lalin-asr-integration"
  doc_type: "core-directive"
  language: "en"
  complexity: "C-3"
  change_risk: "HIGH"
---

# Specification — RWANG Integration with F:\\lalin Voice Worker

## 1. Decision

Use the existing `F:\\lalin` headless voice worker as RWANG's local ASR
backend. Do not add a second Whisper runtime or duplicate the
`large-v3-turbo` model inside RWANG.

The proposed path is:

```text
RWANG browser/Tauri microphone
        │ local audio only
        ▼
RWANG server-side voice adapter
        │ loopback HTTP + worker credential
        ▼
F:\\lalin apps/api voice worker
        │ faster-whisper / CTranslate2
        ▼
large-v3-turbo primary · medium fallback
```

## 2. Existing Lalin evidence

The inspected Lalin checkout already contains:

- `apps/api/.venv-speech` with the isolated ASR dependency set.
- `faster-whisper 1.2.1` and `ctranslate2 4.8.2` without Torch.
- Primary profile `asr-th-en-01` using
  `mobiuslabsgmbh/faster-whisper-large-v3-turbo`.
- Fallback profile `asr-th-en-01-medium`.
- Pinned model assets and SHA-256 values in each profile manifest.
- Loopback headless worker defaulting to `127.0.0.1:8790`.
- Authenticated describe/readiness/operation/status/cancel/output/erase
  contracts.
- Real English smoke success on RTX 5060 Ti with `cuda:0 int8_float16`.

Evidence does not yet establish Thai quality, RTX 3060 compatibility, or
production activation. RWANG must preserve those evidence labels.

## 3. Ownership boundary

### RWANG owns

- Microphone permission and recording UX.
- Push-to-talk/wake-mode user interaction.
- Browser/Tauri mode disclosure.
- The server-side adapter and worker credential storage.
- Transcript display and the existing chat/tool approval policy.
- Fallback to browser SpeechRecognition when Lalin is unavailable.

### Lalin owns

- ASR runtime and model loading.
- Profile/device/epoch validation.
- Audio decoding and duration/size limits.
- Inference lifecycle, readiness, cancellation, receipts, and payload erase.
- Model provenance and GPU/CPU execution selection.

### Explicit boundary

The browser must not receive or store the Lalin worker credential. The browser
must not call `F:\\lalin` directly. RWANG's local server performs the
authenticated worker call and returns a sanitized transcript envelope.

## 4. Configuration contract

Proposed RWANG server configuration:

```text
RWANG_LALIN_VOICE_WORKER_URL=http://127.0.0.1:8790
RWANG_LALIN_VOICE_WORKER_TOKEN=<server-process-secret>
RWANG_LALIN_VOICE_PROFILE=asr-th-en-01
RWANG_LALIN_VOICE_FALLBACK_PROFILE=asr-th-en-01-medium
RWANG_VOICE_MODE=auto
```

Rules:

- URL must be loopback HTTP or an explicitly approved local secure endpoint.
- The worker token is server-side only and never returned to the browser.
- Profile and revision are obtained from the worker's `describe` response and
  must match the selected approved profile.
- `auto` prefers Lalin local ASR, then browser voice; `local` fails closed when
  Lalin is unavailable; `browser` bypasses Lalin explicitly.
- No remote/public Lalin URL is accepted by default.

### 4.1 API key entry contract

For this integration, “API key” means the Lalin voice-worker bearer token used
by RWANG's server-side adapter. It is not an OpenAI, Ollama, or other remote
provider key. The implementation must support both headless and desktop setup:

- `RWANG_LALIN_VOICE_WORKER_TOKEN` is an optional process-environment bootstrap
  value for service/CI use.
- The desktop Settings > Voice screen provides a password-style
  `Lalin worker API key` field and explicit Save/Clear actions.
- A saved desktop key is stored in an OS-protected per-user secret store. On
  Windows, the implementation must use a user-scoped DPAPI/Credential Manager
  boundary; it must not write the raw key to planner state, JSON config,
  `.env`, logs, browser `localStorage`, or packaged resources.
- The adapter resolves credentials in this order: saved per-user key, then
  `RWANG_LALIN_VOICE_WORKER_TOKEN`, then no credential. The UI must disclose
  the source (`desktop`, `environment`, or `not configured`) without exposing
  the value.
- The input is an opaque bearer secret. Reject empty values, control
  characters, and values outside the implementation's bounded secret length;
  preserve the accepted value exactly and never log it or a reversible form of
  it.
- Save may perform an authenticated Lalin `describe`/readiness check. If the
  worker is unavailable, the key may be retained as `unverified`; an explicit
  authentication failure must not be reported as a successful verification or
  exposed with raw upstream details.
- Replacing a key atomically replaces the per-user secret. Clear removes the
  saved value and releases any in-memory copy; an environment value, if
  present, remains available as the documented fallback.

### 4.2 Secret-management API shape

The exact route names may follow existing RWANG conventions, but the contract
must have equivalent behavior:

```json
GET /api/rwang/voice/config
{
  "ok": true,
  "credential": {
    "configured": true,
    "source": "desktop",
    "verification": "verified",
    "masked": "••••••••"
  }
}
```

```json
PUT /api/rwang/voice/config
{ "apiKey": "<opaque bearer secret>" }
```

```json
DELETE /api/rwang/voice/config
```

Rules for these routes:

- They are same-origin, local-only configuration operations and use the
  existing RWANG local access-control mechanism where configured.
- `GET` returns status and a non-reversible mask only; `PUT` and `DELETE`
  return status only and never echo the submitted key.
- The browser sends the key to RWANG only over the local app channel; it never
  sends the key directly to `F:\\lalin`.
- Error responses use stable generic codes such as `INVALID_CREDENTIAL`,
  `WORKER_UNAVAILABLE`, and `SECRET_STORE_UNAVAILABLE`, with no token, path,
  header, receipt, or traceback disclosure.

## 5. Adapter flow

1. RWANG checks configured mode and local worker URL.
2. RWANG calls Lalin `/health/live` and authenticated `/worker/v1/readiness`.
3. RWANG calls `/worker/v1/describe` and verifies `engine=faster-whisper`,
   `labeled_stub=false`, selected profile, and a ready effective device.
4. RWANG records the current `runtime_id`, `runtime_epoch`, physical resource,
   profile ID, and profile revision in the operation target.
5. Browser audio is sent to RWANG's local adapter only after user microphone
   interaction.
6. RWANG submits a bounded multipart ASR operation to Lalin.
7. RWANG polls the operation until `SUCCEEDED`, `FAILED`, `CANCELLED`, or
   `UNKNOWN`, with a bounded deadline.
8. RWANG returns only sanitized transcript data to the UI.
9. The user sees the transcript and sends it through the existing chat path.

## 6. Sanitized RWANG response

```json
{
  "ok": true,
  "mode": "lalin-local-asr",
  "profile": "asr-th-en-01",
  "language": "th",
  "text": "สรุปสถานะระบบ",
  "segments": [],
  "durationMs": 1400
}
```

The adapter must not expose worker tokens, absolute Lalin paths, raw receipts,
audio payloads, internal process IDs, or untrusted error tracebacks.

## 7. Fallback and failure policy

| Condition | `auto` | `local` | UI state |
|---|---|---|---|
| Worker ready and profile matches | use Lalin | use Lalin | `LOCAL LALIN ASR` |
| Worker missing/unreachable | browser fallback | fail | `BROWSER VOICE` / `VOICE ERROR` |
| Profile/model hash mismatch | browser fallback | fail | `VOICE ERROR` |
| Worker busy/readiness false | browser fallback | fail | `VOICE ERROR` |
| Operation timeout/unknown | cancel/poll policy, then fallback | fail | `VOICE ERROR` |
| Empty transcript | no chat submit | no chat submit | `VOICE ERROR` |

Fallback must be disclosed; the UI must never label browser recognition as
local Lalin ASR.

## 8. Security and privacy

- Audio is sent only from RWANG to loopback Lalin in local mode.
- The Lalin token is never exposed to browser JavaScript or mobile clients.
- The API-key input is cleared after submission; no raw credential is retained
  in DOM state, browser storage, URLs, command-line arguments, or telemetry.
- Credential rotation is an explicit replace operation; a key is not copied
  from one profile or workspace to another.
- RWANG does not forward audio to Ollama or a remote service.
- Existing human approval remains mandatory for Home Assistant, MCP, and IoT.
- Voice Profile remains a convenience signal and cannot authorize a command.
- Lalin's payload erase operation is called after terminal transcription state
  according to its worker contract.
- Lalin's isolated `DATA_DIR` and RWANG's data root remain separate.

## 9. Acceptance criteria

### Contract and local adapter

- Worker health/readiness/describe checks reject stub or wrong profile.
- A valid API key entered in Settings is stored in the protected per-user
  secret store and is used by the adapter after restart.
- Invalid credentials are rejected without persistence or secret disclosure;
  worker-unavailable setup is represented as `unverified` and remains
  retryable.
- `GET` configuration never returns the raw key, and the key is absent from
  browser storage, planner state, logs, URLs, and packaged files.
- Clear removes the saved credential and leaves the adapter without a desktop
  override.
- Correct runtime ID, epoch, physical resource, profile ID, and revision are
  sent on every operation.
- Worker `401`, `403`, `409`, `413`, `422`, and `503` errors are mapped without
  leaking internals.
- Timeout/cancel leaves no orphan adapter operation or unbounded polling.

### Functional

- Thai fixture is transcribed with explicit `language=th`.
- English fixture is transcribed with explicit `language=en`.
- Empty/noise input does not submit a chat message.
- Worker unavailable uses clearly disclosed browser fallback in `auto` mode.
- Successful transcript reaches the normal chat and approval flow.

### Evidence gates

- Lalin Slice B English smoke: existing local evidence only.
- Thai quality: `NOT_RUN` until authorized Thai fixtures exist.
- RTX 3060: `NOT_RUN` until a real device run exists.
- Production activation: no claim until deployment/activation evidence exists.

## 10. Non-goals

- No duplicate model download into RWANG.
- No edits to `F:\\lalin` under this integration spec.
- No bypass of Lalin's profile/epoch/admission contract.
- No voice authentication or automatic external-action execution.

## 11. Implementation evidence

- Added `secret-store.mjs` with Windows user-scoped DPAPI persistence; raw
  credentials are passed to PowerShell through stdin and only encrypted output
  is written under the application data root.
- Added local-only `GET`, `PUT`, and `DELETE` voice credential routes, desktop
  Settings UI, environment fallback, masked status, and generic error codes.
- Added regression coverage for invalid credential rejection, profile/auth
  verification, DPAPI persistence, restart behavior, desktop-over-environment
  precedence, clear/fallback behavior, and raw-secret absence from config and
  responses.
- Evidence: `pnpm check`, full security suite in the Windows user session,
  desktop contract suite in the Windows user session, targeted credential test,
  and visual Settings smoke all passed.
- Sandbox-only runs remain limited by `INVALID_HOME_ROOT`, unavailable
  symlink creation, and an unloaded Windows profile; those are not product
  pass/fail evidence.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.0b | 2026-09-21 | beta | Implement API-key entry, protected storage, credential verification, environment fallback, UI, and regression evidence | UNCOMMITTED | RWANG |
| 0.2.0b | 2026-09-21 | candidate | Add desktop API-key entry, protected storage, precedence, and secret-management contract | UNCOMMITTED | RWANG |
| 0.1.0b | 2026-09-21 | candidate | Specify RWANG-to-Lalin local ASR integration using existing large-v3-turbo worker | UNCOMMITTED | RWANG |
