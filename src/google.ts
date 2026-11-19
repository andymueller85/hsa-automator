import { google } from "googleapis";
import { INSTALLMENT_TAB, SHEET_TAB, TRACKER_TITLE } from "./config.js";
import type {
  ClaimCategory,
  InstallmentPlan,
  InstallmentScheduleRow,
} from "./types.js";

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ],
});

export const sheets = google.sheets({ version: "v4", auth });
export const drive = google.drive({ version: "v3", auth });

let cachedSpreadsheetId: string | null = process.env.SPREADSHEET_ID || null;

export async function resolveSpreadsheetId(): Promise<string> {
  if (cachedSpreadsheetId && !cachedSpreadsheetId.includes("your-")) {
    return cachedSpreadsheetId;
  }
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

export async function fetchExpenseRows(spreadsheetId: string): Promise<any[][]> {
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TAB}'!B10:R250`,
  });
  return sheetRes.data.values || [];
}

export async function loadInstallmentTab(spreadsheetId: string): Promise<{
  plans: InstallmentPlan[];
  schedule: InstallmentScheduleRow[];
}> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${INSTALLMENT_TAB}'!A1:K50`,
    });
    const rows = res.data.values || [];
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
  } catch {
    return { plans: [], schedule: [] };
  }
}

export async function lookupDriveLink(fileName: string): Promise<string> {
  const escapedName = fileName.replace(/'/g, "\\'");
  const q = `name = '${escapedName}' and trashed = false`;

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await drive.files.list({
      q,
      fields: "files(id, name, webViewLink)",
      pageSize: 5,
    });
    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].webViewLink!;
    }
    console.log(
      `Waiting for Drive Desktop sync of ${fileName} (${attempt + 1}/10)...`
    );
    await new Promise((r) => setTimeout(r, 3000));
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
  } = params;

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
  rowIndex: number
): Promise<void> {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${INSTALLMENT_TAB}'!H${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["Paid"]] },
  });
}
