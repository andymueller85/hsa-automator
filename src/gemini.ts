import fs from "fs/promises";
import path from "path";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import {
  HOUSEHOLD_MEMBERS,
  HOUSEHOLD_PROMPT_NAMES,
  PAYMENT_METHODS,
} from "./config.js";
import { hashFile, saveCache } from "./cache.js";
import type { InstallmentPlan, ParsedFileMetadata } from "./types.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const extractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    docType: {
      type: Type.STRING,
      enum: [
        "EOB",
        "BILL_OR_INVOICE",
        "PAYMENT_RECEIPT",
        "CC_STATEMENT",
        "TRANSACTION_CSV",
      ],
    },
    isMultiClaimOrStatement: {
      type: Type.BOOLEAN,
      description:
        "True if this is a monthly EOB with multiple claims, a credit card statement, or a multi-row CSV.",
    },
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claimNumber: { type: Type.STRING },
          dateOfService: { type: Type.STRING, description: "YYYY-MM-DD" },
          datePaid: { type: Type.STRING, description: "YYYY-MM-DD if shown" },
          patient: { type: Type.STRING, enum: HOUSEHOLD_MEMBERS },
          provider: {
            type: Type.STRING,
            description:
              "Clean provider name. If matching an active installment plan, use the exact installment plan provider name.",
          },
          installmentPlanId: {
            type: Type.STRING,
            description:
              "If this EOB or payment belongs to one of the active installment plans provided in the prompt, set to its Plan ID (e.g. PLAN-001).",
          },
          category: {
            type: Type.STRING,
            enum: ["Medical", "Dental", "Vision", "Prescription"],
          },
          description: { type: Type.STRING },
          billedOrEobAmount: { type: Type.NUMBER },
          qualifiedOutOfPocketAmount: {
            type: Type.NUMBER,
            description:
              "Patient responsibility or installment payment amount minus non-qualified items like warranties/protection plans.",
          },
          nonQualifiedExcludedAmount: { type: Type.NUMBER },
          paymentMethod: {
            type: Type.STRING,
            enum: PAYMENT_METHODS,
          },
          headerPageIndex: {
            type: Type.INTEGER,
            description:
              "0-based page index containing document header/patient/account info (usually 0).",
          },
          relevantPageIndices: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            description:
              "0-based page indices containing this specific claim or transaction line.",
          },
          provesMedicalNecessity: {
            type: Type.BOOLEAN,
            description:
              "True if the document includes an EOB, itemized medical invoice, or pharmacy Rx label/slip showing patient, date, and drug/service.",
          },
          provesPayment: {
            type: Type.BOOLEAN,
            description:
              "True if the document includes a register receipt, paid confirmation, zero-balance invoice, credit card charge, or CSV payment row.",
          },
          notes: {
            type: Type.STRING,
            description:
              "Concise IRS audit memo listing Rx/Claim/Account/Order numbers, drug or clinical details, payment card last 4 digits/auth codes, and any excluded non-qualified amounts.",
          },
        },
        required: [
          "dateOfService",
          "patient",
          "provider",
          "category",
          "description",
          "billedOrEobAmount",
          "qualifiedOutOfPocketAmount",
          "nonQualifiedExcludedAmount",
          "headerPageIndex",
          "relevantPageIndices",
          "provesMedicalNecessity",
          "provesPayment",
          "notes",
        ],
      },
    },
  },
  required: ["docType", "isMultiClaimOrStatement", "claims"],
};

export async function parseDocumentWithGemini(
  filePath: string,
  subfolderGroup: string | undefined,
  cache: Record<string, ParsedFileMetadata>,
  installmentPlans: InstallmentPlan[]
): Promise<ParsedFileMetadata> {
  const hash = await hashFile(filePath);
  const planFingerprint = installmentPlans.map((p) => p.planId).join(",");
  if (
    cache[hash] &&
    cache[hash].planFingerprint === planFingerprint &&
    cache[hash].claims?.every(
      (c) =>
        typeof c.provesMedicalNecessity === "boolean" &&
        Boolean(c.notes) &&
        (!c.paymentMethod || PAYMENT_METHODS.includes(c.paymentMethod))
    )
  ) {
    return {
      ...cache[hash],
      filePath,
      fileName: path.basename(filePath),
      subfolderGroup,
    };
  }

  const ext = path.extname(filePath).toLowerCase();
  const fileBytes = await fs.readFile(filePath);

  const planContext =
    installmentPlans.length > 0
      ? `\n      Active Installment Plans:\n` +
        installmentPlans
          .map(
            (p) =>
              `      - ${p.planId}: Provider="${p.provider}"${
                p.affiliatedProviders
                  ? ` (Affiliated EOB/Billing Providers: ${p.affiliatedProviders})`
                  : ""
              }, Patient="${p.patient}", TotalResponsibility=$${p.totalResponsibility}, MonthlyPayment=$${p.monthlyPayment}`
          )
          .join("\n") +
        `\n      If an EOB claim or a payment transaction belongs to one of these installment plans (including any listed affiliated providers/doctors or monthly payment amounts), set 'installmentPlanId' to that Plan ID and set 'provider' to the exact Plan Provider name.`
      : "";

  const promptText = `Extract all medical claims, bills, pharmacy slips, or medical payment charges from this document for household members ${HOUSEHOLD_PROMPT_NAMES}.${planContext}
      - Subtract non-qualified items (like eyewear protection plans or warranties) from qualifiedOutOfPocketAmount.
      - Exclude denied out-of-network claims where the plan did not cover the service due to missing preapproval/referral (e.g., reason code 707) or revised/duplicate $0.00 claims.
      - For CSV transaction histories or Credit Card Statements, only extract bona fide medical/dental/vision/pharmacy payments or active installment plan payments (ignore payroll contributions, interest, investment transfers, and non-medical retail charges).
      - Set provesMedicalNecessity to true if the document shows clinical service descriptions, CPT/HCPCS codes, EOB claim details, or a pharmacy Rx slip with drug/patient details.
      - Set provesPayment to true if the document shows a payment tender, register receipt, paid-in-full balance, credit card charge, or CSV payment transaction.
      - Always populate 'notes' with a concise audit memo (e.g., "Rx #123456 (Drug Name); Paid via Visa *1234, Auth #98765" or "Claim #2026...; Patient responsibility $150.00").`;

  const contentPart =
    ext === ".csv"
      ? {
          text: `CSV Filename: ${path.basename(filePath)}\n\n${fileBytes.toString("utf8")}`,
        }
      : {
          inlineData: {
            mimeType:
              ext === ".pdf"
                ? "application/pdf"
                : ext === ".png"
                ? "image/png"
                : "image/jpeg",
            data: fileBytes.toString("base64"),
          },
        };

  console.log(`Analyzing with Gemini: ${path.basename(filePath)}...`);
  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: [contentPart, promptText],
    config: {
      responseMimeType: "application/json",
      responseSchema: extractionSchema,
    },
  });

  const parsed = JSON.parse(response.text!);
  const meta: ParsedFileMetadata = {
    filePath,
    fileName: path.basename(filePath),
    hash,
    planFingerprint,
    subfolderGroup,
    ...parsed,
  };

  cache[hash] = meta;
  await saveCache(cache);
  return meta;
}
