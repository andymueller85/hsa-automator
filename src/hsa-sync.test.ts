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
});
