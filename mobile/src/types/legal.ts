export type DocumentReviewStatus = 'APPROVED' | 'PENDING_REVIEW';

export type LegalDocumentId = 'terms_of_service' | 'privacy_policy';

export interface LegalDocument {
  id: LegalDocumentId;
  title: string;
  version: string;
  status: DocumentReviewStatus;
  effectiveDate: string | null;
  content: string | null; // null if approved copy is not yet compiled into repository
  complianceNotice?: string;
}

export interface LegalDocumentsRegistry {
  termsOfService: LegalDocument;
  privacyPolicy: LegalDocument;
  allApproved: boolean;
}
