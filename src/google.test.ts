import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchExpenseRows,
  loadInstallmentTab,
  lookupDriveLink,
  markInstallmentPaid,
  parseInstallmentRows,
  resetCachedSpreadsheetId,
  resolveSpreadsheetId,
  setGoogleClients,
  upsertExpenseRow,
  type DriveClientLike,
  type SheetsClientLike,
} from "./google.js";

describe("google module", () => {
  test("resolves spreadsheet ID via Drive search and caches it", async () => {
    resetCachedSpreadsheetId(null);
    let listCalls = 0;
    const mockDrive: DriveClientLike = {
      files: {
        list: async () => {
          listCalls++;
          return {
            data: { files: [{ id: "sheet-123", name: "Tracker" }] },
          };
        },
      },
    };

    const id1 = await resolveSpreadsheetId(mockDrive);
    const id2 = await resolveSpreadsheetId(mockDrive);
    assert.equal(id1, "sheet-123");
    assert.equal(id2, "sheet-123");
    assert.equal(listCalls, 1);

    resetCachedSpreadsheetId(null);
    await assert.rejects(
      () =>
        resolveSpreadsheetId({
          files: { list: async () => ({ data: { files: [] } }) },
        }),
      /Could not find spreadsheet/
    );
  });

  test("parses PLAN- and PMT- rows from installment tab values", async () => {
    const rawRows = [
      ["", "ID", "Provider / Date", "Patient / Provider"],
      [
        "",
        "PLAN-001",
        "Smile Ortho",
        "Dependent",
        "$3,000.00",
        "$1,000.00",
        "$2,000.00",
        "$250.00",
        "Active",
        "",
        "Dr. Jane Ortho",
      ],
      [
        "",
        "PMT-01",
        "2026-03-01",
        "Smile Ortho",
        "PLAN-001",
        "$250.00",
        "Credit Card",
        "Pending",
        "Month 1",
      ],
    ];

    const parsed = parseInstallmentRows(rawRows);
    assert.equal(parsed.plans.length, 1);
    assert.equal(parsed.plans[0].planId, "PLAN-001");
    assert.equal(parsed.plans[0].rowIndex, 2);
    assert.equal(parsed.plans[0].totalResponsibility, 3000);
    assert.equal(parsed.plans[0].remainingBalance, 2000);
    assert.equal(parsed.plans[0].monthlyPayment, 250);
    assert.equal(parsed.plans[0].affiliatedProviders, "Dr. Jane Ortho");

    assert.equal(parsed.schedule.length, 1);
    assert.equal(parsed.schedule[0].paymentId, "PMT-01");
    assert.equal(parsed.schedule[0].rowIndex, 3);
    assert.equal(parsed.schedule[0].paymentAmount, 250);
    assert.equal(parsed.schedule[0].status, "Pending");

    const mockSheets: SheetsClientLike = {
      spreadsheets: {
        values: {
          get: async () => ({ data: { values: rawRows } }),
          update: async () => ({}),
          batchUpdate: async () => ({}),
        },
      },
    };
    const loaded = await loadInstallmentTab("sheet-123", mockSheets);
    assert.equal(loaded.plans.length, 1);
    assert.equal(loaded.schedule.length, 1);

    const errorFallback = await loadInstallmentTab("sheet-123", {
      spreadsheets: {
        values: {
          get: async () => {
            throw new Error("tab not found");
          },
          update: async () => ({}),
          batchUpdate: async () => ({}),
        },
      },
    });
    assert.deepEqual(errorFallback, { plans: [], schedule: [] });

    // Also test sparse rows with missing cells and null values fallback
    const sparse = parseInstallmentRows([[], ["", "PLAN-002"], ["", "PMT-02"]]);
    assert.equal(sparse.plans[0].totalResponsibility, 0);
    assert.equal(sparse.schedule[0].paymentAmount, 0);

    const emptyTab = await loadInstallmentTab("sheet-123", {
      spreadsheets: {
        values: {
          get: async () => ({ data: { values: null } }),
          update: async () => ({}),
          batchUpdate: async () => ({}),
        },
      },
    });
    assert.deepEqual(emptyTab, { plans: [], schedule: [] });
  });

  test("polls lookupDriveLink until file appears or returns empty string on timeout", async () => {
    let attempts = 0;
    const mockDrive: DriveClientLike = {
      files: {
        list: async () => {
          attempts++;
          if (attempts < 2) return { data: { files: [] } };
          return {
            data: {
              files: [
                {
                  id: "f1",
                  name: "receipt.pdf",
                  webViewLink: "https://drive.google.com/file/d/f1/view",
                },
              ],
            },
          };
        },
      },
    };

    const link = await lookupDriveLink("receipt.pdf", {
      driveClient: mockDrive,
      maxAttempts: 3,
      retryDelayMs: 1,
    });
    assert.equal(link, "https://drive.google.com/file/d/f1/view");
    assert.equal(attempts, 2);

    const emptyLink = await lookupDriveLink("missing's.pdf", {
      driveClient: {
        files: { list: async () => ({ data: { files: [] } }) },
      },
      maxAttempts: 2,
      retryDelayMs: 1,
    });
    assert.equal(emptyLink, "");
  });

  test("formats batchUpdate ranges and reimbursement status in upsertExpenseRow and markInstallmentPaid", async () => {
    const batchCalls: any[] = [];
    const updateCalls: any[] = [];
    const mockSheets: SheetsClientLike = {
      spreadsheets: {
        values: {
          get: async () => ({ data: { values: [["EXP-1"]] } }),
          batchUpdate: async (params) => {
            batchCalls.push(params);
          },
          update: async (params) => {
            updateCalls.push(params);
          },
        },
      },
    };

    const rows = await fetchExpenseRows("sheet-123", mockSheets);
    assert.equal(rows.length, 1);

    await upsertExpenseRow({
      spreadsheetId: "sheet-123",
      targetSheetRow: 12,
      dateOfService: "2026-03-01",
      datePaid: "2026-03-02",
      patient: "Primary",
      provider: "Quest",
      category: "Medical",
      description: "Lab",
      billedAmount: 100,
      outOfPocketAmount: 25,
      payMethod: "HSA Card",
      hasEobOrInvoice: true,
      hasReceiptOrStatement: true,
      linkFormula: '=HYPERLINK("https://drive/1", "doc.pdf")',
      combinedNotes: "Claim #1",
      sheetsClient: mockSheets,
    });

    assert.equal(batchCalls.length, 1);
    const data = batchCalls[0].requestBody.data;
    assert.equal(data[0].values[0][9], "Yes");
    assert.equal(data[1].values[0][0], "Paid via HSA Directly");
    assert.equal(data[1].values[0][1], "2026-03-02");

    await markInstallmentPaid("sheet-123", 18, mockSheets);
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0].requestBody.values, [["Paid"]]);

    // Also test non-HSA Card upsert and default injected Google clients
    setGoogleClients({
      sheets: {
        spreadsheets: {
          values: {
            get: async () => ({ data: { values: null } }),
            batchUpdate: async (params) => {
              batchCalls.push(params);
            },
            update: async (params) => {
              updateCalls.push(params);
            },
          },
        },
      },
      drive: {
        files: {
          list: async () => ({
            data: {
              files: [{ id: "id-default", webViewLink: "https://drive/def" }],
            },
          }),
        },
      },
    });
    resetCachedSpreadsheetId("your-placeholder-id");
    assert.equal(await resolveSpreadsheetId(), "id-default");
    assert.deepEqual(await fetchExpenseRows("id-default"), []);
    assert.deepEqual(await loadInstallmentTab("id-default"), {
      plans: [],
      schedule: [],
    });
    assert.equal(
      await lookupDriveLink("f.pdf", { maxAttempts: 1, retryDelayMs: 1 }),
      "https://drive/def"
    );
    await upsertExpenseRow({
      spreadsheetId: "id-default",
      targetSheetRow: 15,
      dateOfService: "2026-03-01",
      datePaid: "",
      patient: "Primary",
      provider: "Quest",
      category: "Medical",
      description: "Lab",
      billedAmount: 100,
      outOfPocketAmount: 25,
      payMethod: "Credit Card",
      hasEobOrInvoice: false,
      hasReceiptOrStatement: false,
      linkFormula: "doc.pdf",
      combinedNotes: "",
    });
    assert.equal(
      batchCalls[1].requestBody.data[1].values[0][0],
      "Unreimbursed - Vaulted"
    );
    await markInstallmentPaid("id-default", 20);
    assert.equal(updateCalls.length, 2);
  });
});
