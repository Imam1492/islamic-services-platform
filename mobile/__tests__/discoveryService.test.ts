/* eslint-disable @typescript-eslint/no-require-imports */
import { DiscoveryService } from '../src/services/discoveryService';
import { supabase } from '../src/lib/supabase';
import type { DiscoveryFilters, DiscoveryCursor, DiscoveryItem, PublicProviderProfile } from '../src/types/discovery';
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: {
      getSession: jest.fn(),
    },
  },
}));

describe('DiscoveryService & Security Architecture Suite (Phase 3.4.2A)', () => {
  const validAreaId = '11111111-1111-4111-8111-111111111111';
  const validServiceId = '22222222-2222-4222-8222-222222222222';
  const validProviderId = '33333333-3333-4333-8333-333333333333';

  const mockSession = {
    user: { id: 'user-auth-123' },
    access_token: 'mock-token',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (supabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: mockSession },
      error: null,
    });
  });

  describe('DISCOVERY-01 & DISCOVERY-04: Authenticated discovery & filter mapping', () => {
    it('calls discover_providers RPC with exact parameters for authenticated user', async () => {
      const mockProviders: DiscoveryItem[] = [
        {
          provider_id: validProviderId,
          display_name: 'Ahmad Al-Mansoor',
          gender: 'male',
          bio: 'Experienced electrician',
          years_experience: 7,
          badges: ['identity_verified', 'skill_verified'],
        },
      ];

      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: {
          providers: mockProviders,
          has_more: false,
          next_cursor: null,
        },
        error: null,
      });

      const filters: DiscoveryFilters = {
        areaId: validAreaId,
        serviceId: validServiceId,
        gender: 'male',
        minExperience: 5,
        requiredBadges: ['identity_verified', 'skill_verified'],
        limit: 20,
      };

      const result = await DiscoveryService.discoverProviders(filters);

      expect(supabase.rpc).toHaveBeenCalledWith('discover_providers', {
        p_area_id: validAreaId,
        p_service_id: validServiceId,
        p_gender: 'male',
        p_min_experience: 5,
        p_required_badges: ['identity_verified', 'skill_verified'],
        p_limit: 20,
        p_cursor_display_name: null,
        p_cursor_id: null,
      });

      expect(result.error).toBeNull();
      expect(result.data?.providers.length).toBe(1);
      expect(result.data?.providers[0].display_name).toBe('Ahmad Al-Mansoor');
      expect(result.data?.has_more).toBe(false);
      expect(result.data?.next_cursor).toBeNull();
    });
  });

  describe('DISCOVERY-02: Unauthenticated discovery fail-closed', () => {
    it('fails closed and does NOT call RPC when unauthenticated', async () => {
      (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
        data: { session: null },
        error: null,
      });

      const filters: DiscoveryFilters = {
        areaId: validAreaId,
        serviceId: validServiceId,
      };

      const result = await DiscoveryService.discoverProviders(filters);

      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('AUTH_REQUIRED');
      expect(result.error?.userMessage).toContain('Authentication required');
    });
  });

  describe('DISCOVERY-03: Required area/service validation', () => {
    it('rejects invalid or missing areaId before calling RPC', async () => {
      const result = await DiscoveryService.discoverProviders({
        areaId: 'not-a-uuid',
        serviceId: validServiceId,
      });

      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.error?.userMessage).toContain('valid area must be selected');
    });

    it('rejects invalid or missing serviceId before calling RPC', async () => {
      const result = await DiscoveryService.discoverProviders({
        areaId: validAreaId,
        serviceId: 'bad-service-uuid',
      });

      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.error?.userMessage).toContain('valid service must be selected');
    });
  });

  describe('DISCOVERY-05: Limit is bounded before request', () => {
    it('clamps limit to maximum 50 when higher value requested', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: { providers: [], has_more: false, next_cursor: null },
        error: null,
      });

      await DiscoveryService.discoverProviders({
        areaId: validAreaId,
        serviceId: validServiceId,
        limit: 100,
      });

      expect(supabase.rpc).toHaveBeenCalledWith(
        'discover_providers',
        expect.objectContaining({
          p_limit: 50,
        })
      );
    });

    it('clamps limit to minimum 1 when zero or negative requested', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: { providers: [], has_more: false, next_cursor: null },
        error: null,
      });

      await DiscoveryService.discoverProviders({
        areaId: validAreaId,
        serviceId: validServiceId,
        limit: -5,
      });

      expect(supabase.rpc).toHaveBeenCalledWith(
        'discover_providers',
        expect.objectContaining({
          p_limit: 1,
        })
      );
    });

    it('defaults limit to 15 when omitted', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: { providers: [], has_more: false, next_cursor: null },
        error: null,
      });

      await DiscoveryService.discoverProviders({
        areaId: validAreaId,
        serviceId: validServiceId,
      });

      expect(supabase.rpc).toHaveBeenCalledWith(
        'discover_providers',
        expect.objectContaining({
          p_limit: 15,
        })
      );
    });
  });

  describe('DISCOVERY-06 & DISCOVERY-07: Pagination cursor contract', () => {
    it('sends null cursor parameters on the first page', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: { providers: [], has_more: false, next_cursor: null },
        error: null,
      });

      await DiscoveryService.discoverProviders(
        { areaId: validAreaId, serviceId: validServiceId },
        null
      );

      expect(supabase.rpc).toHaveBeenCalledWith(
        'discover_providers',
        expect.objectContaining({
          p_cursor_display_name: null,
          p_cursor_id: null,
        })
      );
    });

    it('passes the returned cursor parameters for subsequent page', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: { providers: [], has_more: false, next_cursor: null },
        error: null,
      });

      const cursor: DiscoveryCursor = {
        display_name: 'Bilal Khan',
        provider_id: validProviderId,
      };

      await DiscoveryService.discoverProviders(
        { areaId: validAreaId, serviceId: validServiceId },
        cursor
      );

      expect(supabase.rpc).toHaveBeenCalledWith(
        'discover_providers',
        expect.objectContaining({
          p_cursor_display_name: 'Bilal Khan',
          p_cursor_id: validProviderId,
        })
      );
    });
  });

  describe('DISCOVERY-12 & DISCOVERY-13: Empty results and safe error mapping', () => {
    it('handles empty results safely returning empty list and has_more=false', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: { providers: [], has_more: false, next_cursor: null },
        error: null,
      });

      const result = await DiscoveryService.discoverProviders({
        areaId: validAreaId,
        serviceId: validServiceId,
      });

      expect(result.error).toBeNull();
      expect(result.data?.providers).toEqual([]);
      expect(result.data?.has_more).toBe(false);
      expect(result.data?.next_cursor).toBeNull();
    });

    it('maps 42501 error to AUTH_REQUIRED', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'Authentication required' },
      });

      const result = await DiscoveryService.discoverProviders({
        areaId: validAreaId,
        serviceId: validServiceId,
      });

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('AUTH_REQUIRED');
      expect(result.error?.userMessage).toContain('session has expired');
    });

    it('maps P0002 error to NOT_FOUND', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { code: 'P0002', message: 'Invalid or inactive area location' },
      });

      const result = await DiscoveryService.discoverProviders({
        areaId: validAreaId,
        serviceId: validServiceId,
      });

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('NOT_FOUND');
      expect(result.error?.userMessage).toContain('unavailable or inactive');
    });

    it('maps network errors safely without exposing technical stack traces', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { name: 'FetchError', message: 'Network request failed' },
      });

      const result = await DiscoveryService.discoverProviders({
        areaId: validAreaId,
        serviceId: validServiceId,
      });

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('NETWORK_ERROR');
      expect(result.error?.userMessage).toContain('Network connection issue');
    });
  });

  describe('PROFILE-01 to PROFILE-05: Public Provider Profile Service', () => {
    it('PROFILE-01: Authenticated provider profile calls get_public_provider_profile RPC', async () => {
      const mockProfile: PublicProviderProfile = {
        provider_id: validProviderId,
        display_name: 'Fatima Zahra',
        gender: 'female',
        bio: 'Professional tailor with 10 years experience',
        years_experience: 10,
        services: [
          {
            id: validServiceId,
            name: 'Custom Tailoring',
            slug: 'custom-tailoring',
            category_id: '44444444-4444-4444-8444-444444444444',
            category_name: 'Tailoring & Stitching',
          },
        ],
        areas: [
          {
            id: validAreaId,
            name: 'Al-Nahda Area 1',
            parent_id: null,
          },
        ],
        badges: [
          {
            badge_type: 'skill_verified',
            granted_at: '2026-09-01T10:00:00Z',
          },
        ],
      };

      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: mockProfile,
        error: null,
      });

      const result = await DiscoveryService.getPublicProviderProfile(validProviderId);

      expect(supabase.rpc).toHaveBeenCalledWith('get_public_provider_profile', {
        p_provider_id: validProviderId,
      });
      expect(result.error).toBeNull();
      expect(result.data?.display_name).toBe('Fatima Zahra');
      expect(result.data?.services.length).toBe(1);
      expect(result.data?.areas.length).toBe(1);
      expect(result.data?.badges.length).toBe(1);
    });

    it('PROFILE-02: Unauthenticated profile request fails closed', async () => {
      (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
        data: { session: null },
        error: null,
      });

      const result = await DiscoveryService.getPublicProviderProfile(validProviderId);

      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('AUTH_REQUIRED');
    });

    it('PROFILE-03: Invalid provider ID is rejected before calling RPC', async () => {
      const result = await DiscoveryService.getPublicProviderProfile('invalid-uuid-format');

      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('INVALID_ARGUMENT');
    });

    it('PROFILE-04: Unavailable/unapproved provider (P0002) is handled safely', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { code: 'P0002', message: 'Provider not found or unavailable' },
      });

      const result = await DiscoveryService.getPublicProviderProfile(validProviderId);

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('NOT_FOUND');
      expect(result.error?.userMessage).toContain('unavailable');
    });

    it('PROFILE-05: RPC/network error is handled safely', async () => {
      (supabase.rpc as jest.Mock).mockResolvedValueOnce({
        data: null,
        error: { name: 'FetchError', message: 'Failed to fetch' },
      });

      const result = await DiscoveryService.getPublicProviderProfile(validProviderId);

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('NETWORK_ERROR');
    });
  });

  describe('SECURITY & ARCHITECTURE BOUNDARY CHECKS', () => {
    it('SECURITY-01 to SECURITY-04: No mobile discovery code directly queries provider tables', () => {
      const discoveryServicePath = path.resolve(__dirname, '../src/services/discoveryService.ts');
      const discoveryHookPath = path.resolve(__dirname, '../src/hooks/useProviderDiscovery.ts');
      const profileHookPath = path.resolve(__dirname, '../src/hooks/usePublicProviderProfile.ts');

      const files = [discoveryServicePath, discoveryHookPath, profileHookPath];

      const forbiddenTables = [
        'provider_profiles',
        'provider_locations',
        'provider_services',
        'provider_badges',
        'provider_verifications',
      ];

      for (const filePath of files) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf-8');

        for (const table of forbiddenTables) {
          const directQueryPattern = new RegExp(`from\\(['"\`]${table}['"\`]\\)`, 'i');
          expect(directQueryPattern.test(content)).toBe(false);
        }
      }
    });

    it('SECURITY-05: No service_role or privileged Supabase client is introduced in mobile discovery', () => {
      const srcDir = path.resolve(__dirname, '../src');
      const serviceFiles = [
        path.join(srcDir, 'services/discoveryService.ts'),
        path.join(srcDir, 'hooks/useProviderDiscovery.ts'),
        path.join(srcDir, 'hooks/usePublicProviderProfile.ts'),
        path.join(srcDir, 'types/discovery.ts'),
      ];

      for (const filePath of serviceFiles) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).not.toContain('service_role');
        expect(content).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      }
    });

    it('DISCOVERY-14: No private provider fields are introduced into public TypeScript discovery contract', () => {
      const typesPath = path.resolve(__dirname, '../src/types/discovery.ts');
      const typesContent = fs.readFileSync(typesPath, 'utf-8');

      const forbiddenTerms = [
        'phone',
        'user_id',
        'national_id',
        'reviewer_id',
        'admin_notes',
        'verification_ledger',
        'audit',
        'other', // Enforce 'male' | 'female' enum strictly
      ];

      const strippedContent = typesContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

      for (const term of forbiddenTerms) {
        const fieldRegex = new RegExp(`\\b${term}\\b`, 'i');
        expect(fieldRegex.test(strippedContent)).toBe(false);
      }
    });
  });
});
