import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { PDFDocument } from "pdf-lib";
import {
  createMultiPagePdf,
  createReceiptPng,
  generateSimpsonsDemoPackets,
  resetDemoSpreadsheet,
  runDemoReset,
} from "./demo.js";
import { resetCachedSpreadsheetId, setGoogleClients } from "../google.js";

describe("demo module", () => {
  test("createMultiPagePdf and createReceiptPng generate valid PDF and PNG files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hsa-demo-unit-"));
    try {
      const pdfPath = path.join(tmpDir, "test.pdf");
      await createMultiPagePdf(pdfPath, [
        {
          title: "Page 1 Title",
          subtitle: "Subtitle 1",
          lines: ["## Section", "Line 1"],
        },
        {
          title: "Page 2 Title",
          lines: ["Line 2"],
        },
      ]);

      const pdfBytes = await fs.readFile(pdfPath);
      const loadedPdf = await PDFDocument.load(pdfBytes);
      assert.equal(loadedPdf.getPageCount(), 2);

      const pngPath = path.join(tmpDir, "receipt.png");
      await createReceiptPng(pngPath, [
        "**STORE & <OPTICAL> \"QUOTE\" 'SINGLE'**",
        "Item 1: $50.00",
      ]);
      const pngStat = await fs.stat(pngPath);
      assert.ok(pngStat.size > 100);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("generateSimpsonsDemoPackets creates all 4 Simpsons scenario packets", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hsa-packets-"));
    try {
      const files = await generateSimpsonsDemoPackets(tmpDir);
      assert.equal(files.length, 7);
      for (const f of files) {
        const st = await fs.stat(f);
        assert.ok(st.size > 0);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("resetDemoSpreadsheet updates values and dropdown validation rules", async () => {
    const valueBatches: any[] = [];
    const structBatches: any[] = [];
    setGoogleClients({
      drive: {
        files: {
          list: async () => ({ data: { files: [] } }),
        },
      },
      sheets: {
        spreadsheets: {
          get: async () => ({
            data: {
              sheets: [
                { properties: { title: "HSA Expense Tracker", sheetId: 42 } },
              ],
            },
          }),
          batchUpdate: async (params) => {
            structBatches.push(params);
          },
          values: {
            get: async () => ({ data: { values: [] } }),
            update: async () => ({}),
            batchUpdate: async (params) => {
              valueBatches.push(params);
            },
          },
        },
      },
    });

    await resetDemoSpreadsheet("demo-sheet-1");
    assert.equal(valueBatches.length, 1);
    assert.equal(valueBatches[0].requestBody.data.length, 3);
    assert.equal(
      valueBatches[0].requestBody.data[2].values[8][1],
      "PLAN-001"
    );
    assert.equal(
      valueBatches[0].requestBody.data[2].values[8][2],
      "Painless Dentistry"
    );
    assert.equal(structBatches.length, 1);
    assert.equal(
      structBatches[0].requestBody.requests[0].setDataValidation.range.sheetId,
      42
    );
  });

  test("runDemoReset cleans directories, populates packets, and resets live Google Sheet", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hsa-reset-"));
    try {
      const inboxDir = path.join(tmpDir, "Inbox");
      const poolDir = path.join(inboxDir, "Reference-Pool");
      const archiveDir = path.join(tmpDir, "Archive");
      const receiptsRootDir = path.join(tmpDir, "Receipts");
      const cacheFile = path.join(tmpDir, ".hsa-cache.demo.json");

      resetCachedSpreadsheetId(null);
      let batchUpdated = false;
      const res = await runDemoReset({
        rootDir: tmpDir,
        inboxDir,
        poolDir,
        archiveDir,
        receiptsRootDir,
        cacheFile,
        populateInbox: true,
        skipSheets: false,
        driveClient: {
          files: {
            list: async () => ({
              data: { files: [{ id: "demo-sheet-id", name: "Demo Sheet" }] },
            }),
          },
        },
        sheetsClient: {
          spreadsheets: {
            values: {
              get: async () => ({ data: { values: [] } }),
              update: async () => ({}),
              batchUpdate: async () => {
                batchUpdated = true;
              },
            },
          },
        },
      });

      assert.equal(res.generatedFiles.length, 7);
      assert.equal(res.spreadsheetReset, true);
      assert.equal(batchUpdated, true);

      const inboxFiles = await fs.readdir(inboxDir);
      // 7 copied files + Reference-Pool directory
      assert.equal(inboxFiles.length, 8);

      // Test non-populateInbox and failed sheet reset warning path
      resetCachedSpreadsheetId(null);
      const res2 = await runDemoReset({
        rootDir: tmpDir,
        inboxDir,
        poolDir,
        archiveDir,
        receiptsRootDir,
        cacheFile,
        populateInbox: false,
        skipSheets: false,
        driveClient: {
          files: {
            list: async () => ({ data: { files: [] } }),
          },
        },
      });
      assert.equal(res2.spreadsheetReset, false);
      const inboxFilesAfter = await fs.readdir(inboxDir);
      assert.deepEqual(inboxFilesAfter, ["Reference-Pool"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
