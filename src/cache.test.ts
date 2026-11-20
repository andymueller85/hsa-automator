import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { hashFile, loadCache, saveCache } from "./cache.js";
import type { ParsedFileMetadata } from "./types.js";

describe("cache module", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hsa-cache-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("computes a consistent SHA-256 hex digest for file contents", async () => {
    const fileA = path.join(tmpDir, "a.txt");
    const fileB = path.join(tmpDir, "b.txt");
    await fs.writeFile(fileA, "hsa-test-payload");
    await fs.writeFile(fileB, "hsa-test-payload");

    const hashA = await hashFile(fileA);
    const hashB = await hashFile(fileB);

    assert.equal(hashA.length, 64);
    assert.equal(hashA, hashB);
  });

  test("saves and loads cache JSON cleanly and returns empty object on missing file", async () => {
    const missingPath = path.join(tmpDir, "missing-cache.json");
    assert.deepEqual(await loadCache(missingPath), {});

    const cachePath = path.join(tmpDir, "test-cache.json");
    const sampleCache: Record<string, ParsedFileMetadata> = {
      deadbeef: {
        filePath: "/tmp/eob.pdf",
        fileName: "eob.pdf",
        hash: "deadbeef",
        docType: "EOB",
        isMultiClaimOrStatement: false,
        claims: [],
      },
    };

    await saveCache(sampleCache, cachePath);
    const loaded = await loadCache(cachePath);
    assert.deepEqual(loaded, sampleCache);

    // Calling saveCache without an explicit path inside NODE_TEST_CONTEXT is a safe no-op
    await saveCache(sampleCache);
  });
});
