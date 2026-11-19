import path from "path";
import "dotenv/config";

export const DRY_RUN = process.argv.includes("--dry-run");
export const WATCH_MODE = process.argv.includes("--watch");

export const ROOT_DIR = process.env.MEDICAL_ROOT_DIR!;
export const INBOX_DIR = path.join(ROOT_DIR, "Inbox");
export const POOL_DIR = path.join(INBOX_DIR, "Reference-Pool");
export const ARCHIVE_DIR = path.join(ROOT_DIR, "Archive");
export const RECEIPTS_ROOT_DIR = path.join(ROOT_DIR, "Receipts");
export const CACHE_FILE = path.join(process.cwd(), ".hsa-cache.json");

export const TRACKER_TITLE = "Medical Expense & HSA Reimbursement Tracker";
export const SHEET_TAB = process.env.SHEET_TAB_NAME || "HSA Expense Tracker";
export const INSTALLMENT_TAB =
  process.env.INSTALLMENT_TAB_NAME || "0% Installment Plans";
export const CC_POOL_RETENTION_DAYS = 60;

export const HOUSEHOLD_MEMBERS = (
  process.env.HOUSEHOLD_MEMBERS || "Primary,Spouse,Dependent"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const HOUSEHOLD_PROMPT_NAMES =
  process.env.HOUSEHOLD_PROMPT_NAMES || HOUSEHOLD_MEMBERS.join(", ");

export const PAYMENT_METHODS = (
  process.env.PAYMENT_METHODS || "Credit Card,Checking,HSA Card,Unknown"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const DEFAULT_PAYMENT_METHOD =
  process.env.DEFAULT_PAYMENT_METHOD || PAYMENT_METHODS[0] || "Credit Card";
