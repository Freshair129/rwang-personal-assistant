import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_SECRET_BYTES = 4096;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;

const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$payload = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
if ($payload.action -eq 'protect') {
  $plain = [Text.Encoding]::UTF8.GetBytes([string]$payload.value)
  $protected = [Security.Cryptography.ProtectedData]::Protect(
    $plain,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} elseif ($payload.action -eq 'unprotect') {
  $protected = [Convert]::FromBase64String([string]$payload.value)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
} else {
  throw 'unsupported secret-store action'
}
`;
const DPAPI_COMMAND = Buffer.from(DPAPI_SCRIPT, "utf16le").toString("base64");

function storeError(cause) {
  const error = new Error("secure secret store is unavailable");
  error.code = "SECRET_STORE_UNAVAILABLE";
  error.cause = cause;
  return error;
}

function assertSecret(value) {
  const secret = String(value ?? "");
  const bytes = Buffer.byteLength(secret, "utf8");
  if (!secret || bytes > MAX_SECRET_BYTES || /[\u0000-\u001f\u007f]/u.test(secret)) {
    const error = new Error("API key must be a non-empty bounded secret without control characters");
    error.code = "INVALID_CREDENTIAL";
    throw error;
  }
  return secret;
}

function runPowerShell(action, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", DPAPI_COMMAND],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, storeError(new Error("secret-store command timed out")));
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();

    function finish(callback, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(result);
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_COMMAND_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(reject, storeError(error)));
    child.on("close", (code) => {
      if (code !== 0 || stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        finish(reject, storeError(new Error(stderr || `secret-store exit ${code}`)));
        return;
      }
      finish(resolve, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.on("error", (error) => finish(reject, storeError(error)));
    child.stdin.end(JSON.stringify({ action, value }));
  });
}

async function regularFileExists(file) {
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile()) throw storeError(new Error("secret file is not regular"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function createSecretStore({ dataDir, name = "secret" } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("secret store data directory must be absolute");
  const directory = path.join(dataDir, ".secrets");
  const file = path.join(directory, `${name}.dpapi`);
  let cached;

  async function ensureDirectory() {
    await mkdir(directory, { recursive: true });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw storeError(new Error("secret directory is not regular"));
  }

  async function get() {
    if (cached !== undefined) return cached;
    if (process.platform !== "win32") {
      cached = null;
      return cached;
    }
    if (!(await regularFileExists(file))) {
      cached = null;
      return cached;
    }
    try {
      const protectedValue = (await readFile(file, "utf8")).trim();
      if (!protectedValue) throw new Error("secret file is empty");
      cached = assertSecret(await runPowerShell("unprotect", protectedValue));
      return cached;
    } catch (error) {
      throw error?.code === "INVALID_CREDENTIAL" ? error : storeError(error);
    }
  }

  async function has() {
    if (cached !== undefined) return Boolean(cached);
    if (process.platform !== "win32") return false;
    return regularFileExists(file);
  }

  async function set(value) {
    const secret = assertSecret(value);
    if (process.platform !== "win32") {
      cached = secret;
      return { persisted: false, backend: "memory" };
    }
    await ensureDirectory();
    const protectedValue = (await runPowerShell("protect", secret)).trim();
    if (!protectedValue) throw storeError(new Error("secret-store returned an empty value"));
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${protectedValue}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        await rename(temporary, file);
      } catch (error) {
        if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
        await unlink(file).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
        await rename(temporary, file);
      }
      cached = secret;
      return { persisted: true, backend: "dpapi" };
    } catch (error) {
      throw error?.code === "INVALID_CREDENTIAL" ? error : storeError(error);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function clear() {
    cached = null;
    if (process.platform !== "win32") return;
    try {
      const exists = await regularFileExists(file);
      if (exists) await unlink(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error?.code === "SECRET_STORE_UNAVAILABLE" ? error : storeError(error);
    }
  }

  return {
    file,
    backend: process.platform === "win32" ? "dpapi" : "memory",
    get,
    has,
    set,
    clear,
    peek: () => (typeof cached === "string" ? cached : ""),
  };
}

// Compatibility alias for the first Lalin-only integration. New callers should
// use the provider-neutral factory so each credential has its own DPAPI file.
export const createLalinVoiceSecretStore = createSecretStore;
