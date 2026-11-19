import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { processBundle, relocateProcessedFiles, runSync } from "./sync.js";
import type {
  ClaimBundle,
  ExtractedClaim,
  ParsedFileMetadata,
} from "./types.js";
import type { ExpenseRowUpsertParams } from "./google.js";

function makeClaim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    dateOfService: "2026-03-10",
    patient: "Primary",
    provider: "City Clinic",
    category: "Medical",
    description: "Office Visit",
    billedOrEobAmount: 150,
    qualifiedOutOfPocketAmount: 60,
    nonQualifiedExcludedAmount: 0,
    headerPageIndex: 0,
    relevantPageIndices: [0],
    provesMedicalNecessity: true,
    provesPayment: false,
    notes: "Claim #C1",
    ...overrides,
  };
}

describe("sync module", () => {
  let tmpDir: string;
  let inboxDir: string;
  let poolDir: string;
  let archiveDir: string;
  let receiptsRootDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hsa-sync-test-"));
    inboxDir = path.join(tmpDir, "Inbox");
    poolDir = path.join(inboxDir, "Reference-Pool");
    archiveDir = path.join(tmpDir, "Archive");
    receiptsRootDir = path.join(tmpDir, "Receipts");
    await fs.mkdir(poolDir, { recursive: true });
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.mkdir(receiptsRootDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("processes a complete bundle, generates sliced PDF, upserts row, and routes single-claim docs to Archive", async () => {
    const eobDoc: ParsedFileMetadata = {
      filePath: path.join(inboxDir, "eob.pdf"),
      fileName: "eob.pdf",
      hash: "h1",
      docType: "EOB",
      isMultiClaimOrStatement: false,
      claims: [makeClaim({ provesMedicalNecessity: true, provesPayment: false })],
    };
    const receiptDoc: ParsedFileMetadata = {
      filePath: path.join(inboxDir, "receipt.pdf"),
      fileName: "receipt.pdf",
      hash: "h2",
      docType: "PAYMENT_RECEIPT",
      isMultiClaimOrStatement: false,
      claims: [
        makeClaim({
          datePaid: "2026-03-12",
          paymentMethod: "Credit Card",
          provesMedicalNecessity: false,
          provesPayment: true,
          notes: "Visa *1234",
        }),
      ],
    };

    const bundle: ClaimBundle = {
      key: "Primary_60.00",
      claims: [
        { doc: receiptDoc, claim: receiptDoc.claims[0] },
        { doc: eobDoc, claim: eobDoc.claims[0] },
      ],
    };

    const builtPdfs: string[] = [];
    const upserts: ExpenseRowUpsertParams[] = [];
    const filesToMove = new Map<string, string>();

    await processBundle({
      bundle,
      spreadsheetId: "sheet-1",
      existingRows: [],
      getNextAppendRow: () => 10,
      filesToMove,
      poolDir,
      archiveDir,
      receiptsRootDir,
      dryRun: false,
      buildPdfFn: async (_sources, outputPath) => {
        builtPdfs.push(outputPath);
      },
      lookupDriveLinkFn: async () => "https://drive.google.com/file/d/abc/view",
      upsertRowFn: async (params) => {
        upserts.push(params);
      },
    });

    assert.equal(builtPdfs.length, 1);
    assert.equal(
      path.basename(builtPdfs[0]),
      "2026-03-10_City-Clinic_Primary_$60.00.pdf"
    );

    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].targetSheetRow, 10);
    assert.equal(upserts[0].hasEobOrInvoice, true);
    assert.equal(upserts[0].hasReceiptOrStatement, true);
    assert.equal(upserts[0].combinedNotes, "Claim #C1; Visa *1234");

    assert.equal(
      filesToMove.get(eobDoc.filePath),
      path.join(archiveDir, "eob.pdf")
    );
    assert.equal(
      filesToMove.get(receiptDoc.filePath),
      path.join(archiveDir, "receipt.pdf")
    );
  });

  test("routes incomplete or multi-claim documents to Reference-Pool and relocates files on disk", async () => {
    const eobPath = path.join(inboxDir, "unpaid-eob.pdf");
    const ccPath = path.join(inboxDir, "statement.pdf");
    await fs.writeFile(eobPath, "eob");
    await fs.writeFile(ccPath, "cc");

    const eobDoc: ParsedFileMetadata = {
      filePath: eobPath,
      fileName: "unpaid-eob.pdf",
      hash: "h1",
      docType: "EOB",
      isMultiClaimOrStatement: false,
      claims: [makeClaim({ provesMedicalNecessity: true, provesPayment: false })],
    };
    const ccDoc: ParsedFileMetadata = {
      filePath: ccPath,
      fileName: "statement.pdf",
      hash: "h2",
      docType: "CC_STATEMENT",
      isMultiClaimOrStatement: true,
      claims: [],
    };

    const filesToMove = new Map<string, string>();
    await processBundle({
      bundle: {
        key: "Primary_60.00",
        claims: [{ doc: eobDoc, claim: eobDoc.claims[0] }],
      },
      spreadsheetId: "sheet-1",
      existingRows: [],
      getNextAppendRow: () => 10,
      filesToMove,
      poolDir,
      archiveDir,
      receiptsRootDir,
      dryRun: false,
      buildPdfFn: async () => {},
      lookupDriveLinkFn: async () => "",
      upsertRowFn: async () => {},
    });

    await relocateProcessedFiles([eobDoc, ccDoc], filesToMove, {
      inboxDir,
      poolDir,
      archiveDir,
      dryRun: false,
    });

    const poolFiles = (await fs.readdir(poolDir)).sort();
    assert.deepEqual(poolFiles, ["statement.pdf", "unpaid-eob.pdf"]);

    // Also test relocateProcessedFiles with single-claim archive doc, CSV doc, and dryRun=true
    const singleZeroPath = path.join(inboxDir, "zero-eob.pdf");
    const singleCsvPath = path.join(inboxDir, "tx.csv");
    await fs.writeFile(singleZeroPath, "zero");
    await fs.writeFile(singleCsvPath, "csv");
    const zeroDoc: ParsedFileMetadata = {
      filePath: singleZeroPath,
      fileName: "zero-eob.pdf",
      hash: "h3",
      docType: "EOB",
      isMultiClaimOrStatement: false,
      claims: [],
    };
    const csvDoc: ParsedFileMetadata = {
      filePath: singleCsvPath,
      fileName: "tx.csv",
      hash: "h4",
      docType: "TRANSACTION_CSV",
      isMultiClaimOrStatement: false,
      claims: [],
    };
    const dryMoves = new Map<string, string>();
    await relocateProcessedFiles([zeroDoc, csvDoc], dryMoves, {
      inboxDir,
      poolDir,
      archiveDir,
      dryRun: true,
    });
    assert.equal(dryMoves.size, 0);

    await relocateProcessedFiles([zeroDoc, csvDoc], dryMoves, {
      inboxDir,
      poolDir,
      archiveDir,
      dryRun: false,
    });
    assert.equal(
      (await fs.readdir(archiveDir)).includes("zero-eob.pdf"),
      true
    );
    assert.equal((await fs.readdir(poolDir)).includes("tx.csv"), true);
  });

  test("handles installment bundles, schedule row marking, skip conditions, and runSync orchestration", async () => {
    const planEobDoc: ParsedFileMetadata = {
      filePath: path.join(poolDir, "ortho-eob.pdf"),
      fileName: "ortho-eob.pdf",
      hash: "h1",
      docType: "EOB",
      isMultiClaimOrStatement: false,
      claims: [
        makeClaim({
          patient: "Dependent",
          provider: "Smile Ortho",
          qualifiedOutOfPocketAmount: 2000,
          provesMedicalNecessity: true,
          provesPayment: false,
        }),
      ],
    };

    // 1. Unmatched pool EOB with no existing row and no payment is skipped
    let upserted = 0;
    await processBundle({
      bundle: {
        key: "Dependent_2000.00",
        claims: [{ doc: planEobDoc, claim: planEobDoc.claims[0] }],
      },
      spreadsheetId: "sheet-1",
      existingRows: [],
      getNextAppendRow: () => 10,
      filesToMove: new Map(),
      poolDir,
      archiveDir,
      receiptsRootDir,
      dryRun: false,
      upsertRowFn: async () => {
        upserted++;
      },
    });
    assert.equal(upserted, 0);

    // 2. Installment bundle with matchedScheduleRow marks schedule row as Paid
    const pmtDoc: ParsedFileMetadata = {
      filePath: path.join(inboxDir, "pmt.pdf"),
      fileName: "pmt.pdf",
      hash: "h2",
      docType: "PAYMENT_RECEIPT",
      isMultiClaimOrStatement: false,
      claims: [
        makeClaim({
          dateOfService: "2026-04-01",
          datePaid: "2026-04-01",
          patient: "Dependent",
          provider: "Smile Ortho",
          qualifiedOutOfPocketAmount: 200,
          provesMedicalNecessity: false,
          provesPayment: true,
        }),
      ],
    };

    let markedRow = -1;
    let lastDesc = "";
    await processBundle({
      bundle: {
        key: "INSTALLMENT:PLAN-001_2026-04-01_200.00",
        plan: {
          rowIndex: 2,
          planId: "PLAN-001",
          provider: "Smile Ortho",
          patient: "Dependent",
          totalResponsibility: 2000,
          remainingBalance: 1800,
          monthlyPayment: 200,
        },
        matchedScheduleRow: {
          rowIndex: 14,
          paymentId: "PMT-01",
          scheduledDate: "2026-04-01",
          provider: "Smile Ortho",
          paymentAmount: 200,
          status: "Pending",
          notes: "Month 1",
        },
        claims: [
          { doc: planEobDoc, claim: planEobDoc.claims[0] },
          { doc: pmtDoc, claim: pmtDoc.claims[0] },
        ],
      },
      spreadsheetId: "sheet-1",
      existingRows: [],
      getNextAppendRow: () => 10,
      filesToMove: new Map(),
      poolDir,
      archiveDir,
      receiptsRootDir,
      dryRun: false,
      buildPdfFn: async () => {},
      lookupDriveLinkFn: async () => "",
      upsertRowFn: async (p) => {
        lastDesc = p.description;
      },
      markPaidFn: async (_id, row) => {
        markedRow = row;
      },
    });
    assert.equal(lastDesc, "PMT-01: Month 1");
    assert.equal(markedRow, 14);

    // 3. runSync orchestrates empty and non-empty inbox runs
    let cleanedUp = 0;
    await runSync({
      poolDir,
      archiveDir,
      receiptsRootDir,
      inboxDir,
      dryRun: true,
      resolveSpreadsheetIdFn: async () => "sheet-1",
      fetchExpenseRowsFn: async () => [],
      loadInstallmentTabFn: async () => ({ plans: [], schedule: [] }),
      loadCacheFn: async () => ({}),
      scanDocumentsFn: async () => [],
      cleanupReferencePoolFn: async () => {
        cleanedUp++;
      },
    });
    assert.equal(cleanedUp, 0); // Early return when no docs found

    await runSync({
      poolDir,
      archiveDir,
      receiptsRootDir,
      inboxDir,
      dryRun: true,
      resolveSpreadsheetIdFn: async () => "sheet-1",
      fetchExpenseRowsFn: async () => [],
      loadInstallmentTabFn: async () => ({ plans: [], schedule: [] }),
      loadCacheFn: async () => ({}),
      scanDocumentsFn: async () => [pmtDoc],
      relocateProcessedFilesFn: async () => {},
      cleanupReferencePoolFn: async () => {
        cleanedUp++;
      },
    });
    assert.equal(cleanedUp, 1);

    // 4. Test skip conditions for already-Complete row, unchanged pool row, and updating an existing staged row
    const poolEob: ParsedFileMetadata = {
      filePath: path.join(poolDir, "staged-eob.pdf"),
      fileName: "staged-eob.pdf",
      hash: "h3",
      docType: "EOB",
      isMultiClaimOrStatement: true,
      claims: [
        makeClaim({
          claimNumber: "CLM-STAGED",
          dateOfService: "2026-03-10",
          patient: "Primary",
          provider: "City Clinic",
          qualifiedOutOfPocketAmount: 60,
          provesMedicalNecessity: true,
          provesPayment: false,
        }),
      ],
    };

    const existingRows = [
      [
        "EXP-1",
        "2026-03-10",
        "",
        "Primary",
        "City Clinic",
        "Medical",
        "Office Visit",
        "$150.00",
        "$60.00",
        "",
        "Yes",
        "No",
        "Complete",
        "",
        "Unreimbursed - Vaulted",
        "",
        "Claim #CLM-STAGED",
      ],
      [
        "EXP-2",
        "2026-03-11",
        "",
        "Primary",
        "City Clinic",
        "Medical",
        "Office Visit",
        "$150.00",
        "$75.00",
        "",
        "Yes",
        "No",
        "Needs Receipt",
        "",
        "Unreimbursed - Vaulted",
        "",
        "Claim #CLM-POOL-UNCHANGED",
      ],
    ];

    // Row 0 is already Complete and doc is in pool -> skipped
    let completeSkipUpserts = 0;
    await processBundle({
      bundle: {
        key: "Primary_60.00",
        claims: [{ doc: poolEob, claim: poolEob.claims[0] }],
      },
      spreadsheetId: "sheet-1",
      existingRows,
      getNextAppendRow: () => 20,
      filesToMove: new Map(),
      poolDir,
      archiveDir,
      receiptsRootDir,
      dryRun: false,
      upsertRowFn: async () => {
        completeSkipUpserts++;
      },
    });
    assert.equal(completeSkipUpserts, 0);

    // Row 0 is Complete, but a new single-claim Inbox doc arrives -> updates row 10 with prependExisting=true
    const newInboxReceipt: ParsedFileMetadata = {
      filePath: path.join(inboxDir, "late-receipt.pdf"),
      fileName: "late-receipt.pdf",
      hash: "h-late",
      docType: "PAYMENT_RECEIPT",
      isMultiClaimOrStatement: false,
      claims: [
        makeClaim({
          claimNumber: "CLM-STAGED",
          dateOfService: "2026-03-10",
          qualifiedOutOfPocketAmount: 60,
          provesMedicalNecessity: false,
          provesPayment: true,
        }),
      ],
    };
    let prependedFlag = false;
    await processBundle({
      bundle: {
        key: "Primary_60.00",
        claims: [
          { doc: poolEob, claim: poolEob.claims[0] },
          { doc: newInboxReceipt, claim: newInboxReceipt.claims[0] },
        ],
      },
      spreadsheetId: "sheet-1",
      existingRows,
      getNextAppendRow: () => 20,
      filesToMove: new Map(),
      poolDir,
      archiveDir,
      receiptsRootDir,
      dryRun: false,
      buildPdfFn: async (_s, _o, prepend) => {
        prependedFlag = Boolean(prepend);
      },
      lookupDriveLinkFn: async () => "",
      upsertRowFn: async () => {
        completeSkipUpserts++;
      },
    });
    assert.equal(completeSkipUpserts, 1);
    assert.equal(prependedFlag, true);

    // Row 1 is in pool and matches existing row's flags -> skipped
    const unchangedPoolEob: ParsedFileMetadata = {
      ...poolEob,
      claims: [
        makeClaim({
          claimNumber: "CLM-POOL-UNCHANGED",
          dateOfService: "2026-03-11",
          qualifiedOutOfPocketAmount: 75,
          provesMedicalNecessity: true,
          provesPayment: false,
        }),
      ],
    };
    await processBundle({
      bundle: {
        key: "Primary_75.00",
        claims: [{ doc: unchangedPoolEob, claim: unchangedPoolEob.claims[0] }],
      },
      spreadsheetId: "sheet-1",
      existingRows,
      getNextAppendRow: () => 20,
      filesToMove: new Map(),
      poolDir,
      archiveDir,
      receiptsRootDir,
      dryRun: false,
      upsertRowFn: async () => {
        completeSkipUpserts++;
      },
    });
    assert.equal(completeSkipUpserts, 1);
  });
});
