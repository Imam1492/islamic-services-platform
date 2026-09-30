import { CONTROLLED_TOS_VERSION, CONTROLLED_PRIVACY_VERSION } from '../constants/legal';
import type { LegalDocument, LegalDocumentsRegistry, LegalDocumentId } from '../types/legal';

export class LegalDocumentService {
  private static readonly PENDING_NOTICE =
    'This legal document is currently pending formal compliance and legal review. Official binding prose will be published upon regulatory clearance. In accordance with safety rules, onboarding acceptance cannot be recorded while documents remain in review.';

  /**
   * Retrieves the current legal documents registry.
   * Both documents are strictly marked PENDING_REVIEW because approved production text
   * is not present in the repository.
   */
  static getDocuments(): LegalDocumentsRegistry {
    const termsOfService: LegalDocument = {
      id: 'terms_of_service',
      title: 'Terms of Service',
      version: CONTROLLED_TOS_VERSION,
      status: 'PENDING_REVIEW',
      effectiveDate: null,
      content: null,
      complianceNotice: this.PENDING_NOTICE,
    };

    const privacyPolicy: LegalDocument = {
      id: 'privacy_policy',
      title: 'Privacy Policy',
      version: CONTROLLED_PRIVACY_VERSION,
      status: 'PENDING_REVIEW',
      effectiveDate: null,
      content: null,
      complianceNotice: this.PENDING_NOTICE,
    };

    return {
      termsOfService,
      privacyPolicy,
      allApproved: termsOfService.status === 'APPROVED' && privacyPolicy.status === 'APPROVED',
    };
  }

  static getDocumentById(id: LegalDocumentId): LegalDocument {
    const { termsOfService, privacyPolicy } = this.getDocuments();
    return id === 'terms_of_service' ? termsOfService : privacyPolicy;
  }
}
