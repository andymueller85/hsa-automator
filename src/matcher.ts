import type {
  ClaimBundle,
  ClaimBundleItem,
  ExtractedClaim,
  InstallmentPlan,
  InstallmentScheduleRow,
  ParsedFileMetadata,
} from "./types.js";

export function sortBundleClaims(claims: ClaimBundleItem[]): ClaimBundleItem[] {
  return [...claims].sort((a, b) => {
    const aIsMed =
      a.doc.docType === "EOB" ||
      a.doc.docType === "BILL_OR_INVOICE" ||
      a.claim.provesMedicalNecessity;
    const bIsMed =
      b.doc.docType === "EOB" ||
      b.doc.docType === "BILL_OR_INVOICE" ||
      b.claim.provesMedicalNecessity;
    return aIsMed === bIsMed ? 0 : aIsMed ? -1 : 1;
  });
}

export function matchInstallmentPlan(
  claim: ExtractedClaim,
  plans: InstallmentPlan[]
): InstallmentPlan | undefined {
  if (claim.installmentPlanId) {
    const byId = plans.find((p) => p.planId === claim.installmentPlanId);
    if (byId) return byId;
  }
  const tokens = (s: string) =>
    s
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((t) => t.length >= 2);
  const cTokens = new Set(tokens(claim.provider));
  return plans.find((p) => {
    const aliases = [
      p.provider,
      ...(p.affiliatedProviders ? p.affiliatedProviders.split(",") : []),
    ]
      .map((s) => s.trim())
      .filter(Boolean);
    const aliasMatch = aliases.some((a) => {
      const aTokens = tokens(a);
      return aTokens.length > 0 && aTokens.every((t) => cTokens.has(t));
    });
    return (
      aliasMatch ||
      Math.abs(claim.qualifiedOutOfPocketAmount - p.totalResponsibility) <
        0.01 ||
      Math.abs(claim.qualifiedOutOfPocketAmount - p.monthlyPayment) < 0.01
    );
  });
}

export function buildClaimBundles(
  parsedDocs: ParsedFileMetadata[],
  installmentPlans: InstallmentPlan[],
  installmentSchedule: InstallmentScheduleRow[]
): ClaimBundle[] {
  const bundles: ClaimBundle[] = [];
  const installmentEobs = new Map<string, ClaimBundleItem[]>();
  const installmentPayments: {
    plan: InstallmentPlan;
    doc: ParsedFileMetadata;
    claim: ExtractedClaim;
  }[] = [];

  // 1. Group EOBs & Payments into either Installment Plan buckets or standard bundles
  for (const doc of parsedDocs) {
    for (const claim of doc.claims) {
      if (claim.qualifiedOutOfPocketAmount <= 0) continue;

      const plan = !doc.subfolderGroup
        ? matchInstallmentPlan(claim, installmentPlans)
        : undefined;

      if (plan) {
        const isPaymentOnly =
          !claim.provesMedicalNecessity &&
          (doc.docType === "PAYMENT_RECEIPT" ||
            doc.docType === "CC_STATEMENT" ||
            doc.docType === "TRANSACTION_CSV" ||
            claim.provesPayment);

        if (isPaymentOnly) {
          installmentPayments.push({ plan, doc, claim });
        } else {
          const list = installmentEobs.get(plan.planId) || [];
          // Deduplicate identical claim numbers across duplicate EOB files
          if (
            !claim.claimNumber ||
            !list.some((e) => e.claim.claimNumber === claim.claimNumber)
          ) {
            list.push({ doc, claim });
            installmentEobs.set(plan.planId, list);
          }
        }
        continue;
      }

      // Skip standalone CSV/CC rows that don't match an EOB or an active installment plan
      if (
        (doc.docType === "TRANSACTION_CSV" || doc.docType === "CC_STATEMENT") &&
        !claim.provesMedicalNecessity
      ) {
        const matchesSomeEob = parsedDocs.some((d) =>
          d.claims.some(
            (c) =>
              c.provesMedicalNecessity &&
              c.patient === claim.patient &&
              Math.abs(
                c.qualifiedOutOfPocketAmount - claim.qualifiedOutOfPocketAmount
              ) < 0.01
          )
        );
        if (!matchesSomeEob) continue;
      }

      const matchKey = doc.subfolderGroup
        ? `SUBFOLDER:${doc.subfolderGroup}`
        : `${claim.patient}_${claim.qualifiedOutOfPocketAmount.toFixed(2)}`;

      let bundle = bundles.find((b) => b.key === matchKey);
      if (!bundle) {
        bundle = { key: matchKey, claims: [] };
        bundles.push(bundle);
      }
      // Avoid adding duplicate claim numbers from duplicate EOB files
      if (
        !claim.claimNumber ||
        !bundle.claims.some(
          (c) =>
            c.claim.claimNumber === claim.claimNumber &&
            c.doc.docType === doc.docType
        )
      ) {
        bundle.claims.push({ doc, claim });
      }
    }
  }

  // 2. Build a bundle for each matched Installment Plan payment paired with that plan's EOBs
  for (const pmt of installmentPayments) {
    const planEobs = installmentEobs.get(pmt.plan.planId) || [];
    const payDate = pmt.claim.datePaid || pmt.claim.dateOfService;
    if (
      Math.abs(
        pmt.claim.qualifiedOutOfPocketAmount - pmt.plan.monthlyPayment
      ) >= 0.05 &&
      !installmentSchedule.some(
        (s) =>
          s.provider.toUpperCase() === pmt.plan.provider.toUpperCase() &&
          Math.abs(s.paymentAmount - pmt.claim.qualifiedOutOfPocketAmount) < 0.05
      )
    ) {
      continue;
    }
    const matchedSched = installmentSchedule.find(
      (s) =>
        s.provider.toUpperCase() === pmt.plan.provider.toUpperCase() &&
        Math.abs(s.paymentAmount - pmt.claim.qualifiedOutOfPocketAmount) <
          0.05 &&
        Math.abs(
          new Date(s.scheduledDate).getTime() - new Date(payDate).getTime()
        ) <=
          10 * 86400000
    );

    bundles.push({
      key: `INSTALLMENT:${pmt.plan.planId}_${payDate}_${pmt.claim.qualifiedOutOfPocketAmount.toFixed(2)}`,
      plan: pmt.plan,
      matchedScheduleRow: matchedSched,
      claims: [...planEobs, { doc: pmt.doc, claim: pmt.claim }],
    });
  }

  return bundles;
}

export function findExistingExpenseRowIndex(
  existingRows: any[][],
  params: {
    isInstallmentPlan: boolean;
    claimNumber?: string;
    dateOfService: string;
    datePaid: string;
    patient: string;
    provider: string;
    outOfPocketAmount: number;
  }
): number {
  const {
    isInstallmentPlan,
    claimNumber,
    dateOfService,
    datePaid,
    patient,
    provider,
    outOfPocketAmount,
  } = params;

  return existingRows.findIndex((r) => {
    const rDos = (r[1] || "").toString().trim();
    const rPaidDate = (r[2] || "").toString().trim();
    const rPat = (r[3] || "").toString().trim();
    const rAmt = parseFloat((r[8] || "0").toString().replace(/[$,]/g, ""));
    const rNotes = (r[16] || "").toString();

    if (isInstallmentPlan) {
      return (
        rPaidDate === datePaid &&
        Math.abs(rAmt - outOfPocketAmount) < 0.01 &&
        (r[4] || "").toString().toUpperCase() === provider.toUpperCase()
      );
    }
    if (claimNumber && rNotes.includes(claimNumber)) {
      return true;
    }
    return (
      rPat === patient &&
      Math.abs(rAmt - outOfPocketAmount) < 0.01 &&
      (!rDos || rDos === dateOfService)
    );
  });
}
