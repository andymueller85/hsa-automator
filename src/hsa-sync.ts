import { pathToFileURL } from "url";
import chokidar from "chokidar";
import { INBOX_DIR, WATCH_MODE } from "./config.js";
import { runSync } from "./sync.js";

export interface CliOptions {
  watchMode?: boolean;
  inboxDir?: string;
  debounceMs?: number;
  runSyncFn?: () => Promise<void>;
  watchFn?: typeof chokidar.watch;
}

export function startCli(options: CliOptions = {}) {
  const watchMode = options.watchMode ?? WATCH_MODE;
  const inboxDir = options.inboxDir ?? INBOX_DIR;
  const debounceMs = options.debounceMs ?? 250;
  const runSyncFn = options.runSyncFn ?? runSync;
  const watchFn = options.watchFn ?? chokidar.watch.bind(chokidar);

  if (watchMode) {
    console.log(`Watching ${inboxDir} for new medical documents...`);
    let isRunning = false;
    let pendingRun = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerSync = async () => {
      if (isRunning) {
        pendingRun = true;
        return;
      }
      isRunning = true;
      try {
        await runSyncFn();
        console.log(`\nSync complete. Watching ${inboxDir} for new documents...`);
      } catch (err) {
        console.error(err);
      } finally {
        isRunning = false;
        if (pendingRun) {
          pendingRun = false;
          void triggerSync();
        }
      }
    };

    return watchFn(inboxDir, {
      ignoreInitial: false,
      depth: 2,
      ignored: /(Reference-Pool|^\.)/,
    }).on("add", () => {
      if (debounceMs <= 0) {
        void triggerSync();
      } else {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void triggerSync();
        }, debounceMs);
      }
    });
  } else {
    runSyncFn().catch(console.error);
    return null;
  }
}

/* node:coverage disable */
const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startCli();
}
/* node:coverage enable */
