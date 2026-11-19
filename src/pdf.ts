import fs from "fs/promises";
import path from "path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import type { PdfSliceSource } from "./types.js";

export function sanitizeProvider(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function buildSlicedPdf(
  sources: PdfSliceSource[],
  outputPath: string,
  prependExistingPdf: boolean = false
): Promise<void> {
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
