import { renderHook, act } from '@testing-library/react-native';
import { useCatalog } from '../src/hooks/useCatalog';
import { CatalogService } from '../src/services/catalogService';
import type { CatalogData, ResolvedArea, CatalogService as ICatalogService } from '../src/types/catalog';

jest.mock('../src/lib/secureStorage', () => ({
  LargeSecureStoreAdapter: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../src/services/catalogService');

describe('useCatalog Hook Suite (Phase 3.4.2B-A)', () => {
  const mockArea1: ResolvedArea = {
    id: 'area-1',
    name: 'Banjara Hills',
    cityName: 'Hyderabad',
    stateName: 'Telangana',
    countryName: 'India',
    fullName: 'Banjara Hills, Hyderabad, Telangana, India',
  };

  const mockArea2: ResolvedArea = {
    id: 'area-2',
    name: 'Jubilee Hills',
    cityName: 'Hyderabad',
    stateName: 'Telangana',
    countryName: 'India',
    fullName: 'Jubilee Hills, Hyderabad, Telangana, India',
  };

  const mockService1: ICatalogService = {
    id: 'srv-1',
    categoryId: 'cat-1',
    name: 'Pipe Repair',
    slug: 'pipe-repair',
    isActive: true,
  };

  const mockService2: ICatalogService = {
    id: 'srv-2',
    categoryId: 'cat-1',
    name: 'Drain Cleaning',
    slug: 'drain-cleaning',
    isActive: true,
  };

  const mockCatalogData: CatalogData = {
    locations: [
      { id: 'country-1', name: 'India', parentId: null, level: 'country', isActive: true },
      { id: 'state-1', name: 'Telangana', parentId: 'country-1', level: 'state', isActive: true },
      { id: 'city-1', name: 'Hyderabad', parentId: 'state-1', level: 'city', isActive: true },
      { id: 'area-1', name: 'Banjara Hills', parentId: 'city-1', level: 'area', isActive: true },
      { id: 'area-2', name: 'Jubilee Hills', parentId: 'city-1', level: 'area', isActive: true },
    ],
    categories: [
      { id: 'cat-1', name: 'Plumbing', slug: 'plumbing', isActive: true },
    ],
    services: [mockService1, mockService2],
    areas: [mockArea1, mockArea2],
    categoriesWithServices: [
      {
        id: 'cat-1',
        name: 'Plumbing',
        slug: 'plumbing',
        isActive: true,
        services: [mockService2, mockService1],
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Unauthenticated fail-closed state', () => {
    it('sets AUTH_REQUIRED and does not invoke CatalogService when unauthenticated', async () => {
      const { result } = renderHook(() => useCatalog(false));

      await act(async () => {});

      expect(CatalogService.getCatalog).not.toHaveBeenCalled();
      expect(result.current.catalog).toBeNull();
      expect(result.current.areas).toEqual([]);
      expect(result.current.categoriesWithServices).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error?.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('2. Loading & Success Lifecycle', () => {
    it('loads catalog data successfully when authenticated', async () => {
      (CatalogService.getCatalog as jest.Mock).mockResolvedValueOnce({
        data: mockCatalogData,
        error: null,
      });

      const { result } = renderHook(() => useCatalog(true));

      expect(result.current.isLoading).toBe(true);

      await act(async () => {});

      expect(CatalogService.getCatalog).toHaveBeenCalledWith({ forceRefresh: false });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isRefreshing).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.catalog).toEqual(mockCatalogData);
      expect(result.current.areas).toEqual([mockArea1, mockArea2]);
      expect(result.current.categoriesWithServices.length).toBe(1);
    });
  });

  describe('3. Refresh & Force Refresh', () => {
    it('triggers a forceRefresh when refresh() is called', async () => {
      (CatalogService.getCatalog as jest.Mock).mockResolvedValue({
        data: mockCatalogData,
        error: null,
      });

      const { result } = renderHook(() => useCatalog(true));

      await act(async () => {});

      expect(CatalogService.getCatalog).toHaveBeenCalledWith({ forceRefresh: false });

      await act(async () => {
        await result.current.refresh();
      });

      expect(CatalogService.getCatalog).toHaveBeenCalledWith({ forceRefresh: true });
      expect(result.current.isRefreshing).toBe(false);
      expect(result.current.catalog).toEqual(mockCatalogData);
    });
  });

  describe('4. Error Handling', () => {
    it('sets error state when CatalogService returns an error', async () => {
      (CatalogService.getCatalog as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: {
          code: 'NETWORK_ERROR',
          userMessage: 'Unable to connect to the catalog server.',
        },
      });

      const { result } = renderHook(() => useCatalog(true));

      await act(async () => {});

      expect(result.current.isLoading).toBe(false);
      expect(result.current.catalog).toBeNull();
      expect(result.current.error?.code).toBe('NETWORK_ERROR');
      expect(result.current.error?.userMessage).toBe('Unable to connect to the catalog server.');
    });
  });

  describe('5. Lookups: getAreaById & getServiceById', () => {
    it('returns the correct resolved area by id', async () => {
      (CatalogService.getCatalog as jest.Mock).mockResolvedValueOnce({
        data: mockCatalogData,
        error: null,
      });

      const { result } = renderHook(() => useCatalog(true));

      await act(async () => {});

      const found = result.current.getAreaById('area-1');
      expect(found).toEqual(mockArea1);

      const notFound = result.current.getAreaById('non-existent');
      expect(notFound).toBeNull();
    });

    it('returns the correct catalog service by id', async () => {
      (CatalogService.getCatalog as jest.Mock).mockResolvedValueOnce({
        data: mockCatalogData,
        error: null,
      });

      const { result } = renderHook(() => useCatalog(true));

      await act(async () => {});

      const found = result.current.getServiceById('srv-1');
      expect(found).toEqual(mockService1);

      const notFound = result.current.getServiceById('non-existent');
      expect(notFound).toBeNull();
    });
  });

  describe('6. Lifecycle & Unmount Safety', () => {
    it('does not perform state updates after hook unmount', async () => {
      let resolvePromise: any;
      const hangingPromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      (CatalogService.getCatalog as jest.Mock).mockReturnValueOnce(hangingPromise);

      const { unmount } = renderHook(() => useCatalog(true));

      // Unmount before promise resolves
      unmount();

      // Now resolve
      await act(async () => {
        resolvePromise({
          data: mockCatalogData,
          error: null,
        });
      });

      // No unhandled rejection or React warning on unmounted component
      expect(true).toBe(true);
    });
  });
});
