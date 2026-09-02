import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LEGACY_DATA_MIGRATION_MARKER,
  LEGACY_MUTABLE_DATA_ALLOWLIST,
  migrateLegacyMutableData,
} from "../rwang.mjs";

async function removeTree(directory) {
  await rm(directory, { recursive: true, force: true });
}

async function migrationCopiesOnlyStableAllowlist() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rwang-legacy-migration-"));
  const legacyRoot = path.join(root, "legacy-resource");
  const dataRoot = path.join(root, "new-data");
  await Promise.all([mkdir(legacyRoot), mkdir(dataRoot)]);
  try {
    const sourceContent = Object.fromEntries(LEGACY_MUTABLE_DATA_ALLOWLIST.map((filename) => [
      filename,
      `legacy:${filename}:do-not-overwrite`,
    ]));
    for (const [filename, content] of Object.entries(sourceContent)) {
      await writeFile(path.join(legacyRoot, filename), content, "utf8");
    }
    await writeFile(path.join(legacyRoot, ".rwang-config.tmp"), "legacy-temp", "utf8");
    await writeFile(path.join(legacyRoot, ".queue-state.corrupt-123.json"), "legacy-corrupt", "utf8");

    const result = await migrateLegacyMutableData({ legacyRoot, dataRoot });
    assert.deepEqual(result.copied, LEGACY_MUTABLE_DATA_ALLOWLIST);
    assert.equal(result.marker, true);
    assert.deepEqual(await readdir(dataRoot), [...LEGACY_MUTABLE_DATA_ALLOWLIST, LEGACY_DATA_MIGRATION_MARKER].sort());
    for (const filename of LEGACY_MUTABLE_DATA_ALLOWLIST) {
      assert.equal(await readFile(path.join(dataRoot, filename), "utf8"), sourceContent[filename]);
      assert.equal(await readFile(path.join(legacyRoot, filename), "utf8"), sourceContent[filename]);
    }
    assert.equal(await readFile(path.join(legacyRoot, ".rwang-config.tmp"), "utf8"), "legacy-temp");
    assert.equal(await readdir(legacyRoot).then((entries) => entries.includes(LEGACY_DATA_MIGRATION_MARKER)), false);
  } finally {
    await removeTree(root);
  }
}

async function migrationNeverOverwritesOrRepeats() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rwang-legacy-no-overwrite-"));
  const legacyRoot = path.join(root, "legacy-resource");
  const dataRoot = path.join(root, "new-data");
  await Promise.all([mkdir(legacyRoot), mkdir(dataRoot)]);
  try {
    await writeFile(path.join(legacyRoot, ".rwang-config.json"), "legacy-config", "utf8");
    await writeFile(path.join(dataRoot, ".rwang-config.json"), "destination-config", "utf8");
    const first = await migrateLegacyMutableData({ legacyRoot, dataRoot });
    assert.deepEqual(first.copied, []);
    assert.equal(first.skipped.find((entry) => entry.filename === ".rwang-config.json")?.reason, "destination-present");
    assert.equal(await readFile(path.join(dataRoot, ".rwang-config.json"), "utf8"), "destination-config");

    await writeFile(path.join(legacyRoot, ".rwang-config.json"), "changed-legacy-config", "utf8");
    const second = await migrateLegacyMutableData({ legacyRoot, dataRoot });
    assert.deepEqual(second.copied, []);
    assert.equal(second.reason, "already-complete");
    assert.equal(await readFile(path.join(dataRoot, ".rwang-config.json"), "utf8"), "destination-config");
  } finally {
    await removeTree(root);
  }
}

async function migrationFailsClosedForOverlappingRoots() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rwang-legacy-overlap-"));
  const legacyRoot = path.join(root, "legacy-resource");
  const dataRoot = path.join(legacyRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  try {
    await assert.rejects(
      migrateLegacyMutableData({ legacyRoot, dataRoot }),
      (error) => error?.code === "LEGACY_MIGRATION_FAILED",
    );
  } finally {
    await removeTree(root);
  }
}

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /migrateLegacyMutableData\(\{ legacyRoot: resourceDir, dataRoot: dataDir \}\)/);
await migrationCopiesOnlyStableAllowlist();
await migrationNeverOverwritesOrRepeats();
await migrationFailsClosedForOverlappingRoots();
console.log("RWANG legacy data migration tests passed");
