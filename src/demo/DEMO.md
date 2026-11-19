# HSA Automator — Live Simpsons Demo Guide

This guide walks through a step-by-step live demonstration of **HSA Automator** using the generated Simpsons demo packets and your live **`DEMO - Medical Expense & HSA Reimbursement Tracker`** Google Sheet.

---

## Pre-Demo Setup (30 Seconds)

1. **Reset the Demo Environment & Live Google Sheet**:
   ```powershell
   npm run demo:reset
   ```
   **What this does automatically:**
   - Empties `HSA - DEMO/Inbox`, `Archive`, `Receipts`, and `.hsa-cache.demo.json`.
   - Clears all expense rows (`C10:M250` and `O10:R250`) on the **`HSA Expense Tracker`** tab while preserving Expense ID formulas (`Column B`) and Audit-Proof Status formulas (`Column N`).
   - Seeds the **`0% Installment Plans`** tab with 3 active Simpsons 0% APR medical installment plans (`PLAN-001` through `PLAN-003`) and 8 scheduled/paid monthly installments (`PMT-01` through `PMT-08`).
   - Generates 4 fresh scenario folders inside `HSA - DEMO/Demo-Packets/`.

2. **Start the Live Watcher**:
   ```powershell
   npm run demo:watch
   ```
3. **Arrange Your Screen**:
   - **Left half**: Your terminal (`npm run demo:watch`) + File Explorer showing `HSA - DEMO/Demo-Packets/` and `HSA - DEMO/Inbox/`.
   - **Right half**: Your browser open to **`DEMO - Medical Expense & HSA Reimbursement Tracker`**.

---

## Initial State of the `0% Installment Plans` Tab

Before dropping any files, show the audience the **`0% Installment Plans`** tab:
- **KPI Banner (Row 5)**:
  - **Total Remaining Balance**: `$3,075.00`
  - **Monthly Obligation**: `$375.00`
  - **Debt Freedom Timeline**: `5 Payments Left (Target: Sep 2027)`
- **Active Plans (Rows 9–11)**:
  - **`PLAN-001` — Painless Dentistry** (Patient: `Lisa` | Total: `$2,400.00` | Paid to Date: `$200.00` | Remaining: `$2,200.00` | Monthly: `$200.00` | Affiliated: `Dr. Wolfe, Springfield Orthodontics`)
  - **`PLAN-002` — Hibbert Family Practice** (Patient: `Homer` | Total: `$750.00` | Paid to Date: `$125.00` | Remaining: `$625.00` | Monthly: `$125.00`)
  - **`PLAN-003` — Upstairs Medical Clinic** (Patient: `Bart` | Total: `$300.00` | Paid to Date: `$50.00` | Remaining: `$250.00` | Monthly: `$50.00`)
- **Payment Schedule (Row 19)**:
  - Point out **`PMT-04`** (`2026-11-15` | `Painless Dentistry` | `$200.00`), which is currently marked **`Scheduled`**.

---

## Step 1: Standard Claim Bundling & Multi-Page PDF Slicing
**Folder:** `Demo-Packets/Packet-1_Homer-Nuclear-Injury`

### What's Inside the Files
1. **`Springfield-Health-EOB-Oct.pdf` (3-Page PDF)**
   - **Page 1 (Header/Cover)**: Subscriber summary for Homer J. Simpson (`Member ID: SNPP-742-HOMER`, Sector 7G) listing 2 claims.
   - **Page 2 (Relevant Claim)**: Claim `#CLM-2026-8841` for **Homer** at **Springfield General Hospital** on `2026-10-14` — *"Emergency Room - Radiation & Isotope Screening (CPT 99284)"*. Billed: `$940.00`, Plan Discount/Paid: `-$755.00`, **Patient Responsibility: `$185.00`**.
   - **Page 3 (Noise / $0 Claim)**: Claim `#CLM-2026-8849` for **Maggie** at **Dr. Hibbert Family Practice** — Routine Preventive Well-Child Checkup. Billed: `$220.00`, Plan Paid: `-$220.00`, **Patient Responsibility: `$0.00`**.
2. **`First-Bank-of-Springfield-Statement.pdf` (3-Page PDF)**
   - **Page 1 (Header)**: Monthly Visa `*4242` statement header for Homer & Marge Simpson.
   - **Page 2 (Noise / Retail Charges)**: Non-medical charges at **Moe's Tavern** (`$34.00`), **Krusty Burger** (`$14.50`), and **Lard Lad Donuts** (`$8.00`).
   - **Page 3 (Relevant Payment)**: `2026-10-18` charge to **Springfield General Hospital** for **`$185.00`** referencing `Claim #CLM-2026-8841`.

### Action
Drag both PDFs from `Packet-1_Homer-Nuclear-Injury` into `Inbox/`.

### Expected Outcome
- **Terminal & File System**:
  - Gemini extracts both documents, ignores Maggie's `$0.00` claim and Homer's Moe's Tavern/Krusty Burger charges, and matches the EOB and Visa statement by patient (`Homer`), amount (`$185.00`), and claim number (`CLM-2026-8841`).
  - **PDF Slicing**: Slices **Pages 1 & 2** from the EOB (dropping Page 3) and **Pages 1 & 3** from the Visa statement (dropping Page 2), merging them into a 4-page audit-ready PDF:
    `Receipts/2026/2026-10-14_Springfield-General-Hospital_Homer_$185.00.pdf`
  - **Reference Pool Cleanup**: Because all non-zero claims on `Springfield-Health-EOB-Oct.pdf` are now resolved, the EOB is automatically retired to `Archive/`, while the monthly Visa statement is retained in `Inbox/Reference-Pool/` in case other October medical bills arrive later.
- **Spreadsheet (`HSA Expense Tracker` — Row 10)**:
  - **Expense ID**: `HSA-2026-001`
  - **Date of Service / Date Paid**: `2026-10-14` / `2026-10-18`
  - **Patient / Provider / Category**: `Homer` | `Springfield General Hospital` | `Medical`
  - **Billed / Out-of-Pocket**: `$940.00` | **`$185.00`**
  - **Payment Method**: `Credit Card`
  - **Medical Necessity Verified?**: `Yes`
  - **Itemized Receipt on File?**: `Yes`
  - **Audit-Proof Status**: **`Complete`**
  - **Reimbursement Status**: `Unreimbursed - Vaulted`
  - **Receipt Link**: Clickable `=HYPERLINK(...)` opening the 4-page sliced PDF in Google Drive.

---

## Step 2: Image Receipt OCR & Non-Qualified Expense Exclusion
**Folder:** `Demo-Packets/Packet-2_Bart-Vision-Warranty`

### What's Inside the File
1. **`Springfield-Eyecare-Receipt.png` (Image Receipt)**
   - A store receipt image from **Springfield Eyecare & Optical Pavilion** on `2026-11-02` for **Bart**.
   - Contains two line items:
     1. `Rx Eyeglass Frames & Polycarbonate Lenses (Myopia Rx -1.75 OU)`: **`$210.00`** *(HSA-Qualified)*
     2. `2-Year Skateboarding Breakage Warranty (Optional Protection Plan)`: **`$45.00`** *(Non-Qualified under IRS Pub 502)*
   - **Total Paid on Visa `*4242`**: **`$255.00`**.

### Action
Drag `Springfield-Eyecare-Receipt.png` from `Packet-2_Bart-Vision-Warranty` into `Inbox/`.

### Expected Outcome
- **Terminal & File System**:
  - Gemini reads the PNG image, recognizes that optical warranties/protection plans are non-qualified, subtracts `$45.00` from the `$255.00` total, and extracts **`$210.00`** as the `qualifiedOutOfPocketAmount` (`nonQualifiedExcludedAmount: 45`).
  - Converts and embeds the PNG receipt into a standard letter-size PDF:
    `Receipts/2026/2026-11-02_Springfield-Eyecare-Optical-Pavilion_Bart_$210.00.pdf`
  - Moves the single-claim source PNG directly to `Archive/`.
- **Spreadsheet (`HSA Expense Tracker` — Row 11)**:
  - **Expense ID**: `HSA-2026-002`
  - **Date of Service / Date Paid**: `2026-11-02` / `2026-11-02`
  - **Patient / Provider / Category**: `Bart` | `Springfield Eyecare & Optical Pavilion` | `Vision`
  - **Billed / Out-of-Pocket**: `$255.00` | **`$210.00`** *(automatically reduced by $45.00!)*
  - **Medical Necessity / Receipt / Audit Status**: `Yes` | `Yes` | **`Complete`**
  - **Notes / Audit Memo**: Explicitly documents the `$45.00` warranty exclusion for IRS audit protection.

---

## Step 3: 0% Installment Plan Matching & Live Schedule Update
**Folder:** `Demo-Packets/Packet-3_Lisa-Braces-Installment`

### What's Inside the Files
1. **`Master-EOB_Painless-Dentistry.pdf` (1-Page Master Orthodontic EOB)**
   - Master EOB for **Lisa** (`Claim #ORTHO-2026-001`, Date of Service `2026-10-01`) at **Painless Dentistry (Dr. Wolfe / Springfield Orthodontics)** for *"Comprehensive Orthodontic Braces - 'Lisa Needs Braces!'"*.
   - Total Billed: `$3,900.00`, Plan Benefit: `-$1,500.00`, **Total Patient Responsibility: `$2,400.00`** (12 monthly installments of `$200.00`).
2. **`Painless-Dentistry-Installment-2-Receipt.pdf` (1-Page Payment Receipt)**
   - Payment confirmation (`PMT-002`) dated **`2026-11-15`** for **`$200.00`** paid via Credit Card for Installment 2 of 12.

### Action
Drag both PDFs from `Packet-3_Lisa-Braces-Installment` into `Inbox/`.

### Expected Outcome
- **Terminal & File System**:
  - Gemini & the Matcher link both documents to active installment plan **`PLAN-001` (`Painless Dentistry`)** and match the `$200.00` payment on `2026-11-15` to scheduled row **`PMT-04`** (Row 19 on the `0% Installment Plans` tab).
  - Merges the Master Orthodontic EOB + the November installment receipt into:
    `Receipts/2026/2026-11-15_Painless-Dentistry_Lisa_$200.00.pdf`
  - **Smart Pool Retention**: Moves `Master-EOB_Painless-Dentistry.pdf` into `Inbox/Reference-Pool/` (and **keeps** it there because Lisa still has `$2,000.00` remaining on her installment plan for future months!), while archiving the single-month payment receipt.
- **Spreadsheet (`HSA Expense Tracker` — Row 12)**:
  - **Expense ID**: `HSA-2026-003`
  - **Date of Service / Date Paid**: `2026-10-01` / `2026-11-15`
  - **Patient / Provider / Category**: `Lisa` | `Painless Dentistry` | `Dental`
  - **Service Description**: `PMT-04: Nov 2026 monthly installment (#2 of 12) — Lisa Needs Braces!`
  - **Billed / Out-of-Pocket**: `$2,400.00` *(total plan responsibility)* | **`$200.00`** *(this installment)*
  - **Audit-Proof Status**: **`Complete`**
- **Spreadsheet (`0% Installment Plans` Tab — Live Formula Cascade)**:
  - Switch to the **`0% Installment Plans`** tab to show:
    - **Row 19 (`PMT-04`)**: Status automatically flipped from `Scheduled` to **`Paid`**.
    - **Row 9 (`PLAN-001`)**: `Paid to Date` automatically increased from `$200.00` to **`$400.00`**, and `Remaining Balance` dropped from `$2,200.00` to **`$2,000.00`**.
    - **Row 5 (Top KPI Banner)**: `Total Remaining Balance` dropped from `$3,075.00` to **`$2,875.00`**, and `Debt Freedom Timeline` updated to **`4 Payments Left`**.

---

## Step 4: Direct HSA Card Prescription & CSV Transaction Proof
**Folder:** `Demo-Packets/Packet-4_Marge-HSA-Card-Rx`

### What's Inside the Files
1. **`Try-N-Save-Pharmacy-Rx-Slip.pdf` (1-Page Pharmacy Prescription Tag)**
   - Official pharmacy prescription slip (`Rx #RX-774120`) for **Marge** at **Try-N-Save Pharmacy** on `2026-11-10` for *"Focusyn / Blue-Hair Scalp Soothing Topical Rx"* prescribed by Dr. Julius Hibbert.
   - Retail: `$115.00`, Insurance Paid: `-$80.00`, **Patient Copay Owed: `$35.00`**.
   - *(Note: Proves medical necessity, but does not prove payment on its own.)*
2. **`HSA-Bank-Transactions.csv` (CSV Transaction Export)**
   - A bank CSV export containing:
     `TXN-9901,2026-11-10,2026-11-10,Try-N-Save Pharmacy,Marge,Prescription,HSA Card,35.00,Posted`

### Action
Drag both files from `Packet-4_Marge-HSA-Card-Rx` into `Inbox/`.

### Expected Outcome
- **Terminal & File System**:
  - Bundles the PDF pharmacy slip with the CSV payment row (`Marge`, `$35.00`).
  - Because `HSA Automator` never embeds raw CSV text into IRS PDFs (and `HSA Card` distributions are backed by the custodian's Form 1099-SA + the Rx slip), the generated PDF contains only the clean pharmacy slip:
    `Receipts/2026/2026-11-10_Try-N-Save-Pharmacy_Marge_$35.00.pdf`
- **Spreadsheet (`HSA Expense Tracker` — Row 13)**:
  - **Expense ID**: `HSA-2026-004`
  - **Date of Service / Date Paid**: `2026-11-10` / `2026-11-10`
  - **Patient / Provider / Category**: `Marge` | `Try-N-Save Pharmacy` | `Prescription`
  - **Billed / Out-of-Pocket**: `$115.00` *(retail drug price)* | **`$35.00`** *(copay paid after $80.00 insurance benefit)*
  - **Payment Method**: **`HSA Card`**
  - **Medical Necessity / Receipt / Audit Status**: `Yes` | `Yes` | **`Complete`**
  - **Reimbursement Status (Column O)**: Automatically set to **`Paid via HSA Directly`** (instead of `Unreimbursed - Vaulted`) with **Date Reimbursed (Column P)** populated as **`2026-11-10`**, preventing double-reimbursement!
