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
} from "./google.js";
import { buildClaimBundles, findExistingExpenseRowIndex } from "./matcher.js";
import { buildSlicedPdf, sanitizeProvider } from "./pdf.js";
import { cleanupReferencePool, scanDocuments } from "./pool.js";
import type {
  ClaimBundle,
  ClaimBundleItem,
  ParsedFileMetadata,
} from "./types.js";

function sortBundleClaims(claims: ClaimBundleItem[]): ClaimBundleItem[] {
  return [...claims].sort((a, b) => {
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
}

async function processBundle(params: {
  bundle: ClaimBundle;
  spreadsheetId: string;
  existingRows: any[][];
  getNextAppendRow: () => number;
  filesToMove: Map<string, string>;
}): Promise<void> {
  const {
    bundle,
    spreadsheetId,
    existingRows,
    getNextAppendRow,
    filesToMove,
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
    existingRowIndex >= 0 ? 10 + existingRowIndex : getNextAppendRow();

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

  if (DRY_RUN) return;

  const prependExisting =
    existingRowIndex >= 0 &&
    existingRows[existingRowIndex][12] === "Complete" &&
    hasNewInboxSingleDoc;
  await buildSlicedPdf(slicePlan, outputPdfPath, prependExisting);

  const webViewLink = await lookupDriveLink(pdfFileName);
  const linkFormula = webViewLink
    ? `=HYPERLINK("${webViewLink}", "${pdfFileName}")`
    : pdfFileName;

  const combinedNotes = orderedClaims
    .map((c) => c.claim.notes)
    .filter(Boolean)
    .join("; ");

  await upsertExpenseRow({
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
    await markInstallmentPaid(
      spreadsheetId,
      bundle.matchedScheduleRow.rowIndex
    );
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
      filesToMove.get(item.doc.filePath) !==
        path.join(POOL_DIR, item.doc.fileName)
    ) {
      filesToMove.set(item.doc.filePath, destPath);
    }
  }
}

async function relocateProcessedFiles(
  parsedDocs: ParsedFileMetadata[],
  filesToMove: Map<string, string>
): Promise<void> {
  if (DRY_RUN) return;

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

export async function runSync(): Promise<void> {
  await fs.mkdir(POOL_DIR, { recursive: true });
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  await fs.mkdir(RECEIPTS_ROOT_DIR, { recursive: true });

  const spreadsheetId = await resolveSpreadsheetId();
  const [existingRows, installmentData, cache] = await Promise.all([
    fetchExpenseRows(spreadsheetId),
    loadInstallmentTab(spreadsheetId),
    loadCache(),
  ]);
  const { plans: installmentPlans, schedule: installmentSchedule } =
    installmentData;

  const parsedDocs = await scanDocuments(cache, installmentPlans);
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
    await processBundle({
      bundle,
      spreadsheetId,
      existingRows,
      getNextAppendRow: () => 10 + nextAppendOffset++,
      filesToMove,
    });
  }

  await relocateProcessedFiles(parsedDocs, filesToMove);
  await cleanupReferencePool(spreadsheetId, cache, installmentPlans);
}
