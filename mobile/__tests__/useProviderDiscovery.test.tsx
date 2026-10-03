import { renderHook, act } from '@testing-library/react-native';
import { useProviderDiscovery } from '../src/hooks/useProviderDiscovery';
import { usePublicProviderProfile } from '../src/hooks/usePublicProviderProfile';
import { DiscoveryService } from '../src/services/discoveryService';
import type {
  DiscoveryFilters,
  DiscoveryItem,
  PublicProviderProfile,
} from '../src/types/discovery';

jest.mock('../src/services/discoveryService');

describe('useProviderDiscovery & usePublicProviderProfile Hook Concurrency Suite', () => {
  const validAreaId = '11111111-1111-4111-8111-111111111111';
  const validServiceId = '22222222-2222-4222-8222-222222222222';
  const validProviderId1 = '33333333-3333-4333-8333-333333333331';
  const validProviderId2 = '33333333-3333-4333-8333-333333333332';
  const validProviderId3 = '33333333-3333-4333-8333-333333333333';

  const defaultFilters: DiscoveryFilters = {
    areaId: validAreaId,
    serviceId: validServiceId,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('useProviderDiscovery', () => {
    it('initializes with empty providers and not loading when no filters provided', () => {
      const { result } = renderHook(() => useProviderDiscovery(null, true));

      expect(result.current.providers).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.hasMore).toBe(false);
      expect(result.current.nextCursor).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('fails closed when unauthenticated', async () => {
      const { result } = renderHook(() => useProviderDiscovery(defaultFilters, false));

      await act(async () => {});

      expect(DiscoveryService.discoverProviders).not.toHaveBeenCalled();
      expect(result.current.providers).toEqual([]);
      expect(result.current.error?.code).toBe('AUTH_REQUIRED');
    });

    it('loads first page when valid initial filters are provided', async () => {
      const page1Providers: DiscoveryItem[] = [
        {
          provider_id: validProviderId1,
          display_name: 'Adam Tariq',
          gender: 'male',
          bio: 'General technician',
          years_experience: 4,
          badges: ['identity_verified'],
        },
      ];

      (DiscoveryService.discoverProviders as jest.Mock).mockResolvedValueOnce({
        data: {
          providers: page1Providers,
          has_more: true,
          next_cursor: {
            display_name: 'Adam Tariq',
            provider_id: validProviderId1,
          },
        },
        error: null,
      });

      const { result } = renderHook(() => useProviderDiscovery(defaultFilters, true));

      expect(result.current.isLoading).toBe(true);

      await act(async () => {});

      expect(result.current.isLoading).toBe(false);
      expect(result.current.providers.length).toBe(1);
      expect(result.current.hasMore).toBe(true);
      expect(result.current.nextCursor).toEqual({
        display_name: 'Adam Tariq',
        provider_id: validProviderId1,
      });
      expect(result.current.isEmpty).toBe(false);
    });

    it('DISCOVERY-08: has_more=false prevents further pagination', async () => {
      (DiscoveryService.discoverProviders as jest.Mock).mockResolvedValueOnce({
        data: {
          providers: [
            {
              provider_id: validProviderId1,
              display_name: 'Solo Provider',
              gender: 'male',
              bio: null,
              years_experience: 1,
              badges: [],
            },
          ],
          has_more: false,
          next_cursor: null,
        },
        error: null,
      });

      const { result } = renderHook(() => useProviderDiscovery(defaultFilters, true));

      await act(async () => {});

      expect(result.current.hasMore).toBe(false);
      expect(result.current.nextCursor).toBeNull();

      // Attempt to load more
      await act(async () => {
        await result.current.loadMore();
      });

      // discoverProviders should have only been called once (initial page)
      expect(DiscoveryService.discoverProviders).toHaveBeenCalledTimes(1);
    });

    it('DISCOVERY-09: Concurrent load-more calls do not duplicate requests', async () => {
      let resolveSecondPage: (value: any) => void;
      const secondPagePromise = new Promise((resolve) => {
        resolveSecondPage = resolve;
      });

      (DiscoveryService.discoverProviders as jest.Mock)
        .mockResolvedValueOnce({
          data: {
            providers: [
              {
                provider_id: validProviderId1,
                display_name: 'Provider One',
                gender: 'male',
                bio: null,
                years_experience: 2,
                badges: [],
              },
            ],
            has_more: true,
            next_cursor: {
              display_name: 'Provider One',
              provider_id: validProviderId1,
            },
          },
          error: null,
        })
        .mockImplementationOnce(() => secondPagePromise);

      const { result } = renderHook(() => useProviderDiscovery(defaultFilters, true));

      await act(async () => {});

      expect(result.current.providers.length).toBe(1);
      expect(result.current.hasMore).toBe(true);

      // Fire two loadMore calls concurrently
      let p1: Promise<void>;
      let p2: Promise<void>;
      act(() => {
        p1 = result.current.loadMore();
        p2 = result.current.loadMore();
      });

      // Expect discoverProviders to have been called twice total (1 for initial, 1 for loadMore)
      expect(DiscoveryService.discoverProviders).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveSecondPage!({
          data: {
            providers: [
              {
                provider_id: validProviderId2,
                display_name: 'Provider Two',
                gender: 'male',
                bio: null,
                years_experience: 5,
                badges: ['skill_verified'],
              },
            ],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        });
        await Promise.all([p1!, p2!]);
      });

      expect(result.current.providers.length).toBe(2);
      expect(result.current.hasMore).toBe(false);
      expect(DiscoveryService.discoverProviders).toHaveBeenCalledTimes(2);
    });

    it('DISCOVERY-10: Changing filters resets pagination', async () => {
      (DiscoveryService.discoverProviders as jest.Mock)
        .mockResolvedValueOnce({
          data: {
            providers: [
              {
                provider_id: validProviderId1,
                display_name: 'Provider A',
                gender: 'male',
                bio: null,
                years_experience: 2,
                badges: [],
              },
            ],
            has_more: true,
            next_cursor: { display_name: 'Provider A', provider_id: validProviderId1 },
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            providers: [
              {
                provider_id: validProviderId3,
                display_name: 'New Area Provider',
                gender: 'female',
                bio: null,
                years_experience: 8,
                badges: ['identity_verified'],
              },
            ],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        });

      const { result } = renderHook(() => useProviderDiscovery(defaultFilters, true));

      await act(async () => {});

      expect(result.current.providers[0].provider_id).toBe(validProviderId1);
      expect(result.current.hasMore).toBe(true);

      // Change filters to a different area
      const newAreaId = '99999999-9999-4999-8999-999999999999';
      await act(async () => {
        result.current.setFilters({
          areaId: newAreaId,
          serviceId: validServiceId,
        });
      });

      expect(result.current.providers.length).toBe(1);
      expect(result.current.providers[0].provider_id).toBe(validProviderId3);
      expect(result.current.hasMore).toBe(false);
      expect(result.current.nextCursor).toBeNull();
    });

    it('DISCOVERY-11: Stale responses cannot overwrite newer filter state', async () => {
      let resolveFirstCall: (value: any) => void;
      const slowFirstCall = new Promise((resolve) => {
        resolveFirstCall = resolve;
      });

      (DiscoveryService.discoverProviders as jest.Mock)
        .mockImplementationOnce(() => slowFirstCall)
        .mockResolvedValueOnce({
          data: {
            providers: [
              {
                provider_id: validProviderId2,
                display_name: 'Fast Second Provider',
                gender: 'male',
                bio: null,
                years_experience: 6,
                badges: [],
              },
            ],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        });

      const { result } = renderHook(() => useProviderDiscovery(defaultFilters, true));

      // Change filters before the first request resolves
      await act(async () => {
        result.current.setFilters({
          areaId: '88888888-8888-4888-8888-888888888888',
          serviceId: validServiceId,
        });
      });

      // Second query completes and updates state
      expect(result.current.providers.length).toBe(1);
      expect(result.current.providers[0].display_name).toBe('Fast Second Provider');

      // Now resolve the stale first query
      await act(async () => {
        resolveFirstCall!({
          data: {
            providers: [
              {
                provider_id: validProviderId1,
                display_name: 'Old Stale Provider',
                gender: 'male',
                bio: null,
                years_experience: 1,
                badges: [],
              },
            ],
            has_more: true,
            next_cursor: { display_name: 'Old Stale Provider', provider_id: validProviderId1 },
          },
          error: null,
        });
      });

      // Result should NOT be overwritten by the stale first query
      expect(result.current.providers.length).toBe(1);
      expect(result.current.providers[0].display_name).toBe('Fast Second Provider');
      expect(result.current.hasMore).toBe(false);
    });

    it('refreshes the page correctly on refresh()', async () => {
      (DiscoveryService.discoverProviders as jest.Mock)
        .mockResolvedValueOnce({
          data: {
            providers: [
              {
                provider_id: validProviderId1,
                display_name: 'Provider Initial',
                gender: 'male',
                bio: null,
                years_experience: 3,
                badges: [],
              },
            ],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            providers: [
              {
                provider_id: validProviderId1,
                display_name: 'Provider Refreshed',
                gender: 'male',
                bio: null,
                years_experience: 3,
                badges: [],
              },
            ],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        });

      const { result } = renderHook(() => useProviderDiscovery(defaultFilters, true));

      await act(async () => {});
      expect(result.current.providers[0].display_name).toBe('Provider Initial');

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.providers[0].display_name).toBe('Provider Refreshed');
    });
  });

  describe('usePublicProviderProfile', () => {
    it('initializes with null profile when no providerId is given', () => {
      const { result } = renderHook(() => usePublicProviderProfile(undefined, true));

      expect(result.current.profile).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('fails closed when unauthenticated', async () => {
      const { result } = renderHook(() => usePublicProviderProfile(validProviderId1, false));

      await act(async () => {});

      expect(DiscoveryService.getPublicProviderProfile).not.toHaveBeenCalled();
      expect(result.current.profile).toBeNull();
      expect(result.current.error?.code).toBe('AUTH_REQUIRED');
    });

    it('loads profile on mount when valid providerId provided', async () => {
      const mockProfile: PublicProviderProfile = {
        provider_id: validProviderId1,
        display_name: 'Sami Yusuf',
        gender: 'male',
        bio: 'HVAC specialist',
        years_experience: 9,
        services: [],
        areas: [],
        badges: [],
      };

      (DiscoveryService.getPublicProviderProfile as jest.Mock).mockResolvedValueOnce({
        data: mockProfile,
        error: null,
      });

      const { result } = renderHook(() => usePublicProviderProfile(validProviderId1, true));

      await act(async () => {});

      expect(DiscoveryService.getPublicProviderProfile).toHaveBeenCalledWith(validProviderId1);
      expect(result.current.profile?.display_name).toBe('Sami Yusuf');
      expect(result.current.error).toBeNull();
    });

    it('handles profile errors safely', async () => {
      (DiscoveryService.getPublicProviderProfile as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: {
          code: 'NOT_FOUND',
          userMessage: 'Provider profile not found.',
        },
      });

      const { result } = renderHook(() => usePublicProviderProfile(validProviderId1, true));

      await act(async () => {});

      expect(result.current.profile).toBeNull();
      expect(result.current.error?.code).toBe('NOT_FOUND');
    });
  });
});
