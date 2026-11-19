import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import {
  ARCHIVE_DIR,
  CACHE_FILE,
  HOUSEHOLD_MEMBERS,
  INBOX_DIR,
  INSTALLMENT_TAB,
  PAYMENT_METHODS,
  POOL_DIR,
  RECEIPTS_ROOT_DIR,
  ROOT_DIR,
  SHEET_TAB,
  TRACKER_TITLE,
} from "../config.js";
import {
  getGoogleClients,
  resolveSpreadsheetId,
  type DriveClientLike,
  type SheetsClientLike,
} from "../google.js";

export interface PageDef {
  title: string;
  subtitle?: string;
  lines: string[];
}

export async function createMultiPagePdf(
  filePath: string,
  pages: PageDef[]
): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (let i = 0; i < pages.length; i++) {
    const pDef = pages[i];
    const page = pdfDoc.addPage([612, 792]);

    // Header Banner
    page.drawRectangle({
      x: 40,
      y: 710,
      width: 532,
      height: 50,
      color: rgb(0.12, 0.25, 0.45),
    });

    page.drawText(pDef.title, {
      x: 52,
      y: 736,
      size: 16,
      font: boldFont,
      color: rgb(1, 1, 1),
    });

    if (pDef.subtitle) {
      page.drawText(pDef.subtitle, {
        x: 52,
        y: 718,
        size: 10,
        font,
        color: rgb(0.85, 0.9, 1),
      });
    }

    page.drawText(`Page ${i + 1} of ${pages.length}`, {
      x: 500,
      y: 736,
      size: 10,
      font,
      color: rgb(1, 1, 1),
    });

    let y = 680;
    for (const line of pDef.lines) {
      const isHeader = line.startsWith("## ");
      const text = isHeader ? line.slice(3) : line;
      page.drawText(text, {
        x: 50,
        y,
        size: isHeader ? 12 : 10,
        font: isHeader ? boldFont : font,
        color: isHeader ? rgb(0.1, 0.2, 0.4) : rgb(0.15, 0.15, 0.15),
      });
      y -= isHeader ? 22 : 16;
    }
  }

  const pdfBytes = await pdfDoc.save();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, pdfBytes);
}

export async function createReceiptPng(
  filePath: string,
  lines: string[]
): Promise<void> {
  const escapeXml = (unsafe: string) =>
    unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const textElements = lines
    .map((line, idx) => {
      const y = 60 + idx * 24;
      const isBold = line.startsWith("**") && line.endsWith("**");
      const clean = escapeXml(isBold ? line.slice(2, -2) : line);
      const weight = isBold ? "bold" : "normal";
      const size = idx === 0 ? 20 : 14;
      return `<text x="40" y="${y}" font-family="monospace" font-size="${size}" font-weight="${weight}" fill="#1a1a1a">${clean}</text>`;
    })
    .join("\n");

  const height = Math.max(460, 90 + lines.length * 24);
  const svg = `<svg width="560" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#fdfcf7"/>
    <rect x="16" y="16" width="528" height="${height - 32}" fill="none" stroke="#333" stroke-width="2" stroke-dasharray="6,4"/>
    ${textElements}
  </svg>`;

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, pngBuffer);
}

export async function generateSimpsonsDemoPackets(
  demoPacketsDir: string
): Promise<string[]> {
  await fs.rm(demoPacketsDir, { recursive: true, force: true });
  await fs.mkdir(demoPacketsDir, { recursive: true });

  const createdFiles: string[] = [];

  // =========================================================================
  // Packet 1: Homer Nuclear Injury (Multi-page EOB + Multi-page CC Statement)
  // =========================================================================
  const packet1Dir = path.join(demoPacketsDir, "Packet-1_Homer-Nuclear-Injury");
  const eob1Path = path.join(packet1Dir, "Springfield-Health-EOB-Oct.pdf");
  await createMultiPagePdf(eob1Path, [
    {
      title: "SPRINGFIELD HEALTH & NUCLEAR BENEFIT PLAN",
      subtitle: "Explanation of Benefits (EOB) - Statement Date: 2026-10-20",
      lines: [
        "## Subscriber & Policyholder Summary",
        "Primary Insured: Homer J. Simpson",
        "Member ID: SNPP-742-HOMER",
        "Group: Springfield Nuclear Power Plant (Sector 7G)",
        "Address: 742 Evergreen Terrace, Springfield",
        "",
        "## Summary of Claims in This Statement",
        "1. Claim #CLM-2026-8841 - Patient: Homer - Springfield General Hospital ($185.00 Owed)",
        "2. Claim #CLM-2026-8849 - Patient: Maggie - Dr. Hibbert Family Practice ($0.00 Owed)",
        "",
        "THIS IS NOT A BILL. Retain this Explanation of Benefits for your HSA tax records.",
      ],
    },
    {
      title: "EXPLANATION OF BENEFITS - CLAIM DETAIL",
      subtitle: "Claim #CLM-2026-8841 | Patient: Homer",
      lines: [
        "## Claim #CLM-2026-8841 (Medical)",
        "Patient Name: Homer",
        "Provider: Springfield General Hospital",
        "Date of Service: 2026-10-14",
        "Service Description: Emergency Room - Radiation & Isotope Screening ( CPT 99284 )",
        "",
        "Amount Billed by Provider:          $940.00",
        "Plan Network Discount:             -$555.00",
        "Plan Paid to Provider:             -$200.00",
        "--------------------------------------------",
        "PATIENT RESPONSIBILITY (YOU OWE):   $185.00",
      ],
    },
    {
      title: "EXPLANATION OF BENEFITS - CLAIM DETAIL",
      subtitle: "Claim #CLM-2026-8849 | Patient: Maggie",
      lines: [
        "## Claim #CLM-2026-8849 (Preventive Well-Baby Visit)",
        "Patient Name: Maggie",
        "Provider: Dr. Hibbert Family Practice",
        "Date of Service: 2026-10-16",
        "Service Description: Routine Preventive Well-Child Checkup",
        "",
        "Amount Billed by Provider:          $220.00",
        "Plan Paid (100% Preventive):       -$220.00",
        "--------------------------------------------",
        "PATIENT RESPONSIBILITY (YOU OWE):     $0.00",
      ],
    },
  ]);
  createdFiles.push(eob1Path);

  const cc1Path = path.join(
    packet1Dir,
    "First-Bank-of-Springfield-Statement.pdf"
  );
  await createMultiPagePdf(cc1Path, [
    {
      title: "FIRST BANK OF SPRINGFIELD - VISA STATEMENT",
      subtitle: "Account Holder: Homer & Marge Simpson | Account Ending: 4242",
      lines: [
        "## Monthly Credit Card Statement Summary",
        "Statement Closing Date: 2026-10-28",
        "Payment Method: Credit Card (Visa -4242)",
        "Previous Balance: $410.00",
        "New Purchases: $241.50",
        "",
        "See following pages for itemized transaction history.",
      ],
    },
    {
      title: "FIRST BANK OF SPRINGFIELD - TRANSACTIONS",
      subtitle: "Account Ending: 4242 | Dining & Entertainment",
      lines: [
        "## General Purchases (Non-Medical)",
        "2026-10-10   MOE'S TAVERN SPRINGFIELD             $34.00",
        "2026-10-12   KRUSTY BURGER DRIVE-THRU             $14.50",
        "2026-10-13   LARD LAD DONUTS                      $8.00",
      ],
    },
    {
      title: "FIRST BANK OF SPRINGFIELD - TRANSACTIONS",
      subtitle: "Account Ending: 4242 | Healthcare & Medical Transactions",
      lines: [
        "## Posted Transactions (Continued)",
        "2026-10-18   SPRINGFIELD GENERAL HOSPITAL        $185.00",
        "             Payment for Claim #CLM-2026-8841 (Patient: Homer, DOS 2026-10-14)",
        "             Payment Method: Credit Card",
      ],
    },
  ]);
  createdFiles.push(cc1Path);

  // =========================================================================
  // Packet 2: Bart Vision Warranty Exclusion (Itemized PNG Receipt)
  // =========================================================================
  const packet2Dir = path.join(demoPacketsDir, "Packet-2_Bart-Vision-Warranty");
  const visionPngPath = path.join(
    packet2Dir,
    "Springfield-Eyecare-Receipt.png"
  );
  await createReceiptPng(visionPngPath, [
    "**SPRINGFIELD EYECARE & OPTICAL PAVILION**",
    "Springfield Mall - Level 2",
    "------------------------------------------------",
    "Receipt #: EYE-2026-1102",
    "Date of Service: 2026-11-02",
    "Date Paid:       2026-11-02",
    "Patient Name:    Bart",
    "Category:        Vision (Prescription Eyeglasses)",
    "------------------------------------------------",
    "ITEMIZED CHARGES:",
    "1. Rx Eyeglass Frames & Polycarbonate Lenses  $210.00",
    "   (Medical Necessity: Myopia Rx -1.75 OU)",
    "2. 2-Year Skateboarding Breakage Warranty      $45.00",
    "   (Optional Protection Plan - Non-Qualified)",
    "------------------------------------------------",
    "TOTAL BILLED:                                 $255.00",
    "**TOTAL PAID (Credit Card Visa -4242):        $255.00**",
    "------------------------------------------------",
    "Note: $210.00 is HSA Qualified; $45.00 Warranty is excluded.",
  ]);
  createdFiles.push(visionPngPath);

  // =========================================================================
  // Packet 3: Lisa Braces 0% Installment Plan ("Lisa Needs Braces!")
  // =========================================================================
  const packet3Dir = path.join(
    demoPacketsDir,
    "Packet-3_Lisa-Braces-Installment"
  );
  const orthoEobPath = path.join(
    packet3Dir,
    "Master-EOB_Painless-Dentistry.pdf"
  );
  await createMultiPagePdf(orthoEobPath, [
    {
      title: "SPRINGFIELD DENTAL PLAN - MASTER ORTHODONTIC EOB",
      subtitle: "Installment Plan Reference: PLAN-001 | Claim #ORTHO-2026-001",
      lines: [
        "## Orthodontic Treatment Explanation of Benefits (EOB)",
        "Patient Name: Lisa",
        "Provider: Painless Dentistry (Dr. Wolfe / Springfield Orthodontics)",
        "Installment Plan ID: PLAN-001",
        "Date of Service: 2026-10-01",
        "Category: Dental (Comprehensive Orthodontic Braces - 'Lisa Needs Braces!')",
        "",
        "Total Orthodontic Charge Billed:     $3,900.00",
        "Dental Plan Orthodontic Benefit:    -$1,500.00",
        "-----------------------------------------------",
        "TOTAL PATIENT RESPONSIBILITY:        $2,400.00",
        "Approved 0% Installment Schedule: 12 Monthly Payments of $200.00",
      ],
    },
  ]);
  createdFiles.push(orthoEobPath);

  const orthoPaymentPath = path.join(
    packet3Dir,
    "Painless-Dentistry-Installment-2-Receipt.pdf"
  );
  await createMultiPagePdf(orthoPaymentPath, [
    {
      title: "PAINLESS DENTISTRY - MONTHLY INSTALLMENT RECEIPT",
      subtitle: "Dr. Wolfe | Springfield Orthodontics | Plan ID: PLAN-001",
      lines: [
        "## 0% Installment Payment Confirmation (Installment 2 of 12)",
        "Receipt Number: PMT-002",
        "Installment Plan ID: PLAN-001",
        "Patient Name: Lisa",
        "Provider: Painless Dentistry",
        "Date of Service: 2026-10-01",
        "Date Paid: 2026-11-15",
        "Payment Method: Credit Card",
        "",
        "Installment Payment Amount Paid:     $200.00",
        "Status: PAID IN FULL (Scheduled Date: 2026-11-15)",
      ],
    },
  ]);
  createdFiles.push(orthoPaymentPath);

  // =========================================================================
  // Packet 4: Marge Direct HSA Card Prescription + CSV Export
  // =========================================================================
  const packet4Dir = path.join(demoPacketsDir, "Packet-4_Marge-HSA-Card-Rx");
  const rxSlipPath = path.join(packet4Dir, "Try-N-Save-Pharmacy-Rx-Slip.pdf");
  await createMultiPagePdf(rxSlipPath, [
    {
      title: "TRY-N-SAVE PHARMACY - PRESCRIPTION RECEIPT & LABEL",
      subtitle: "Rx #RX-774120 | Store #104 Springfield",
      lines: [
        "## Official Pharmacy Prescription Slip (Proves Medical Necessity)",
        "Patient Name: Marge",
        "Provider: Try-N-Save Pharmacy",
        "Date of Service: 2026-11-10",
        "Category: Prescription",
        "Medication: Focusyn / Blue-Hair Scalp Soothing Topical Rx (30-Day Supply)",
        "Prescriber: Dr. Julius Hibbert, MD",
        "",
        "Retail Price:                        $115.00",
        "Insurance Plan Paid:                 -$80.00",
        "---------------------------------------------",
        "PATIENT COPAY OWED:                   $35.00",
      ],
    },
  ]);
  createdFiles.push(rxSlipPath);

  const hsaCsvPath = path.join(packet4Dir, "HSA-Bank-Transactions.csv");
  const csvContent = [
    "Transaction ID,Date Paid,Date of Service,Merchant / Provider,Patient,Category,Payment Method,Amount,Status",
    "TXN-9901,2026-11-10,2026-11-10,Try-N-Save Pharmacy,Marge,Prescription,HSA Card,35.00,Posted",
  ].join("\n");
  await fs.writeFile(hsaCsvPath, csvContent, "utf8");
  createdFiles.push(hsaCsvPath);

  return createdFiles;
}

export async function resetDemoSpreadsheet(
  spreadsheetId: string,
  sheetsClient?: SheetsClientLike
): Promise<void> {
  const sheets = sheetsClient ?? (await getGoogleClients()).sheets;

  // Build empty rows for C10:M250 (11 columns) and O10:R250 (4 columns), preserving column B (IDs) and N (Audit Status formulas)
  const rowCount = 241;
  const emptyCM = Array.from({ length: rowCount }, () =>
    Array.from({ length: 11 }, () => "")
  );
  const emptyOR = Array.from({ length: rowCount }, () =>
    Array.from({ length: 4 }, () => "")
  );

  // Match the exact dashboard layout & live formulas of the '0% Installment Plans' tab (rows 1..45)
  const installmentRows: any[][] = [
    // Row 1: blank
    ["", "", "", "", "", "", "", "", "", "", ""],
    // Row 2: Title banner
    [
      "",
      "0% Medical Installment Plans Tracker",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
    // Row 3: Subtitle banner
    [
      "",
      "Active 0% APR Medical Debt Payoff & Cash Flow Schedule | Monthly Budget: $375.00/mo from First Bank of Springfield",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
    // Row 4: KPI Headers
    [
      "",
      "TOTAL REMAINING BALANCE",
      "",
      "MONTHLY OBLIGATION",
      "",
      "DEBT FREEDOM TIMELINE",
      "",
      "",
      "",
      "",
      "",
    ],
    // Row 5: KPI Live Formulas
    [
      "",
      "=G12",
      "",
      "=H12",
      "",
      '=IF(COUNTIF(H16:H40, "Scheduled")=0, "100% Paid Off 🎉", COUNTIF(H16:H40, "Scheduled") & " Payments Left (Target: Sep 2027)")',
      "",
      "",
      "",
      "",
      "",
    ],
    // Row 6: KPI Captions
    [
      "",
      "Remaining 0% medical debt principal",
      "",
      "Budgeted @ $375.00/mo peak",
      "",
      "Zero interest paid | On track for Sep 2027",
      "",
      "",
      "",
      "",
      "",
    ],
    // Row 7: blank
    ["", "", "", "", "", "", "", "", "", "", ""],
    // Row 8: Active Plans Table Headers
    [
      "",
      "Plan ID",
      "Provider / Facility Name",
      "Patient",
      "Patient Responsibility",
      "Paid to Date",
      "Remaining Balance",
      "Monthly Payment",
      "APR & Status",
      "Payment Portal",
      "Affiliated Providers / EOB Billing Names",
    ],
    // Row 9: PLAN-001 (Lisa's Braces)
    [
      "",
      "PLAN-001",
      "Painless Dentistry",
      "Lisa",
      2400.0,
      '=SUMIFS($F$16:$F$40, $D$16:$D$40, C9, $H$16:$H$40, "Paid")',
      "=MAX(0, E9 - F9)",
      "=IF(G9<=0, 0, 200.00)",
      '=IF(G9<=0, "Paid Off 🎉", "0.0% APR (Active)")',
      "https://painlessdentistry.springfield.example",
      "Dr. Wolfe, Springfield Orthodontics, Painless Dentistry",
    ],
    // Row 10: PLAN-002 (Homer's Dr. Hibbert Family Practice Plan)
    [
      "",
      "PLAN-002",
      "Hibbert Family Practice",
      "Homer",
      750.0,
      '=SUMIFS($F$16:$F$40, $D$16:$D$40, C10, $H$16:$H$40, "Paid")',
      "=MAX(0, E10 - F10)",
      "=IF(G10<=0, 0, 125.00)",
      '=IF(G10<=0, "Paid Off 🎉", "0.0% APR (Active)")',
      "https://billing.hibbertmd.springfield.example",
      "Dr. Julius Hibbert, Hibbert Medical Group",
    ],
    // Row 11: PLAN-003 (Bart's Dr. Nick Clinic Plan)
    [
      "",
      "PLAN-003",
      "Upstairs Medical Clinic",
      "Bart",
      300.0,
      '=SUMIFS($F$16:$F$40, $D$16:$D$40, C11, $H$16:$H$40, "Paid")',
      "=MAX(0, E11 - F11)",
      "=IF(G11<=0, 0, 50.00)",
      '=IF(G11<=0, "Paid Off 🎉", "0.0% APR (Active)")',
      "https://drnick.springfield.example",
      "Dr. Nick Riviera, Hollywood Upstairs Medical",
    ],
    // Row 12: Active Plans Totals Row
    [
      "",
      "Total Active Plans (3 Accounts)",
      "",
      "",
      "=SUM(E9:E11)",
      "=SUM(F9:F11)",
      "=SUM(G9:G11)",
      "=SUM(H9:H11)",
      "0.0% Weighted APR",
      "",
      "",
    ],
    // Row 13: blank
    ["", "", "", "", "", "", "", "", "", "", ""],
    // Row 14: Schedule Section Title
    [
      "",
      "INDIVIDUAL PROVIDER PAYMENT & CASH FLOW SCHEDULE",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
    // Row 15: Schedule Table Headers
    [
      "",
      "Payment ID",
      "Scheduled Date",
      "Provider / Facility Name",
      "Payment Method",
      "Payment Amount",
      "Provider Balance After Payment",
      "Payment Status",
      "Notes & Payment Context",
      "",
      "",
    ],
    // Row 16: PMT-01 (Lisa Installment 1 - Paid)
    [
      "",
      "PMT-01",
      "2026-10-15",
      "Painless Dentistry",
      "Credit Card",
      200.0,
      "=MAX(0, VLOOKUP(D16, $C$9:$E$11, 3, FALSE) - SUMIFS($F$16:F16, $D$16:D16, D16))",
      "Paid",
      "Oct 2026 monthly installment (#1 of 12) — Lisa Needs Braces!",
      "",
      "",
    ],
    // Row 17: PMT-02 (Homer Installment 1 - Paid)
    [
      "",
      "PMT-02",
      "2026-10-20",
      "Hibbert Family Practice",
      "Credit Card",
      125.0,
      "=MAX(0, VLOOKUP(D17, $C$9:$E$11, 3, FALSE) - SUMIFS($F$16:F17, $D$16:D17, D17))",
      "Paid",
      "Oct 2026 monthly installment (#1 of 6) — Homer Sleep Study",
      "",
      "",
    ],
    // Row 18: PMT-03 (Bart Installment 1 - Paid)
    [
      "",
      "PMT-03",
      "2026-10-25",
      "Upstairs Medical Clinic",
      "Credit Card",
      50.0,
      "=MAX(0, VLOOKUP(D18, $C$9:$E$11, 3, FALSE) - SUMIFS($F$16:F18, $D$16:D18, D18))",
      "Paid",
      "Oct 2026 monthly installment (#1 of 6) — Hi Everybody! Clinic Visit",
      "",
      "",
    ],
    // Row 19: PMT-04 (Lisa Installment 2 - Scheduled -> Flips to Paid when Packet 3 is dropped!)
    [
      "",
      "PMT-04",
      "2026-11-15",
      "Painless Dentistry",
      "Credit Card",
      200.0,
      "=MAX(0, VLOOKUP(D19, $C$9:$E$11, 3, FALSE) - SUMIFS($F$16:F19, $D$16:D19, D19))",
      "Scheduled",
      "Nov 2026 monthly installment (#2 of 12) — Lisa Needs Braces!",
      "",
      "",
    ],
    // Row 20: PMT-05 (Homer Installment 2 - Scheduled)
    [
      "",
      "PMT-05",
      "2026-11-20",
      "Hibbert Family Practice",
      "Credit Card",
      125.0,
      "=MAX(0, VLOOKUP(D20, $C$9:$E$11, 3, FALSE) - SUMIFS($F$16:F20, $D$16:D20, D20))",
      "Scheduled",
      "Nov 2026 monthly installment (#2 of 6) — Homer Sleep Study",
      "",
      "",
    ],
    // Row 21: PMT-06 (Bart Installment 2 - Scheduled)
    [
      "",
      "PMT-06",
      "2026-11-25",
      "Upstairs Medical Clinic",
      "Credit Card",
      50.0,
      "=MAX(0, VLOOKUP(D21, $C$9:$E$11, 3, FALSE) - SUMIFS($F$16:F21, $D$16:D21, D21))",
      "Scheduled",
      "Nov 2026 monthly installment (#2 of 6) — Hi Everybody! Clinic Visit",
      "",
      "",
    ],
    // Row 22: PMT-07 (Lisa Installment 3 - Scheduled)
    [
      "",
      "PMT-07",
      "2026-12-15",
      "Painless Dentistry",
      "Credit Card",
      200.0,
      "=MAX(0, VLOOKUP(D22, $C$9:$E$11, 3, FALSE) - SUMIFS($F$16:F22, $D$16:D22, D22))",
      "Scheduled",
      "Dec 2026 monthly installment (#3 of 12) — Lisa Needs Braces!",
      "",
      "",
    ],
    // Row 23: PMT-08 (Homer Installment 3 - Scheduled)
    [
      "",
      "PMT-08",
      "2026-12-20",
      "Hibbert Family Practice",
      "Credit Card",
      125.0,
      "=MAX(0, VLOOKUP(D23, $C$9:$E$11, 3, FALSE) - SUMIFS($F$16:F23, $D$16:D23, D23))",
      "Scheduled",
      "Dec 2026 monthly installment (#3 of 6) — Homer Sleep Study",
      "",
      "",
    ],
  ];

  // Blank out rows 24..40 so no personal schedule rows remain
  while (installmentRows.length < 40) {
    installmentRows.push(["", "", "", "", "", "", "", "", "", "", ""]);
  }

  // Row 41: Schedule Totals Row
  installmentRows.push([
    "",
    "Total Scheduled Payments (8 Installments)",
    "",
    "",
    "",
    "=SUM(F16:F40)",
    0,
    '=IF(COUNTIF(H16:H40,"Scheduled")=0,"100% Paid Off 🎉","Active Schedule")',
    "Simpsons 0% APR Demo Schedule",
    "",
    "",
  ]);

  // Blank out rows 42..50
  while (installmentRows.length < 50) {
    installmentRows.push(["", "", "", "", "", "", "", "", "", "", ""]);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `'${SHEET_TAB}'!C10:M250`,
          values: emptyCM,
        },
        {
          range: `'${SHEET_TAB}'!O10:R250`,
          values: emptyOR,
        },
        {
          range: `'${INSTALLMENT_TAB}'!A1:K50`,
          values: installmentRows,
        },
      ],
    },
  });

  // Update Patient (Column E) and Payment Method (Column K) dropdown data validation rules on the main tracker tab
  if (sheets.spreadsheets.get && sheets.spreadsheets.batchUpdate) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties(title,sheetId)",
    });
    const trackerSheet = meta.data.sheets?.find(
      (s) => s.properties?.title === SHEET_TAB
    );
    const trackerSheetId = trackerSheet?.properties?.sheetId ?? 0;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            setDataValidation: {
              range: {
                sheetId: trackerSheetId,
                startRowIndex: 9,
                endRowIndex: 250,
                startColumnIndex: 4, // Column E (Patient)
                endColumnIndex: 5,
              },
              rule: {
                condition: {
                  type: "ONE_OF_LIST",
                  values: HOUSEHOLD_MEMBERS.map((userEnteredValue) => ({
                    userEnteredValue,
                  })),
                },
                showCustomUi: true,
              },
            },
          },
          {
            setDataValidation: {
              range: {
                sheetId: trackerSheetId,
                startRowIndex: 9,
                endRowIndex: 250,
                startColumnIndex: 10, // Column K (Payment Method)
                endColumnIndex: 11,
              },
              rule: {
                condition: {
                  type: "ONE_OF_LIST",
                  values: PAYMENT_METHODS.map((userEnteredValue) => ({
                    userEnteredValue,
                  })),
                },
                showCustomUi: true,
              },
            },
          },
        ],
      },
    });
  }
}

export interface RunDemoResetOptions {
  rootDir?: string;
  inboxDir?: string;
  poolDir?: string;
  archiveDir?: string;
  receiptsRootDir?: string;
  cacheFile?: string;
  populateInbox?: boolean;
  skipSheets?: boolean;
  driveClient?: DriveClientLike;
  sheetsClient?: SheetsClientLike;
}

export async function runDemoReset(
  options: RunDemoResetOptions = {}
): Promise<{
  demoPacketsDir: string;
  generatedFiles: string[];
  spreadsheetReset: boolean;
}> {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const inboxDir = options.inboxDir ?? INBOX_DIR;
  const poolDir = options.poolDir ?? POOL_DIR;
  const archiveDir = options.archiveDir ?? ARCHIVE_DIR;
  const receiptsRootDir = options.receiptsRootDir ?? RECEIPTS_ROOT_DIR;
  const cacheFile = options.cacheFile ?? CACHE_FILE;
  const populateInbox =
    options.populateInbox ?? process.argv.includes("--populate-inbox");
  const skipSheets =
    options.skipSheets ?? process.argv.includes("--skip-sheets");

  console.log(`\n=== HSA Automator: Simpsons Demo Reset ===`);
  console.log(`Demo Root Directory: ${rootDir}`);

  // 1. Clean Inbox, Reference-Pool, Archive, Receipts, and Cache
  await fs.rm(inboxDir, { recursive: true, force: true });
  await fs.rm(archiveDir, { recursive: true, force: true });
  await fs.rm(receiptsRootDir, { recursive: true, force: true });
  await fs.rm(cacheFile, { force: true });

  await fs.mkdir(poolDir, { recursive: true });
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.mkdir(receiptsRootDir, { recursive: true });

  // 2. Generate Simpsons Demo Packets
  const demoPacketsDir = path.join(rootDir, "Demo-Packets");
  const generatedFiles = await generateSimpsonsDemoPackets(demoPacketsDir);
  console.log(
    `Generated ${generatedFiles.length} Simpsons demo documents in ${demoPacketsDir}`
  );

  // 3. Optionally copy packets straight into Inbox for immediate batch sync
  if (populateInbox) {
    for (const filePath of generatedFiles) {
      const dest = path.join(inboxDir, path.basename(filePath));
      await fs.copyFile(filePath, dest);
    }
    console.log(
      `Copied all ${generatedFiles.length} demo files into ${inboxDir}`
    );
  } else {
    console.log(
      `Ready for live drag-and-drop! Drag folders/files from ${demoPacketsDir} into ${inboxDir}`
    );
  }

  // 4. Reset Live Demo Google Sheet
  let spreadsheetReset = false;
  if (!skipSheets) {
    try {
      const spreadsheetId = await resolveSpreadsheetId(options.driveClient);
      await resetDemoSpreadsheet(spreadsheetId, options.sheetsClient);
      spreadsheetReset = true;
      console.log(
        `Reset live Google Sheet "${TRACKER_TITLE}" (${spreadsheetId}) & seeded Lisa's Braces (PLAN-001).`
      );
    } catch (err: any) {
      console.warn(
        `Note: Could not reset live Google Sheet "${TRACKER_TITLE}": ${err.message}`
      );
    }
  }

  return { demoPacketsDir, generatedFiles, spreadsheetReset };
}

/* node:coverage disable */
const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runDemoReset().catch((err) => {
    console.error("Demo reset failed:", err);
    process.exit(1);
  });
}
/* node:coverage enable */
