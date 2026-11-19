export type ClaimCategory = "Medical" | "Dental" | "Vision" | "Prescription";

export type DocType =
  | "EOB"
  | "BILL_OR_INVOICE"
  | "PAYMENT_RECEIPT"
  | "CC_STATEMENT"
  | "TRANSACTION_CSV";

export interface ExtractedClaim {
  claimNumber?: string;
  dateOfService: string; // YYYY-MM-DD
  datePaid?: string; // YYYY-MM-DD
  patient: string;
  provider: string;
  installmentPlanId?: string; // Populated by Gemini when claim/payment matches an active installment plan
  category: ClaimCategory;
  description: string;
  billedOrEobAmount: number;
  qualifiedOutOfPocketAmount: number;
  nonQualifiedExcludedAmount: number;
  paymentMethod?: string;
  headerPageIndex: number; // 0-based page index
  relevantPageIndices: number[]; // 0-based page indices for this specific claim/charge
  provesMedicalNecessity: boolean; // True if EOB, itemized medical invoice, or Rx label/slip is shown
  provesPayment: boolean; // True if paid receipt, zero-balance invoice, or card charge is shown
  notes?: string;
}

export interface ParsedFileMetadata {
  filePath: string;
  fileName: string;
  hash: string;
  planFingerprint?: string;
  subfolderGroup?: string;
  docType: DocType;
  isMultiClaimOrStatement: boolean;
  claims: ExtractedClaim[];
}

export interface InstallmentPlan {
  rowIndex: number;
  planId: string;
  provider: string;
  patient: string;
  totalResponsibility: number;
  remainingBalance: number;
  monthlyPayment: number;
  affiliatedProviders?: string;
}

export interface InstallmentScheduleRow {
  rowIndex: number;
  paymentId: string;
  scheduledDate: string;
  provider: string;
  paymentAmount: number;
  status: string;
  notes: string;
}

export interface ClaimBundleItem {
  doc: ParsedFileMetadata;
  claim: ExtractedClaim;
}

export interface ClaimBundle {
  key: string;
  plan?: InstallmentPlan;
  matchedScheduleRow?: InstallmentScheduleRow;
  claims: ClaimBundleItem[];
}

export interface PdfSliceSource {
  fileName?: string;
  filePath: string;
  pagesToInclude: number[];
}
