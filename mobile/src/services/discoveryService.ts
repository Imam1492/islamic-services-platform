import { supabase } from '../lib/supabase';
import type {
  DiscoveryFilters,
  DiscoveryCursor,
  DiscoveryResult,
  DiscoveryItem,
  PublicProviderProfile,
  DiscoveryServiceError,
} from '../types/discovery';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id.trim());
}

export class DiscoveryService {
  /**
   * Executes public.discover_providers(...) RPC.
   * Consumes only the public RPC contract and never queries internal provider tables.
   */
  static async discoverProviders(
    params: DiscoveryFilters,
    cursor?: DiscoveryCursor | null
  ): Promise<{ data: DiscoveryResult; error: null } | { data: null; error: DiscoveryServiceError }> {
    try {
      // 1. Session gate: fail closed if unauthenticated
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session) {
        return {
          data: null,
          error: {
            code: 'AUTH_REQUIRED',
            userMessage: 'Authentication required. Please sign in to discover providers.',
            sanitizedDetails: 'Active authentication session not found.',
          },
        };
      }

      // 2. Validate required arguments
      if (!isValidUuid(params?.areaId)) {
        return {
          data: null,
          error: {
            code: 'INVALID_ARGUMENT',
            userMessage: 'A valid area must be selected to discover providers.',
            sanitizedDetails: 'Invalid or missing areaId UUID.',
          },
        };
      }

      if (!isValidUuid(params?.serviceId)) {
        return {
          data: null,
          error: {
            code: 'INVALID_ARGUMENT',
            userMessage: 'A valid service must be selected to discover providers.',
            sanitizedDetails: 'Invalid or missing serviceId UUID.',
          },
        };
      }

      // 3. Bound limit between 1 and 50 (server default 15)
      const requestedLimit = params.limit ?? 15;
      const clampedLimit = Math.max(1, Math.min(requestedLimit, 50));

      // 4. Validate cursor if provided
      if (cursor && (!cursor.display_name || !isValidUuid(cursor.provider_id))) {
        return {
          data: null,
          error: {
            code: 'INVALID_ARGUMENT',
            userMessage: 'Invalid pagination cursor provided.',
            sanitizedDetails: 'Malformed cursor payload.',
          },
        };
      }

      // 5. Invoke discover_providers RPC
      const { data, error } = await supabase.rpc('discover_providers', {
        p_area_id: params.areaId,
        p_service_id: params.serviceId,
        p_gender: params.gender ?? null,
        p_min_experience:
          params.minExperience !== undefined && params.minExperience !== null
            ? Math.max(0, Math.floor(params.minExperience))
            : null,
        p_required_badges:
          params.requiredBadges && params.requiredBadges.length > 0
            ? params.requiredBadges
            : null,
        p_limit: clampedLimit,
        p_cursor_display_name: cursor?.display_name ?? null,
        p_cursor_id: cursor?.provider_id ?? null,
      });

      if (error) {
        return { data: null, error: this.classifyError(error) };
      }

      if (!data || typeof data !== 'object') {
        return {
          data: {
            providers: [],
            has_more: false,
            next_cursor: null,
          },
          error: null,
        };
      }

      const raw = data as Record<string, unknown>;
      const rawProviders = Array.isArray(raw.providers) ? raw.providers : [];

      const providers: DiscoveryItem[] = rawProviders.map((p: any) => ({
        provider_id: String(p.provider_id || ''),
        display_name: String(p.display_name || ''),
        gender: p.gender === 'female' ? 'female' : 'male',
        bio: typeof p.bio === 'string' ? p.bio : null,
        years_experience: typeof p.years_experience === 'number' ? p.years_experience : 0,
        badges: Array.isArray(p.badges) ? p.badges : [],
      }));

      const hasMore = Boolean(raw.has_more);
      let nextCursor: DiscoveryCursor | null = null;
      if (
        hasMore &&
        raw.next_cursor &&
        typeof raw.next_cursor === 'object' &&
        typeof (raw.next_cursor as any).display_name === 'string' &&
        typeof (raw.next_cursor as any).provider_id === 'string'
      ) {
        nextCursor = {
          display_name: (raw.next_cursor as any).display_name,
          provider_id: (raw.next_cursor as any).provider_id,
        };
      }

      return {
        data: {
          providers,
          has_more: hasMore,
          next_cursor: nextCursor,
        },
        error: null,
      };
    } catch (err: unknown) {
      return { data: null, error: this.classifyError(err) };
    }
  }

  /**
   * Executes public.get_public_provider_profile(...) RPC.
   * Consumes only the public RPC contract and never queries internal provider tables.
   */
  static async getPublicProviderProfile(
    providerId: string
  ): Promise<
    | { data: PublicProviderProfile; error: null }
    | { data: null; error: DiscoveryServiceError }
  > {
    try {
      // 1. Session gate: fail closed if unauthenticated
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session) {
        return {
          data: null,
          error: {
            code: 'AUTH_REQUIRED',
            userMessage: 'Authentication required. Please sign in to view provider details.',
            sanitizedDetails: 'Active authentication session not found.',
          },
        };
      }

      // 2. Validate providerId UUID before calling RPC
      if (!isValidUuid(providerId)) {
        return {
          data: null,
          error: {
            code: 'INVALID_ARGUMENT',
            userMessage: 'Invalid provider identifier provided.',
            sanitizedDetails: 'Invalid providerId UUID.',
          },
        };
      }

      // 3. Invoke get_public_provider_profile RPC
      const { data, error } = await supabase.rpc('get_public_provider_profile', {
        p_provider_id: providerId,
      });

      if (error) {
        return { data: null, error: this.classifyError(error) };
      }

      if (!data || typeof data !== 'object') {
        return {
          data: null,
          error: {
            code: 'NOT_FOUND',
            userMessage: 'Provider profile not found or currently unavailable.',
            sanitizedDetails: 'Null or non-object profile response.',
          },
        };
      }

      const raw = data as Record<string, unknown>;

      const profile: PublicProviderProfile = {
        provider_id: String(raw.provider_id || ''),
        display_name: String(raw.display_name || ''),
        gender: raw.gender === 'female' ? 'female' : 'male',
        bio: typeof raw.bio === 'string' ? raw.bio : null,
        years_experience: typeof raw.years_experience === 'number' ? raw.years_experience : 0,
        services: Array.isArray(raw.services)
          ? raw.services.map((s: any) => ({
              id: String(s.id || ''),
              name: String(s.name || ''),
              slug: String(s.slug || ''),
              category_id: String(s.category_id || ''),
              category_name: String(s.category_name || ''),
            }))
          : [],
        areas: Array.isArray(raw.areas)
          ? raw.areas.map((a: any) => ({
              id: String(a.id || ''),
              name: String(a.name || ''),
              parent_id: typeof a.parent_id === 'string' ? a.parent_id : null,
            }))
          : [],
        badges: Array.isArray(raw.badges)
          ? raw.badges.map((b: any) => ({
              badge_type: b.badge_type,
              granted_at: String(b.granted_at || ''),
            }))
          : [],
      };

      return { data: profile, error: null };
    } catch (err: unknown) {
      return { data: null, error: this.classifyError(err) };
    }
  }

  /**
   * Sanitizes and classifies database/network errors into safe user-facing errors.
   * Never exposes internal database schemas, stacks, or PII.
   */
  private static classifyError(error: any): DiscoveryServiceError {
    if (!error) {
      return {
        code: 'UNKNOWN_ERROR',
        userMessage: 'An unexpected error occurred. Please try again later.',
        sanitizedDetails: 'Undefined error.',
      };
    }

    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? error.message : '';

    // Authentication failure (42501)
    if (code === '42501' || message.includes('Authentication required')) {
      return {
        code: 'AUTH_REQUIRED',
        userMessage: 'Your authentication session has expired or is invalid. Please sign in again.',
        sanitizedDetails: 'PostgreSQL 42501 authentication required.',
      };
    }

    // Not found / inactive area, service, or provider (P0002)
    if (
      code === 'P0002' ||
      message.includes('Invalid or inactive') ||
      message.includes('Provider not found')
    ) {
      return {
        code: 'NOT_FOUND',
        userMessage: 'The requested provider, area, or service is unavailable or inactive.',
        sanitizedDetails: 'Entity not found or inactive.',
      };
    }

    // Validation errors (22023)
    if (code === '22023') {
      return {
        code: 'VALIDATION_ERROR',
        userMessage: 'Invalid search or filter parameters provided.',
        sanitizedDetails: 'PostgreSQL 22023 validation parameter boundary.',
      };
    }

    // Network / connectivity errors
    if (
      message.includes('Network request failed') ||
      message.includes('Failed to fetch') ||
      message.includes('timeout') ||
      error.name === 'FetchError' ||
      error.name === 'TypeError'
    ) {
      return {
        code: 'NETWORK_ERROR',
        userMessage: 'Network connection issue. Please check your internet connection and try again.',
        sanitizedDetails: 'Network communication failure.',
      };
    }

    return {
      code: 'UNKNOWN_ERROR',
      userMessage: 'Unable to complete provider discovery. Please try again later.',
      sanitizedDetails: 'Unclassified discovery error.',
    };
  }
}
