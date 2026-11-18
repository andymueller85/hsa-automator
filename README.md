# HSA Automator

An automated medical document parser, PDF slicer/merger, and Google Sheets tracker for managing Health Savings Account (HSA) expenses and IRS audit-ready receipt vaults.

## Overview

`HSA Automator` monitors an `Inbox` directory for medical documents—such as Explanation of Benefits (EOBs), itemized medical/dental/vision bills, pharmacy prescription slips, payment receipts, credit card statements, and CSV transaction exports—and automatically:

1. **Extracts Claim Details with Gemini**: Uses Google's `@google/genai` structured output to extract patient name, provider, service/payment dates, category (`Medical`, `Dental`, `Vision`, `Prescription`), billed vs. qualified out-of-pocket amounts (excluding non-qualified items like warranties), page indices, and a concise IRS audit memo.
2. **Matches & Bundles Supporting Docs (Including 0% Installment Plans)**: Groups related EOBs, bills, and payment receipts/statements by claim, subfolder, or active installment plan (from the `0% Installment Plans` tab) and slices/merges only the relevant pages (plus header pages) into a single, standardized PDF (`YYYY-MM-DD_Provider_Patient_$Amount.pdf`).
3. **Syncs to Google Sheets & Google Drive**: Uploads/resolves the Google Drive `webViewLink` for each generated receipt PDF, writes or updates the corresponding row in your Google Sheets tracker with a clickable `=HYPERLINK(...)` formula and audit status metrics, and marks matched scheduled installment payments as `Paid`.
4. **Manages Multi-Claim Reference Pool & Archive**: Moves single-claim documents to `Archive` after processing, retains multi-claim EOBs, active installment plan EOBs, or credit card statements in `Inbox/Reference-Pool` until all claims/installments are resolved, and automatically retires completed pool documents.

---

## Directory Structure

Point `MEDICAL_ROOT_DIR` in your `.env` to a local folder (ideally synced via Google Drive for Desktop so generated receipt PDFs receive Drive links automatically):

```text
<MEDICAL_ROOT_DIR>/
├── Inbox/                  # Drop new EOBs, bills, receipts, or subfolders here
│   └── Reference-Pool/     # Multi-claim EOBs & credit card statements held until all claims resolve
├── Archive/                # Processed raw source documents
└── Receipts/               # Final merged, audit-ready PDFs organized by service year
    ├── 2025/
    └── 2026/
```

---

## Prerequisites & Setup

### 1. Install Dependencies

Requires **Node.js v20+**.

```bash
npm install
# or
yarn install
```

### 2. Google Cloud Service Account & APIs

1. In the [Google Cloud Console](https://console.cloud.google.com/), enable the **Google Sheets API** and **Google Drive API**.
2. Create a Service Account and download its JSON key file (e.g., `service-account.json`) to the project root.
3. Share both your **Google Drive HSA folder** and your **Google Sheets tracker** with the service account's `client_email` as an **Editor**.

### 3. Environment Configuration

Copy [`.env.example`](.env.example) to `.env` and fill in your settings:

```bash
cp .env.example .env
```

| Variable | Description |
| :--- | :--- |
| `GEMINI_API_KEY` | Google AI Studio API key (Paid Tier recommended so prompts/documents are not logged). |
| `SHEET_TAB_NAME` | Tab name in your Google Sheet (default: `HSA Expense Tracker`). |
| `INSTALLMENT_TAB_NAME` | *(Optional)* Tab name for tracking 0% installment plans and payment schedules (default: `0% Installment Plans`). |
| `SPREADSHEET_ID` | *(Optional)* Google Spreadsheet ID. If omitted, resolved automatically by title. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to your Google Service Account JSON key file. |
| `MEDICAL_ROOT_DIR` | Local path to your HSA root directory containing `Inbox`, `Archive`, and `Receipts`. |
| `HOUSEHOLD_MEMBERS` | Comma-separated list of patient names for schema validation (e.g., `Alice,Bob,Charlie`). |
| `HOUSEHOLD_PROMPT_NAMES` | Natural-language list of household members for the extraction prompt. |
| `PAYMENT_METHODS` | Comma-separated list of payment methods (e.g., `Credit Card,PayPal,Checking,HSA Card,Unknown`). |
| `DEFAULT_PAYMENT_METHOD` | Fallback payment method when none is explicitly detected. |

---

## Usage

### Dry Run (Preview Only)
Analyzes documents in `Inbox`, logs the bundle matching, PDF page slicing plan, and target spreadsheet rows without modifying files or updating Google Sheets:

```bash
npm run dry-run
```

### One-Time Sync
Processes all documents currently in `Inbox`, generates merged PDFs in `Receipts/<Year>`, updates the Google Sheet, and archives source files:

```bash
npm run sync
```

### Watch Mode
Continuously watches `Inbox` for newly added PDFs or images and triggers a sync automatically:

```bash
npm run watch
```

---

## Automated Scheduling (Windows Task Scheduler)

To run the sync automatically every night at 9:00 PM in a hidden background window using `run-hsa-sync.ps1`, run the following in PowerShell:

```powershell
$WorkDir = "C:\Path\To\HSA Automator"
$Action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-File `"$WorkDir\run-hsa-sync.ps1`"" -WorkingDirectory $WorkDir
$Trigger = New-ScheduledTaskTrigger -Daily -At 9:00PM
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -Hidden
Register-ScheduledTask -TaskName "HSA-Receipt-Sync" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Nightly HSA Inbox PDF slicer and Google Sheets sync"
```

---

## License

MIT
