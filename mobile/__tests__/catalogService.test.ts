/* eslint-disable @typescript-eslint/no-require-imports */
import { CatalogService } from '../src/services/catalogService';
import { supabase } from '../src/lib/supabase';
import type { CatalogLocation } from '../src/types/catalog';
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
    auth: {
      getSession: jest.fn(),
    },
  },
}));

describe('CatalogService & Security Architecture Suite (Phase 3.4.2B-A)', () => {
  const mockSession = {
    user: { id: 'test-user-123' },
    access_token: 'valid-token',
  };

  // Sample locations with valid hierarchy: Country -> State -> City -> Area
  const mockLocationsData = [
    {
      id: 'loc-country-1',
      parent_id: null,
      name: 'India',
      level: 'country',
      is_active: true,
    },
    {
      id: 'loc-state-1',
      parent_id: 'loc-country-1',
      name: 'Telangana',
      level: 'state',
      is_active: true,
    },
    {
      id: 'loc-city-1',
      parent_id: 'loc-state-1',
      name: 'Hyderabad',
      level: 'city',
      is_active: true,
    },
    {
      id: 'loc-area-1',
      parent_id: 'loc-city-1',
      name: 'Banjara Hills',
      level: 'area',
      is_active: true,
    },
    {
      id: 'loc-area-2',
      parent_id: 'loc-city-1',
      name: 'Jubilee Hills',
      level: 'area',
      is_active: true,
    },
  ];

  const mockCategoriesData = [
    {
      id: 'cat-1',
      name: 'Plumbing',
      slug: 'plumbing',
      is_active: true,
    },
    {
      id: 'cat-2',
      name: 'Electrical',
      slug: 'electrical',
      is_active: true,
    },
    {
      id: 'cat-empty',
      name: 'Gardening',
      slug: 'gardening',
      is_active: true,
    },
  ];

  const mockServicesData = [
    {
      id: 'srv-1',
      category_id: 'cat-1',
      name: 'Pipe Repair',
      slug: 'pipe-repair',
      is_active: true,
    },
    {
      id: 'srv-2',
      category_id: 'cat-1',
      name: 'Drain Cleaning',
      slug: 'drain-cleaning',
      is_active: true,
    },
    {
      id: 'srv-3',
      category_id: 'cat-2',
      name: 'Wiring Inspection',
      slug: 'wiring-inspection',
      is_active: true,
    },
  ];

  function setupTableMocks(overrides?: {
    locations?: { data: any; error: any };
    categories?: { data: any; error: any };
    services?: { data: any; error: any };
  }) {
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      const createChain = (resolvedValue: { data: any; error: any }) => {
        const chain: any = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockResolvedValue(resolvedValue),
        };
        return chain;
      };

      if (table === 'locations') {
        return createChain(overrides?.locations ?? { data: mockLocationsData, error: null });
      }
      if (table === 'categories') {
        return createChain(overrides?.categories ?? { data: mockCategoriesData, error: null });
      }
      if (table === 'services') {
        return createChain(overrides?.services ?? { data: mockServicesData, error: null });
      }

      return createChain({ data: [], error: null });
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    CatalogService.clearCache();
    (supabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: mockSession },
      error: null,
    });
    setupTableMocks();
  });

  afterEach(() => {
    CatalogService.clearCache();
  });

  describe('1. Authentication Gating & Fail-Closed Behavior', () => {
    it('fails closed when there is no authenticated session', async () => {
      (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
        data: { session: null },
        error: null,
      });

      const result = await CatalogService.getCatalog();

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error?.code).toBe('AUTH_REQUIRED');
      expect(result.error?.userMessage).toBe('Authentication required to view available catalog.');
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('fails closed when getSession returns an authentication error', async () => {
      (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
        data: { session: null },
        error: { message: 'JWT expired' },
      });

      const result = await CatalogService.getCatalog();

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('AUTH_REQUIRED');
      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  describe('2. Active Entity Mapping & Filtering', () => {
    it('correctly maps active locations, categories, and services to camelCase', async () => {
      const result = await CatalogService.getCatalog();

      expect(result.error).toBeNull();
      expect(result.data).not.toBeNull();
      expect(result.data?.locations.length).toBe(5);

      const banjara = result.data?.locations.find((l) => l.id === 'loc-area-1');
      expect(banjara).toEqual({
        id: 'loc-area-1',
        name: 'Banjara Hills',
        parentId: 'loc-city-1',
        level: 'area',
        isActive: true,
      });

      const plumbing = result.data?.categories.find((c) => c.id === 'cat-1');
      expect(plumbing).toEqual({
        id: 'cat-1',
        name: 'Plumbing',
        slug: 'plumbing',
        isActive: true,
      });

      const pipeRepair = result.data?.services.find((s) => s.id === 'srv-1');
      expect(pipeRepair).toEqual({
        id: 'srv-1',
        categoryId: 'cat-1',
        name: 'Pipe Repair',
        slug: 'pipe-repair',
        isActive: true,
      });
    });

    it('defensively filters out inactive records if returned by queries', async () => {
      const locationsWithInactive = [
        ...mockLocationsData,
        {
          id: 'loc-area-inactive',
          parent_id: 'loc-city-1',
          name: 'Inactive Area',
          level: 'area',
          is_active: false,
        },
      ];
      setupTableMocks({ locations: { data: locationsWithInactive, error: null } });

      const result = await CatalogService.getCatalog();

      expect(result.data?.locations.some((l) => l.id === 'loc-area-inactive')).toBe(false);
      expect(result.data?.areas.some((a) => a.id === 'loc-area-inactive')).toBe(false);
    });
  });

  describe('3. Hierarchy Resolution & Deterministic Area Sorting', () => {
    it('resolves Area -> City -> State -> Country into canonical fullName with country included', async () => {
      const result = await CatalogService.getCatalog();

      expect(result.data?.areas.length).toBe(2);

      const banjara = result.data?.areas.find((a) => a.id === 'loc-area-1');
      expect(banjara).toEqual({
        id: 'loc-area-1',
        name: 'Banjara Hills',
        cityName: 'Hyderabad',
        stateName: 'Telangana',
        countryName: 'India',
        fullName: 'Banjara Hills, Hyderabad, Telangana, India',
      });
    });

    it('sorts resolved areas deterministically by name ASC with id ASC tie-breaker', async () => {
      const result = await CatalogService.getCatalog();

      const areaNames = result.data?.areas.map((a) => a.name);
      expect(areaNames).toEqual(['Banjara Hills', 'Jubilee Hills']);
    });

    it('excludes areas with malformed or missing hierarchy without throwing or inventing parents', () => {
      const rawLocations: CatalogLocation[] = [
        { id: '1', name: 'India', parentId: null, level: 'country', isActive: true },
        { id: '2', name: 'Telangana', parentId: '1', level: 'state', isActive: true },
        // Missing city! Area links directly to state
        { id: '3', name: 'Broken Area', parentId: '2', level: 'area', isActive: true },
      ];

      const resolved = CatalogService.resolveArea('3', rawLocations);
      expect(resolved).toBeNull();
    });

    it('excludes areas with orphaned parentId', () => {
      const rawLocations: CatalogLocation[] = [
        { id: '3', name: 'Orphan Area', parentId: 'non-existent', level: 'area', isActive: true },
      ];

      const resolved = CatalogService.resolveArea('3', rawLocations);
      expect(resolved).toBeNull();
    });
  });

  describe('4. Category & Service Grouping', () => {
    it('groups active services under their parent category', async () => {
      const result = await CatalogService.getCatalog();

      const groups = result.data?.categoriesWithServices;
      expect(groups).toBeDefined();
      expect(groups?.length).toBe(2); // Gardening has no services, so excluded

      const plumbingGroup = groups?.find((g) => g.id === 'cat-1');
      expect(plumbingGroup).toBeDefined();
      expect(plumbingGroup?.services.length).toBe(2);
      expect(plumbingGroup?.services.map((s) => s.name)).toEqual(['Drain Cleaning', 'Pipe Repair']); // Sorted name ASC
    });

    it('excludes categories that have zero active services', async () => {
      const result = await CatalogService.getCatalog();

      const gardeningGroup = result.data?.categoriesWithServices.find((g) => g.id === 'cat-empty');
      expect(gardeningGroup).toBeUndefined();
    });

    it('sorts categories deterministically by name ASC', async () => {
      const result = await CatalogService.getCatalog();

      const categoryNames = result.data?.categoriesWithServices.map((g) => g.name);
      expect(categoryNames).toEqual(['Electrical', 'Plumbing']);
    });
  });

  describe('5. Caching, Request Deduplication & Lifecycle', () => {
    it('reuses in-memory session cache on sequential calls without re-querying Supabase', async () => {
      const firstResult = await CatalogService.getCatalog();
      expect(supabase.from).toHaveBeenCalledTimes(3);

      const secondResult = await CatalogService.getCatalog();
      // Should NOT have made additional database queries
      expect(supabase.from).toHaveBeenCalledTimes(3);
      expect(secondResult.data).toBe(firstResult.data);
    });

    it('deduplicates concurrent in-flight requests into a single database query batch', async () => {
      const promise1 = CatalogService.getCatalog();
      const promise2 = CatalogService.getCatalog();
      const promise3 = CatalogService.getCatalog();

      const [res1, res2, res3] = await Promise.all([promise1, promise2, promise3]);

      expect(supabase.from).toHaveBeenCalledTimes(3); // Exactly 1 batch of 3 queries
      expect(res1.data).toBe(res2.data);
      expect(res2.data).toBe(res3.data);
    });

    it('bypasses in-memory cache when forceRefresh is true', async () => {
      await CatalogService.getCatalog();
      expect(supabase.from).toHaveBeenCalledTimes(3);

      await CatalogService.getCatalog({ forceRefresh: true });
      expect(supabase.from).toHaveBeenCalledTimes(6); // 3 original + 3 refreshed
    });

    it('clearCache removes cached data and causes subsequent call to query Supabase', async () => {
      await CatalogService.getCatalog();
      expect(supabase.from).toHaveBeenCalledTimes(3);

      CatalogService.clearCache();

      await CatalogService.getCatalog();
      expect(supabase.from).toHaveBeenCalledTimes(6);
    });
  });

  describe('6. Error Handling & Sanitization', () => {
    it('sanitizes and maps network errors without leaking internals', async () => {
      setupTableMocks({
        locations: { data: null, error: { message: 'Failed to fetch network error' } },
      });

      const result = await CatalogService.getCatalog();

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('NETWORK_ERROR');
      expect(result.error?.userMessage).toBe(
        'Unable to connect to the catalog server. Please check your internet connection.'
      );
    });

    it('sanitizes PostgreSQL database errors without exposing SQL or table names', async () => {
      setupTableMocks({
        services: {
          data: null,
          error: {
            code: '42P01',
            message: 'relation "public.services" does not exist',
          },
        },
      });

      const result = await CatalogService.getCatalog();

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('DATABASE_ERROR');
      expect(result.error?.userMessage).toBe(
        'Unable to load service and location catalog. Please try again.'
      );
      expect(result.error?.userMessage).not.toContain('public.services');
      expect(result.error?.userMessage).not.toContain('relation');
    });

    it('sanitizes authorization / 42501 error to AUTH_REQUIRED', async () => {
      setupTableMocks({
        categories: {
          data: null,
          error: {
            code: '42501',
            message: 'permission denied for table categories',
          },
        },
      });

      const result = await CatalogService.getCatalog();

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('AUTH_REQUIRED');
      expect(result.error?.userMessage).toBe('Authentication required to view available catalog.');
    });
  });

  describe('7. Architectural Security Assertions', () => {
    it('verifies catalogService.ts contains zero references to forbidden tables or service_role', () => {
      const serviceFilePath = path.join(__dirname, '../src/services/catalogService.ts');
      const content = fs.readFileSync(serviceFilePath, 'utf8');

      // Security boundaries
      expect(content).not.toContain('service_role');
      expect(content).not.toContain('provider_profiles');
      expect(content).not.toContain('provider_locations');
      expect(content).not.toContain('provider_services');
      expect(content).not.toContain('provider_badges');
      expect(content).not.toContain('user_private');
      expect(content).not.toContain('user_consents');
      expect(content).not.toContain('audit_logs');
      expect(content).not.toContain('discover_providers');
      expect(content).not.toContain('get_public_provider_profile');
    });

    it('verifies catalog.ts types contain zero references to forbidden tables or PII', () => {
      const typesFilePath = path.join(__dirname, '../src/types/catalog.ts');
      const content = fs.readFileSync(typesFilePath, 'utf8');

      expect(content).not.toContain('phone');
      expect(content).not.toContain('email');
      expect(content).not.toContain('national_id');
      expect(content).not.toContain('service_role');
    });
  });
});
