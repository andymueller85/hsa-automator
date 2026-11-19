import { pathToFileURL } from "url";
import chokidar from "chokidar";
import { INBOX_DIR, WATCH_MODE } from "./config.js";
import { runSync } from "./sync.js";

export interface CliOptions {
  watchMode?: boolean;
  inboxDir?: string;
  runSyncFn?: () => Promise<void>;
  watchFn?: typeof chokidar.watch;
}

export function startCli(options: CliOptions = {}) {
  const watchMode = options.watchMode ?? WATCH_MODE;
  const inboxDir = options.inboxDir ?? INBOX_DIR;
  const runSyncFn = options.runSyncFn ?? runSync;
  const watchFn = options.watchFn ?? chokidar.watch.bind(chokidar);

  if (watchMode) {
    console.log(`Watching ${inboxDir} for new medical documents...`);
    return watchFn(inboxDir, {
      ignoreInitial: false,
      depth: 2,
      ignored: /(Reference-Pool|^\.)/,
    }).on("add", () => {
      runSyncFn().catch(console.error);
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
