import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { buildSlicedPdf, sanitizeProvider } from "./pdf.js";

describe("sanitizeProvider", () => {
  test("replaces non-alphanumeric characters with single hyphens and trims edges", () => {
    assert.equal(
      sanitizeProvider("  Dr. Jane's Ortho & Dental, LLC! "),
      "Dr-Jane-s-Ortho-Dental-LLC"
    );
    assert.equal(sanitizeProvider("---Quest Diagnostics---"), "Quest-Diagnostics");
  });
});

describe("buildSlicedPdf", () => {
  let tmpDir: string;
  let threePagePdfPath: string;
  let sampleImagePath: string;
  let sampleCsvPath: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hsa-pdf-test-"));

    // Create a 3-page PDF with distinct page dimensions so we can verify which pages were sliced
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]); // page 0
    doc.addPage([500, 500]); // page 1
    doc.addPage([600, 600]); // page 2
    threePagePdfPath = path.join(tmpDir, "source.pdf");
    await fs.writeFile(threePagePdfPath, await doc.save());

    // Create a small PNG image
    sampleImagePath = path.join(tmpDir, "receipt.png");
    const pngBuffer = await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 3,
        background: { r: 240, g: 240, b: 240 },
      },
    })
      .png()
      .toBuffer();
    await fs.writeFile(sampleImagePath, pngBuffer);

    // Create a dummy CSV file
    sampleCsvPath = path.join(tmpDir, "tx.csv");
    await fs.writeFile(sampleCsvPath, "Date,Amount\n2026-01-01,50.00\n");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("slices requested PDF pages, deduplicates repeated indices, and ignores out-of-range pages", async () => {
    const outPath = path.join(tmpDir, "sliced.pdf");
    await buildSlicedPdf(
      [
        {
          filePath: threePagePdfPath,
          pagesToInclude: [0, 2, 2, -1, 99],
        },
      ],
      outPath
    );

    const outDoc = await PDFDocument.load(await fs.readFile(outPath));
    assert.equal(outDoc.getPageCount(), 2);
    assert.equal(outDoc.getPage(0).getWidth(), 400); // page 0
    assert.equal(outDoc.getPage(1).getWidth(), 600); // page 2
  });

  test("embeds image files as standard letter PDF pages and skips CSV files", async () => {
    const outPath = path.join(tmpDir, "with-image.pdf");
    await buildSlicedPdf(
      [
        { filePath: sampleCsvPath, pagesToInclude: [0] },
        { filePath: threePagePdfPath, pagesToInclude: [1] },
        { filePath: sampleImagePath, pagesToInclude: [0] },
      ],
      outPath
    );

    const outDoc = await PDFDocument.load(await fs.readFile(outPath));
    assert.equal(outDoc.getPageCount(), 2);
    assert.equal(outDoc.getPage(0).getWidth(), 500); // PDF page 1
    assert.equal(outDoc.getPage(1).getWidth(), 612); // Embedded image page
    assert.equal(outDoc.getPage(1).getHeight(), 792);

    // Deduplicates duplicate image sources and skips writing when only CSVs are passed
    const dupImgOut = path.join(tmpDir, "dup-image.pdf");
    await buildSlicedPdf(
      [
        { filePath: sampleImagePath, pagesToInclude: [0] },
        { filePath: sampleImagePath, pagesToInclude: [0] },
      ],
      dupImgOut
    );
    const dupDoc = await PDFDocument.load(await fs.readFile(dupImgOut));
    assert.equal(dupDoc.getPageCount(), 1);

    const csvOnlyOut = path.join(tmpDir, "csv-only.pdf");
    await buildSlicedPdf(
      [{ filePath: sampleCsvPath, pagesToInclude: [0] }],
      csvOnlyOut
    );
    await assert.rejects(() => fs.stat(csvOnlyOut));
  });

  test("prepends existing PDF pages when prependExistingPdf is true", async () => {
    const outPath = path.join(tmpDir, "prepend.pdf");

    // Initial write with prependExistingPdf=true when outputPath does not exist yet (graceful fallback)
    await buildSlicedPdf(
      [{ filePath: threePagePdfPath, pagesToInclude: [0] }],
      outPath,
      true
    );

    // Second write prepending existing PDF and appending page 2 (width 600)
    await buildSlicedPdf(
      [{ filePath: threePagePdfPath, pagesToInclude: [2] }],
      outPath,
      true
    );

    const outDoc = await PDFDocument.load(await fs.readFile(outPath));
    assert.equal(outDoc.getPageCount(), 2);
    assert.equal(outDoc.getPage(0).getWidth(), 400);
    assert.equal(outDoc.getPage(1).getWidth(), 600);
  });
});
