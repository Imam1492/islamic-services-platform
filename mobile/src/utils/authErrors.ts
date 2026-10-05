/**
 * Safe error message classification for Google OAuth authentication.
 * Never leaks OAuth tokens, authorization codes, client secrets, internal redirect URLs,
 * database error messages, or Supabase error codes.
 */

export interface SafeOAuthErrorResult {
  message: string | null;
  isCancelled: boolean;
}

export function classifyOAuthError(error: unknown): SafeOAuthErrorResult {
  if (!error) {
    return { message: null, isCancelled: false };
  }

  const errObj = error as { message?: string; status?: number; error_description?: string; code?: string };
  const raw = [errObj?.message, errObj?.error_description, errObj?.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const status = typeof errObj?.status === 'number' ? errObj.status : 0;

  // 1. User cancellation (closed browser sheet / tapped cancel)
  if (
    raw.includes('cancel') ||
    raw.includes('dismiss') ||
    raw.includes('abort') ||
    raw.includes('user_cancelled')
  ) {
    return {
      message: null,
      isCancelled: true,
    };
  }

  // 2. Rate limiting / Too many requests
  if (
    status === 429 ||
    raw.includes('rate limit') ||
    raw.includes('too many') ||
    raw.includes('security purposes')
  ) {
    return {
      message: 'Too many requests. Please wait a moment before trying again.',
      isCancelled: false,
    };
  }

  // 3. Network connection errors
  if (
    raw.includes('network') ||
    raw.includes('fetch') ||
    raw.includes('connection') ||
    raw.includes('failed to fetch') ||
    raw.includes('timeout')
  ) {
    return {
      message: 'Network connection error. Please check your internet connection and try again.',
      isCancelled: false,
    };
  }

  // 4. Default safe provider/auth error
  return {
    message: 'Unable to sign in with Google. Please try again.',
    isCancelled: false,
  };
}

export function getSafeOAuthErrorMessage(error: unknown): string | null {
  return classifyOAuthError(error).message;
}
