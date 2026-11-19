import path from "path";
import dotenv from "dotenv";

/* node:coverage disable */
const isDemoArg = process.argv.includes("--demo");
dotenv.config({
  path: isDemoArg ? [".env.demo", ".env"] : [".env"],
});
/* node:coverage enable */

export function parseConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  cwd: string = process.cwd()
) {
  const dryRun = argv.includes("--dry-run");
  const watchMode = argv.includes("--watch");
  const demoMode = argv.includes("--demo") || env.DEMO_MODE === "true";

  const rootDir =
    (demoMode && env.DEMO_MEDICAL_ROOT_DIR) ||
    env.MEDICAL_ROOT_DIR ||
    cwd;
  const inboxDir = path.join(rootDir, "Inbox");
  const poolDir = path.join(inboxDir, "Reference-Pool");
  const archiveDir = path.join(rootDir, "Archive");
  const receiptsRootDir = path.join(rootDir, "Receipts");
  const cacheFile =
    env.CACHE_FILE ||
    path.join(cwd, demoMode ? ".hsa-cache.demo.json" : ".hsa-cache.json");

  const trackerTitle =
    (demoMode && env.DEMO_TRACKER_TITLE) ||
    env.TRACKER_TITLE ||
    (demoMode
      ? "DEMO - Medical Expense & HSA Reimbursement Tracker"
      : "Medical Expense & HSA Reimbursement Tracker");
  const sheetTab = env.SHEET_TAB_NAME || "HSA Expense Tracker";
  const installmentTab = env.INSTALLMENT_TAB_NAME || "0% Installment Plans";
  const ccPoolRetentionDays = 60;

  const householdMembers = (
    (demoMode && env.DEMO_HOUSEHOLD_MEMBERS) ||
    (!demoMode && env.HOUSEHOLD_MEMBERS) ||
    (demoMode ? "Homer,Marge,Bart,Lisa,Maggie" : "Primary,Spouse,Dependent")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const householdPromptNames =
    (demoMode && env.DEMO_HOUSEHOLD_PROMPT_NAMES) ||
    (!demoMode && env.HOUSEHOLD_PROMPT_NAMES) ||
    householdMembers.join(", ");

  const paymentMethods = (
    (demoMode && env.DEMO_PAYMENT_METHODS) ||
    (!demoMode && env.PAYMENT_METHODS) ||
    "Credit Card,Checking,HSA Card,Unknown"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultPaymentMethod =
    (demoMode && env.DEMO_DEFAULT_PAYMENT_METHOD) ||
    (!demoMode && env.DEFAULT_PAYMENT_METHOD) ||
    paymentMethods[0] ||
    "Credit Card";

  return {
    DRY_RUN: dryRun,
    WATCH_MODE: watchMode,
    DEMO_MODE: demoMode,
    ROOT_DIR: rootDir,
    INBOX_DIR: inboxDir,
    POOL_DIR: poolDir,
    ARCHIVE_DIR: archiveDir,
    RECEIPTS_ROOT_DIR: receiptsRootDir,
    CACHE_FILE: cacheFile,
    TRACKER_TITLE: trackerTitle,
    SHEET_TAB: sheetTab,
    INSTALLMENT_TAB: installmentTab,
    CC_POOL_RETENTION_DAYS: ccPoolRetentionDays,
    HOUSEHOLD_MEMBERS: householdMembers,
    HOUSEHOLD_PROMPT_NAMES: householdPromptNames,
    PAYMENT_METHODS: paymentMethods,
    DEFAULT_PAYMENT_METHOD: defaultPaymentMethod,
  };
}

const activeConfig = parseConfig();

export const DRY_RUN = activeConfig.DRY_RUN;
export const WATCH_MODE = activeConfig.WATCH_MODE;
export const DEMO_MODE = activeConfig.DEMO_MODE;
export const ROOT_DIR = activeConfig.ROOT_DIR;
export const INBOX_DIR = activeConfig.INBOX_DIR;
export const POOL_DIR = activeConfig.POOL_DIR;
export const ARCHIVE_DIR = activeConfig.ARCHIVE_DIR;
export const RECEIPTS_ROOT_DIR = activeConfig.RECEIPTS_ROOT_DIR;
export const CACHE_FILE = activeConfig.CACHE_FILE;
export const TRACKER_TITLE = activeConfig.TRACKER_TITLE;
export const SHEET_TAB = activeConfig.SHEET_TAB;
export const INSTALLMENT_TAB = activeConfig.INSTALLMENT_TAB;
export const CC_POOL_RETENTION_DAYS = activeConfig.CC_POOL_RETENTION_DAYS;
export const HOUSEHOLD_MEMBERS = activeConfig.HOUSEHOLD_MEMBERS;
export const HOUSEHOLD_PROMPT_NAMES = activeConfig.HOUSEHOLD_PROMPT_NAMES;
export const PAYMENT_METHODS = activeConfig.PAYMENT_METHODS;
export const DEFAULT_PAYMENT_METHOD = activeConfig.DEFAULT_PAYMENT_METHOD;
