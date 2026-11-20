import fs from "fs/promises";
import path from "path";
import {
  ARCHIVE_DIR,
  CC_POOL_RETENTION_DAYS,
  DRY_RUN,
  INBOX_DIR,
  POOL_DIR,
} from "./config.js";
import { parseDocumentWithGemini } from "./gemini.js";
import { fetchExpenseRows } from "./google.js";
import { matchInstallmentPlan } from "./matcher.js";
import type {
  ExtractedClaim,
  InstallmentPlan,
  ParsedFileMetadata,
} from "./types.js";

const SUPPORTED_DOC_REGEX = /\.(pdf|png|jpg|jpeg|csv)$/i;

export interface PoolScanOptions {
  inboxDir?: string;
  poolDir?: string;
  parseDoc?: typeof parseDocumentWithGemini;
}

export async function scanDocuments(
  cache: Record<string, ParsedFileMetadata>,
  installmentPlans: InstallmentPlan[],
  options: PoolScanOptions = {}
): Promise<ParsedFileMetadata[]> {
  const inboxDir = options.inboxDir ?? INBOX_DIR;
  const poolDir = options.poolDir ?? POOL_DIR;
  const parseDoc = options.parseDoc ?? parseDocumentWithGemini;

  const entries = await fs.readdir(inboxDir, { withFileTypes: true });
  const parsedDocs: ParsedFileMetadata[] = [];

  for (const entry of entries) {
    if (entry.name === "Reference-Pool" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(inboxDir, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await fs.readdir(fullPath);
      for (const sf of subFiles) {
        if (SUPPORTED_DOC_REGEX.test(sf)) {
          parsedDocs.push(
            await parseDoc(
              path.join(fullPath, sf),
              entry.name,
              cache,
              installmentPlans
            )
          );
        }
      }
    } else if (SUPPORTED_DOC_REGEX.test(entry.name)) {
      parsedDocs.push(
        await parseDoc(fullPath, undefined, cache, installmentPlans)
      );
    }
  }

  if (parsedDocs.length === 0) {
    return [];
  }

  const poolEntries = await fs.readdir(poolDir);
  for (const pe of poolEntries) {
    if (SUPPORTED_DOC_REGEX.test(pe)) {
      parsedDocs.push(
        await parseDoc(
          path.join(poolDir, pe),
          undefined,
          cache,
          installmentPlans
        )
      );
    }
  }

  return parsedDocs;
}

export interface CleanupPoolOptions {
  inboxDir?: string;
  poolDir?: string;
  archiveDir?: string;
  dryRun?: boolean;
  retentionDays?: number;
  fetchRows?: (spreadsheetId: string) => Promise<any[][]>;
  parseDoc?: typeof parseDocumentWithGemini;
}

export async function cleanupReferencePool(
  spreadsheetId: string,
  cache: Record<string, ParsedFileMetadata>,
  installmentPlans: InstallmentPlan[],
  options: CleanupPoolOptions = {}
): Promise<void> {
  const inboxDir = options.inboxDir ?? INBOX_DIR;
  const poolDir = options.poolDir ?? POOL_DIR;
  const archiveDir = options.archiveDir ?? ARCHIVE_DIR;
  const dryRun = options.dryRun ?? DRY_RUN;
  const retentionDays = options.retentionDays ?? CC_POOL_RETENTION_DAYS;
  const fetchRows = options.fetchRows ?? fetchExpenseRows;
  const parseDoc = options.parseDoc ?? parseDocumentWithGemini;

  const latestRows = await fetchRows(spreadsheetId);

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

  const poolFiles = await fs.readdir(poolDir);
  for (const fileName of poolFiles) {
    if (!SUPPORTED_DOC_REGEX.test(fileName)) continue;
    const poolFilePath = path.join(poolDir, fileName);
    const meta = await parseDoc(
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
      retentionSatisfied = ageInDays >= retentionDays;
    }

    if (allClaimsComplete && retentionSatisfied) {
      const archiveDest = path.join(archiveDir, fileName);
      console.log(
        `${
          dryRun ? "[DRY-RUN] " : ""
        }Retiring resolved pool document to Archive: ${fileName}`
      );
      if (!dryRun) {
        await fs.rename(poolFilePath, archiveDest);
      }
    }
  }

  const inboxEntries = await fs.readdir(inboxDir, { withFileTypes: true });
  for (const entry of inboxEntries) {
    if (entry.isDirectory() && entry.name !== "Reference-Pool") {
      const subDirPath = path.join(inboxDir, entry.name);
      const remaining = await fs.readdir(subDirPath);
      if (remaining.length === 0) {
        console.log(
          `${dryRun ? "[DRY-RUN] " : ""}Removing empty Inbox subfolder: ${
            entry.name
          }`
        );
        if (!dryRun) {
          await fs.rmdir(subDirPath);
        }
      }
    }
  }
}
