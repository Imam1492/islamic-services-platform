import { supabase } from '../lib/supabase';
import { CONTROLLED_TOS_VERSION, CONTROLLED_PRIVACY_VERSION } from '../constants/legal';
import { LegalDocumentService } from './legalDocumentService';

export interface OnboardingStatusResult {
  isOnboarded: boolean;
  onboardedAt: string | null;
}

export interface OnboardingCompletionResult {
  success: boolean;
  onboardedAt?: string;
  consentId?: string;
  alreadyOnboarded?: boolean;
}

export type OnboardingErrorCode =
  | 'AUTH_REQUIRED'
  | 'PROFILE_NOT_FOUND'
  | 'ALREADY_ONBOARDED'
  | 'DATABASE_CONFLICT'
  | 'VALIDATION_NAME_LENGTH'
  | 'VALIDATION_VERSION'
  | 'LEGAL_PENDING_REVIEW'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export interface OnboardingServiceError {
  code: OnboardingErrorCode;
  userMessage: string;
  sanitizedDetails?: string;
}

export class OnboardingService {
  /**
   * Fetches authoritative onboarding status via get_my_onboarding_status() RPC.
   * Signature has zero parameters. Derives caller identity strictly from auth.uid().
   */
  static async getStatus(): Promise<
    { data: OnboardingStatusResult; error: null } | { data: null; error: OnboardingServiceError }
  > {
    try {
      const { data, error } = await supabase.rpc('get_my_onboarding_status');

      if (error) {
        return { data: null, error: this.classifyError(error) };
      }

      if (!data || typeof data !== 'object') {
        return {
          data: null,
          error: {
            code: 'UNKNOWN_ERROR',
            userMessage: 'Received invalid onboarding status response from server.',
          },
        };
      }

      const isOnboarded = Boolean((data as any).is_onboarded);
      const onboardedAt = typeof (data as any).onboarded_at === 'string' ? (data as any).onboarded_at : null;

      return {
        data: {
          isOnboarded,
          onboardedAt,
        },
        error: null,
      };
    } catch (err: any) {
      return { data: null, error: this.classifyError(err) };
    }
  }

  /**
   * Completes legitimate user onboarding via complete_user_onboarding() RPC.
   * Enforces:
   * 1. Legal documents must be APPROVED (blocks submission if PENDING_REVIEW).
   * 2. Full name is trimmed and length verified (2..100 characters).
   * 3. Uses strictly controlled application versions.
   * 4. Zero user_id parameter.
   */
  static async completeOnboarding(fullName: string): Promise<
    { data: OnboardingCompletionResult; error: null } | { data: null; error: OnboardingServiceError }
  > {
    const trimmedName = fullName.trim();
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      return {
        data: null,
        error: {
          code: 'VALIDATION_NAME_LENGTH',
          userMessage: 'Full name must be between 2 and 100 characters.',
        },
      };
    }

    // Safety check: Legal documents must not be in PENDING_REVIEW
    const legalRegistry = LegalDocumentService.getDocuments();
    if (!legalRegistry.allApproved) {
      return {
        data: null,
        error: {
          code: 'LEGAL_PENDING_REVIEW',
          userMessage:
            'Legal documents are currently pending compliance review. Onboarding cannot be completed until official documents are approved.',
        },
      };
    }

    try {
      const { data, error } = await supabase.rpc('complete_user_onboarding', {
        p_full_name: trimmedName,
        p_tos_version: CONTROLLED_TOS_VERSION,
        p_privacy_policy_version: CONTROLLED_PRIVACY_VERSION,
      });

      if (error) {
        const classified = this.classifyError(error);
        if (classified.code === 'ALREADY_ONBOARDED') {
          return {
            data: {
              success: true,
              alreadyOnboarded: true,
            },
            error: null,
          };
        }
        return { data: null, error: classified };
      }

      const payload = data as any;
      return {
        data: {
          success: true,
          onboardedAt: payload?.onboarded_at,
          consentId: payload?.consent_id,
        },
        error: null,
      };
    } catch (err: any) {
      const classified = this.classifyError(err);
      if (classified.code === 'ALREADY_ONBOARDED') {
        return {
          data: {
            success: true,
            alreadyOnboarded: true,
          },
          error: null,
        };
      }
      return { data: null, error: classified };
    }
  }

  /**
   * Sanitizes and classifies database/network errors into typed domain errors.
   * Strips all PII and PostgreSQL internal stack traces.
   */
  static classifyError(error: any): OnboardingServiceError {
    if (!error) {
      return {
        code: 'UNKNOWN_ERROR',
        userMessage: 'An unexpected error occurred. Please try again.',
      };
    }

    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? error.message : '';

    // Check for exact already-onboarded condition (Migration 07 line 134)
    if (code === '23505' && message.includes('has already completed onboarding')) {
      return {
        code: 'ALREADY_ONBOARDED',
        userMessage: 'Onboarding has already been completed for this account.',
        sanitizedDetails: 'User onboarding idempotency trigger matched.',
      };
    }

    // Unrelated 23505 unique violation
    if (code === '23505') {
      return {
        code: 'DATABASE_CONFLICT',
        userMessage: 'A database conflict occurred. Please retry your request.',
        sanitizedDetails: 'Unique constraint collision on unhandled relation.',
      };
    }

    // Authentication failure (42501)
    if (code === '42501' || message.includes('Authentication required')) {
      return {
        code: 'AUTH_REQUIRED',
        userMessage: 'Your authentication session has expired or is invalid. Please sign in again.',
        sanitizedDetails: 'PostgreSQL 42501 insufficient privileges.',
      };
    }

    // User profile missing in public.users (P0002)
    if (code === 'P0002' || message.includes('User profile not found')) {
      return {
        code: 'PROFILE_NOT_FOUND',
        userMessage: 'User profile could not be found. Please sign out and sign in again.',
        sanitizedDetails: 'P0002 profile missing in public.users.',
      };
    }

    // Validation errors (22023)
    if (code === '22023') {
      if (message.includes('Full name')) {
        return {
          code: 'VALIDATION_NAME_LENGTH',
          userMessage: 'Full name must be between 2 and 100 characters.',
          sanitizedDetails: '22023 name length boundary.',
        };
      }
      return {
        code: 'VALIDATION_VERSION',
        userMessage: 'Invalid application legal version configuration.',
        sanitizedDetails: '22023 legal version boundary.',
      };
    }

    // Network / connectivity errors
    if (
      message.includes('Network request failed') ||
      message.includes('Failed to fetch') ||
      message.includes('timeout') ||
      error.name === 'FetchError' ||
      error.name === 'TypeError'
    ) {
      return {
        code: 'NETWORK_ERROR',
        userMessage: 'Network connection issue. Please check your internet connection and try again.',
        sanitizedDetails: 'Network communication failure.',
      };
    }

    return {
      code: 'UNKNOWN_ERROR',
      userMessage: 'Unable to process your request. Please try again later.',
      sanitizedDetails: 'Unclassified error condition.',
    };
  }
}
