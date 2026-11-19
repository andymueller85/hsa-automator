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

export async function scanDocuments(
  cache: Record<string, ParsedFileMetadata>,
  installmentPlans: InstallmentPlan[]
): Promise<ParsedFileMetadata[]> {
  const entries = await fs.readdir(INBOX_DIR, { withFileTypes: true });
  const parsedDocs: ParsedFileMetadata[] = [];

  for (const entry of entries) {
    if (entry.name === "Reference-Pool" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(INBOX_DIR, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await fs.readdir(fullPath);
      for (const sf of subFiles) {
        if (SUPPORTED_DOC_REGEX.test(sf)) {
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
    } else if (SUPPORTED_DOC_REGEX.test(entry.name)) {
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
    if (SUPPORTED_DOC_REGEX.test(pe)) {
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

  return parsedDocs;
}

export async function cleanupReferencePool(
  spreadsheetId: string,
  cache: Record<string, ParsedFileMetadata>,
  installmentPlans: InstallmentPlan[]
): Promise<void> {
  const latestRows = await fetchExpenseRows(spreadsheetId);

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
    if (!SUPPORTED_DOC_REGEX.test(fileName)) continue;
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
