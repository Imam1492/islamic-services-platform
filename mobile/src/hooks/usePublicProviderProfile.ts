import { useState, useCallback, useRef, useEffect } from 'react';
import { DiscoveryService } from '../services/discoveryService';
import type { PublicProviderProfile, DiscoveryServiceError } from '../types/discovery';

export interface UsePublicProviderProfileReturn {
  profile: PublicProviderProfile | null;
  isLoading: boolean;
  error: DiscoveryServiceError | null;
  fetchProfile: (targetId?: string) => Promise<void>;
  reset: () => void;
}

export function usePublicProviderProfile(
  initialProviderId?: string,
  isAuthenticated: boolean = true
): UsePublicProviderProfileReturn {
  const hasInitialQuery = Boolean(initialProviderId && isAuthenticated);
  const [profile, setProfile] = useState<PublicProviderProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(hasInitialQuery);
  const [error, setError] = useState<DiscoveryServiceError | null>(
    !isAuthenticated
      ? {
          code: 'AUTH_REQUIRED',
          userMessage: 'Authentication required. Please sign in to view provider details.',
          sanitizedDetails: 'Session missing in usePublicProviderProfile.',
        }
      : null
  );

  const requestIdRef = useRef<number>(0);
  const isAuthRef = useRef<boolean>(isAuthenticated);
  const activeIdRef = useRef<string | undefined>(initialProviderId);

  useEffect(() => {
    isAuthRef.current = isAuthenticated;
    activeIdRef.current = initialProviderId;
  }, [isAuthenticated, initialProviderId]);

  const fetchProfile = useCallback(async (targetId?: string) => {
    const idToFetch = targetId || activeIdRef.current;

    // Fail closed if unauthenticated
    if (!isAuthRef.current) {
      setProfile(null);
      setIsLoading(false);
      setError({
        code: 'AUTH_REQUIRED',
        userMessage: 'Authentication required. Please sign in to view provider details.',
        sanitizedDetails: 'Session missing in usePublicProviderProfile.',
      });
      return;
    }

    if (!idToFetch) {
      setProfile(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const token = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    const result = await DiscoveryService.getPublicProviderProfile(idToFetch);

    // Guard against stale response
    if (requestIdRef.current !== token) {
      return;
    }

    setIsLoading(false);

    if (result.error) {
      setError(result.error);
      setProfile(null);
    } else {
      setProfile(result.data);
      setError(null);
    }
  }, []);

  const reset = useCallback(() => {
    requestIdRef.current++;
    setProfile(null);
    setIsLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    let isCancelled = false;
    if (hasInitialQuery && initialProviderId) {
      const token = ++requestIdRef.current;
      void (async () => {
        const result = await DiscoveryService.getPublicProviderProfile(initialProviderId);
        if (!isCancelled && requestIdRef.current === token) {
          setIsLoading(false);
          if (result.error) {
            setError(result.error);
            setProfile(null);
          } else {
            setProfile(result.data);
            setError(null);
          }
        }
      })();
    }
    return () => {
      isCancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProviderId]);

  return {
    profile,
    isLoading,
    error,
    fetchProfile,
    reset,
  };
}
