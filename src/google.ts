import { INSTALLMENT_TAB, SHEET_TAB, TRACKER_TITLE } from "./config.js";
import type {
  ClaimCategory,
  InstallmentPlan,
  InstallmentScheduleRow,
} from "./types.js";

export interface SheetsClientLike {
  spreadsheets: {
    values: {
      get: (params: any) => Promise<{ data: { values?: any[][] | null } }>;
      update: (params: any) => Promise<any>;
      batchUpdate: (params: any) => Promise<any>;
    };
  };
}

export interface DriveClientLike {
  files: {
    list: (params: any) => Promise<{
      data: {
        files?: Array<{
          id?: string | null;
          name?: string | null;
          webViewLink?: string | null;
        }> | null;
      };
    }>;
  };
}

let cachedSheetsClient: SheetsClientLike | null = null;
let cachedDriveClient: DriveClientLike | null = null;

export function setGoogleClients(clients: {
  sheets?: SheetsClientLike | null;
  drive?: DriveClientLike | null;
}): void {
  if (clients.sheets !== undefined) cachedSheetsClient = clients.sheets;
  if (clients.drive !== undefined) cachedDriveClient = clients.drive;
}

/* node:coverage disable */
async function getGoogleClients(): Promise<{
  sheets: SheetsClientLike;
  drive: DriveClientLike;
}> {
  if (!cachedSheetsClient || !cachedDriveClient) {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
      ],
    });
    cachedSheetsClient = google.sheets({ version: "v4", auth });
    cachedDriveClient = google.drive({ version: "v3", auth });
  }
  return { sheets: cachedSheetsClient, drive: cachedDriveClient };
}
/* node:coverage enable */

let cachedSpreadsheetId: string | null = process.env.SPREADSHEET_ID || null;

export function resetCachedSpreadsheetId(value: string | null = null): void {
  cachedSpreadsheetId = value;
}

export async function resolveSpreadsheetId(
  driveClient?: DriveClientLike
): Promise<string> {
  if (cachedSpreadsheetId && !cachedSpreadsheetId.includes("your-")) {
    return cachedSpreadsheetId;
  }
  const drive = driveClient ?? (await getGoogleClients()).drive;
  const res = await drive.files.list({
    q: `name = '${TRACKER_TITLE}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 5,
  });
  if (!res.data.files || res.data.files.length === 0) {
    throw new Error(
      `Could not find spreadsheet "${TRACKER_TITLE}" in Google Drive. Ensure it is shared with the service account.`
    );
  }
  cachedSpreadsheetId = res.data.files[0].id!;
  return cachedSpreadsheetId;
}

export async function fetchExpenseRows(
  spreadsheetId: string,
  sheetsClient?: SheetsClientLike
): Promise<any[][]> {
  const sheets = sheetsClient ?? (await getGoogleClients()).sheets;
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TAB}'!B10:R250`,
  });
  return sheetRes.data.values || [];
}

export function parseInstallmentRows(rows: any[][]): {
  plans: InstallmentPlan[];
  schedule: InstallmentScheduleRow[];
} {
  const plans: InstallmentPlan[] = [];
  const schedule: InstallmentScheduleRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id = (r[1] || "").toString().trim();
    if (id.startsWith("PLAN-")) {
      plans.push({
        rowIndex: i + 1,
        planId: id,
        provider: (r[2] || "").toString().trim(),
        patient: (r[3] || "").toString().trim(),
        totalResponsibility: parseFloat(
          (r[4] || "0").toString().replace(/[$,]/g, "")
        ),
        remainingBalance: parseFloat(
          (r[6] || "0").toString().replace(/[$,]/g, "")
        ),
        monthlyPayment: parseFloat(
          (r[7] || "0").toString().replace(/[$,]/g, "")
        ),
        affiliatedProviders: (r[10] || "").toString().trim(),
      });
    } else if (id.startsWith("PMT-")) {
      schedule.push({
        rowIndex: i + 1,
        paymentId: id,
        scheduledDate: (r[2] || "").toString().trim(),
        provider: (r[3] || "").toString().trim(),
        paymentAmount: parseFloat(
          (r[5] || "0").toString().replace(/[$,]/g, "")
        ),
        status: (r[7] || "").toString().trim(),
        notes: (r[8] || "").toString().trim(),
      });
    }
  }
  return { plans, schedule };
}

export async function loadInstallmentTab(
  spreadsheetId: string,
  sheetsClient?: SheetsClientLike
): Promise<{
  plans: InstallmentPlan[];
  schedule: InstallmentScheduleRow[];
}> {
  try {
    const sheets = sheetsClient ?? (await getGoogleClients()).sheets;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${INSTALLMENT_TAB}'!A1:K50`,
    });
    return parseInstallmentRows(res.data.values || []);
  } catch {
    return { plans: [], schedule: [] };
  }
}

export async function lookupDriveLink(
  fileName: string,
  options: {
    driveClient?: DriveClientLike;
    maxAttempts?: number;
    retryDelayMs?: number;
  } = {}
): Promise<string> {
  const drive = options.driveClient ?? (await getGoogleClients()).drive;
  const maxAttempts = options.maxAttempts ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 3000;
  const escapedName = fileName.replace(/'/g, "\\'");
  const q = `name = '${escapedName}' and trashed = false`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await drive.files.list({
      q,
      fields: "files(id, name, webViewLink)",
      pageSize: 5,
    });
    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].webViewLink!;
    }
    console.log(
      `Waiting for Drive Desktop sync of ${fileName} (${attempt + 1}/${maxAttempts})...`
    );
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  console.warn(`Could not find Drive webViewLink for ${fileName} after 30s.`);
  return "";
}

export interface ExpenseRowUpsertParams {
  spreadsheetId: string;
  targetSheetRow: number;
  dateOfService: string;
  datePaid: string;
  patient: string;
  provider: string;
  category: ClaimCategory;
  description: string;
  billedAmount: number;
  outOfPocketAmount: number;
  payMethod: string;
  hasEobOrInvoice: boolean;
  hasReceiptOrStatement: boolean;
  linkFormula: string;
  combinedNotes: string;
  sheetsClient?: SheetsClientLike;
}

export async function upsertExpenseRow(
  params: ExpenseRowUpsertParams
): Promise<void> {
  const {
    spreadsheetId,
    targetSheetRow,
    dateOfService,
    datePaid,
    patient,
    provider,
    category,
    description,
    billedAmount,
    outOfPocketAmount,
    payMethod,
    hasEobOrInvoice,
    hasReceiptOrStatement,
    linkFormula,
    combinedNotes,
    sheetsClient,
  } = params;

  const sheets = sheetsClient ?? (await getGoogleClients()).sheets;
  const reimbStatus =
    payMethod === "HSA Card"
      ? "Paid via HSA Directly"
      : "Unreimbursed - Vaulted";

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `'${SHEET_TAB}'!C${targetSheetRow}:M${targetSheetRow}`,
          values: [
            [
              dateOfService,
              datePaid,
              patient,
              provider,
              category,
              description,
              billedAmount,
              outOfPocketAmount,
              payMethod,
              hasEobOrInvoice ? "Yes" : "No",
              hasReceiptOrStatement ? "Yes" : "No",
            ],
          ],
        },
        {
          range: `'${SHEET_TAB}'!O${targetSheetRow}:R${targetSheetRow}`,
          values: [
            [
              reimbStatus,
              payMethod === "HSA Card" ? datePaid : "",
              linkFormula,
              combinedNotes,
            ],
          ],
        },
      ],
    },
  });
}

export async function markInstallmentPaid(
  spreadsheetId: string,
  rowIndex: number,
  sheetsClient?: SheetsClientLike
): Promise<void> {
  const sheets = sheetsClient ?? (await getGoogleClients()).sheets;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${INSTALLMENT_TAB}'!H${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["Paid"]] },
  });
}
