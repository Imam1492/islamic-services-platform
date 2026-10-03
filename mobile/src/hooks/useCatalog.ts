import { useState, useEffect, useCallback, useMemo } from 'react';
import { CatalogService } from '../services/catalogService';
import type {
  CatalogData,
  CatalogError,
  CatalogService as ICatalogService,
  CategoryWithServices,
  ResolvedArea,
} from '../types/catalog';

export interface UseCatalogReturn {
  catalog: CatalogData | null;
  areas: ResolvedArea[];
  categoriesWithServices: CategoryWithServices[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: CatalogError | null;
  refresh: () => Promise<void>;
  getAreaById: (areaId: string) => ResolvedArea | null;
  getServiceById: (serviceId: string) => ICatalogService | null;
}

export function useCatalog(isAuthenticated: boolean = true): UseCatalogReturn {
  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(isAuthenticated);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<CatalogError | null>(() => {
    if (!isAuthenticated) {
      return {
        code: 'AUTH_REQUIRED',
        userMessage: 'Authentication required to view available catalog.',
        sanitizedDetails: 'User is not authenticated.',
      };
    }
    return null;
  });

  useEffect(() => {
    let isCancelled = false;

    if (!isAuthenticated) {
      return;
    }

    void (async () => {
      setIsLoading(true);
      const result = await CatalogService.getCatalog({ forceRefresh: false });
      if (!isCancelled) {
        setIsLoading(false);
        if (result.error) {
          setError(result.error);
          setCatalog(null);
        } else {
          setCatalog(result.data);
          setError(null);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [isAuthenticated]);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setError({
        code: 'AUTH_REQUIRED',
        userMessage: 'Authentication required to view available catalog.',
        sanitizedDetails: 'User is not authenticated.',
      });
      return;
    }

    setIsRefreshing(true);
    const result = await CatalogService.getCatalog({ forceRefresh: true });
    setIsRefreshing(false);

    if (result.error) {
      setError(result.error);
    } else {
      setCatalog(result.data);
      setError(null);
    }
  }, [isAuthenticated]);

  const areas = useMemo(() => {
    return catalog?.areas ?? [];
  }, [catalog]);

  const categoriesWithServices = useMemo(() => {
    return catalog?.categoriesWithServices ?? [];
  }, [catalog]);

  const areaMap = useMemo(() => {
    const map = new Map<string, ResolvedArea>();
    if (catalog?.areas) {
      for (const area of catalog.areas) {
        map.set(area.id, area);
      }
    }
    return map;
  }, [catalog]);

  const serviceMap = useMemo(() => {
    const map = new Map<string, ICatalogService>();
    if (catalog?.services) {
      for (const service of catalog.services) {
        map.set(service.id, service);
      }
    }
    return map;
  }, [catalog]);

  const getAreaById = useCallback(
    (areaId: string): ResolvedArea | null => {
      return areaMap.get(areaId) ?? null;
    },
    [areaMap]
  );

  const getServiceById = useCallback(
    (serviceId: string): ICatalogService | null => {
      return serviceMap.get(serviceId) ?? null;
    },
    [serviceMap]
  );

  return {
    catalog,
    areas,
    categoriesWithServices,
    isLoading,
    isRefreshing,
    error,
    refresh,
    getAreaById,
    getServiceById,
  };
}
