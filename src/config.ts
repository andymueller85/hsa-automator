import path from "path";
import "dotenv/config";

export function parseConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  cwd: string = process.cwd()
) {
  const dryRun = argv.includes("--dry-run");
  const watchMode = argv.includes("--watch");

  const rootDir = env.MEDICAL_ROOT_DIR || cwd;
  const inboxDir = path.join(rootDir, "Inbox");
  const poolDir = path.join(inboxDir, "Reference-Pool");
  const archiveDir = path.join(rootDir, "Archive");
  const receiptsRootDir = path.join(rootDir, "Receipts");
  const cacheFile = path.join(cwd, ".hsa-cache.json");

  const trackerTitle = "Medical Expense & HSA Reimbursement Tracker";
  const sheetTab = env.SHEET_TAB_NAME || "HSA Expense Tracker";
  const installmentTab = env.INSTALLMENT_TAB_NAME || "0% Installment Plans";
  const ccPoolRetentionDays = 60;

  const householdMembers = (
    env.HOUSEHOLD_MEMBERS || "Primary,Spouse,Dependent"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const householdPromptNames =
    env.HOUSEHOLD_PROMPT_NAMES || householdMembers.join(", ");

  const paymentMethods = (
    env.PAYMENT_METHODS || "Credit Card,Checking,HSA Card,Unknown"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultPaymentMethod =
    env.DEFAULT_PAYMENT_METHOD || paymentMethods[0] || "Credit Card";

  return {
    DRY_RUN: dryRun,
    WATCH_MODE: watchMode,
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
