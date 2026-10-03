import { supabase } from '../lib/supabase';
import type {
  CatalogCategory,
  CatalogData,
  CatalogError,
  CatalogLocation,
  CatalogResult,
  CatalogService as ICatalogService,
  CategoryWithServices,
  LocationLevel,
  ResolvedArea,
} from '../types/catalog';

// Module-scoped in-memory session cache and in-flight deduplication promise
let memoryCache: CatalogData | null = null;
let inFlightPromise: Promise<CatalogResult<CatalogData>> | null = null;

function sanitizeCatalogError(error: unknown): CatalogError {
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    const code = String(err.code || '');
    const message = String(err.message || '').toLowerCase();

    // Authorization & Authentication errors
    if (
      code === '42501' ||
      code === 'PGRST301' ||
      message.includes('jwt') ||
      message.includes('auth') ||
      message.includes('permission denied')
    ) {
      return {
        code: 'AUTH_REQUIRED',
        userMessage: 'Authentication required to view available catalog.',
        sanitizedDetails: 'Session missing or permission denied.',
      };
    }

    // Network connection errors
    if (
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('connection')
    ) {
      return {
        code: 'NETWORK_ERROR',
        userMessage: 'Unable to connect to the catalog server. Please check your internet connection.',
        sanitizedDetails: 'Network request failed or timed out.',
      };
    }

    // Database query errors
    if (code.startsWith('2') || code.startsWith('4') || code.startsWith('P')) {
      return {
        code: 'DATABASE_ERROR',
        userMessage: 'Unable to load service and location catalog. Please try again.',
        sanitizedDetails: 'Database query execution failed.',
      };
    }
  }

  return {
    code: 'UNKNOWN_ERROR',
    userMessage: 'An unexpected error occurred while loading catalog data.',
    sanitizedDetails: 'An unhandled exception occurred.',
  };
}

export class CatalogService {
  /**
   * Fetches the complete active catalog (locations, categories, services).
   * Sequential calls reuse the valid in-memory session cache.
   * Concurrent calls share a single in-flight network request.
   */
  static async getCatalog(options?: { forceRefresh?: boolean }): Promise<CatalogResult<CatalogData>> {
    // 1. Return in-memory session cache if valid and not forcing refresh
    if (!options?.forceRefresh && memoryCache !== null) {
      return { data: memoryCache, error: null };
    }

    // 2. Share in-flight request if one is currently in progress
    if (!options?.forceRefresh && inFlightPromise !== null) {
      return inFlightPromise;
    }

    // 3. Initiate fresh fetch
    inFlightPromise = CatalogService.fetchCatalogData();

    try {
      const result = await inFlightPromise;
      if (result.data) {
        memoryCache = result.data;
      }
      return result;
    } finally {
      inFlightPromise = null;
    }
  }

  /**
   * Internal data fetcher executing session validation and concurrent queries.
   */
  private static async fetchCatalogData(): Promise<CatalogResult<CatalogData>> {
    try {
      // Authenticated session check - fail closed if unauthenticated
      const {
        data: { session },
        error: authError,
      } = await supabase.auth.getSession();

      if (authError || !session) {
        return {
          data: null,
          error: {
            code: 'AUTH_REQUIRED',
            userMessage: 'Authentication required to view available catalog.',
            sanitizedDetails: 'Active authentication session not found.',
          },
        };
      }

      // Execute queries concurrently using the authenticated Supabase client
      const [locationsRes, categoriesRes, servicesRes] = await Promise.all([
        supabase
          .from('locations')
          .select('id, parent_id, name, level, is_active')
          .eq('is_active', true)
          .order('name', { ascending: true }),
        supabase
          .from('categories')
          .select('id, name, slug, is_active')
          .eq('is_active', true)
          .order('name', { ascending: true }),
        supabase
          .from('services')
          .select('id, category_id, name, slug, is_active')
          .eq('is_active', true)
          .order('name', { ascending: true }),
      ]);

      if (locationsRes.error) {
        return { data: null, error: sanitizeCatalogError(locationsRes.error) };
      }
      if (categoriesRes.error) {
        return { data: null, error: sanitizeCatalogError(categoriesRes.error) };
      }
      if (servicesRes.error) {
        return { data: null, error: sanitizeCatalogError(servicesRes.error) };
      }

      // Map snake_case to camelCase and apply defensive active filtering
      const locations: CatalogLocation[] = (locationsRes.data || [])
        .filter((row: any) => row.is_active === true)
        .map((row: any) => ({
          id: String(row.id),
          name: String(row.name),
          parentId: row.parent_id ? String(row.parent_id) : null,
          level: row.level as LocationLevel,
          isActive: Boolean(row.is_active),
        }));

      const categories: CatalogCategory[] = (categoriesRes.data || [])
        .filter((row: any) => row.is_active === true)
        .map((row: any) => ({
          id: String(row.id),
          name: String(row.name),
          slug: String(row.slug),
          isActive: Boolean(row.is_active),
        }));

      const services: ICatalogService[] = (servicesRes.data || [])
        .filter((row: any) => row.is_active === true)
        .map((row: any) => ({
          id: String(row.id),
          categoryId: String(row.category_id),
          name: String(row.name),
          slug: String(row.slug),
          isActive: Boolean(row.is_active),
        }));

      // Resolve areas hierarchically
      const areas: ResolvedArea[] = [];
      for (const loc of locations) {
        if (loc.level === 'area' && loc.isActive) {
          const resolved = CatalogService.resolveArea(loc.id, locations);
          if (resolved) {
            areas.push(resolved);
          }
        }
      }

      // Sort resolved areas deterministically: name ASC, id ASC
      areas.sort((a, b) => {
        const cmp = a.name.localeCompare(b.name);
        if (cmp !== 0) return cmp;
        return a.id.localeCompare(b.id);
      });

      // Group active categories with active services
      const categoriesWithServices = CatalogService.groupCategoriesWithServices(
        categories,
        services
      );

      const catalogData: CatalogData = {
        locations,
        categories,
        services,
        areas,
        categoriesWithServices,
      };

      return { data: catalogData, error: null };
    } catch (err: unknown) {
      return { data: null, error: sanitizeCatalogError(err) };
    }
  }

  /**
   * Resolves an Area location through City -> State -> Country.
   * If any level is missing or mismatched, returns null (never fabricates missing parents).
   */
  static resolveArea(areaId: string, locations: CatalogLocation[]): ResolvedArea | null {
    const locMap = new Map<string, CatalogLocation>();
    for (const loc of locations) {
      locMap.set(loc.id, loc);
    }

    const area = locMap.get(areaId);
    if (!area || area.level !== 'area' || !area.isActive || !area.parentId) {
      return null;
    }

    const city = locMap.get(area.parentId);
    if (!city || city.level !== 'city' || !city.isActive || !city.parentId) {
      return null;
    }

    const state = locMap.get(city.parentId);
    if (!state || state.level !== 'state' || !state.isActive || !state.parentId) {
      return null;
    }

    const country = locMap.get(state.parentId);
    if (!country || country.level !== 'country' || !country.isActive) {
      return null;
    }

    return {
      id: area.id,
      name: area.name,
      cityName: city.name,
      stateName: state.name,
      countryName: country.name,
      fullName: `${area.name}, ${city.name}, ${state.name}, ${country.name}`,
    };
  }

  /**
   * Groups active services under active parent categories.
   * Only includes active categories that have at least one active service.
   * Deterministically sorts categories (name ASC, id ASC) and services (name ASC, id ASC).
   */
  static groupCategoriesWithServices(
    categories: CatalogCategory[],
    services: ICatalogService[]
  ): CategoryWithServices[] {
    const servicesByCategoryId = new Map<string, ICatalogService[]>();

    for (const s of services) {
      if (!s.isActive) continue;
      const list = servicesByCategoryId.get(s.categoryId);
      if (list) {
        list.push(s);
      } else {
        servicesByCategoryId.set(s.categoryId, [s]);
      }
    }

    // Sort services in each category deterministically
    for (const [, sList] of servicesByCategoryId.entries()) {
      sList.sort((a, b) => {
        const cmp = a.name.localeCompare(b.name);
        if (cmp !== 0) return cmp;
        return a.id.localeCompare(b.id);
      });
    }

    const result: CategoryWithServices[] = [];

    for (const cat of categories) {
      if (!cat.isActive) continue;
      const catServices = servicesByCategoryId.get(cat.id);
      if (catServices && catServices.length > 0) {
        result.push({
          ...cat,
          services: [...catServices],
        });
      }
    }

    // Sort categories deterministically: name ASC, id ASC
    result.sort((a, b) => {
      const cmp = a.name.localeCompare(b.name);
      if (cmp !== 0) return cmp;
      return a.id.localeCompare(b.id);
    });

    return result;
  }

  /**
   * Resets the in-memory session cache and cancels in-flight reference.
   * Call on sign out or when an explicit cache clear is needed.
   */
  static clearCache(): void {
    memoryCache = null;
    inFlightPromise = null;
  }
}
