import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimBundles,
  findExistingExpenseRowIndex,
  matchInstallmentPlan,
  sortBundleClaims,
} from "./matcher.js";
import type {
  ExtractedClaim,
  InstallmentPlan,
  InstallmentScheduleRow,
  ParsedFileMetadata,
} from "./types.js";

function makeClaim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    dateOfService: "2026-03-10",
    patient: "Primary",
    provider: "City Medical Group",
    category: "Medical",
    description: "Office Visit",
    billedOrEobAmount: 250,
    qualifiedOutOfPocketAmount: 75,
    nonQualifiedExcludedAmount: 0,
    headerPageIndex: 0,
    relevantPageIndices: [0],
    provesMedicalNecessity: true,
    provesPayment: false,
    notes: "Claim #CLM-100",
    ...overrides,
  };
}

function makeDoc(
  overrides: Partial<ParsedFileMetadata> & { claims: ExtractedClaim[] }
): ParsedFileMetadata {
  return {
    filePath: "/tmp/Inbox/eob.pdf",
    fileName: "eob.pdf",
    hash: "abc123",
    docType: "EOB",
    isMultiClaimOrStatement: false,
    ...overrides,
  };
}

const samplePlans: InstallmentPlan[] = [
  {
    rowIndex: 4,
    planId: "PLAN-001",
    provider: "Smile Orthodontics",
    patient: "Dependent",
    totalResponsibility: 3000,
    remainingBalance: 2000,
    monthlyPayment: 250,
    affiliatedProviders: "Dr. Jane Ortho, Ortho Associates LLC",
  },
];

describe("matchInstallmentPlan", () => {
  test("matches by explicit installmentPlanId", () => {
    const claim = makeClaim({
      installmentPlanId: "PLAN-001",
      provider: "Unrelated Name",
      qualifiedOutOfPocketAmount: 123.45,
    });
    const matched = matchInstallmentPlan(claim, samplePlans);
    assert.equal(matched?.planId, "PLAN-001");
  });

  test("matches by primary provider token overlap", () => {
    const claim = makeClaim({
      provider: "Smile Orthodontics PC",
      qualifiedOutOfPocketAmount: 99,
    });
    const matched = matchInstallmentPlan(claim, samplePlans);
    assert.equal(matched?.planId, "PLAN-001");
  });

  test("matches by affiliated provider token overlap", () => {
    const claim = makeClaim({
      provider: "Dr. Jane Ortho DDS",
      qualifiedOutOfPocketAmount: 99,
    });
    const matched = matchInstallmentPlan(claim, samplePlans);
    assert.equal(matched?.planId, "PLAN-001");
  });

  test("matches by exact monthlyPayment or totalResponsibility", () => {
    const byMonthly = makeClaim({
      provider: "Generic Billing Service",
      qualifiedOutOfPocketAmount: 250,
    });
    assert.equal(
      matchInstallmentPlan(byMonthly, samplePlans)?.planId,
      "PLAN-001"
    );

    const byTotal = makeClaim({
      provider: "Generic Billing Service",
      qualifiedOutOfPocketAmount: 3000,
    });
    assert.equal(
      matchInstallmentPlan(byTotal, samplePlans)?.planId,
      "PLAN-001"
    );
  });

  test("returns undefined when nothing matches", () => {
    const claim = makeClaim({
      provider: "Quest Diagnostics",
      qualifiedOutOfPocketAmount: 42.5,
    });
    assert.equal(matchInstallmentPlan(claim, samplePlans), undefined);
  });
});

describe("buildClaimBundles", () => {
  test("bundles an EOB and a payment receipt with matching patient and amount", () => {
    const eobDoc = makeDoc({
      fileName: "eob.pdf",
      docType: "EOB",
      claims: [
        makeClaim({
          claimNumber: "CLM-1",
          patient: "Primary",
          qualifiedOutOfPocketAmount: 75,
          provesMedicalNecessity: true,
          provesPayment: false,
        }),
      ],
    });
    const receiptDoc = makeDoc({
      fileName: "receipt.pdf",
      docType: "PAYMENT_RECEIPT",
      claims: [
        makeClaim({
          patient: "Primary",
          qualifiedOutOfPocketAmount: 75,
          datePaid: "2026-03-15",
          provesMedicalNecessity: false,
          provesPayment: true,
        }),
      ],
    });

    const bundles = buildClaimBundles([eobDoc, receiptDoc], [], []);
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].key, "Primary_75.00");
    assert.equal(bundles[0].claims.length, 2);
  });

  test("bundles all documents in the same subfolderGroup together", () => {
    const doc1 = makeDoc({
      fileName: "invoice.pdf",
      subfolderGroup: "vision-visit",
      docType: "BILL_OR_INVOICE",
      claims: [
        makeClaim({
          patient: "Spouse",
          qualifiedOutOfPocketAmount: 180,
          provesMedicalNecessity: true,
        }),
      ],
    });
    const doc2 = makeDoc({
      fileName: "card-slip.png",
      subfolderGroup: "vision-visit",
      docType: "PAYMENT_RECEIPT",
      claims: [
        makeClaim({
          patient: "Spouse",
          qualifiedOutOfPocketAmount: 180,
          provesMedicalNecessity: false,
          provesPayment: true,
        }),
      ],
    });

    const bundles = buildClaimBundles([doc1, doc2], [], []);
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].key, "SUBFOLDER:vision-visit");
    assert.equal(bundles[0].claims.length, 2);
  });

  test("deduplicates identical claim numbers across duplicate EOB files while bundling different docTypes sharing a claimNumber", () => {
    const eob1 = makeDoc({
      fileName: "eob-copy1.pdf",
      docType: "EOB",
      claims: [makeClaim({ claimNumber: "DUP-999" })],
    });
    const eob2 = makeDoc({
      fileName: "eob-copy2.pdf",
      docType: "EOB",
      claims: [makeClaim({ claimNumber: "DUP-999" })],
    });
    const ccStatementWithSameClaimNumber = makeDoc({
      fileName: "cc-statement.pdf",
      docType: "CC_STATEMENT",
      claims: [
        makeClaim({
          claimNumber: "DUP-999",
          provesMedicalNecessity: false,
          provesPayment: true,
        }),
      ],
    });

    const bundles = buildClaimBundles(
      [ccStatementWithSameClaimNumber, eob1, eob2],
      [],
      []
    );
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].claims.length, 2);
    assert.equal(bundles[0].claims[0].doc.docType, "CC_STATEMENT");
    assert.equal(bundles[0].claims[1].doc.docType, "EOB");
  });

  test("skips $0 out-of-pocket claims and unmatched standalone CSV/CC rows", () => {
    const zeroDoc = makeDoc({
      fileName: "zero-eob.pdf",
      claims: [makeClaim({ qualifiedOutOfPocketAmount: 0 })],
    });
    const unmatchedCsv = makeDoc({
      fileName: "transactions.csv",
      docType: "TRANSACTION_CSV",
      claims: [
        makeClaim({
          qualifiedOutOfPocketAmount: 55,
          provesMedicalNecessity: false,
          provesPayment: true,
        }),
      ],
    });

    const bundles = buildClaimBundles([zeroDoc, unmatchedCsv], [], []);
    assert.equal(bundles.length, 0);

    // A CSV payment that matches an EOB by patient & amount is bundled with that EOB
    const matchingEob = makeDoc({
      fileName: "eob-55.pdf",
      docType: "EOB",
      claims: [
        makeClaim({
          patient: "Primary",
          qualifiedOutOfPocketAmount: 55,
          provesMedicalNecessity: true,
          provesPayment: false,
        }),
      ],
    });
    const matchedBundles = buildClaimBundles(
      [matchingEob, unmatchedCsv],
      [],
      []
    );
    assert.equal(matchedBundles.length, 1);
    assert.equal(matchedBundles[0].claims.length, 2);
  });

  test("pairs installment plan payments with plan EOBs and matches schedule rows", () => {
    const schedule: InstallmentScheduleRow[] = [
      {
        rowIndex: 15,
        paymentId: "PMT-02",
        scheduledDate: "2026-04-01",
        provider: "Smile Orthodontics",
        paymentAmount: 250,
        status: "Pending",
        notes: "Installment 2 of 12",
      },
    ];

    const planEob = makeDoc({
      fileName: "ortho-eob.pdf",
      docType: "EOB",
      claims: [
        makeClaim({
          claimNumber: "ORTHO-EOB-1",
          patient: "Dependent",
          provider: "Dr. Jane Ortho",
          installmentPlanId: "PLAN-001",
          qualifiedOutOfPocketAmount: 3000,
          provesMedicalNecessity: true,
          provesPayment: false,
        }),
      ],
    });

    const planPayment = makeDoc({
      fileName: "cc-statement.pdf",
      docType: "CC_STATEMENT",
      claims: [
        makeClaim({
          patient: "Dependent",
          provider: "Smile Orthodontics",
          installmentPlanId: "PLAN-001",
          dateOfService: "2026-04-03",
          datePaid: "2026-04-03",
          qualifiedOutOfPocketAmount: 250,
          provesMedicalNecessity: false,
          provesPayment: true,
        }),
      ],
    });

    const bundles = buildClaimBundles(
      [planEob, planPayment],
      samplePlans,
      schedule
    );

    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].key, "INSTALLMENT:PLAN-001_2026-04-03_250.00");
    assert.equal(bundles[0].plan?.planId, "PLAN-001");
    assert.equal(bundles[0].matchedScheduleRow?.paymentId, "PMT-02");
    assert.equal(bundles[0].claims.length, 2);

    // An installment payment whose amount matches neither monthlyPayment nor any schedule row is ignored
    const bogusPlanPayment = makeDoc({
      fileName: "cc-statement-2.pdf",
      docType: "CC_STATEMENT",
      claims: [
        makeClaim({
          patient: "Dependent",
          provider: "Smile Orthodontics",
          installmentPlanId: "PLAN-001",
          dateOfService: "2026-04-05",
          datePaid: "2026-04-05",
          qualifiedOutOfPocketAmount: 19.99,
          provesMedicalNecessity: false,
          provesPayment: true,
        }),
      ],
    });
    const filteredBundles = buildClaimBundles(
      [planEob, bogusPlanPayment],
      samplePlans,
      schedule
    );
    assert.equal(filteredBundles.length, 0);
  });
});

describe("findExistingExpenseRowIndex", () => {
  const rows = [
    [
      "EXP-1",
      "2026-02-10",
      "",
      "Primary",
      "Quest Diagnostics",
      "Medical",
      "Lab Work",
      "$120.00",
      "$45.50",
      "",
      "Yes",
      "No",
      "Needs Receipt",
      "",
      "Unreimbursed - Vaulted",
      "",
      "Claim #CLM-777; Patient responsibility $45.50",
    ],
    [
      "EXP-2",
      "2026-01-15",
      "2026-04-01",
      "Dependent",
      "Smile Orthodontics",
      "Dental",
      "PMT-02: Installment 2 of 12",
      "$3,000.00",
      "$250.00",
      "Credit Card",
      "Yes",
      "Yes",
      "Complete",
      "",
      "Unreimbursed - Vaulted",
      "",
      "Ortho installment",
    ],
  ];

  test("finds a row by claim number in notes", () => {
    const idx = findExistingExpenseRowIndex(rows, {
      isInstallmentPlan: false,
      claimNumber: "CLM-777",
      dateOfService: "2026-02-99",
      datePaid: "",
      patient: "Primary",
      provider: "Quest",
      outOfPocketAmount: 999,
    });
    assert.equal(idx, 0);
  });

  test("finds a standard row by patient, amount, and dateOfService", () => {
    const idx = findExistingExpenseRowIndex(rows, {
      isInstallmentPlan: false,
      dateOfService: "2026-02-10",
      datePaid: "2026-02-14",
      patient: "Primary",
      provider: "Quest Diagnostics",
      outOfPocketAmount: 45.5,
    });
    assert.equal(idx, 0);
  });

  test("finds an installment row by datePaid, amount, and provider", () => {
    const idx = findExistingExpenseRowIndex(rows, {
      isInstallmentPlan: true,
      dateOfService: "2026-01-15",
      datePaid: "2026-04-01",
      patient: "Dependent",
      provider: "SMILE ORTHODONTICS",
      outOfPocketAmount: 250,
    });
    assert.equal(idx, 1);
  });

  test("returns -1 when no row matches", () => {
    const idx = findExistingExpenseRowIndex(rows, {
      isInstallmentPlan: false,
      dateOfService: "2026-05-01",
      datePaid: "",
      patient: "Spouse",
      provider: "Unknown Clinic",
      outOfPocketAmount: 19.99,
    });
    assert.equal(idx, -1);
  });
});

describe("sortBundleClaims", () => {
  test("orders EOBs and medical necessity documents ahead of payment-only documents", () => {
    const paymentReceipt = {
      doc: makeDoc({ docType: "PAYMENT_RECEIPT", claims: [] }),
      claim: makeClaim({ provesMedicalNecessity: false, provesPayment: true }),
    };
    const ccStatement = {
      doc: makeDoc({ docType: "CC_STATEMENT", claims: [] }),
      claim: makeClaim({ provesMedicalNecessity: false, provesPayment: true }),
    };
    const eob = {
      doc: makeDoc({ docType: "EOB", claims: [] }),
      claim: makeClaim({ provesMedicalNecessity: true, provesPayment: false }),
    };

    const sorted = sortBundleClaims([paymentReceipt, ccStatement, eob]);
    assert.equal(sorted[0].doc.docType, "EOB");
    assert.equal(sorted[1].doc.docType, "PAYMENT_RECEIPT");
    assert.equal(sorted[2].doc.docType, "CC_STATEMENT");
  });
});
