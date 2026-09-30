import { renderHook, act } from '@testing-library/react-native';
import { useOnboardingStatus } from '../src/hooks/useOnboardingStatus';
import { OnboardingService } from '../src/services/onboardingService';

jest.mock('../src/services/onboardingService');

describe('useOnboardingStatus Hook Lifecycle & Concurrency Suite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initializes in CHECKING step and resolves to NOT_ONBOARDED when isOnboarded is false', async () => {
    (OnboardingService.getStatus as jest.Mock).mockResolvedValueOnce({
      data: { isOnboarded: false, onboardedAt: null },
      error: null,
    });

    const { result } = renderHook(() => useOnboardingStatus('user-fresh-1'));

    expect(result.current.step).toBe('CHECKING');
    expect(result.current.onboardedAt).toBeNull();

    await act(async () => {});

    expect(result.current.step).toBe('NOT_ONBOARDED');
    expect(result.current.onboardedAt).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('resolves to ONBOARDED when isOnboarded is true with timestamp', async () => {
    const timestamp = '2026-09-30T12:00:00Z';
    (OnboardingService.getStatus as jest.Mock).mockResolvedValueOnce({
      data: { isOnboarded: true, onboardedAt: timestamp },
      error: null,
    });

    const { result } = renderHook(() => useOnboardingStatus('user-onboarded-2'));

    await act(async () => {});

    expect(result.current.step).toBe('ONBOARDED');
    expect(result.current.onboardedAt).toBe(timestamp);
    expect(result.current.error).toBeNull();
  });

  it('resolves to ERROR when OnboardingService returns an error', async () => {
    (OnboardingService.getStatus as jest.Mock).mockResolvedValueOnce({
      data: null,
      error: {
        code: 'PROFILE_NOT_FOUND',
        userMessage: 'User profile not found.',
      },
    });

    const { result } = renderHook(() => useOnboardingStatus('user-orphan-3'));

    await act(async () => {});

    expect(result.current.step).toBe('ERROR');
    expect(result.current.error?.code).toBe('PROFILE_NOT_FOUND');
    expect(result.current.onboardedAt).toBeNull();
  });

  it('deduplicates rapid concurrent calls to refreshStatus', async () => {
    let resolveFirstPromise: (val: any) => void;
    const slowPromise = new Promise((resolve) => {
      resolveFirstPromise = resolve;
    });

    (OnboardingService.getStatus as jest.Mock).mockImplementation(() => slowPromise);

    const { result } = renderHook(() => useOnboardingStatus('user-dedup-4'));

    // Trigger refreshStatus multiple times concurrently
    act(() => {
      result.current.refreshStatus();
      result.current.refreshStatus();
      result.current.refreshStatus();
    });

    // Resolve the promise
    await act(async () => {
      resolveFirstPromise!({
        data: { isOnboarded: false, onboardedAt: null },
        error: null,
      });
    });

    // Only 1 call was initiated during hook mount + deduped refreshes
    expect(OnboardingService.getStatus).toHaveBeenCalledTimes(1);
    expect(result.current.step).toBe('NOT_ONBOARDED');
  });

  it('mitigates race condition: stale response from user-A cannot overwrite user-B state', async () => {
    let resolveUserA: (val: any) => void;
    const userAPromise = new Promise((res) => {
      resolveUserA = res;
    });

    (OnboardingService.getStatus as jest.Mock).mockImplementationOnce(() => userAPromise);

    const { result, rerender } = renderHook(
      (props: { uid: string | undefined }) => useOnboardingStatus(props.uid),
      {
        initialProps: { uid: 'user-A' as string | undefined },
      }
    );

    // Switch to user-B while user-A's request is still unresolved in flight
    (OnboardingService.getStatus as jest.Mock).mockResolvedValueOnce({
      data: { isOnboarded: true, onboardedAt: '2026-09-30T19:00:00Z' },
      error: null,
    });

    rerender({ uid: 'user-B' });

    // Allow user-B's request to complete
    await act(async () => {});
    expect(result.current.step).toBe('ONBOARDED');
    expect(result.current.onboardedAt).toBe('2026-09-30T19:00:00Z');

    // Now resolve user-A's slow request (which returned false)
    await act(async () => {
      resolveUserA!({
        data: { isOnboarded: false, onboardedAt: null },
        error: null,
      });
    });

    // User-B's state must NOT be overwritten by user-A's stale response
    expect(result.current.step).toBe('ONBOARDED');
    expect(result.current.onboardedAt).toBe('2026-09-30T19:00:00Z');
  });

  it('resets state safely when userId becomes undefined (sign out)', async () => {
    (OnboardingService.getStatus as jest.Mock).mockResolvedValueOnce({
      data: { isOnboarded: true, onboardedAt: '2026-09-30T12:00:00Z' },
      error: null,
    });

    const { result, rerender } = renderHook(
      (props: { uid: string | undefined }) => useOnboardingStatus(props.uid),
      {
        initialProps: { uid: 'user-logged-in' as string | undefined },
      }
    );

    await act(async () => {});
    expect(result.current.step).toBe('ONBOARDED');

    // Sign out
    rerender({ uid: undefined });

    expect(result.current.step).toBe('CHECKING');
    expect(result.current.onboardedAt).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('blocks duplicate concurrent submissions during submitOnboarding', async () => {
    (OnboardingService.getStatus as jest.Mock).mockResolvedValueOnce({
      data: { isOnboarded: false, onboardedAt: null },
      error: null,
    });

    let resolveSubmission: (val: any) => void;
    const submissionPromise = new Promise((res) => {
      resolveSubmission = res;
    });

    (OnboardingService.completeOnboarding as jest.Mock).mockImplementationOnce(
      () => submissionPromise
    );

    const { result } = renderHook(() => useOnboardingStatus('user-submit-5'));
    await act(async () => {});

    let firstSubmitPromise: Promise<any>;
    act(() => {
      firstSubmitPromise = result.current.submitOnboarding('Valid Name');
    });

    expect(result.current.isSubmitting).toBe(true);

    // Attempt second submission concurrently
    let secondResult: any;
    await act(async () => {
      secondResult = await result.current.submitOnboarding('Another Name');
    });

    expect(secondResult.success).toBe(false);
    expect(secondResult.error.userMessage).toContain('already in progress');
    expect(OnboardingService.completeOnboarding).toHaveBeenCalledTimes(1);

    // Resolve first submission
    await act(async () => {
      resolveSubmission!({
        data: { success: true, onboardedAt: '2026-09-30T20:00:00Z' },
        error: null,
      });
      await firstSubmitPromise!;
    });

    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.step).toBe('ONBOARDED');
  });
});
