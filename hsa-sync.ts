// hsa-sync.ts
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { google } from "googleapis";
import chokidar from "chokidar";
import "dotenv/config";

const DRY_RUN = process.argv.includes("--dry-run");
const WATCH_MODE = process.argv.includes("--watch");

const ROOT_DIR = process.env.MEDICAL_ROOT_DIR!;
const INBOX_DIR = path.join(ROOT_DIR, "Inbox");
const POOL_DIR = path.join(INBOX_DIR, "Reference-Pool");
const ARCHIVE_DIR = path.join(ROOT_DIR, "Archive");
const RECEIPTS_ROOT_DIR = path.join(ROOT_DIR, "Receipts");
const CACHE_FILE = path.join(process.cwd(), ".hsa-cache.json");

const TRACKER_TITLE = "Medical Expense & HSA Reimbursement Tracker";
const SHEET_TAB = process.env.SHEET_TAB_NAME || "HSA Expense Tracker";
const CC_POOL_RETENTION_DAYS = 60;

const HOUSEHOLD_MEMBERS = (process.env.HOUSEHOLD_MEMBERS || "Primary,Spouse,Dependent")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const HOUSEHOLD_PROMPT_NAMES =
  process.env.HOUSEHOLD_PROMPT_NAMES || HOUSEHOLD_MEMBERS.join(", ");
const PAYMENT_METHODS = (
  process.env.PAYMENT_METHODS || "Credit Card,Checking,HSA Card,Unknown"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_PAYMENT_METHOD =
  process.env.DEFAULT_PAYMENT_METHOD || PAYMENT_METHODS[0] || "Credit Card";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ],
});
const sheets = google.sheets({ version: "v4", auth });
const drive = google.drive({ version: "v3", auth });

interface ExtractedClaim {
  claimNumber?: string;
  dateOfService: string; // YYYY-MM-DD
  datePaid?: string; // YYYY-MM-DD
  patient: string;
  provider: string;
  category: "Medical" | "Dental" | "Vision" | "Prescription";
  description: string;
  billedOrEobAmount: number;
  qualifiedOutOfPocketAmount: number;
  nonQualifiedExcludedAmount: number;
  paymentMethod?: string;
  headerPageIndex: number; // 0-based page index
  relevantPageIndices: number[]; // 0-based page indices for this specific claim/charge
  provesMedicalNecessity: boolean; // True if EOB, itemized medical invoice, or Rx label/slip is shown
  provesPayment: boolean; // True if paid receipt, zero-balance invoice, or card charge is shown
  notes?: string;
}

interface ParsedFileMetadata {
  filePath: string;
  fileName: string;
  hash: string;
  subfolderGroup?: string;
  docType: "EOB" | "BILL_OR_INVOICE" | "PAYMENT_RECEIPT" | "CC_STATEMENT";
  isMultiClaimOrStatement: boolean;
  claims: ExtractedClaim[];
}

const extractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    docType: {
      type: Type.STRING,
      enum: ["EOB", "BILL_OR_INVOICE", "PAYMENT_RECEIPT", "CC_STATEMENT"],
    },
    isMultiClaimOrStatement: {
      type: Type.BOOLEAN,
      description:
        "True if this is a monthly EOB with multiple claims or a full credit card statement.",
    },
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claimNumber: { type: Type.STRING },
          dateOfService: { type: Type.STRING, description: "YYYY-MM-DD" },
          datePaid: { type: Type.STRING, description: "YYYY-MM-DD if shown" },
          patient: { type: Type.STRING, enum: HOUSEHOLD_MEMBERS },
          provider: {
            type: Type.STRING,
            description: "Clean provider name, e.g., Valley Medical Clinic",
          },
          category: {
            type: Type.STRING,
            enum: ["Medical", "Dental", "Vision", "Prescription"],
          },
          description: { type: Type.STRING },
          billedOrEobAmount: { type: Type.NUMBER },
          qualifiedOutOfPocketAmount: {
            type: Type.NUMBER,
            description:
              "Patient responsibility minus non-qualified items like warranties/protection plans.",
          },
          nonQualifiedExcludedAmount: { type: Type.NUMBER },
          paymentMethod: {
            type: Type.STRING,
            enum: PAYMENT_METHODS,
          },
          headerPageIndex: {
            type: Type.INTEGER,
            description:
              "0-based page index containing document header/patient/account info (usually 0).",
          },
          relevantPageIndices: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            description:
              "0-based page indices containing this specific claim or transaction line.",
          },
          provesMedicalNecessity: {
            type: Type.BOOLEAN,
            description:
              "True if the document includes an EOB, itemized medical invoice, or pharmacy Rx label/slip showing patient, date, and drug/service.",
          },
          provesPayment: {
            type: Type.BOOLEAN,
            description:
              "True if the document includes a register receipt, paid confirmation, zero-balance invoice, or credit card charge.",
          },
          notes: {
            type: Type.STRING,
            description:
              "Concise IRS audit memo listing Rx/Claim/Account/Order numbers, drug or clinical details, payment card last 4 digits/auth codes, and any excluded non-qualified amounts.",
          },
        },
        required: [
          "dateOfService",
          "patient",
          "provider",
          "category",
          "description",
          "billedOrEobAmount",
          "qualifiedOutOfPocketAmount",
          "nonQualifiedExcludedAmount",
          "headerPageIndex",
          "relevantPageIndices",
          "provesMedicalNecessity",
          "provesPayment",
          "notes",
        ],
      },
    },
  },
  required: ["docType", "isMultiClaimOrStatement", "claims"],
};

let cachedSpreadsheetId: string | null = process.env.SPREADSHEET_ID || null;

async function resolveSpreadsheetId(): Promise<string> {
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

async function hashFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function loadCache(): Promise<Record<string, ParsedFileMetadata>> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveCache(cache: Record<string, ParsedFileMetadata>) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function parseDocumentWithGemini(
  filePath: string,
  subfolderGroup?: string,
  cache: Record<string, ParsedFileMetadata> = {}
): Promise<ParsedFileMetadata> {
  const hash = await hashFile(filePath);
  if (
    cache[hash] &&
    cache[hash].claims?.every(
      (c) => typeof c.provesMedicalNecessity === "boolean" && Boolean(c.notes)
    )
  ) {
    return {
      ...cache[hash],
      filePath,
      fileName: path.basename(filePath),
      subfolderGroup,
    };
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType =
    ext === ".pdf"
      ? "application/pdf"
      : ext === ".png"
      ? "image/png"
      : "image/jpeg";
  const fileBytes = await fs.readFile(filePath);

  console.log(`Analyzing with Gemini: ${path.basename(filePath)}...`);
  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: [
      {
        inlineData: {
          mimeType,
          data: fileBytes.toString("base64"),
        },
      },
      `Extract all medical claims, bills, pharmacy slips, or medical credit card charges from this document for household members ${HOUSEHOLD_PROMPT_NAMES}.
      - Subtract non-qualified items (like eyewear protection plans or warranties) from qualifiedOutOfPocketAmount.
      - Set provesMedicalNecessity to true if the document shows clinical service descriptions, CPT/HCPCS codes, EOB claim details, or a pharmacy Rx slip with drug/patient details.
      - Set provesPayment to true if the document shows a payment tender, register receipt, paid-in-full balance, or credit card statement charge.
      - For EOBs or credit card statements, return separate items in the claims array for each distinct medical claim/charge, along with exact 0-based page indices.
      - Always populate 'notes' with a concise audit memo (e.g., "Rx #123456 (Drug Name); Paid via Visa *1234, Auth #98765" or "Claim #2026...; Excludes $30 protection plan").`,
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: extractionSchema,
    },
  });

  const parsed = JSON.parse(response.text!);
  const meta: ParsedFileMetadata = {
    filePath,
    fileName: path.basename(filePath),
    hash,
    subfolderGroup,
    ...parsed,
  };

  cache[hash] = meta;
  await saveCache(cache);
  return meta;
}

async function buildSlicedPdf(
  sources: { filePath: string; pagesToInclude: number[] }[],
  outputPath: string
) {
  const mergedPdf = await PDFDocument.create();

  for (const src of sources) {
    const ext = path.extname(src.filePath).toLowerCase();
    const rawBytes = await fs.readFile(src.filePath);

    if (ext === ".pdf") {
      const srcDoc = await PDFDocument.load(rawBytes);
      const totalPages = srcDoc.getPageCount();
      const uniqueValidPages = Array.from(new Set(src.pagesToInclude)).filter(
        (p) => p >= 0 && p < totalPages
      );
      const copiedPages = await mergedPdf.copyPages(srcDoc, uniqueValidPages);
      copiedPages.forEach((p) => mergedPdf.addPage(p));
    } else {
      const pngBytes = await sharp(rawBytes).png().toBuffer();
      const img = await mergedPdf.embedPng(pngBytes);
      const page = mergedPdf.addPage([612, 792]);
      const maxW = 532;
      const scale = Math.min(1, maxW / img.width);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      page.drawImage(img, {
        x: 40,
        y: 792 - 60 - drawH,
        width: drawW,
        height: drawH,
      });
    }
  }

  const pdfBytes = await mergedPdf.save();
  await fs.writeFile(outputPath, pdfBytes);
}

async function lookupDriveLink(fileName: string): Promise<string> {
  const escapedName = fileName.replace(/'/g, "\\'");
  const q = `name = '${escapedName}' and trashed = false`;

  // Retry up to 10 times (30s total) for Google Drive for Desktop to upload the new PDF
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

function sanitizeProvider(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function cleanupReferencePool(
  spreadsheetId: string,
  cache: Record<string, ParsedFileMetadata>
) {
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TAB}'!B10:R200`,
  });
  const latestRows = sheetRes.data.values || [];

  const isClaimCompleteInSheet = (claim: ExtractedClaim): boolean => {
    return latestRows.some((row) => {
      const rowPatient = row[3];
      const rowBilled = parseFloat(
        (row[7] || "0").toString().replace(/[$,]/g, "")
      );
      const rowQualified = parseFloat(
        (row[8] || "0").toString().replace(/[$,]/g, "")
      );
      const rowAuditStatus = row[12]; // Column N (0-indexed from Column B = index 12)
      const rowNotes = (row[16] || "").toString();

      const amountMatches =
        Math.abs(rowQualified - claim.qualifiedOutOfPocketAmount) < 0.01 ||
        Math.abs(rowBilled - claim.billedOrEobAmount) < 0.01;

      const claimNumMatches =
        claim.claimNumber && rowNotes.includes(claim.claimNumber);

      return (
        rowAuditStatus === "Complete" &&
        rowPatient === claim.patient &&
        (amountMatches || Boolean(claimNumMatches))
      );
    });
  };

  const poolFiles = await fs.readdir(POOL_DIR);
  for (const fileName of poolFiles) {
    if (!/\.(pdf|png|jpg|jpeg)$/i.test(fileName)) continue;
    const poolFilePath = path.join(POOL_DIR, fileName);
    const meta = await parseDocumentWithGemini(poolFilePath, undefined, cache);

    const actionableClaims = meta.claims.filter(
      (c) => c.qualifiedOutOfPocketAmount > 0
    );

    const allClaimsComplete =
      actionableClaims.length > 0 &&
      actionableClaims.every((c) => isClaimCompleteInSheet(c));

    let retentionSatisfied = true;
    if (meta.docType === "CC_STATEMENT") {
      const stats = await fs.stat(poolFilePath);
      const ageInDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      retentionSatisfied = ageInDays >= CC_POOL_RETENTION_DAYS;
    }

    if (allClaimsComplete && retentionSatisfied) {
      const archiveDest = path.join(ARCHIVE_DIR, fileName);
      console.log(
        `${
          DRY_RUN ? "[DRY-RUN] " : ""
        }Retiring resolved pool document to Archive: ${fileName}`
      );
      if (!DRY_RUN) {
        await fs.rename(poolFilePath, archiveDest);
      }
    }
  }

  const inboxEntries = await fs.readdir(INBOX_DIR, { withFileTypes: true });
  for (const entry of inboxEntries) {
    if (entry.isDirectory() && entry.name !== "Reference-Pool") {
      const subDirPath = path.join(INBOX_DIR, entry.name);
      const remaining = await fs.readdir(subDirPath);
      if (remaining.length === 0) {
        console.log(
          `${DRY_RUN ? "[DRY-RUN] " : ""}Removing empty Inbox subfolder: ${
            entry.name
          }`
        );
        if (!DRY_RUN) {
          await fs.rmdir(subDirPath);
        }
      }
    }
  }
}

async function runSync() {
  await fs.mkdir(POOL_DIR, { recursive: true });
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  await fs.mkdir(RECEIPTS_ROOT_DIR, { recursive: true });

  const spreadsheetId = await resolveSpreadsheetId();
  const cache = await loadCache();
  const entries = await fs.readdir(INBOX_DIR, { withFileTypes: true });
  const parsedDocs: ParsedFileMetadata[] = [];

  for (const entry of entries) {
    if (entry.name === "Reference-Pool" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(INBOX_DIR, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await fs.readdir(fullPath);
      for (const sf of subFiles) {
        if (/\.(pdf|png|jpg|jpeg)$/i.test(sf)) {
          parsedDocs.push(
            await parseDocumentWithGemini(
              path.join(fullPath, sf),
              entry.name,
              cache
            )
          );
        }
      }
    } else if (/\.(pdf|png|jpg|jpeg)$/i.test(entry.name)) {
      parsedDocs.push(
        await parseDocumentWithGemini(fullPath, undefined, cache)
      );
    }
  }

  const poolEntries = await fs.readdir(POOL_DIR);
  for (const pe of poolEntries) {
    if (/\.(pdf|png|jpg|jpeg)$/i.test(pe)) {
      parsedDocs.push(
        await parseDocumentWithGemini(path.join(POOL_DIR, pe), undefined, cache)
      );
    }
  }

  if (parsedDocs.length === 0) {
    console.log("No documents found in Inbox.");
    return;
  }

  interface ClaimBundle {
    key: string;
    claims: { doc: ParsedFileMetadata; claim: ExtractedClaim }[];
  }
  const bundles: ClaimBundle[] = [];

  for (const doc of parsedDocs) {
    for (const claim of doc.claims) {
      if (claim.qualifiedOutOfPocketAmount <= 0) continue;

      const matchKey = doc.subfolderGroup
        ? `SUBFOLDER:${doc.subfolderGroup}`
        : `${claim.patient}_${claim.qualifiedOutOfPocketAmount.toFixed(2)}`;

      let bundle = bundles.find((b) => b.key === matchKey);
      if (!bundle) {
        bundle = { key: matchKey, claims: [] };
        bundles.push(bundle);
      }
      bundle.claims.push({ doc, claim });
    }
  }

  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TAB}'!B10:R200`,
  });
  const existingRows = sheetRes.data.values || [];

  for (const bundle of bundles) {
    const primary = bundle.claims[0].claim;
    const hasEobOrInvoice = bundle.claims.some(
      (c) =>
        c.claim.provesMedicalNecessity ||
        c.doc.docType === "EOB" ||
        c.doc.docType === "BILL_OR_INVOICE"
    );
    const hasReceiptOrStatement = bundle.claims.some(
      (c) =>
        c.claim.provesPayment ||
        c.doc.docType === "PAYMENT_RECEIPT" ||
        c.doc.docType === "CC_STATEMENT"
    );

    const amountStr = primary.qualifiedOutOfPocketAmount.toFixed(2);
    const pdfFileName = `${primary.dateOfService}_${sanitizeProvider(
      primary.provider
    )}_${primary.patient}_$${amountStr}.pdf`;
    const serviceYear =
      primary.dateOfService.slice(0, 4) || new Date().getFullYear().toString();
    const yearReceiptsDir = path.join(RECEIPTS_ROOT_DIR, serviceYear);
    await fs.mkdir(yearReceiptsDir, { recursive: true });
    const outputPdfPath = path.join(yearReceiptsDir, pdfFileName);

    const slicePlan = bundle.claims.map((c) => ({
      fileName: c.doc.fileName,
      filePath: c.doc.filePath,
      pagesToInclude: [c.claim.headerPageIndex, ...c.claim.relevantPageIndices],
    }));

    const existingRowIndex = existingRows.findIndex(
      (r) =>
        r[3] === primary.patient &&
        parseFloat((r[8] || "0").toString().replace(/[$,]/g, "")) ===
          primary.qualifiedOutOfPocketAmount
    );
    const targetSheetRow =
      existingRowIndex >= 0 ? 10 + existingRowIndex : 10 + existingRows.length;

    console.log("\n========================================");
    console.log(`${DRY_RUN ? "[DRY-RUN] " : ""}Bundle: ${bundle.key}`);
    console.log(`Target PDF: ${pdfFileName}`);
    console.log(
      `Page Slices: ${slicePlan
        .map(
          (s) =>
            `${s.fileName} [pages: ${Array.from(new Set(s.pagesToInclude))
              .map((p) => p + 1)
              .join(",")}]`
        )
        .join(" + ")}`
    );
    console.log(
      `Sheet Action: ${
        existingRowIndex >= 0
          ? `Update Staged Row ${targetSheetRow}`
          : `Append at Row ${targetSheetRow}`
      } | MedNecessity=${hasEobOrInvoice ? "Yes" : "No"}, Receipt=${
        hasReceiptOrStatement ? "Yes" : "No"
      }`
    );

    if (!DRY_RUN) {
      await buildSlicedPdf(slicePlan, outputPdfPath);
      const webViewLink = await lookupDriveLink(pdfFileName);
      const linkFormula = webViewLink
        ? `=HYPERLINK("${webViewLink}", "${pdfFileName}")`
        : pdfFileName;

      const payMethod =
        bundle.claims.find(
          (c) => c.claim.paymentMethod && c.claim.paymentMethod !== "Unknown"
        )?.claim.paymentMethod || DEFAULT_PAYMENT_METHOD;
      const reimbStatus =
        payMethod === "HSA Card"
          ? "Paid via HSA Directly"
          : "Unreimbursed (Vaulted)";
      const datePaid =
        bundle.claims.find((c) => c.claim.datePaid)?.claim.datePaid || "";
      const combinedNotes = bundle.claims
        .map((c) => c.claim.notes)
        .filter(Boolean)
        .join("; ");

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            {
              range: `'${SHEET_TAB}'!C${targetSheetRow}:M${targetSheetRow}`,
              values: [
                [
                  primary.dateOfService,
                  datePaid,
                  primary.patient,
                  primary.provider,
                  primary.category,
                  primary.description,
                  primary.billedOrEobAmount,
                  primary.qualifiedOutOfPocketAmount,
                  payMethod,
                  hasEobOrInvoice ? "Yes" : "No",
                  hasReceiptOrStatement ? "Yes" : "No",
                ],
              ],
            },
            {
              range: `'${SHEET_TAB}'!O${targetSheetRow}:R${targetSheetRow}`,
              values: [[reimbStatus, "", linkFormula, combinedNotes]],
            },
          ],
        },
      });

      for (const item of bundle.claims) {
        const destDir = item.doc.isMultiClaimOrStatement
          ? POOL_DIR
          : ARCHIVE_DIR;
        const destPath = path.join(destDir, item.doc.fileName);
        if (item.doc.filePath !== destPath) {
          await fs.rename(item.doc.filePath, destPath).catch(() => {});
        }
      }
    }
  }

  await cleanupReferencePool(spreadsheetId, cache);
}

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
