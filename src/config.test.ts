import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  test("applies sensible defaults when env vars and CLI flags are omitted", () => {
    const cfg = parseConfig({}, ["node", "hsa-sync.ts"], "/app");
    assert.equal(cfg.DRY_RUN, false);
    assert.equal(cfg.WATCH_MODE, false);
    assert.equal(cfg.ROOT_DIR, "/app");
    assert.equal(cfg.INBOX_DIR, path.join("/app", "Inbox"));
    assert.equal(cfg.POOL_DIR, path.join("/app", "Inbox", "Reference-Pool"));
    assert.equal(cfg.ARCHIVE_DIR, path.join("/app", "Archive"));
    assert.equal(cfg.RECEIPTS_ROOT_DIR, path.join("/app", "Receipts"));
    assert.equal(cfg.SHEET_TAB, "HSA Expense Tracker");
    assert.equal(cfg.INSTALLMENT_TAB, "0% Installment Plans");
    assert.deepEqual(cfg.HOUSEHOLD_MEMBERS, ["Primary", "Spouse", "Dependent"]);
    assert.equal(cfg.HOUSEHOLD_PROMPT_NAMES, "Primary, Spouse, Dependent");
    assert.deepEqual(cfg.PAYMENT_METHODS, [
      "Credit Card",
      "Checking",
      "HSA Card",
      "Unknown",
    ]);
    assert.equal(cfg.DEFAULT_PAYMENT_METHOD, "Credit Card");
  });

  test("parses custom environment variables and CLI flags", () => {
    const cfg = parseConfig(
      {
        MEDICAL_ROOT_DIR: "/data/hsa",
        SHEET_TAB_NAME: "Custom Tracker",
        INSTALLMENT_TAB_NAME: "Custom Plans",
        HOUSEHOLD_MEMBERS: " Alice , Bob ",
        PAYMENT_METHODS: "Amex, Visa",
        DEFAULT_PAYMENT_METHOD: "Visa",
      },
      ["node", "hsa-sync.ts", "--dry-run", "--watch"],
      "/workspace"
    );

    assert.equal(cfg.DRY_RUN, true);
    assert.equal(cfg.WATCH_MODE, true);
    assert.equal(cfg.ROOT_DIR, "/data/hsa");
    assert.equal(cfg.SHEET_TAB, "Custom Tracker");
    assert.equal(cfg.INSTALLMENT_TAB, "Custom Plans");
    assert.deepEqual(cfg.HOUSEHOLD_MEMBERS, ["Alice", "Bob"]);
    assert.equal(cfg.HOUSEHOLD_PROMPT_NAMES, "Alice, Bob");
    assert.deepEqual(cfg.PAYMENT_METHODS, ["Amex", "Visa"]);
    assert.equal(cfg.DEFAULT_PAYMENT_METHOD, "Visa");

    const cfgWithPromptNames = parseConfig(
      {
        HOUSEHOLD_PROMPT_NAMES: "Custom Prompt List",
        PAYMENT_METHODS: ",,,",
      },
      []
    );
    assert.equal(cfgWithPromptNames.HOUSEHOLD_PROMPT_NAMES, "Custom Prompt List");
    assert.equal(cfgWithPromptNames.DEFAULT_PAYMENT_METHOD, "Credit Card");
  });

  test("applies Simpsons demo defaults and DEMO_* overrides when --demo flag is passed", () => {
    const demoCfg = parseConfig({}, ["node", "hsa-sync.ts", "--demo"], "/app");
    assert.equal(demoCfg.DEMO_MODE, true);
    assert.equal(
      demoCfg.TRACKER_TITLE,
      "DEMO - Medical Expense & HSA Reimbursement Tracker"
    );
    assert.equal(demoCfg.CACHE_FILE, path.join("/app", ".hsa-cache.demo.json"));
    assert.deepEqual(demoCfg.HOUSEHOLD_MEMBERS, [
      "Homer",
      "Marge",
      "Bart",
      "Lisa",
      "Maggie",
    ]);

    const customDemoCfg = parseConfig(
      {
        DEMO_MODE: "true",
        DEMO_MEDICAL_ROOT_DIR: "/drive/hsa-demo",
        DEMO_TRACKER_TITLE: "Custom Demo Sheet",
        DEMO_HOUSEHOLD_MEMBERS: "Homer,Bart",
        DEMO_HOUSEHOLD_PROMPT_NAMES: "Homer or Bart",
        CACHE_FILE: "/custom/cache.json",
      },
      ["node", "hsa-sync.ts"],
      "/app"
    );
    assert.equal(customDemoCfg.DEMO_MODE, true);
    assert.equal(customDemoCfg.ROOT_DIR, "/drive/hsa-demo");
    assert.equal(customDemoCfg.TRACKER_TITLE, "Custom Demo Sheet");
    assert.equal(customDemoCfg.CACHE_FILE, "/custom/cache.json");
    assert.deepEqual(customDemoCfg.HOUSEHOLD_MEMBERS, ["Homer", "Bart"]);
    assert.equal(customDemoCfg.HOUSEHOLD_PROMPT_NAMES, "Homer or Bart");
  });
});
