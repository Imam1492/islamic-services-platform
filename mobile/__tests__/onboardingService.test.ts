import { OnboardingService } from '../src/services/onboardingService';
import { supabase } from '../src/lib/supabase';
import { CONTROLLED_TOS_VERSION, CONTROLLED_PRIVACY_VERSION } from '../src/constants/legal';
import { LegalDocumentService } from '../src/services/legalDocumentService';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
  },
}));

describe('OnboardingService Unit & Threat Verification Suite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. getStatus()', () => {
    it('calls get_my_onboarding_status RPC with zero parameters', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: { is_onboarded: false, onboarded_at: null },
        error: null,
      });

      const result = await OnboardingService.getStatus();

      expect(supabase.rpc).toHaveBeenCalledWith('get_my_onboarding_status');
      // Verify no second argument was passed
      expect((supabase.rpc as jest.Mock).mock.calls[0].length).toBe(1);
      expect(result.data).toEqual({
        isOnboarded: false,
        onboardedAt: null,
      });
      expect(result.error).toBeNull();
    });

    it('correctly maps onboarded true with valid ISO timestamp', async () => {
      const timestamp = '2026-09-30T18:00:00.000Z';
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: { is_onboarded: true, onboarded_at: timestamp },
        error: null,
      });

      const result = await OnboardingService.getStatus();

      expect(result.data).toEqual({
        isOnboarded: true,
        onboardedAt: timestamp,
      });
      expect(result.error).toBeNull();
    });

    it('maps P0002 to PROFILE_NOT_FOUND error', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { code: 'P0002', message: 'User profile not found' },
      });

      const result = await OnboardingService.getStatus();

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error!.code).toBe('PROFILE_NOT_FOUND');
      expect(result.error!.userMessage).toContain('User profile could not be found');
    });

    it('maps 42501 to AUTH_REQUIRED error', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'Authentication required to retrieve onboarding status' },
      });

      const result = await OnboardingService.getStatus();

      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('AUTH_REQUIRED');
      expect(result.error!.userMessage).toContain('session has expired');
    });

    it('maps network disconnect to NETWORK_ERROR', async () => {
      (supabase.rpc as jest.Mock).mockRejectedValueOnce(new TypeError('Network request failed'));

      const result = await OnboardingService.getStatus();

      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('NETWORK_ERROR');
      expect(result.error!.userMessage).toContain('internet connection');
    });
  });

  describe('2. completeOnboarding()', () => {
    it('blocks submission if legal documents are PENDING_REVIEW without calling RPC', async () => {
      // By default in this repository, legal documents are PENDING_REVIEW
      const result = await OnboardingService.completeOnboarding('Valid User Name');

      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('LEGAL_PENDING_REVIEW');
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('rejects names shorter than 2 characters before invoking network', async () => {
      const result = await OnboardingService.completeOnboarding('A');

      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('VALIDATION_NAME_LENGTH');
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('rejects names with only whitespace before invoking network', async () => {
      const result = await OnboardingService.completeOnboarding('   ');

      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('VALIDATION_NAME_LENGTH');
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('passes trimmed name and controlled version constants when documents are approved', async () => {
      // Spy on LegalDocumentService.getDocuments to simulate approved documents
      const getDocumentsSpy = jest.spyOn(LegalDocumentService, 'getDocuments').mockReturnValueOnce({
        termsOfService: {
          id: 'terms_of_service',
          title: 'Terms of Service',
          version: CONTROLLED_TOS_VERSION,
          status: 'APPROVED',
          effectiveDate: '2026-09-01',
          content: 'Approved Terms Body',
        },
        privacyPolicy: {
          id: 'privacy_policy',
          title: 'Privacy Policy',
          version: CONTROLLED_PRIVACY_VERSION,
          status: 'APPROVED',
          effectiveDate: '2026-09-01',
          content: 'Approved Privacy Body',
        },
        allApproved: true,
      });

      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: {
          status: 'success',
          user_id: 'mock-user-uuid',
          onboarded_at: '2026-09-30T18:00:00Z',
          consent_id: 'mock-consent-uuid',
        },
        error: null,
      });

      const result = await OnboardingService.completeOnboarding('   Fatima Zahra   ');

      expect(supabase.rpc).toHaveBeenCalledWith('complete_user_onboarding', {
        p_full_name: 'Fatima Zahra',
        p_tos_version: CONTROLLED_TOS_VERSION,
        p_privacy_policy_version: CONTROLLED_PRIVACY_VERSION,
      });

      // Verify no user_id or other fields were passed
      expect((supabase.rpc as jest.Mock).mock.calls[0][1].user_id).toBeUndefined();
      expect(result.data).toEqual({
        success: true,
        onboardedAt: '2026-09-30T18:00:00Z',
        consentId: 'mock-consent-uuid',
      });
      expect(result.error).toBeNull();

      getDocumentsSpy.mockRestore();
    });

    it('recovers gracefully from exact 23505 already-onboarded condition as idempotent success', async () => {
      jest.spyOn(LegalDocumentService, 'getDocuments').mockReturnValueOnce({
        termsOfService: {
          id: 'terms_of_service',
          title: 'Terms',
          version: CONTROLLED_TOS_VERSION,
          status: 'APPROVED',
          effectiveDate: null,
          content: 'Terms',
        },
        privacyPolicy: {
          id: 'privacy_policy',
          title: 'Privacy',
          version: CONTROLLED_PRIVACY_VERSION,
          status: 'APPROVED',
          effectiveDate: null,
          content: 'Privacy',
        },
        allApproved: true,
      });

      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: {
          code: '23505',
          message: 'User 11111111-1111-4111-8111-111111111111 has already completed onboarding',
        },
      });

      const result = await OnboardingService.completeOnboarding('Fatima Zahra');

      expect(result.data).toEqual({
        success: true,
        alreadyOnboarded: true,
      });
      expect(result.error).toBeNull();
    });

    it('treats unrelated 23505 collision as DATABASE_CONFLICT error', async () => {
      jest.spyOn(LegalDocumentService, 'getDocuments').mockReturnValueOnce({
        termsOfService: {
          id: 'terms_of_service',
          title: 'Terms',
          version: CONTROLLED_TOS_VERSION,
          status: 'APPROVED',
          effectiveDate: null,
          content: 'Terms',
        },
        privacyPolicy: {
          id: 'privacy_policy',
          title: 'Privacy',
          version: CONTROLLED_PRIVACY_VERSION,
          status: 'APPROVED',
          effectiveDate: null,
          content: 'Privacy',
        },
        allApproved: true,
      });

      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "users_pkey"',
        },
      });

      const result = await OnboardingService.completeOnboarding('Fatima Zahra');

      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('DATABASE_CONFLICT');
      expect(result.error!.userMessage).toContain('database conflict occurred');
    });
  });

  describe('3. PII & Privacy Sanitization', () => {
    it('sanitizes errors and does not expose user identifiers, phone, or raw SQL in user messages', () => {
      const rawError = {
        code: '23505',
        message: 'User 22222222-2222-4222-8222-222222222222 has already completed onboarding with phone +12025550101',
      };

      const classified = OnboardingService.classifyError(rawError);

      expect(classified.userMessage).not.toContain('22222222-2222-4222-8222-222222222222');
      expect(classified.userMessage).not.toContain('+12025550101');
      expect(classified.userMessage).not.toContain('23505');
    });
  });
});
