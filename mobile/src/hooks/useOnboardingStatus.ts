import { useState, useEffect, useCallback, useRef } from 'react';
import { OnboardingService, type OnboardingServiceError } from '../services/onboardingService';

export type OnboardingStep = 'CHECKING' | 'NOT_ONBOARDED' | 'ONBOARDED' | 'ERROR';

export interface UseOnboardingStatusReturn {
  step: OnboardingStep;
  onboardedAt: string | null;
  error: OnboardingServiceError | null;
  isSubmitting: boolean;
  refreshStatus: () => Promise<void>;
  submitOnboarding: (fullName: string) => Promise<{ success: boolean; error: OnboardingServiceError | null }>;
}

export function useOnboardingStatus(userId: string | undefined): UseOnboardingStatusReturn {
  const [prevUserId, setPrevUserId] = useState<string | undefined>(userId);
  const [step, setStep] = useState<OnboardingStep>('CHECKING');
  const [onboardedAt, setOnboardedAt] = useState<string | null>(null);
  const [error, setError] = useState<OnboardingServiceError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Adjust state during render when userId prop changes (official React pattern)
  if (prevUserId !== userId) {
    setPrevUserId(userId);
    setStep('CHECKING');
    setOnboardedAt(null);
    setError(null);
  }

  // Active in-flight promise ref with associated userId for per-user request deduplication
  const inFlightPromiseRef = useRef<{ promise: Promise<void>; userId: string } | null>(null);

  // Current active userId ref to detect race conditions/stale responses across asynchronous queries
  const activeUserIdRef = useRef<string | undefined>(userId);

  useEffect(() => {
    activeUserIdRef.current = userId;
  }, [userId]);

  const refreshStatus = useCallback(async () => {
    if (!userId) {
      return;
    }

    const requestedForUserId = userId;

    // Return existing in-flight request if one is already running for this exact user
    if (inFlightPromiseRef.current && inFlightPromiseRef.current.userId === requestedForUserId) {
      return inFlightPromiseRef.current.promise;
    }

    const queryPromise = (async () => {
      setStep('CHECKING');
      setError(null);

      const result = await OnboardingService.getStatus();

      // Guard against race condition: if user changed or signed out while request was in-flight, discard
      if (activeUserIdRef.current !== requestedForUserId) {
        return;
      }

      if (result.error) {
        setError(result.error);
        setStep('ERROR');
        return;
      }

      if (result.data.isOnboarded) {
        setOnboardedAt(result.data.onboardedAt);
        setStep('ONBOARDED');
      } else {
        setOnboardedAt(null);
        setStep('NOT_ONBOARDED');
      }
    })();

    inFlightPromiseRef.current = { promise: queryPromise, userId: requestedForUserId };
    try {
      await queryPromise;
    } finally {
      if (inFlightPromiseRef.current?.userId === requestedForUserId) {
        inFlightPromiseRef.current = null;
      }
    }
  }, [userId]);

  // Synchronize query execution on userId change
  useEffect(() => {
    if (!userId) {
      return;
    }

    refreshStatus();
  }, [userId, refreshStatus]);

  const submitOnboarding = useCallback(
    async (fullName: string): Promise<{ success: boolean; error: OnboardingServiceError | null }> => {
      // Prevent duplicate concurrent submissions
      if (isSubmitting) {
        return {
          success: false,
          error: {
            code: 'UNKNOWN_ERROR',
            userMessage: 'A submission is already in progress.',
          },
        };
      }

      setIsSubmitting(true);
      setError(null);

      try {
        const result = await OnboardingService.completeOnboarding(fullName);

        if (result.error) {
          setError(result.error);
          return { success: false, error: result.error };
        }

        // On success or idempotent recovery: transition immediately to ONBOARDED
        setOnboardedAt(result.data.onboardedAt || new Date().toISOString());
        setStep('ONBOARDED');
        return { success: true, error: null };
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting]
  );

  return {
    step,
    onboardedAt,
    error,
    isSubmitting,
    refreshStatus,
    submitOnboarding,
  };
}
