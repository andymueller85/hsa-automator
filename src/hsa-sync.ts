import chokidar from "chokidar";
import { INBOX_DIR, WATCH_MODE } from "./config.js";
import { runSync } from "./sync.js";

if (WATCH_MODE) {
  console.log(`Watching ${INBOX_DIR} for new medical documents...`);
  chokidar
    .watch(INBOX_DIR, {
      ignoreInitial: false,
      depth: 2,
      ignored: /(Reference-Pool|^\.)/,
    })
    .on("add", () => {
      runSync().catch(console.error);
    });
} else {
  runSync().catch(console.error);
}
