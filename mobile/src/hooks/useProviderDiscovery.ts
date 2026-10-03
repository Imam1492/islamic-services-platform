import { useState, useCallback, useRef, useEffect } from 'react';
import { DiscoveryService } from '../services/discoveryService';
import type {
  DiscoveryFilters,
  DiscoveryCursor,
  DiscoveryItem,
  DiscoveryServiceError,
} from '../types/discovery';

export interface UseProviderDiscoveryReturn {
  providers: DiscoveryItem[];
  hasMore: boolean;
  nextCursor: DiscoveryCursor | null;
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  error: DiscoveryServiceError | null;
  isEmpty: boolean;
  setFilters: (filters: DiscoveryFilters | null) => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

export function useProviderDiscovery(
  initialFilters: DiscoveryFilters | null = null,
  isAuthenticated: boolean = true
): UseProviderDiscoveryReturn {
  const hasInitialQuery = Boolean(
    isAuthenticated && initialFilters?.areaId && initialFilters?.serviceId
  );
  const [filters, setFiltersState] = useState<DiscoveryFilters | null>(initialFilters);
  const [providers, setProviders] = useState<DiscoveryItem[]>([]);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<DiscoveryCursor | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(hasInitialQuery);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<DiscoveryServiceError | null>(
    !isAuthenticated
      ? {
          code: 'AUTH_REQUIRED',
          userMessage: 'Authentication required. Please sign in to discover providers.',
          sanitizedDetails: 'Session missing in useProviderDiscovery.',
        }
      : null
  );

  // Monotonic token to detect stale responses across filter changes and resets
  const queryTokenRef = useRef<number>(0);

  // Ref tracking current filter and cursor state for safe access inside callbacks
  const activeFiltersRef = useRef<DiscoveryFilters | null>(filters);
  const nextCursorRef = useRef<DiscoveryCursor | null>(nextCursor);
  const hasMoreRef = useRef<boolean>(hasMore);
  const isAuthRef = useRef<boolean>(isAuthenticated);

  // Synchronize refs outside of render
  useEffect(() => {
    activeFiltersRef.current = filters;
    nextCursorRef.current = nextCursor;
    hasMoreRef.current = hasMore;
    isAuthRef.current = isAuthenticated;
  }, [filters, nextCursor, hasMore, isAuthenticated]);

  // In-flight loadMore ref for request deduplication
  const inFlightLoadMoreRef = useRef<boolean>(false);

  /**
   * Core query executor for page 1 (initial or refresh)
   */
  const executeFirstPage = useCallback(
    async (targetFilters: DiscoveryFilters | null, isRefresh: boolean) => {
      // Fail closed if unauthenticated
      if (!isAuthRef.current) {
        setProviders([]);
        setHasMore(false);
        setNextCursor(null);
        setIsLoading(false);
        setIsRefreshing(false);
        setError({
          code: 'AUTH_REQUIRED',
          userMessage: 'Authentication required. Please sign in to discover providers.',
          sanitizedDetails: 'Session missing in useProviderDiscovery.',
        });
        return;
      }

      if (!targetFilters || !targetFilters.areaId || !targetFilters.serviceId) {
        setProviders([]);
        setHasMore(false);
        setNextCursor(null);
        setIsLoading(false);
        setIsRefreshing(false);
        setError(null);
        return;
      }

      const token = ++queryTokenRef.current;

      if (isRefresh) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      const result = await DiscoveryService.discoverProviders(targetFilters, null);

      // Guard against stale response
      if (queryTokenRef.current !== token) {
        return;
      }

      if (isRefresh) {
        setIsRefreshing(false);
      } else {
        setIsLoading(false);
      }

      if (result.error) {
        setError(result.error);
        setProviders([]);
        setHasMore(false);
        setNextCursor(null);
      } else {
        setProviders(result.data.providers);
        setHasMore(result.data.has_more);
        setNextCursor(result.data.next_cursor);
        setError(null);
      }
    },
    []
  );

  /**
   * Updates filters and resets pagination
   */
  const setFilters = useCallback(
    (newFilters: DiscoveryFilters | null) => {
      queryTokenRef.current++;
      setFiltersState(newFilters);
      setProviders([]);
      setHasMore(false);
      setNextCursor(null);
      setError(null);

      if (newFilters && newFilters.areaId && newFilters.serviceId) {
        executeFirstPage(newFilters, false);
      } else {
        setIsLoading(false);
      }
    },
    [executeFirstPage]
  );

  /**
   * Refreshes the first page with current filters
   */
  const refresh = useCallback(async () => {
    await executeFirstPage(activeFiltersRef.current, true);
  }, [executeFirstPage]);

  /**
   * Loads the next page using keyset next_cursor
   */
  const loadMore = useCallback(async () => {
    // Fail closed if unauthenticated
    if (!isAuthRef.current) {
      return;
    }

    const currentFilters = activeFiltersRef.current;
    if (!currentFilters || !currentFilters.areaId || !currentFilters.serviceId) {
      return;
    }

    if (!hasMoreRef.current || !nextCursorRef.current) {
      return;
    }

    // Deduplicate: prevent concurrent loadMore calls
    if (inFlightLoadMoreRef.current) {
      return;
    }

    inFlightLoadMoreRef.current = true;
    setIsLoadingMore(true);

    const token = queryTokenRef.current;
    const cursor = nextCursorRef.current;

    try {
      const result = await DiscoveryService.discoverProviders(currentFilters, cursor);

      // Guard against stale response: if filters changed or reset while in-flight, discard
      if (queryTokenRef.current !== token) {
        return;
      }

      if (result.error) {
        setError(result.error);
      } else {
        setProviders((prev) => {
          const existingIds = new Set(prev.map((p) => p.provider_id));
          const newUnique = result.data.providers.filter((p) => !existingIds.has(p.provider_id));
          return [...prev, ...newUnique];
        });
        setHasMore(result.data.has_more);
        setNextCursor(result.data.next_cursor);
        setError(null);
      }
    } finally {
      if (queryTokenRef.current === token) {
        setIsLoadingMore(false);
      }
      inFlightLoadMoreRef.current = false;
    }
  }, []);

  /**
   * Resets all search state
   */
  const reset = useCallback(() => {
    queryTokenRef.current++;
    setFiltersState(null);
    setProviders([]);
    setHasMore(false);
    setNextCursor(null);
    setIsLoading(false);
    setIsRefreshing(false);
    setIsLoadingMore(false);
    setError(null);
  }, []);

  // Initial load if initialFilters were provided on mount
  useEffect(() => {
    let isCancelled = false;
    if (hasInitialQuery && initialFilters) {
      const token = ++queryTokenRef.current;
      void (async () => {
        const result = await DiscoveryService.discoverProviders(initialFilters, null);
        if (!isCancelled && queryTokenRef.current === token) {
          setIsLoading(false);
          if (result.error) {
            setError(result.error);
            setProviders([]);
            setHasMore(false);
            setNextCursor(null);
          } else {
            setProviders(result.data.providers);
            setHasMore(result.data.has_more);
            setNextCursor(result.data.next_cursor);
            setError(null);
          }
        }
      })();
    }
    return () => {
      isCancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isEmpty = !isLoading && !isRefreshing && providers.length === 0 && Boolean(filters?.areaId && filters?.serviceId);

  return {
    providers,
    hasMore,
    nextCursor,
    isLoading,
    isRefreshing,
    isLoadingMore,
    error,
    isEmpty,
    setFilters,
    refresh,
    loadMore,
    reset,
  };
}
