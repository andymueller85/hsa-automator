import fs from "fs/promises";
import path from "path";
import {
  ARCHIVE_DIR,
  DEFAULT_PAYMENT_METHOD,
  DRY_RUN,
  INBOX_DIR,
  POOL_DIR,
  RECEIPTS_ROOT_DIR,
} from "./config.js";
import { loadCache } from "./cache.js";
import {
  fetchExpenseRows,
  loadInstallmentTab,
  lookupDriveLink,
  markInstallmentPaid,
  resolveSpreadsheetId,
  upsertExpenseRow,
  type ExpenseRowUpsertParams,
} from "./google.js";
import {
  buildClaimBundles,
  findExistingExpenseRowIndex,
  sortBundleClaims,
} from "./matcher.js";
import { buildSlicedPdf, sanitizeProvider } from "./pdf.js";
import { cleanupReferencePool, scanDocuments } from "./pool.js";
import type { ClaimBundle, ParsedFileMetadata } from "./types.js";

export interface ProcessBundleParams {
  bundle: ClaimBundle;
  spreadsheetId: string;
  existingRows: any[][];
  getNextAppendRow: () => number;
  filesToMove: Map<string, string>;
  poolDir?: string;
  archiveDir?: string;
  receiptsRootDir?: string;
  dryRun?: boolean;
  buildPdfFn?: typeof buildSlicedPdf;
  lookupDriveLinkFn?: (fileName: string) => Promise<string>;
  upsertRowFn?: (params: ExpenseRowUpsertParams) => Promise<void>;
  markPaidFn?: (spreadsheetId: string, rowIndex: number) => Promise<void>;
}

export async function processBundle(
  params: ProcessBundleParams
): Promise<void> {
  const {
    bundle,
    spreadsheetId,
    existingRows,
    getNextAppendRow,
    filesToMove,
    poolDir = POOL_DIR,
    archiveDir = ARCHIVE_DIR,
    receiptsRootDir = RECEIPTS_ROOT_DIR,
    dryRun = DRY_RUN,
    buildPdfFn = buildSlicedPdf,
    lookupDriveLinkFn = lookupDriveLink,
    upsertRowFn = upsertExpenseRow,
    markPaidFn = markInstallmentPaid,
  } = params;

  const orderedClaims = sortBundleClaims(bundle.claims);
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

  const existingRowIndex = findExistingExpenseRowIndex(existingRows, {
    isInstallmentPlan: Boolean(bundle.plan),
    claimNumber: primary.claimNumber,
    dateOfService,
    datePaid,
    patient,
    provider,
    outOfPocketAmount,
  });

  const allInPool = orderedClaims.every(
    (c) => path.dirname(c.doc.filePath) === poolDir
  );
  const hasNewInboxSingleDoc = orderedClaims.some(
    (c) =>
      path.dirname(c.doc.filePath) !== poolDir &&
      !c.doc.isMultiClaimOrStatement
  );

  if (
    existingRowIndex >= 0 &&
    existingRows[existingRowIndex][12] === "Complete" &&
    !hasNewInboxSingleDoc
  ) {
    return;
  }
  if (allInPool && existingRowIndex < 0 && !payClaim) {
    // Unmatched EOBs already sitting in Reference-Pool stay in Reference-Pool until a matching payment arrives
    return;
  }
  if (allInPool && existingRowIndex >= 0) {
    const existingRow = existingRows[existingRowIndex];
    if (
      existingRow[10] === (hasEobOrInvoice ? "Yes" : "No") &&
      existingRow[11] === (hasReceiptOrStatement ? "Yes" : "No") &&
      (existingRow[9] || "") === payMethod
    ) {
      return;
    }
  }

  const amountStr = outOfPocketAmount.toFixed(2);
  const pdfDate = bundle.plan && datePaid ? datePaid : dateOfService;
  const pdfFileName = `${pdfDate}_${sanitizeProvider(
    provider
  )}_${patient}_$${amountStr}.pdf`;
  const serviceYear =
    pdfDate.slice(0, 4) || new Date().getFullYear().toString();
  const yearReceiptsDir = path.join(receiptsRootDir, serviceYear);
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
    existingRowIndex >= 0 ? 10 + existingRowIndex : getNextAppendRow();

  console.log("\n========================================");
  console.log(`${dryRun ? "[DRY-RUN] " : ""}Bundle: ${bundle.key}`);
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

  if (dryRun) return;

  const prependExisting =
    existingRowIndex >= 0 &&
    existingRows[existingRowIndex][12] === "Complete" &&
    hasNewInboxSingleDoc;
  await buildPdfFn(slicePlan, outputPdfPath, prependExisting);

  const webViewLink = await lookupDriveLinkFn(pdfFileName);
  const linkFormula = webViewLink
    ? `=HYPERLINK("${webViewLink}", "${pdfFileName}")`
    : pdfFileName;

  const combinedNotes = orderedClaims
    .map((c) => c.claim.notes)
    .filter(Boolean)
    .join("; ");

  await upsertRowFn({
    spreadsheetId,
    targetSheetRow,
    dateOfService,
    datePaid,
    patient,
    provider,
    category: primary.category,
    description,
    billedAmount,
    outOfPocketAmount,
    payMethod,
    hasEobOrInvoice,
    hasReceiptOrStatement,
    linkFormula,
    combinedNotes,
  });

  if (
    bundle.matchedScheduleRow &&
    bundle.matchedScheduleRow.status !== "Paid"
  ) {
    await markPaidFn(spreadsheetId, bundle.matchedScheduleRow.rowIndex);
  }

  for (const item of orderedClaims) {
    const destDir =
      item.doc.isMultiClaimOrStatement ||
      item.doc.docType === "TRANSACTION_CSV" ||
      Boolean(bundle.plan) ||
      !isBundleComplete
        ? poolDir
        : archiveDir;
    const destPath = path.join(destDir, item.doc.fileName);
    if (
      item.doc.filePath !== destPath &&
      filesToMove.get(item.doc.filePath) !==
        path.join(poolDir, item.doc.fileName)
    ) {
      filesToMove.set(item.doc.filePath, destPath);
    }
  }
}

export async function relocateProcessedFiles(
  parsedDocs: ParsedFileMetadata[],
  filesToMove: Map<string, string>,
  options: {
    inboxDir?: string;
    poolDir?: string;
    archiveDir?: string;
    dryRun?: boolean;
  } = {}
): Promise<void> {
  const {
    inboxDir = INBOX_DIR,
    poolDir = POOL_DIR,
    archiveDir = ARCHIVE_DIR,
    dryRun = DRY_RUN,
  } = options;

  if (dryRun) return;

  for (const doc of parsedDocs) {
    if (
      path.dirname(doc.filePath) === inboxDir &&
      !filesToMove.has(doc.filePath)
    ) {
      const destDir =
        doc.isMultiClaimOrStatement ||
        doc.docType === "CC_STATEMENT" ||
        doc.docType === "TRANSACTION_CSV"
          ? poolDir
          : archiveDir;
      filesToMove.set(doc.filePath, path.join(destDir, doc.fileName));
    }
  }

  for (const [srcPath, destPath] of filesToMove.entries()) {
    await fs.rename(srcPath, destPath).catch(() => {});
  }
}

export interface RunSyncOptions {
  poolDir?: string;
  archiveDir?: string;
  receiptsRootDir?: string;
  inboxDir?: string;
  dryRun?: boolean;
  resolveSpreadsheetIdFn?: () => Promise<string>;
  fetchExpenseRowsFn?: (spreadsheetId: string) => Promise<any[][]>;
  loadInstallmentTabFn?: typeof loadInstallmentTab;
  loadCacheFn?: typeof loadCache;
  scanDocumentsFn?: typeof scanDocuments;
  processBundleFn?: typeof processBundle;
  relocateProcessedFilesFn?: typeof relocateProcessedFiles;
  cleanupReferencePoolFn?: typeof cleanupReferencePool;
}

export async function runSync(options: RunSyncOptions = {}): Promise<void> {
  const {
    poolDir = POOL_DIR,
    archiveDir = ARCHIVE_DIR,
    receiptsRootDir = RECEIPTS_ROOT_DIR,
    inboxDir = INBOX_DIR,
    dryRun = DRY_RUN,
    resolveSpreadsheetIdFn = resolveSpreadsheetId,
    fetchExpenseRowsFn = fetchExpenseRows,
    loadInstallmentTabFn = loadInstallmentTab,
    loadCacheFn = loadCache,
    scanDocumentsFn = scanDocuments,
    processBundleFn = processBundle,
    relocateProcessedFilesFn = relocateProcessedFiles,
    cleanupReferencePoolFn = cleanupReferencePool,
  } = options;

  await fs.mkdir(poolDir, { recursive: true });
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.mkdir(receiptsRootDir, { recursive: true });

  const spreadsheetId = await resolveSpreadsheetIdFn();
  const [existingRows, installmentData, cache] = await Promise.all([
    fetchExpenseRowsFn(spreadsheetId),
    loadInstallmentTabFn(spreadsheetId),
    loadCacheFn(),
  ]);
  const { plans: installmentPlans, schedule: installmentSchedule } =
    installmentData;

  const parsedDocs = await scanDocumentsFn(cache, installmentPlans);
  if (parsedDocs.length === 0) {
    console.log("No documents found in Inbox.");
    return;
  }

  const bundles = buildClaimBundles(
    parsedDocs,
    installmentPlans,
    installmentSchedule
  );

  let nextAppendOffset = existingRows.length;
  const filesToMove = new Map<string, string>();

  for (const bundle of bundles) {
    await processBundleFn({
      bundle,
      spreadsheetId,
      existingRows,
      getNextAppendRow: () => 10 + nextAppendOffset++,
      filesToMove,
      poolDir,
      archiveDir,
      receiptsRootDir,
      dryRun,
    });
  }

  await relocateProcessedFilesFn(parsedDocs, filesToMove, {
    inboxDir,
    poolDir,
    archiveDir,
    dryRun,
  });
  await cleanupReferencePoolFn(spreadsheetId, cache, installmentPlans);
}
