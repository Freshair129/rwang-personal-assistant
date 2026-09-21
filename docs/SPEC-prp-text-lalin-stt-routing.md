---
version: "0.2.1b"
created_at: "2026-09-21T21:48:54+07:00,RWANG,UNCOMMITTED"
last_update: "2026-09-22T03:08:32+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "assistant-runtime"
  scope: "rwang-prp-text-lalin-stt-routing"
  doc_type: "core-directive"
  language: "th-en"
  complexity: "C-3"
  change_risk: "HIGH"
---

# Specification — PRP Text with Lalin Whisper STT

## 1. Decision proposal

Use two independent providers with a single RWANG orchestration boundary:

```text
typed text  ───────────────────────────────┐
                                           ▼
                                  PRP text API
                                  /v1/chat/completions

microphone ── local audio ──▶ F:\\lalin STT worker
                              faster-whisper large-v3-turbo
                                           │
                                           ▼
                                      transcript
                                           │
                                           ▼
                                  PRP text API
```

The PRP credential is used only for text generation. The Lalin worker
credential is used only for speech-to-text. Neither credential is forwarded to
the other provider.

This document is a routing and credential-boundary amendment to the existing
Lalin ASR integration. It does not replace the Lalin worker specification.

## 2. Evidence and current gap

- RWANG currently sends chat traffic to the local Ollama-compatible provider.
- `F:\\Private-Runtime-Platform\\contracts\\openapi\\prp-client.yaml`
  defines `POST /v1/chat/completions` with a PRP-scoped bearer credential.
- `F:\\lalin\\apps\\api\\app\\voice_worker\\app.py` exposes
  `/worker/v1/operations`, status, output, cancel, and payload-erasure routes.
- Lalin already contains the `faster-whisper` engine and the approved primary
  profile `asr-th-en-01` for `large-v3-turbo`.
- The current RWANG implementation has Lalin credential storage and readiness
  verification, but it does not yet have a PRP text provider adapter or a
  server-side audio-to-transcript route.

The evidence supports the separation of responsibilities. It does not yet
prove a live PRP ingress, a valid user key, Thai quality, or end-to-end
production readiness.

## 3. Ownership boundary

### RWANG owns

- Text/voice-turn orchestration.
- Microphone permissions and bounded audio upload.
- Provider selection disclosure and transcript display.
- Credential storage status and local approval policy.
- Passing the resulting transcript as text to PRP.

### PRP owns

- Text model routing and text generation.
- PRP client-key scope, quota, and authorization.
- Private ingress, request IDs, and provider-side audit.

### Lalin owns

- Audio decoding and STT execution.
- `faster-whisper` profile/device/readiness/epoch validation.
- Operation lifecycle, output retrieval, cancellation, and payload erasure.

## 4. Credential contract

The two secrets must have separate storage identities and separate UI status:

```text
PRP text client key     -> Windows DPAPI secret: prp-text-client
Lalin worker bearer key -> Windows DPAPI secret: lalin-voice-worker
```

Optional headless bootstrap names:

```text
RWANG_PRP_TEXT_BASE_URL=https://<approved-private-prp-ingress>
  RWANG_PRP_TEXT_CLIENT_KEY=<prp-scoped-client-key>
RWANG_PRP_TEXT_MODEL=<approved-text-model>

RWANG_LALIN_VOICE_WORKER_URL=http://127.0.0.1:8790
RWANG_LALIN_VOICE_WORKER_TOKEN=<lalin-worker-bearer-token>
RWANG_LALIN_VOICE_PROFILE=asr-th-en-01
  RWANG_LALIN_VOICE_FALLBACK_PROFILE=<optional-explicit-profile; current Slice B primary has no medium fallback>
```

“Key from `F:\\Private-Runtime-Platform`” means a PRP-scoped client key
issued by the approved PRP key authority. RWANG must not scan or read secret
values from the PRP repository, evidence files, databases, or management
credentials. The management key and worker service credential are not valid
substitutes for the desktop text key.

The browser/Tauri UI never receives either raw secret. Status endpoints return
only configured/source/verification state and a fixed mask.

## 5. Request routing

### 5.1 Text input

For typed text or an already-created transcript, the server-side PRP adapter
calls:

```text
POST {RWANG_PRP_TEXT_BASE_URL}/v1/chat/completions
Authorization: Bearer <PRP client key>
```

The adapter sends only the bounded OpenAI-compatible message subset supported
by the PRP contract. It must preserve stream cancellation, request IDs, safe
error mapping, and the existing RWANG human-approval policy for tools/actions.

### 5.2 Voice input

The server-side Lalin adapter:

1. Checks Lalin liveness, selected profile, and readiness.
2. Sends bounded audio to `POST /worker/v1/operations` with the Lalin bearer
   credential and the selected `asr-th-en-01` profile.
3. Polls the operation status and retrieves the transcript output.
4. Requests payload erasure according to the Lalin contract.
5. Sends only the resulting transcript text to the PRP text adapter.

The browser must not call either backend directly. Raw audio stays in the
local RWANG-to-Lalin path; the transcript is the only voice-derived payload
sent onward to PRP.

## 6. Failure and fallback policy

- A missing or invalid PRP key fails text generation with an explicit provider
  error; it must not silently use the Lalin key.
- A missing or unavailable Lalin worker fails voice capture with an explicit
  STT error; it must not send raw audio to PRP text.
- The existing local Ollama path remains available only as an explicitly
  selected migration provider until PRP text readiness is verified. No silent
  cross-provider fallback is introduced in the first implementation slice.
- Partial streamed text is never silently resumed on another provider.
- Tool calls and external actions remain behind the existing RWANG approval
  boundary after PRP returns text or a tool request.

## 7. Proposed implementation DAG

```text
G0: approve this routing/credential spec
 ├─ A: PRP text adapter + scoped-key verification
 ├─ B: Lalin STT operation adapter + transcript envelope
 └─ C: split credential UI/storage/status contracts
       A, B, C
          ▼
G1: serial end-to-end voice -> transcript -> PRP text test
          ▼
G2: security, packaging, and regression evidence
```

Lanes A, B, and C may be implemented in parallel after G0. G1 is serial
because it validates the actual boundary between the three components.

## 8. Acceptance criteria

- Typed text reaches PRP using only the PRP client key.
- Voice audio reaches Lalin using only the Lalin worker key.
- Lalin primary STT profile is `asr-th-en-01` with `large-v3-turbo`; no
  automatic profile fallback is performed, and any fallback setting remains
  explicit rather than silently selecting a different model.
- A successful voice turn produces `audio -> transcript -> PRP text` evidence.
- No raw key appears in browser storage, API responses, logs, snapshots, or
  packaged resources.
- PRP management/service credentials are rejected by the text adapter when
  their scope is not a client inference scope.
- Existing RWANG tool approval and authorization behavior remains unchanged.
- Tests cover invalid credentials, unavailable backends, cancellation, bounded
  audio, stream abort, and secret redaction.

## 9. Out of scope

- Replacing the Lalin `large-v3-turbo` runtime.
- Moving PRP secret authority into RWANG.
- Sending raw audio to PRP.
- Adding TTS or a full voice-turn business workflow.
- Claiming production readiness before live PRP, Thai quality, packaging, and
  clean-machine evidence are available.

## 10. Risk assessment

Risk: HIGH. The change crosses two authenticated backends and changes the
text-provider boundary. The primary mitigations are separate DPAPI entries,
scope-specific credentials, server-side adapters, no browser secret exposure,
bounded payloads, and serial end-to-end verification.

## 11. Approval and implementation status

The user approved the routing, credential separation, and fallback policy on
2026-09-22. The first implementation slice is now in beta testing:

- `rwang.mjs` selects Ollama or PRP for text without silent cross-provider
  fallback, stores the PRP key separately, and redacts both provider keys.
- `server.mjs` exposes a same-origin, local-only bounded audio route and keeps
  raw audio out of the PRP path.
- `public/app.js` uses an explicit Lalin push-to-talk path that encodes
  browser microphone input as 16 kHz mono WAV, which is accepted by the
  current Lalin profile; wake-word monitoring remains browser recognition.
- `tests/text-stt-routing.mjs` proves PRP text routing and Lalin operation
  submission/status/payload-erasure against isolated fixtures.
- The focused routing test passed in a Windows user session with PRP DPAPI
  persistence and restart redaction; `pnpm test:security` and the desktop
  contract suite also passed. Symlink checks remain environment-skipped.

The implementation evidence is fixture/local evidence only. Live PRP ingress,
the real Windows DPAPI user-session path, RTX 3060 throughput, Thai quality,
packaging, and production activation remain open.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-21 | superseded | Define PRP text routing with separate Lalin `large-v3-turbo` STT and credential boundaries | UNCOMMITTED | RWANG |
| 0.2.0b | 2026-09-22 | beta | Implement provider routing, split secret stores, bounded Lalin WAV transcription, UI settings, and fixture evidence | UNCOMMITTED | RWANG |
| 0.2.1b | 2026-09-22 | beta | Pin Lalin readiness to the approved `large-v3-turbo` profile revision and record Windows-session regression evidence | UNCOMMITTED | RWANG |

## Version Diff

- Approved specification promoted to beta after implementation.
- Corrected the headless PRP key variable to `RWANG_PRP_TEXT_CLIENT_KEY`.
- Recorded that the current Lalin Slice B profile is `large-v3-turbo` without an
  active medium fallback.
- Added implementation and fixture evidence boundaries.
- Added a profile-revision guard so a different Whisper model cannot pass Lalin
  readiness by sharing only the `faster-whisper` engine label.
- Recorded the final Windows-user-session and regression evidence.
