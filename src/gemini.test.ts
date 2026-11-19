import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { hashFile } from "./cache.js";
import {
  buildExtractionPrompt,
  extractionSchema,
  parseDocumentWithGemini,
  setAiClient,
} from "./gemini.js";
import type { InstallmentPlan, ParsedFileMetadata } from "./types.js";

describe("gemini module", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hsa-gemini-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("includes active installment plans and affiliated providers in buildExtractionPrompt", () => {
    const plans: InstallmentPlan[] = [
      {
        rowIndex: 2,
        planId: "PLAN-001",
        provider: "Smile Ortho",
        patient: "Dependent",
        totalResponsibility: 2400,
        remainingBalance: 1800,
        monthlyPayment: 200,
        affiliatedProviders: "Dr. Smith DDS",
      },
    ];
    const prompt = buildExtractionPrompt(plans, "Alice, Bob");
    assert.equal(prompt.includes("household members Alice, Bob"), true);
    assert.equal(prompt.includes("PLAN-001: Provider=\"Smile Ortho\""), true);
    assert.equal(
      prompt.includes("Affiliated EOB/Billing Providers: Dr. Smith DDS"),
      true
    );
  });

  test("returns cached metadata without calling Gemini when hash and planFingerprint match", async () => {
    const pdfPath = path.join(tmpDir, "cached-eob.pdf");
    await fs.writeFile(pdfPath, "dummy-pdf-bytes");
    const hash = await hashFile(pdfPath);

    const cache: Record<string, ParsedFileMetadata> = {
      [hash]: {
        filePath: "/old/path/cached-eob.pdf",
        fileName: "cached-eob.pdf",
        hash,
        planFingerprint: "PLAN-001",
        docType: "EOB",
        isMultiClaimOrStatement: false,
        claims: [
          {
            dateOfService: "2026-03-01",
            patient: "Primary",
            provider: "Clinic",
            category: "Medical",
            description: "Visit",
            billedOrEobAmount: 100,
            qualifiedOutOfPocketAmount: 50,
            nonQualifiedExcludedAmount: 0,
            headerPageIndex: 0,
            relevantPageIndices: [0],
            provesMedicalNecessity: true,
            provesPayment: false,
            notes: "Claim #1",
          },
        ],
      },
    };

    let geminiCalled = false;
    const result = await parseDocumentWithGemini(
      pdfPath,
      "sub-group-1",
      cache,
      [
        {
          rowIndex: 1,
          planId: "PLAN-001",
          provider: "Ortho",
          patient: "Primary",
          totalResponsibility: 1000,
          remainingBalance: 500,
          monthlyPayment: 100,
        },
      ],
      {
        generateContent: async () => {
          geminiCalled = true;
          return { text: "{}" };
        },
      }
    );

    assert.equal(geminiCalled, false);
    assert.equal(result.filePath, pdfPath);
    assert.equal(result.subfolderGroup, "sub-group-1");
  });

  test("calls Gemini and updates cache on cache miss for CSV and binary files", async () => {
    const csvPath = path.join(tmpDir, "activity.csv");
    await fs.writeFile(csvPath, "Date,Description,Amount\n2026-03-10,Clinic,40.00");

    const cache: Record<string, ParsedFileMetadata> = {};
    let capturedParams: any = null;
    let savedCacheCount = 0;

    const meta = await parseDocumentWithGemini(csvPath, undefined, cache, [], {
      generateContent: async (params) => {
        capturedParams = params;
        return {
          text: JSON.stringify({
            docType: "TRANSACTION_CSV",
            isMultiClaimOrStatement: true,
            claims: [
              {
                dateOfService: "2026-03-10",
                patient: "Primary",
                provider: "Clinic",
                category: "Medical",
                description: "Card Charge",
                billedOrEobAmount: 40,
                qualifiedOutOfPocketAmount: 40,
                nonQualifiedExcludedAmount: 0,
                headerPageIndex: 0,
                relevantPageIndices: [0],
                provesMedicalNecessity: false,
                provesPayment: true,
                notes: "CSV Charge $40",
              },
            ],
          }),
        };
      },
      saveCacheFn: async () => {
        savedCacheCount++;
      },
    });

    assert.equal(meta.docType, "TRANSACTION_CSV");
    assert.equal(meta.claims.length, 1);
    assert.equal(savedCacheCount, 1);
    assert.equal(
      capturedParams.config.responseSchema,
      extractionSchema
    );
    assert.equal(
      capturedParams.contents[0].text.includes("CSV Filename: activity.csv"),
      true
    );

    // Also test PDF, PNG, and JPEG inlineData mimeType branches
    for (const [ext, expectedMime] of [
      [".pdf", "application/pdf"],
      [".png", "image/png"],
      [".jpg", "image/jpeg"],
    ] as const) {
      const binPath = path.join(tmpDir, `sample${ext}`);
      await fs.writeFile(binPath, `binary-content-${ext}`);
      let capturedBin: any = null;
      await parseDocumentWithGemini(binPath, undefined, cache, [], {
        generateContent: async (params) => {
          capturedBin = params;
          return {
            text: JSON.stringify({
              docType: "PAYMENT_RECEIPT",
              isMultiClaimOrStatement: false,
              claims: [],
            }),
          };
        },
        saveCacheFn: async () => {},
      });
      assert.equal(
        capturedBin.contents[0].inlineData.mimeType,
        expectedMime
      );
    }

    // Also test default AI client delegate and cache hit with valid paymentMethod
    let defaultAiCalled = false;
    setAiClient({
      models: {
        generateContent: async () => {
          defaultAiCalled = true;
          return {
            text: JSON.stringify({
              docType: "EOB",
              isMultiClaimOrStatement: false,
              claims: [
                {
                  dateOfService: "2026-03-10",
                  patient: "Primary",
                  provider: "Clinic",
                  category: "Medical",
                  description: "Visit",
                  billedOrEobAmount: 100,
                  qualifiedOutOfPocketAmount: 20,
                  nonQualifiedExcludedAmount: 0,
                  paymentMethod: "Credit Card",
                  headerPageIndex: 0,
                  relevantPageIndices: [0],
                  provesMedicalNecessity: true,
                  provesPayment: false,
                  notes: "Note",
                },
              ],
            }),
          };
        },
      },
    });
    const defaultClientPath = path.join(tmpDir, "default-client.pdf");
    await fs.writeFile(defaultClientPath, "pdf-bytes");
    await parseDocumentWithGemini(defaultClientPath, undefined, cache, [], {
      saveCacheFn: async () => {},
    });
    assert.equal(defaultAiCalled, true);

    // Second call hits cache with valid paymentMethod
    const cachedAgain = await parseDocumentWithGemini(
      defaultClientPath,
      undefined,
      cache,
      []
    );
    assert.equal(cachedAgain.claims[0].paymentMethod, "Credit Card");
    setAiClient(null);
  });
});
