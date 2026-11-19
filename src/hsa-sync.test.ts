import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { startCli } from "./hsa-sync.js";

describe("hsa-sync CLI entrypoint", () => {
  test("invokes runSync immediately when watchMode is false", () => {
    let syncCalls = 0;
    const watcher = startCli({
      watchMode: false,
      runSyncFn: async () => {
        syncCalls++;
      },
    });

    assert.equal(watcher, null);
    assert.equal(syncCalls, 1);
  });

  test("starts chokidar watcher and triggers runSync on file add when watchMode is true", () => {
    let syncCalls = 0;
    let watchedDir = "";
    const fakeWatcher = new EventEmitter();

    startCli({
      watchMode: true,
      inboxDir: "/data/hsa/Inbox",
      debounceMs: 0,
      runSyncFn: async () => {
        syncCalls++;
      },
      watchFn: ((dir: string) => {
        watchedDir = dir;
        return fakeWatcher as any;
      }) as any,
    });

    assert.equal(watchedDir, "/data/hsa/Inbox");
    fakeWatcher.emit("add", "/data/hsa/Inbox/eob.pdf");
    assert.equal(syncCalls, 1);
  });

  test("debounces overlapping add events and queues pending sync when already running", async () => {
    let syncCalls = 0;
    let resolveRun: (() => void) | null = null;
    const fakeWatcher = new EventEmitter();

    startCli({
      watchMode: true,
      inboxDir: "/data/hsa/Inbox",
      debounceMs: 10,
      runSyncFn: () =>
        new Promise<void>((resolve, reject) => {
          syncCalls++;
          if (syncCalls === 1) {
            resolveRun = resolve;
          } else {
            reject(new Error("simulated sync error"));
          }
        }),
      watchFn: (() => fakeWatcher as any) as any,
    });

    // Rapid double emit triggers debounce timer reset
    fakeWatcher.emit("add", "/data/hsa/Inbox/doc1.pdf");
    fakeWatcher.emit("add", "/data/hsa/Inbox/doc2.pdf");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(syncCalls, 1);

    // Emit while first run is still in progress to exercise pendingRun queue
    fakeWatcher.emit("add", "/data/hsa/Inbox/doc3.pdf");
    await new Promise((r) => setTimeout(r, 30));
    resolveRun!();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(syncCalls, 2);
  });
});
