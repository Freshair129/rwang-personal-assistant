/*
 * RWANG desktop child entrypoint.
 *
 * The Rust host starts this file with an absolute path and sets
 * RWANG_SERVER_ENTRYPOINT to the absolute bundled server.mjs path.  Keeping
 * this tiny launcher separate from server.mjs lets the existing HTTP server
 * remain usable from the command line while the desktop host gets a stable,
 * line-delimited JSON lifecycle protocol.
 */

import process from "node:process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const port = Number(process.env.OLLAMA_CENTER_PORT || 4173);
const serverEntrypoint = process.env.RWANG_SERVER_ENTRYPOINT;
const desktopNonce = process.env.RWANG_DESKTOP_NONCE;
let fatalSent = false;
let shutdownRequested = false;
let serverLoaded = false;

function emit(event, payload = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...payload })}\n`);
}

function asMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private)\/)[^\s'"`]+/g, "<path>")
    .slice(0, 240);
}

function fatal(error) {
  if (fatalSent) return;
  fatalSent = true;
  emit("fatal", { message: asMessage(error) });
}

function verifyDesktopProof(response, challenge) {
  const proof = response.headers.get("x-rwang-desktop-proof");
  if (!/^[0-9a-f]{64}$/i.test(proof || "")) return false;
  const expected = createHmac("sha256", Buffer.from(desktopNonce, "hex"))
    .update(Buffer.from(challenge, "hex"))
    .digest();
  const received = Buffer.from(proof, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

process.on("uncaughtException", (error) => {
  fatal(error);
  process.exitCode = 1;
});
process.on("unhandledRejection", (error) => {
  fatal(error);
  process.exitCode = 1;
});
process.on("SIGTERM", () => {
  // Windows may otherwise report a self-delivered SIGTERM as exit code 1 even
  // when server.mjs has completed its graceful cleanup.
  if (shutdownRequested) process.exitCode = 0;
});

// Rust keeps stdin private to the sidecar. A single NDJSON control message is
// enough to reach server.mjs's real SIGTERM cleanup path on Windows and Unix;
// Rust only force-kills if this bounded graceful path does not exit.
const control = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function releaseControlInput() {
  control.close();
  process.stdin.pause();
  process.stdin.unref?.();
}
control.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const event = message && typeof message === "object"
    ? String(message.event || message.type || "").trim().toLowerCase()
    : "";
  if (event !== "shutdown" || shutdownRequested) return;
  shutdownRequested = true;
  emit("stopping");
  releaseControlInput();
  try {
    // process.emit reaches server.mjs's installed SIGTERM cleanup listener on
    // Windows, where process.kill(self, "SIGTERM") terminates immediately
    // without dispatching the listener. Keep process.kill as the startup race
    // fallback for a launcher that has not loaded the server yet.
    if (serverLoaded) process.emit("SIGTERM");
    else process.kill(process.pid, "SIGTERM");
  } catch (error) {
    fatal(error);
    process.exitCode = 1;
  }
});

if (!serverEntrypoint || !path.isAbsolute(serverEntrypoint)) {
  fatal(new Error("RWANG_SERVER_ENTRYPOINT must be an absolute server.mjs path"));
  releaseControlInput();
  process.exitCode = 1;
} else if (!/^[0-9a-f]{64}$/.test(desktopNonce || "")) {
  fatal(new Error("RWANG_DESKTOP_NONCE must be a 32-byte lowercase hex value"));
  releaseControlInput();
  process.exitCode = 1;
} else {
  try {
    await import(pathToFileURL(serverEntrypoint).href);
    serverLoaded = true;

    // server.mjs starts listening asynchronously.  Emit ready only after the
    // HTTP listener accepts a request, so the host can safely create its
    // webview as soon as it receives this signal.
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const challenge = randomBytes(32).toString("hex");
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          redirect: "manual",
          headers: { "x-rwang-desktop-challenge": challenge },
          signal: AbortSignal.timeout(500),
        });
        if (response.status === 200 && verifyDesktopProof(response, challenge)) {
          try {
            const health = await response.json();
            if (health?.service === "rwang" && health?.ready === true) {
              ready = true;
              break;
            }
          } catch {
            // A non-JSON response is not a valid RWANG readiness proof.
          }
        }
      } catch {
        // The listener may need another event-loop turn after import.
      }
      await sleep(100);
    }
    if (!ready) {
      throw new Error(`RWANG HTTP readiness timed out on port ${port}`);
    }
    emit("ready", { port });
  } catch (error) {
    fatal(error);
    releaseControlInput();
    process.exitCode = 1;
  }
}
