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
const INSTALLMENT_TAB =
  process.env.INSTALLMENT_TAB_NAME || "0% Installment Plans";
const CC_POOL_RETENTION_DAYS = 60;

const HOUSEHOLD_MEMBERS = (
  process.env.HOUSEHOLD_MEMBERS || "Primary,Spouse,Dependent"
)
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
  installmentPlanId?: string; // Populated by Gemini when claim/payment matches an active installment plan
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
  planFingerprint?: string;
  subfolderGroup?: string;
  docType:
    | "EOB"
    | "BILL_OR_INVOICE"
    | "PAYMENT_RECEIPT"
    | "CC_STATEMENT"
    | "TRANSACTION_CSV";
  isMultiClaimOrStatement: boolean;
  claims: ExtractedClaim[];
}

interface InstallmentPlan {
  rowIndex: number;
  planId: string;
  provider: string;
  patient: string;
  totalResponsibility: number;
  remainingBalance: number;
  monthlyPayment: number;
  affiliatedProviders?: string;
}

interface InstallmentScheduleRow {
  rowIndex: number;
  paymentId: string;
  scheduledDate: string;
  provider: string;
  paymentAmount: number;
  status: string;
  notes: string;
}

const extractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    docType: {
      type: Type.STRING,
      enum: [
        "EOB",
        "BILL_OR_INVOICE",
        "PAYMENT_RECEIPT",
        "CC_STATEMENT",
        "TRANSACTION_CSV",
      ],
    },
    isMultiClaimOrStatement: {
      type: Type.BOOLEAN,
      description:
        "True if this is a monthly EOB with multiple claims, a credit card statement, or a multi-row CSV.",
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
            description:
              "Clean provider name. If matching an active installment plan, use the exact installment plan provider name.",
          },
          installmentPlanId: {
            type: Type.STRING,
            description:
              "If this EOB or payment belongs to one of the active installment plans provided in the prompt, set to its Plan ID (e.g. PLAN-001).",
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
              "Patient responsibility or installment payment amount minus non-qualified items like warranties/protection plans.",
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
              "True if the document includes a register receipt, paid confirmation, zero-balance invoice, credit card charge, or CSV payment row.",
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

async function loadInstallmentTab(spreadsheetId: string): Promise<{
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
  subfolderGroup: string | undefined,
  cache: Record<string, ParsedFileMetadata>,
  installmentPlans: InstallmentPlan[]
): Promise<ParsedFileMetadata> {
  const hash = await hashFile(filePath);
  const planFingerprint = installmentPlans.map((p) => p.planId).join(",");
  if (
    cache[hash] &&
    cache[hash].planFingerprint === planFingerprint &&
    cache[hash].claims?.every(
      (c) =>
        typeof c.provesMedicalNecessity === "boolean" &&
        Boolean(c.notes) &&
        (!c.paymentMethod || PAYMENT_METHODS.includes(c.paymentMethod))
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
  const fileBytes = await fs.readFile(filePath);

  const planContext =
    installmentPlans.length > 0
      ? `\n      Active Installment Plans:\n` +
        installmentPlans
          .map(
            (p) =>
              `      - ${p.planId}: Provider="${p.provider}"${
                p.affiliatedProviders
                  ? ` (Affiliated EOB/Billing Providers: ${p.affiliatedProviders})`
                  : ""
              }, Patient="${p.patient}", TotalResponsibility=$${p.totalResponsibility}, MonthlyPayment=$${p.monthlyPayment}`
          )
          .join("\n") +
        `\n      If an EOB claim or a payment transaction belongs to one of these installment plans (including any listed affiliated providers/doctors or monthly payment amounts), set 'installmentPlanId' to that Plan ID and set 'provider' to the exact Plan Provider name.`
      : "";

  const promptText = `Extract all medical claims, bills, pharmacy slips, or medical payment charges from this document for household members ${HOUSEHOLD_PROMPT_NAMES}.${planContext}
      - Subtract non-qualified items (like eyewear protection plans or warranties) from qualifiedOutOfPocketAmount.
      - Exclude denied out-of-network claims where the plan did not cover the service due to missing preapproval/referral (e.g., reason code 707) or revised/duplicate $0.00 claims.
      - For CSV transaction histories or Credit Card Statements, only extract bona fide medical/dental/vision/pharmacy payments or active installment plan payments (ignore payroll contributions, interest, investment transfers, and non-medical retail charges).
      - Set provesMedicalNecessity to true if the document shows clinical service descriptions, CPT/HCPCS codes, EOB claim details, or a pharmacy Rx slip with drug/patient details.
      - Set provesPayment to true if the document shows a payment tender, register receipt, paid-in-full balance, credit card charge, or CSV payment transaction.
      - Always populate 'notes' with a concise audit memo (e.g., "Rx #123456 (Drug Name); Paid via Visa *1234, Auth #98765" or "Claim #2026...; Patient responsibility $150.00").`;

  const contentPart =
    ext === ".csv"
      ? { text: `CSV Filename: ${path.basename(filePath)}\n\n${fileBytes.toString("utf8")}` }
      : {
          inlineData: {
            mimeType:
              ext === ".pdf"
                ? "application/pdf"
                : ext === ".png"
                ? "image/png"
                : "image/jpeg",
            data: fileBytes.toString("base64"),
          },
        };

  console.log(`Analyzing with Gemini: ${path.basename(filePath)}...`);
  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: [contentPart, promptText],
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
    planFingerprint,
    subfolderGroup,
    ...parsed,
  };

  cache[hash] = meta;
  await saveCache(cache);
  return meta;
}

async function buildSlicedPdf(
  sources: { filePath: string; pagesToInclude: number[] }[],
  outputPath: string,
  prependExistingPdf: boolean = false
) {
  const mergedPdf = await PDFDocument.create();
  const seenPages = new Set<string>();

  if (prependExistingPdf) {
    try {
      const existingBytes = await fs.readFile(outputPath);
      const existingDoc = await PDFDocument.load(existingBytes);
      const indices = existingDoc.getPageIndices();
      const copied = await mergedPdf.copyPages(existingDoc, indices);
      copied.forEach((p) => mergedPdf.addPage(p));
    } catch {
      // Output PDF does not exist yet
    }
  }

  for (const src of sources) {
    const ext = path.extname(src.filePath).toLowerCase();
    if (ext === ".csv") continue; // CSVs are provisional metadata only; never embedded into IRS PDFs

    const rawBytes = await fs.readFile(src.filePath);

    if (ext === ".pdf") {
      const srcDoc = await PDFDocument.load(rawBytes);
      const totalPages = srcDoc.getPageCount();
      const uniqueValidPages = Array.from(new Set(src.pagesToInclude)).filter(
        (p) => {
          if (p < 0 || p >= totalPages) return false;
          const key = `${src.filePath}::${p}`;
          if (seenPages.has(key)) return false;
          seenPages.add(key);
          return true;
        }
      );
      if (uniqueValidPages.length > 0) {
        const copiedPages = await mergedPdf.copyPages(srcDoc, uniqueValidPages);
        copiedPages.forEach((p) => mergedPdf.addPage(p));
      }
    } else {
      const key = `${src.filePath}::0`;
      if (seenPages.has(key)) continue;
      seenPages.add(key);

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

  if (mergedPdf.getPageCount() > 0) {
    const pdfBytes = await mergedPdf.save();
    await fs.writeFile(outputPath, pdfBytes);
  }
}

async function lookupDriveLink(fileName: string): Promise<string> {
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

function sanitizeProvider(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function matchInstallmentPlan(
  claim: ExtractedClaim,
  plans: InstallmentPlan[]
): InstallmentPlan | undefined {
  if (claim.installmentPlanId) {
    const byId = plans.find((p) => p.planId === claim.installmentPlanId);
    if (byId) return byId;
  }
  const tokens = (s: string) =>
    s
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((t) => t.length >= 2);
  const cTokens = new Set(tokens(claim.provider));
  return plans.find((p) => {
    const aliases = [
      p.provider,
      ...(p.affiliatedProviders ? p.affiliatedProviders.split(",") : []),
    ]
      .map((s) => s.trim())
      .filter(Boolean);
    const aliasMatch = aliases.some((a) => {
      const aTokens = tokens(a);
      return aTokens.length > 0 && aTokens.every((t) => cTokens.has(t));
    });
    return (
      aliasMatch ||
      Math.abs(claim.qualifiedOutOfPocketAmount - p.totalResponsibility) <
        0.01 ||
      Math.abs(claim.qualifiedOutOfPocketAmount - p.monthlyPayment) < 0.01
    );
  });
}

async function cleanupReferencePool(
  spreadsheetId: string,
  cache: Record<string, ParsedFileMetadata>,
  installmentPlans: InstallmentPlan[]
) {
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TAB}'!B10:R250`,
  });
  const latestRows = sheetRes.data.values || [];

  const isClaimCompleteInSheet = (claim: ExtractedClaim): boolean => {
    const plan = matchInstallmentPlan(claim, installmentPlans);
    if (plan && plan.remainingBalance > 0) {
      return false; // Keep installment EOBs in Reference-Pool while the plan has a remaining balance
    }

    return latestRows.some((row) => {
      const rowPatient = row[3];
      const rowBilled = parseFloat(
        (row[7] || "0").toString().replace(/[$,]/g, "")
      );
      const rowQualified = parseFloat(
        (row[8] || "0").toString().replace(/[$,]/g, "")
      );
      const rowAuditStatus = row[12];
      const rowNotes = (row[16] || "").toString();

      const amountMatches =
        Math.abs(rowQualified - claim.qualifiedOutOfPocketAmount) < 0.01 ||
        Math.abs(rowBilled - claim.qualifiedOutOfPocketAmount) < 0.01;
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
    if (!/\.(pdf|png|jpg|jpeg|csv)$/i.test(fileName)) continue;
    const poolFilePath = path.join(POOL_DIR, fileName);
    const meta = await parseDocumentWithGemini(
      poolFilePath,
      undefined,
      cache,
      installmentPlans
    );
    if (meta.docType === "TRANSACTION_CSV") continue;

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
  const [sheetRes, installmentData, cache] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${SHEET_TAB}'!B10:R250`,
    }),
    loadInstallmentTab(spreadsheetId),
    loadCache(),
  ]);
  const existingRows = sheetRes.data.values || [];
  const { plans: installmentPlans, schedule: installmentSchedule } =
    installmentData;

  const entries = await fs.readdir(INBOX_DIR, { withFileTypes: true });
  const parsedDocs: ParsedFileMetadata[] = [];

  for (const entry of entries) {
    if (entry.name === "Reference-Pool" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(INBOX_DIR, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await fs.readdir(fullPath);
      for (const sf of subFiles) {
        if (/\.(pdf|png|jpg|jpeg|csv)$/i.test(sf)) {
          parsedDocs.push(
            await parseDocumentWithGemini(
              path.join(fullPath, sf),
              entry.name,
              cache,
              installmentPlans
            )
          );
        }
      }
    } else if (/\.(pdf|png|jpg|jpeg|csv)$/i.test(entry.name)) {
      parsedDocs.push(
        await parseDocumentWithGemini(
          fullPath,
          undefined,
          cache,
          installmentPlans
        )
      );
    }
  }

  const poolEntries = await fs.readdir(POOL_DIR);
  for (const pe of poolEntries) {
    if (/\.(pdf|png|jpg|jpeg|csv)$/i.test(pe)) {
      parsedDocs.push(
        await parseDocumentWithGemini(
          path.join(POOL_DIR, pe),
          undefined,
          cache,
          installmentPlans
        )
      );
    }
  }

  if (parsedDocs.length === 0) {
    console.log("No documents found in Inbox.");
    return;
  }

  interface ClaimBundle {
    key: string;
    plan?: InstallmentPlan;
    matchedScheduleRow?: InstallmentScheduleRow;
    claims: { doc: ParsedFileMetadata; claim: ExtractedClaim }[];
  }
  const bundles: ClaimBundle[] = [];
  const installmentEobs = new Map<
    string,
    { doc: ParsedFileMetadata; claim: ExtractedClaim }[]
  >();
  const installmentPayments: {
    plan: InstallmentPlan;
    doc: ParsedFileMetadata;
    claim: ExtractedClaim;
  }[] = [];

  // 1. Group EOBs & Payments into either Installment Plan buckets or standard bundles
  for (const doc of parsedDocs) {
    for (const claim of doc.claims) {
      if (claim.qualifiedOutOfPocketAmount <= 0) continue;

      const plan = !doc.subfolderGroup
        ? matchInstallmentPlan(claim, installmentPlans)
        : undefined;

      if (plan) {
        const isPaymentOnly =
          !claim.provesMedicalNecessity &&
          (doc.docType === "PAYMENT_RECEIPT" ||
            doc.docType === "CC_STATEMENT" ||
            doc.docType === "TRANSACTION_CSV" ||
            claim.provesPayment);

        if (isPaymentOnly) {
          installmentPayments.push({ plan, doc, claim });
        } else {
          const list = installmentEobs.get(plan.planId) || [];
          // Deduplicate identical claim numbers across duplicate EOB files
          if (
            !claim.claimNumber ||
            !list.some((e) => e.claim.claimNumber === claim.claimNumber)
          ) {
            list.push({ doc, claim });
            installmentEobs.set(plan.planId, list);
          }
        }
        continue;
      }

      // Skip standalone CSV/CC rows that don't match an EOB or an active installment plan
      if (
        (doc.docType === "TRANSACTION_CSV" || doc.docType === "CC_STATEMENT") &&
        !claim.provesMedicalNecessity
      ) {
        const matchesSomeEob = parsedDocs.some((d) =>
          d.claims.some(
            (c) =>
              c.provesMedicalNecessity &&
              c.patient === claim.patient &&
              Math.abs(
                c.qualifiedOutOfPocketAmount - claim.qualifiedOutOfPocketAmount
              ) < 0.01
          )
        );
        if (!matchesSomeEob) continue;
      }

      const matchKey = doc.subfolderGroup
        ? `SUBFOLDER:${doc.subfolderGroup}`
        : `${claim.patient}_${claim.qualifiedOutOfPocketAmount.toFixed(2)}`;

      let bundle = bundles.find((b) => b.key === matchKey);
      if (!bundle) {
        bundle = { key: matchKey, claims: [] };
        bundles.push(bundle);
      }
      // Avoid adding duplicate claim numbers from duplicate EOB files
      if (
        !claim.claimNumber ||
        !bundle.claims.some((c) => c.claim.claimNumber === claim.claimNumber)
      ) {
        bundle.claims.push({ doc, claim });
      }
    }
  }

  // 2. Build a bundle for each matched Installment Plan payment paired with that plan's EOBs
  for (const pmt of installmentPayments) {
    const planEobs = installmentEobs.get(pmt.plan.planId) || [];
    const payDate = pmt.claim.datePaid || pmt.claim.dateOfService;
    if (
      Math.abs(
        pmt.claim.qualifiedOutOfPocketAmount - pmt.plan.monthlyPayment
      ) >= 0.05 &&
      !installmentSchedule.some(
        (s) =>
          s.provider.toUpperCase() === pmt.plan.provider.toUpperCase() &&
          Math.abs(s.paymentAmount - pmt.claim.qualifiedOutOfPocketAmount) < 0.05
      )
    ) {
      continue;
    }
    const matchedSched = installmentSchedule.find(
      (s) =>
        s.provider.toUpperCase() === pmt.plan.provider.toUpperCase() &&
        Math.abs(s.paymentAmount - pmt.claim.qualifiedOutOfPocketAmount) <
          0.05 &&
        Math.abs(
          new Date(s.scheduledDate).getTime() - new Date(payDate).getTime()
        ) <=
          10 * 86400000
    );

    bundles.push({
      key: `INSTALLMENT:${pmt.plan.planId}_${payDate}_${pmt.claim.qualifiedOutOfPocketAmount.toFixed(2)}`,
      plan: pmt.plan,
      matchedScheduleRow: matchedSched,
      claims: [...planEobs, { doc: pmt.doc, claim: pmt.claim }],
    });
  }

  let nextAppendOffset = existingRows.length;

  const filesToMove = new Map<string, string>();

  for (const bundle of bundles) {
    const orderedClaims = [...bundle.claims].sort((a, b) => {
      const aIsMed =
        a.doc.docType === "EOB" ||
        a.doc.docType === "BILL_OR_INVOICE" ||
        a.claim.provesMedicalNecessity;
      const bIsMed =
        b.doc.docType === "EOB" ||
        b.doc.docType === "BILL_OR_INVOICE" ||
        b.claim.provesMedicalNecessity;
      return aIsMed === bIsMed ? 0 : aIsMed ? -1 : 1;
    });

    const primary = orderedClaims[0].claim;
    const payClaim = orderedClaims.find((c) => c.claim.provesPayment)?.claim;
    const dateOfService = primary.dateOfService;
    const datePaid =
      payClaim?.datePaid ||
      (payClaim ? payClaim.dateOfService : "") ||
      orderedClaims.find((c) => c.claim.datePaid)?.claim.datePaid ||
      "";
    const payMethod = datePaid
      ? orderedClaims.find(
          (c) => c.claim.paymentMethod && c.claim.paymentMethod !== "Unknown"
        )?.claim.paymentMethod || DEFAULT_PAYMENT_METHOD
      : "";

    const hasEobOrInvoice = orderedClaims.some(
      (c) =>
        c.claim.provesMedicalNecessity ||
        c.doc.docType === "EOB" ||
        c.doc.docType === "BILL_OR_INVOICE"
    );
    const hasPdfPaymentProof = orderedClaims.some(
      (c) =>
        c.doc.docType !== "TRANSACTION_CSV" &&
        (c.claim.provesPayment ||
          c.doc.docType === "PAYMENT_RECEIPT" ||
          c.doc.docType === "CC_STATEMENT")
    );
    const hasCsvPaymentProof = orderedClaims.some(
      (c) => c.doc.docType === "TRANSACTION_CSV" && c.claim.provesPayment
    );
    // CSV is only final audit proof for HSA Card distributions (backed by custodian 1099-SA + EOB PDF).
    // Out-of-pocket Amex/Checking CSV rows remain Receipt=No until an official PDF statement/receipt is matched.
    const hasReceiptOrStatement =
      hasPdfPaymentProof || (hasCsvPaymentProof && payMethod === "HSA Card");
    const isBundleComplete = hasEobOrInvoice && hasReceiptOrStatement;

    const patient =
      bundle.plan && bundle.plan.patient !== "Family"
        ? bundle.plan.patient
        : primary.patient;
    const provider = bundle.plan ? bundle.plan.provider : primary.provider;
    const outOfPocketAmount =
      bundle.plan && payClaim
        ? payClaim.qualifiedOutOfPocketAmount
        : primary.qualifiedOutOfPocketAmount;
    const billedAmount = bundle.plan
      ? bundle.plan.totalResponsibility
      : Math.max(...orderedClaims.map((c) => c.claim.billedOrEobAmount || 0));
    const description = bundle.plan
      ? bundle.matchedScheduleRow
        ? `${bundle.matchedScheduleRow.paymentId}: ${bundle.matchedScheduleRow.notes}`
        : `0% Installment Plan Payment (${bundle.plan.planId})`
      : primary.description;

    const existingRowIndex = existingRows.findIndex((r) => {
      const rDos = (r[1] || "").toString().trim();
      const rPaidDate = (r[2] || "").toString().trim();
      const rPat = (r[3] || "").toString().trim();
      const rAmt = parseFloat((r[8] || "0").toString().replace(/[$,]/g, ""));
      const rNotes = (r[16] || "").toString();

      if (bundle.plan) {
        return (
          rPaidDate === datePaid &&
          Math.abs(rAmt - outOfPocketAmount) < 0.01 &&
          (r[4] || "").toString().toUpperCase() === provider.toUpperCase()
        );
      }
      if (primary.claimNumber && rNotes.includes(primary.claimNumber)) {
        return true;
      }
      return (
        rPat === patient &&
        Math.abs(rAmt - outOfPocketAmount) < 0.01 &&
        (!rDos || rDos === dateOfService)
      );
    });

    const allInPool = orderedClaims.every(
      (c) => path.dirname(c.doc.filePath) === POOL_DIR
    );
    const hasNewInboxSingleDoc = orderedClaims.some(
      (c) =>
        path.dirname(c.doc.filePath) !== POOL_DIR &&
        !c.doc.isMultiClaimOrStatement
    );
    if (
      existingRowIndex >= 0 &&
      existingRows[existingRowIndex][12] === "Complete" &&
      !hasNewInboxSingleDoc
    ) {
      continue;
    }
    if (allInPool && existingRowIndex < 0 && !payClaim) {
      // Unmatched EOBs already sitting in Reference-Pool stay in Reference-Pool until a matching payment arrives
      continue;
    }
    if (allInPool && existingRowIndex >= 0) {
      const existingRow = existingRows[existingRowIndex];
      if (
        existingRow[10] === (hasEobOrInvoice ? "Yes" : "No") &&
        existingRow[11] === (hasReceiptOrStatement ? "Yes" : "No") &&
        (existingRow[9] || "") === payMethod
      ) {
        continue;
      }
    }

    const amountStr = outOfPocketAmount.toFixed(2);
    const pdfDate = bundle.plan && datePaid ? datePaid : dateOfService;
    const pdfFileName = `${pdfDate}_${sanitizeProvider(
      provider
    )}_${patient}_$${amountStr}.pdf`;
    const serviceYear =
      pdfDate.slice(0, 4) || new Date().getFullYear().toString();
    const yearReceiptsDir = path.join(RECEIPTS_ROOT_DIR, serviceYear);
    await fs.mkdir(yearReceiptsDir, { recursive: true });
    const outputPdfPath = path.join(yearReceiptsDir, pdfFileName);

    const slicePlan = orderedClaims
      .filter((c) => c.doc.docType !== "TRANSACTION_CSV")
      .map((c) => ({
        fileName: c.doc.fileName,
        filePath: c.doc.filePath,
        pagesToInclude: [
          c.claim.headerPageIndex,
          ...c.claim.relevantPageIndices,
        ],
      }));

    const targetSheetRow =
      existingRowIndex >= 0 ? 10 + existingRowIndex : 10 + nextAppendOffset++;

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
      const prependExisting =
        existingRowIndex >= 0 &&
        existingRows[existingRowIndex][12] === "Complete" &&
        hasNewInboxSingleDoc;
      await buildSlicedPdf(slicePlan, outputPdfPath, prependExisting);
      const webViewLink = await lookupDriveLink(pdfFileName);
      const linkFormula = webViewLink
        ? `=HYPERLINK("${webViewLink}", "${pdfFileName}")`
        : pdfFileName;

      const reimbStatus =
        payMethod === "HSA Card"
          ? "Paid via HSA Directly"
          : "Unreimbursed - Vaulted";
      const combinedNotes = orderedClaims
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
                  dateOfService,
                  datePaid,
                  patient,
                  provider,
                  primary.category,
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

      if (
        bundle.matchedScheduleRow &&
        bundle.matchedScheduleRow.status !== "Paid"
      ) {
        const schedRow = bundle.matchedScheduleRow.rowIndex;
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${INSTALLMENT_TAB}'!H${schedRow}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [["Paid"]] },
        });
      }

      for (const item of orderedClaims) {
        const destDir =
          item.doc.isMultiClaimOrStatement ||
          item.doc.docType === "TRANSACTION_CSV" ||
          Boolean(bundle.plan) ||
          !isBundleComplete
            ? POOL_DIR
            : ARCHIVE_DIR;
        const destPath = path.join(destDir, item.doc.fileName);
        if (
          item.doc.filePath !== destPath &&
          filesToMove.get(item.doc.filePath) !== path.join(POOL_DIR, item.doc.fileName)
        ) {
          filesToMove.set(item.doc.filePath, destPath);
        }
      }
    }
  }

  if (!DRY_RUN) {
    for (const doc of parsedDocs) {
      if (
        path.dirname(doc.filePath) === INBOX_DIR &&
        !filesToMove.has(doc.filePath)
      ) {
        const destDir =
          doc.isMultiClaimOrStatement ||
          doc.docType === "CC_STATEMENT" ||
          doc.docType === "TRANSACTION_CSV"
            ? POOL_DIR
            : ARCHIVE_DIR;
        filesToMove.set(doc.filePath, path.join(destDir, doc.fileName));
      }
    }
    for (const [srcPath, destPath] of filesToMove.entries()) {
      await fs.rename(srcPath, destPath).catch(() => {});
    }
  }

  await cleanupReferencePool(spreadsheetId, cache, installmentPlans);
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
