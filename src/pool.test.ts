import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanupReferencePool, scanDocuments } from "./pool.js";
import type { ParsedFileMetadata } from "./types.js";

describe("pool module", () => {
  let tmpDir: string;
  let inboxDir: string;
  let poolDir: string;
  let archiveDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hsa-pool-test-"));
    inboxDir = path.join(tmpDir, "Inbox");
    poolDir = path.join(inboxDir, "Reference-Pool");
    archiveDir = path.join(tmpDir, "Archive");
    await fs.mkdir(poolDir, { recursive: true });
    await fs.mkdir(archiveDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("scans Inbox root, Inbox subfolders, and Reference-Pool while ignoring dotfiles and unsupported files", async () => {
    await fs.writeFile(path.join(inboxDir, "eob1.pdf"), "pdf");
    await fs.writeFile(path.join(inboxDir, ".hidden.pdf"), "pdf");
    await fs.writeFile(path.join(inboxDir, "notes.txt"), "txt");
    const subDir = path.join(inboxDir, "visit-bundle");
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(subDir, "receipt.png"), "png");
    await fs.writeFile(path.join(poolDir, "multi-eob.pdf"), "pdf");

    const scanned: Array<{ fileName: string; subfolderGroup?: string }> = [];
    const docs = await scanDocuments({}, [], {
      inboxDir,
      poolDir,
      parseDoc: async (filePath, subfolderGroup) => {
        const fileName = path.basename(filePath);
        scanned.push({ fileName, subfolderGroup });
        return {
          filePath,
          fileName,
          hash: "h",
          subfolderGroup,
          docType: "EOB",
          isMultiClaimOrStatement: false,
          claims: [],
        };
      },
    });

    assert.equal(docs.length, 3);
    assert.deepEqual(
      scanned.sort((a, b) => a.fileName.localeCompare(b.fileName)),
      [
        { fileName: "eob1.pdf", subfolderGroup: undefined },
        { fileName: "multi-eob.pdf", subfolderGroup: undefined },
        { fileName: "receipt.png", subfolderGroup: "visit-bundle" },
      ]
    );

    // When Inbox has no new files, scanDocuments returns [] immediately without scanning Reference-Pool
    await fs.unlink(path.join(inboxDir, "eob1.pdf"));
    await fs.unlink(path.join(subDir, "receipt.png"));
    let poolScannedWhenInboxEmpty = false;
    const emptyInboxDocs = await scanDocuments({}, [], {
      inboxDir,
      poolDir,
      parseDoc: async (filePath) => {
        poolScannedWhenInboxEmpty = true;
        return {
          filePath,
          fileName: path.basename(filePath),
          hash: "h",
          docType: "EOB",
          isMultiClaimOrStatement: false,
          claims: [],
        };
      },
    });
    assert.deepEqual(emptyInboxDocs, []);
    assert.equal(poolScannedWhenInboxEmpty, false);
  });

  test("retires resolved pool documents to Archive and removes empty Inbox subfolders", async () => {
    const poolEobPath = path.join(poolDir, "resolved-eob.pdf");
    await fs.writeFile(poolEobPath, "pdf");

    const emptySubDir = path.join(inboxDir, "empty-group");
    await fs.mkdir(emptySubDir);

    await cleanupReferencePool("sheet-1", {}, [], {
      inboxDir,
      poolDir,
      archiveDir,
      dryRun: false,
      fetchRows: async () => [
        [
          "EXP-1",
          "2026-03-01",
          "2026-03-05",
          "Primary",
          "Quest",
          "Medical",
          "Lab",
          "$100.00",
          "$45.00",
          "Credit Card",
          "Yes",
          "Yes",
          "Complete",
          "",
          "Unreimbursed - Vaulted",
          "",
          "Claim #CLM-900",
        ],
      ],
      parseDoc: async (filePath): Promise<ParsedFileMetadata> => ({
        filePath,
        fileName: path.basename(filePath),
        hash: "h",
        docType: "EOB",
        isMultiClaimOrStatement: true,
        claims: [
          {
            claimNumber: "CLM-900",
            dateOfService: "2026-03-01",
            patient: "Primary",
            provider: "Quest",
            category: "Medical",
            description: "Lab",
            billedOrEobAmount: 100,
            qualifiedOutOfPocketAmount: 45,
            nonQualifiedExcludedAmount: 0,
            headerPageIndex: 0,
            relevantPageIndices: [0],
            provesMedicalNecessity: true,
            provesPayment: false,
            notes: "Claim #CLM-900",
          },
        ],
      }),
    });

    const archiveFiles = await fs.readdir(archiveDir);
    assert.deepEqual(archiveFiles, ["resolved-eob.pdf"]);

    const inboxEntries = await fs.readdir(inboxDir);
    assert.deepEqual(inboxEntries, ["Reference-Pool"]);
  });

  test("retains active installment plan EOBs and enforces retention window on CC statements", async () => {
    const orthoEobPath = path.join(poolDir, "ortho-plan-eob.pdf");
    const recentCcPath = path.join(poolDir, "recent-cc.pdf");
    const csvPath = path.join(poolDir, "activity.csv");
    await fs.writeFile(orthoEobPath, "pdf");
    await fs.writeFile(recentCcPath, "pdf");
    await fs.writeFile(csvPath, "csv");

    await cleanupReferencePool(
      "sheet-1",
      {},
      [
        {
          rowIndex: 2,
          planId: "PLAN-001",
          provider: "Smile Ortho",
          patient: "Dependent",
          totalResponsibility: 2000,
          remainingBalance: 1000,
          monthlyPayment: 200,
        },
      ],
      {
        inboxDir,
        poolDir,
        archiveDir,
        dryRun: false,
        retentionDays: 60,
        fetchRows: async () => [
          [
            "EXP-1",
            "2026-03-01",
            "2026-03-05",
            "Dependent",
            "Smile Ortho",
            "Dental",
            "Ortho",
            "$2,000.00",
            "$200.00",
            "Credit Card",
            "Yes",
            "Yes",
            "Complete",
            "",
            "Unreimbursed - Vaulted",
            "",
            "Claim #ORTHO-1",
          ],
        ],
        parseDoc: async (filePath): Promise<ParsedFileMetadata> => {
          const name = path.basename(filePath);
          if (name.endsWith(".csv")) {
            return {
              filePath,
              fileName: name,
              hash: "h",
              docType: "TRANSACTION_CSV",
              isMultiClaimOrStatement: true,
              claims: [],
            };
          }
          return {
            filePath,
            fileName: name,
            hash: "h",
            docType: name.includes("cc") ? "CC_STATEMENT" : "EOB",
            isMultiClaimOrStatement: true,
            claims: [
              {
                claimNumber: "ORTHO-1",
                dateOfService: "2026-03-01",
                patient: "Dependent",
                provider: "Smile Ortho",
                installmentPlanId: name.includes("ortho")
                  ? "PLAN-001"
                  : undefined,
                category: "Dental",
                description: "Ortho",
                billedOrEobAmount: 200,
                qualifiedOutOfPocketAmount: 200,
                nonQualifiedExcludedAmount: 0,
                headerPageIndex: 0,
                relevantPageIndices: [0],
                provesMedicalNecessity: !name.includes("cc"),
                provesPayment: name.includes("cc"),
                notes: "Claim #ORTHO-1",
              },
            ],
          };
        },
      }
    );

    // Neither ortho-plan-eob.pdf (active installment plan balance > 0) nor recent-cc.pdf (< 60 days old) nor activity.csv should be archived
    const archiveFiles = await fs.readdir(archiveDir);
    assert.deepEqual(archiveFiles, []);

    // Also test dryRun=true retirement, billed-amount match, and sparse rows
    const resolvedByBilledPath = path.join(poolDir, "billed-match.pdf");
    await fs.writeFile(resolvedByBilledPath, "pdf");
    const dryEmptySubDir = path.join(inboxDir, "dry-empty");
    await fs.mkdir(dryEmptySubDir);

    await cleanupReferencePool("sheet-1", {}, [], {
      inboxDir,
      poolDir,
      archiveDir,
      dryRun: true,
      fetchRows: async () => [
        [],
        [
          "EXP-2",
          "2026-03-01",
          "2026-03-05",
          "Primary",
          "Quest",
          "Medical",
          "Lab",
          "$88.00",
          "$0.00",
          "Credit Card",
          "Yes",
          "Yes",
          "Complete",
        ],
      ],
      parseDoc: async (filePath): Promise<ParsedFileMetadata> => ({
        filePath,
        fileName: path.basename(filePath),
        hash: "h",
        docType: "EOB",
        isMultiClaimOrStatement: false,
        claims: [
          {
            dateOfService: "2026-03-01",
            patient: "Primary",
            provider: "Quest",
            category: "Medical",
            description: "Lab",
            billedOrEobAmount: 88,
            qualifiedOutOfPocketAmount: 88,
            nonQualifiedExcludedAmount: 0,
            headerPageIndex: 0,
            relevantPageIndices: [0],
            provesMedicalNecessity: true,
            provesPayment: false,
            notes: "Note",
          },
        ],
      }),
    });

    // Since dryRun=true, billed-match.pdf and dry-empty remain in place
    assert.equal(
      (await fs.readdir(poolDir)).includes("billed-match.pdf"),
      true
    );
    assert.equal((await fs.readdir(inboxDir)).includes("dry-empty"), true);
  });
});
