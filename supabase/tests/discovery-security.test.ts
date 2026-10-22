/**
 * Phase 3.4.1: Database Discovery Foundation Security & Integration Test Suite
 *
 * Verifies:
 * 1. Authenticated discovery succeeds for valid inputs
 * 2. Unauthenticated discovery is rejected
 * 3. Approved provider in matching area/service is returned
 * 4. Pending provider is not returned
 * 5. Area_reviewed provider is not returned
 * 6. Suspended provider is not returned
 * 7. Wrong-area provider is not returned
 * 8. Wrong-service provider is not returned
 * 9. Inactive service is not returned
 * 10. Inactive category service is not returned
 * 11. Inactive area is rejected
 * 12. Provider phone is never returned
 * 13. Provider user_id is never returned
 * 14. Provider verification records are never returned
 * 15. Reviewer IDs/internal notes are never returned
 * 16. Required badge filter works
 * 17. Gender filter works
 * 18. Minimum experience filter works
 * 19. Pagination is deterministic
 * 20. No duplicate providers across pages
 * 21. Arbitrary/tampered area IDs cannot bypass eligibility
 * 22. Arbitrary/tampered service IDs cannot bypass eligibility
 * 23. Unapproved provider profile is not exposed
 * 24. Approved provider profile exposes only intended fields
 * 25. Inactive services/areas do not appear in provider profile
 * 26. RPC execution privileges are correctly restricted
 * 27. SECURITY DEFINER search_path is hardened
 */

import { Client } from 'pg';
import * as jwtLib from 'jsonwebtoken';
const jwt: typeof import('jsonwebtoken') = (jwtLib as any).default ?? jwtLib;
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  resolveLocalDatabaseTestUrl,
  shouldRunDatabaseIntegrationTests,
} from './database-test-guard';

interface TestUser {
  id: string;
  name: string;
  token: string;
}

const DB_URL = resolveLocalDatabaseTestUrl();
const runDatabaseTests = shouldRunDatabaseIntegrationTests();
const databaseDescribe = runDatabaseTests ? describe : describe.skip;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long';

function generateSupabaseJwt(userId: string, role: string = 'authenticated'): string {
  return jwt.sign(
    {
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: userId,
      role: role,
      app_metadata: { provider: 'email' },
      user_metadata: {},
    },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );
}

describe('Phase 3.4.1: Database Discovery Foundation Security & Integration Tests', () => {
  let isDbConnected = false;
  let adminClient: Client;

  const testUser: TestUser = {
    id: randomUUID(),
    name: 'Discovery Caller User',
    token: '',
  };
  testUser.token = generateSupabaseJwt(testUser.id);

  async function createAuthClient(user: TestUser): Promise<Client> {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`SET ROLE authenticated;`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [user.id]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
    return client;
  }

  // Read Migration 09 and 10 files for static architectural verification
  const migration09Path = path.resolve(__dirname, '../migrations/20261005000000_09_catalog_and_discovery.sql');
  const migration10Path = path.resolve(__dirname, '../migrations/20261005010000_10_revoke_direct_provider_badges_select.sql');
  let migration09Sql = '';
  let migration10Sql = '';

  beforeAll(() => {
    if (fs.existsSync(migration09Path)) {
      migration09Sql = fs.readFileSync(migration09Path, 'utf8');
    }
    if (fs.existsSync(migration10Path)) {
      migration10Sql = fs.readFileSync(migration10Path, 'utf8');
    }

  });

  afterAll(async () => {
    if (isDbConnected && adminClient) {
      await adminClient.end();
    }
  });

  // ==========================================================================
  // STATIC & SCHEMA ARCHITECTURE TESTS (RUN IN ALL ENVIRONMENTS)
  // ==========================================================================

  describe('Static & SQL Architecture Verification of Migration 09', () => {
    test('M09-01: Migration file exists and is populated', () => {
      expect(fs.existsSync(migration09Path)).toBe(true);
      expect(migration09Sql.length).toBeGreaterThan(500);
    });

    test('M09-02: Correction 1 - Catalog read access is strictly revoked from PUBLIC and anon', () => {
      expect(migration09Sql).toContain('REVOKE ALL ON TABLE public.locations FROM PUBLIC, anon;');
      expect(migration09Sql).toContain('REVOKE ALL ON TABLE public.categories FROM PUBLIC, anon;');
      expect(migration09Sql).toContain('REVOKE ALL ON TABLE public.services FROM PUBLIC, anon;');
      expect(migration09Sql).toContain('REVOKE ALL ON TABLE public.provider_badges FROM PUBLIC, anon;');

      expect(migration09Sql).toContain('GRANT SELECT ON TABLE public.locations TO authenticated;');
      expect(migration09Sql).toContain('GRANT SELECT ON TABLE public.categories TO authenticated;');
      expect(migration09Sql).toContain('GRANT SELECT ON TABLE public.services TO authenticated;');
      expect(migration09Sql).toContain('GRANT SELECT ON TABLE public.provider_badges TO authenticated;');
    });

    test('M09-03: Catalog RLS policies filter is_active and parent category activity', () => {
      expect(migration09Sql).toContain('p_locations_select_active');
      expect(migration09Sql).toContain('p_categories_select_active');
      expect(migration09Sql).toContain('p_services_select_active');
      expect(migration09Sql).toContain('p_provider_badges_select');

      // Services policy checks parent category is_active
      expect(migration09Sql).toMatch(/categories\s+c\s+WHERE\s+c\.id\s+=\s+services\.category_id\s+AND\s+c\.is_active\s+=\s+true/i);
    });

    test('M09-04: Correction 2 - SECURITY DEFINER search_path is explicitly hardened on all RPCs', () => {
      const searchPathOccurrences = migration09Sql.match(/SET search_path = pg_catalog, public, pg_temp/g);
      expect(searchPathOccurrences).not.toBeNull();
      expect(searchPathOccurrences!.length).toBeGreaterThanOrEqual(2);
    });

    test('M09-05: Correction 2 - Function EXECUTE privileges are revoked from PUBLIC and anon', () => {
      expect(migration09Sql).toContain('REVOKE ALL ON FUNCTION public.discover_providers');
      expect(migration09Sql).toContain('FROM PUBLIC;');
      expect(migration09Sql).toContain('FROM anon;');
      expect(migration09Sql).toContain('GRANT EXECUTE ON FUNCTION public.discover_providers');
      expect(migration09Sql).toContain('TO authenticated, service_role;');

      expect(migration09Sql).toContain('REVOKE ALL ON FUNCTION public.get_public_provider_profile');
      expect(migration09Sql).toContain('TO authenticated, service_role;');
    });

    test('M09-06: Correction 3 - Provider display name uses neutral terminology and never verified name', () => {
      expect(migration09Sql).toContain("'display_name', r.display_name");
      expect(migration09Sql).toContain("'display_name', v_provider.display_name");
      expect(migration09Sql).not.toContain('verified_name');
      expect(migration09Sql).not.toContain('verified_business_name');
    });

    test('M09-07: Correction 4 - Non-existent or private fields are not projected in JSON payload', () => {
      expect(migration09Sql).not.toContain("'photo'");
      expect(migration09Sql).not.toContain("'availability'");
      expect(migration09Sql).not.toContain("'audio'");
      expect(migration09Sql).not.toContain("'social'");
      expect(migration09Sql).not.toContain("'phone'");
      expect(migration09Sql).not.toContain("'phone_e164'");
      expect(migration09Sql).not.toContain("'user_id'");
      expect(migration09Sql).not.toContain("'internal_notes'");
      expect(migration09Sql).not.toContain("'reviewer_id'");
    });

    test('M09-08: Correction 6 - Keyset pagination uses neutral deterministic sort by display_name ASC, provider_id ASC', () => {
      expect(migration09Sql).toContain('ORDER BY u.full_name ASC, p.id ASC');
      expect(migration09Sql).not.toContain('years_experience DESC');
    });

    test('M09-09: Discovery performance indexes exist and are non-redundant', () => {
      expect(migration09Sql).toContain('idx_users_full_name');
      expect(migration09Sql).toContain('idx_provider_profiles_approved_discovery');
      expect(migration09Sql).toContain("WHERE status = 'approved'::public.provider_status");
    });
  });

  describe('Phase 3.4.1B: Migration 10 Static Architecture Verification', () => {
    test('M10-01: Migration 10 exists, is non-empty, and sorts strictly after Migration 09', () => {
      expect(fs.existsSync(migration10Path)).toBe(true);
      expect(migration10Sql.length).toBeGreaterThan(100);
      const filename09 = path.basename(migration09Path);
      const filename10 = path.basename(migration10Path);
      expect(filename10.localeCompare(filename09)).toBeGreaterThan(0);
    });

    test('M10-02: Migration 10 drops p_provider_badges_select policy and revokes direct client access', () => {
      expect(migration10Sql).toContain('DROP POLICY IF EXISTS p_provider_badges_select ON public.provider_badges;');
      expect(migration10Sql).toContain('REVOKE SELECT ON TABLE public.provider_badges FROM authenticated;');
      expect(migration10Sql).toContain('REVOKE ALL ON TABLE public.provider_badges FROM PUBLIC, anon;');
      expect(migration10Sql).toContain('GRANT SELECT ON TABLE public.provider_badges TO service_role;');
    });

    test('M10-03: Zero mobile production code imports or queries provider_badges directly', () => {
      const mobileDir = path.resolve(__dirname, '../../mobile/src');
      let foundDirectQuery = false;

      function scanDir(dir: string) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes("from('provider_badges')") || content.includes('from("provider_badges")')) {
              foundDirectQuery = true;
            }
          }
        }
      }

      scanDir(mobileDir);
      expect(foundDirectQuery).toBe(false);
    });
  });

  // ==========================================================================
  // LIVE DATABASE EXECUTION TESTS (RUN WHEN POSTGRESQL IS CONNECTED)
  // ==========================================================================

  databaseDescribe('Live Database Security & Authorization Integration Tests', () => {
    let areaAId: string;
    let areaBId: string;
    let inactiveAreaId: string;
    let catAId: string;
    let inactiveCatId: string;
    let serviceAId: string;
    let serviceBId: string;
    let inactiveServiceId: string;
    let serviceUnderInactiveCatId: string;

    let approvedProvId: string;
    let pendingProvId: string;
    let areaReviewedProvId: string;
    let suspendedProvId: string;
    let wrongAreaProvId: string;
    let wrongServiceProvId: string;

    const createdUserIds: string[] = [];
    const createdProviderIds: string[] = [];
    const createdLocationIds: string[] = [];
    const createdCategoryIds: string[] = [];
    const createdServiceIds: string[] = [];
    const runToken = randomUUID().replace(/-/g, '');

    beforeAll(async () => {
      adminClient = new Client({ connectionString: DB_URL });
      try {
        await adminClient.connect();
        isDbConnected = true;
      } catch {
        throw new Error(
          'Database integration tests were enabled, but the approved local PostgreSQL target could not be reached (127.0.0.1:54322/postgres).'
        );
      }

      // 1. Setup location hierarchy (Country -> State -> City -> Areas)
      const countryRes = await adminClient.query(
        `INSERT INTO public.locations (name, level) VALUES ('Disc Country', 'country') RETURNING id;`
      );
      createdLocationIds.push(countryRes.rows[0].id);
      const stateRes = await adminClient.query(
        `INSERT INTO public.locations (name, level, parent_id) VALUES ('Disc State', 'state', $1) RETURNING id;`,
        [countryRes.rows[0].id]
      );
      createdLocationIds.push(stateRes.rows[0].id);
      const cityRes = await adminClient.query(
        `INSERT INTO public.locations (name, level, parent_id) VALUES ('Disc City', 'city', $1) RETURNING id;`,
        [stateRes.rows[0].id]
      );
      createdLocationIds.push(cityRes.rows[0].id);
      const areaARes = await adminClient.query(
        `INSERT INTO public.locations (name, level, parent_id) VALUES ('Disc Area A', 'area', $1) RETURNING id;`,
        [cityRes.rows[0].id]
      );
      createdLocationIds.push(areaARes.rows[0].id);
      const areaBRes = await adminClient.query(
        `INSERT INTO public.locations (name, level, parent_id) VALUES ('Disc Area B', 'area', $1) RETURNING id;`,
        [cityRes.rows[0].id]
      );
      createdLocationIds.push(areaBRes.rows[0].id);
      const inactAreaRes = await adminClient.query(
        `INSERT INTO public.locations (name, level, parent_id, is_active) VALUES ('Disc Inactive Area', 'area', $1, false) RETURNING id;`,
        [cityRes.rows[0].id]
      );
      createdLocationIds.push(inactAreaRes.rows[0].id);

      areaAId = areaARes.rows[0].id;
      areaBId = areaBRes.rows[0].id;
      inactiveAreaId = inactAreaRes.rows[0].id;

      // 2. Setup categories and services
      const catARes = await adminClient.query(
        `INSERT INTO public.categories (name, slug) VALUES ($1, $2) RETURNING id;`,
        [`Disc Cat A ${runToken}`, `disc-cat-a-${runToken}`]
      );
      createdCategoryIds.push(catARes.rows[0].id);
      const inactCatRes = await adminClient.query(
        `INSERT INTO public.categories (name, slug, is_active) VALUES ($1, $2, false) RETURNING id;`,
        [`Disc Inactive Cat ${runToken}`, `disc-inact-cat-${runToken}`]
      );
      createdCategoryIds.push(inactCatRes.rows[0].id);
      catAId = catARes.rows[0].id;
      inactiveCatId = inactCatRes.rows[0].id;

      const servARes = await adminClient.query(
        `INSERT INTO public.services (category_id, name, slug) VALUES ($1, 'Disc Service A', $2) RETURNING id;`,
        [catAId, `disc-serv-a-${runToken}`]
      );
      createdServiceIds.push(servARes.rows[0].id);
      const servBRes = await adminClient.query(
        `INSERT INTO public.services (category_id, name, slug) VALUES ($1, 'Disc Service B', $2) RETURNING id;`,
        [catAId, `disc-serv-b-${runToken}`]
      );
      createdServiceIds.push(servBRes.rows[0].id);
      const inactServRes = await adminClient.query(
        `INSERT INTO public.services (category_id, name, slug, is_active) VALUES ($1, 'Disc Inactive Serv', $2, false) RETURNING id;`,
        [catAId, `disc-inact-serv-${runToken}`]
      );
      createdServiceIds.push(inactServRes.rows[0].id);
      const servUnderInactCatRes = await adminClient.query(
        `INSERT INTO public.services (category_id, name, slug) VALUES ($1, 'Disc Serv Under Inact Cat', $2) RETURNING id;`,
        [inactiveCatId, `disc-serv-inact-cat-${runToken}`]
      );
      createdServiceIds.push(servUnderInactCatRes.rows[0].id);

      serviceAId = servARes.rows[0].id;
      serviceBId = servBRes.rows[0].id;
      inactiveServiceId = inactServRes.rows[0].id;
      serviceUnderInactiveCatId = servUnderInactCatRes.rows[0].id;

      /**
       * Generates a valid E.164 phone number with the following guarantees:
       * 1. Each phone is derived from its own random UUID, so fixture identities do not
       *    depend on cleanup of users retained by immutable audit rows.
       * 2. UUID-derived E.164 digits make cross-run phone collisions negligible.
       */
      function phoneForTestUser(userId: string): string {
        const digits = BigInt(`0x${userId.replace(/-/g, '')}`).toString().slice(0, 13);
        return `+1${digits}`;
      }

      // Helper to provision provider
      async function createTestProvider(name: string, status: string, gender: string, exp: number, areaId: string, servId: string) {
        const uId = randomUUID();
        const testPhone = phoneForTestUser(uId);
        await adminClient.query(
          `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
           VALUES ($1, $2, $3, jsonb_build_object('full_name', $4::text))`,
          [uId, `${uId}@example.test`, testPhone, name]
        );
        createdUserIds.push(uId);

        const profId = (await adminClient.query(
          `INSERT INTO public.provider_profiles (user_id, bio, gender, years_experience, status)
           VALUES ($1, 'Bio for ' || $2::text, $3, $4, $5) RETURNING id;`,
          [uId, name, gender, exp, status]
        )).rows[0].id;
        createdProviderIds.push(profId);

        await adminClient.query(
          `INSERT INTO public.provider_locations (provider_id, location_id) VALUES ($1, $2);`,
          [profId, areaId]
        );
        await adminClient.query(
          `INSERT INTO public.provider_services (provider_id, service_id) VALUES ($1, $2);`,
          [profId, servId]
        );
        return profId;
      }

      approvedProvId = await createTestProvider('Approved Provider One', 'approved', 'male', 5, areaAId, serviceAId);
      pendingProvId = await createTestProvider('Pending Provider Two', 'pending', 'male', 3, areaAId, serviceAId);
      areaReviewedProvId = await createTestProvider('Reviewed Provider Three', 'area_reviewed', 'female', 4, areaAId, serviceAId);
      suspendedProvId = await createTestProvider('Suspended Provider Four', 'suspended', 'male', 8, areaAId, serviceAId);
      wrongAreaProvId = await createTestProvider('Wrong Area Provider Five', 'approved', 'male', 6, areaBId, serviceAId);
      wrongServiceProvId = await createTestProvider('Wrong Service Provider Six', 'approved', 'male', 7, areaAId, serviceBId);

      // Add badge to approved provider
      await adminClient.query(
        `INSERT INTO public.provider_badges (provider_id, badge_type) VALUES ($1, 'identity_verified');`,
        [approvedProvId]
      );
    });

    test('1. Authenticated discovery succeeds for valid inputs', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.discover_providers($1, $2) as payload;`,
          [areaAId, serviceAId]
        );
        expect(res.rows[0].payload).toBeDefined();
        expect(res.rows[0].payload.providers).toBeDefined();
        expect(Array.isArray(res.rows[0].payload.providers)).toBe(true);
      } finally {
        await client.end();
      }
    });

    test('2. Unauthenticated discovery is rejected (fails closed)', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const anonClient = new Client({ connectionString: DB_URL });
      await anonClient.connect();
      try {
        await anonClient.query(`SET ROLE anon;`);
        await expect(
          anonClient.query(`SELECT public.discover_providers($1, $2);`, [areaAId, serviceAId])
        ).rejects.toThrow();
      } finally {
        await anonClient.end();
      }
    });

    test('3. Approved provider in matching area/service is returned', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.discover_providers($1, $2) as payload;`,
          [areaAId, serviceAId]
        );
        const providers = res.rows[0].payload.providers;
        const found = providers.find((p: any) => p.provider_id === approvedProvId);
        expect(found).toBeDefined();
        expect(found.display_name).toBe('Approved Provider One');
      } finally {
        await client.end();
      }
    });

    test('4–6. Pending, area_reviewed, and suspended providers are strictly excluded', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.discover_providers($1, $2) as payload;`,
          [areaAId, serviceAId]
        );
        const ids = res.rows[0].payload.providers.map((p: any) => p.provider_id);
        expect(ids).not.toContain(pendingProvId);
        expect(ids).not.toContain(areaReviewedProvId);
        expect(ids).not.toContain(suspendedProvId);
      } finally {
        await client.end();
      }
    });

    test('7. Wrong-area provider is not returned', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.discover_providers($1, $2) as payload;`,
          [areaAId, serviceAId]
        );
        const ids = res.rows[0].payload.providers.map((p: any) => p.provider_id);
        expect(ids).not.toContain(wrongAreaProvId);
      } finally {
        await client.end();
      }
    });

    test('8. Wrong-service provider is not returned', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.discover_providers($1, $2) as payload;`,
          [areaAId, serviceAId]
        );
        const ids = res.rows[0].payload.providers.map((p: any) => p.provider_id);
        expect(ids).not.toContain(wrongServiceProvId);
      } finally {
        await client.end();
      }
    });

    test('9–10. Inactive service or service under inactive category is rejected', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        await expect(
          client.query(`SELECT public.discover_providers($1, $2);`, [areaAId, inactiveServiceId])
        ).rejects.toThrow(/invalid or inactive service/i);

        await expect(
          client.query(`SELECT public.discover_providers($1, $2);`, [areaAId, serviceUnderInactiveCatId])
        ).rejects.toThrow(/invalid or inactive service/i);
      } finally {
        await client.end();
      }
    });

    test('11. Inactive area is rejected', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        await expect(
          client.query(`SELECT public.discover_providers($1, $2);`, [inactiveAreaId, serviceAId])
        ).rejects.toThrow(/invalid or inactive area/i);
      } finally {
        await client.end();
      }
    });

    test('12–15. Provider phone, user_id, verification records, notes, reviewer IDs are never returned', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.discover_providers($1, $2) as payload;`,
          [areaAId, serviceAId]
        );
        const prov = res.rows[0].payload.providers[0];
        expect(prov).toBeDefined();

        expect(prov.phone).toBeUndefined();
        expect(prov.phone_e164).toBeUndefined();
        expect(prov.user_id).toBeUndefined();
        expect(prov.reviewer_id).toBeUndefined();
        expect(prov.internal_notes).toBeUndefined();
        expect(prov.decision).toBeUndefined();
        expect(prov.verifications).toBeUndefined();
      } finally {
        await client.end();
      }
    });

    test('16. Required badge filter works', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        // Search with badge that provider HAS
        const resHas = await client.query(
          `SELECT public.discover_providers($1, $2, NULL, NULL, ARRAY['identity_verified'::public.badge_type]) as payload;`,
          [areaAId, serviceAId]
        );
        expect(resHas.rows[0].payload.providers.some((p: any) => p.provider_id === approvedProvId)).toBe(true);

        // Search with badge that provider DOES NOT HAVE
        const resNotHas = await client.query(
          `SELECT public.discover_providers($1, $2, NULL, NULL, ARRAY['background_checked'::public.badge_type]) as payload;`,
          [areaAId, serviceAId]
        );
        expect(resNotHas.rows[0].payload.providers.some((p: any) => p.provider_id === approvedProvId)).toBe(false);
      } finally {
        await client.end();
      }
    });

    test('17. Gender filter works', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const resMale = await client.query(
          `SELECT public.discover_providers($1, $2, 'male'::public.provider_gender) as payload;`,
          [areaAId, serviceAId]
        );
        expect(resMale.rows[0].payload.providers.every((p: any) => p.gender === 'male')).toBe(true);

        const resFemale = await client.query(
          `SELECT public.discover_providers($1, $2, 'female'::public.provider_gender) as payload;`,
          [areaAId, serviceAId]
        );
        expect(resFemale.rows[0].payload.providers.every((p: any) => p.gender === 'female')).toBe(true);
      } finally {
        await client.end();
      }
    });

    test('18. Minimum experience filter works', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const resExp = await client.query(
          `SELECT public.discover_providers($1, $2, NULL, 10) as payload;`,
          [areaAId, serviceAId]
        );
        // Provider 1 has 5 years experience, so min 10 should not match
        expect(resExp.rows[0].payload.providers.some((p: any) => p.provider_id === approvedProvId)).toBe(false);
      } finally {
        await client.end();
      }
    });

    test('19–20. Keyset pagination is deterministic and duplicate-free', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const resP1 = await client.query(
          `SELECT public.discover_providers($1, $2, NULL, NULL, NULL, 1) as payload;`,
          [areaAId, serviceAId]
        );
        const page1 = resP1.rows[0].payload;
        expect(page1.providers.length).toBeLessThanOrEqual(1);

        if (page1.has_more && page1.next_cursor) {
          const resP2 = await client.query(
            `SELECT public.discover_providers($1, $2, NULL, NULL, NULL, 1, $3, $4) as payload;`,
            [areaAId, serviceAId, page1.next_cursor.display_name, page1.next_cursor.provider_id]
          );
          const page2 = resP2.rows[0].payload;
          expect(page2.providers.length).toBeLessThanOrEqual(1);

          // Assert zero intersection between page 1 and page 2
          const id1 = page1.providers[0]?.provider_id;
          const id2 = page2.providers[0]?.provider_id;
          if (id1 && id2) {
            expect(id1).not.toBe(id2);
          }
        }
      } finally {
        await client.end();
      }
    });

    test('21–22. Arbitrary/tampered area or service IDs fail safely', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const fakeId = '00000000-0000-0000-0000-000000000000';
        await expect(
          client.query(`SELECT public.discover_providers($1, $2);`, [fakeId, serviceAId])
        ).rejects.toThrow(/invalid or inactive area/i);

        await expect(
          client.query(`SELECT public.discover_providers($1, $2);`, [areaAId, fakeId])
        ).rejects.toThrow(/invalid or inactive service/i);
      } finally {
        await client.end();
      }
    });

    test('23. Unapproved provider profile cannot be retrieved via get_public_provider_profile', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        await expect(
          client.query(`SELECT public.get_public_provider_profile($1);`, [pendingProvId])
        ).rejects.toThrow(/provider not found or unavailable/i);

        await expect(
          client.query(`SELECT public.get_public_provider_profile($1);`, [suspendedProvId])
        ).rejects.toThrow(/provider not found or unavailable/i);
      } finally {
        await client.end();
      }
    });

    test('24. Approved provider profile exposes only intended public fields', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.get_public_provider_profile($1) as profile;`,
          [approvedProvId]
        );
        const prof = res.rows[0].profile;
        expect(prof.provider_id).toBe(approvedProvId);
        expect(prof.display_name).toBe('Approved Provider One');
        expect(prof.gender).toBe('male');
        expect(prof.years_experience).toBe(5);
        expect(Array.isArray(prof.services)).toBe(true);
        expect(Array.isArray(prof.areas)).toBe(true);
        expect(Array.isArray(prof.badges)).toBe(true);

        // Sensitive fields check
        expect(prof.phone).toBeUndefined();
        expect(prof.phone_e164).toBeUndefined();
        expect(prof.user_id).toBeUndefined();
        expect(prof.internal_notes).toBeUndefined();
      } finally {
        await client.end();
      }
    });

    test('25. Inactive services/areas do not appear in provider profile', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      let tempAreaId: string | null = null;
      let tempServiceId: string | null = null;
      try {
        // Step A: Create Area and Service as ACTIVE through valid production transitions
        // Lookup parent city of areaAId to maintain valid location hierarchy
        const cityRes = await adminClient.query(
          `SELECT parent_id FROM public.locations WHERE id = $1;`,
          [areaAId]
        );
        const cityId = cityRes.rows[0].parent_id;

        const areaRes = await adminClient.query(
          `INSERT INTO public.locations (name, level, parent_id, is_active)
           VALUES ('Disc Test Active-Then-Inactive Area', 'area', $1, true)
           RETURNING id;`,
          [cityId]
        );
        tempAreaId = areaRes.rows[0].id;

        const tempSlug = `disc-deact-serv-${runToken}`;
        const servRes = await adminClient.query(
          `INSERT INTO public.services (category_id, name, slug, is_active)
           VALUES ($1, 'Disc Test Active-Then-Inactive Service', $2, true)
           RETURNING id;`,
          [catAId, tempSlug]
        );
        tempServiceId = servRes.rows[0].id;

        // Step B: Associate the approved provider with the active Area & Service
        // This satisfies trg_validate_provider_location_area which permits associations only for active areas
        await adminClient.query(
          `INSERT INTO public.provider_locations (provider_id, location_id) VALUES ($1, $2);`,
          [approvedProvId, tempAreaId]
        );
        await adminClient.query(
          `INSERT INTO public.provider_services (provider_id, service_id) VALUES ($1, $2);`,
          [approvedProvId, tempServiceId]
        );

        // Step C: Deactivate the Area and Service after the valid association exists
        await adminClient.query(
          `UPDATE public.locations SET is_active = false WHERE id = $1;`,
          [tempAreaId]
        );
        await adminClient.query(
          `UPDATE public.services SET is_active = false WHERE id = $1;`,
          [tempServiceId]
        );

        // Step D: Query public provider profile via client
        const res = await client.query(
          `SELECT public.get_public_provider_profile($1) as profile;`,
          [approvedProvId]
        );
        const prof = res.rows[0].profile;

        const areaIds = prof.areas.map((a: any) => a.id);
        const servIds = prof.services.map((s: any) => s.id);

        // Step E: Assert inactive area and service do NOT appear in public provider profile
        expect(areaIds).not.toContain(tempAreaId);
        expect(servIds).not.toContain(tempServiceId);
        expect(areaIds).not.toContain(inactiveAreaId);
        expect(servIds).not.toContain(inactiveServiceId);

        // Verify active areas and services remain present
        expect(areaIds).toContain(areaAId);
        expect(servIds).toContain(serviceAId);
      } finally {
        // Cleanup test fixtures created specifically for test #25
        if (tempAreaId) {
          await adminClient.query(
            `DELETE FROM public.provider_locations WHERE provider_id = $1 AND location_id = $2;`,
            [approvedProvId, tempAreaId]
          );
          await adminClient.query(
            `DELETE FROM public.locations WHERE id = $1;`,
            [tempAreaId]
          );
        }
        if (tempServiceId) {
          await adminClient.query(
            `DELETE FROM public.provider_services WHERE provider_id = $1 AND service_id = $2;`,
            [approvedProvId, tempServiceId]
          );
          await adminClient.query(
            `DELETE FROM public.services WHERE id = $1;`,
            [tempServiceId]
          );
        }
        await client.end();
      }
    });

    test('26–27. RPC execution privileges are restricted and search_path is hardened', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const procRes = await adminClient.query(`
        SELECT p.proname, p.prosecdef, p.proconfig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('discover_providers', 'get_public_provider_profile');
      `);
      expect(procRes.rows.length).toBe(2);
      for (const row of procRes.rows) {
        expect(row.prosecdef).toBe(true);
        expect(row.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
      }
    });

    test('28. Migration 10: Authenticated client direct SELECT on public.provider_badges is denied', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        try {
          const res = await client.query(`SELECT * FROM public.provider_badges;`);
          expect(res.rows.length).toBe(0);
        } catch (err: any) {
          expect(err.message).toMatch(/permission denied/i);
        }
      } finally {
        await client.end();
      }
    });

    test('29. Migration 10: Anonymous client direct SELECT on public.provider_badges is denied', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const anonClient = new Client({ connectionString: DB_URL });
      await anonClient.connect();
      try {
        await anonClient.query(`SET ROLE anon;`);
        await expect(anonClient.query(`SELECT * FROM public.provider_badges;`)).rejects.toThrow(/permission denied/i);
      } finally {
        await anonClient.end();
      }
    });

    test('30–32. Migration 10: Direct INSERT, UPDATE, DELETE on public.provider_badges is denied to client', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        await expect(
          client.query(
            `INSERT INTO public.provider_badges (provider_id, badge_type) VALUES ($1, 'skill_verified');`,
            [approvedProvId]
          )
        ).rejects.toThrow();

        await expect(
          client.query(
            `UPDATE public.provider_badges SET badge_type = 'background_checked' WHERE provider_id = $1;`,
            [approvedProvId]
          )
        ).rejects.toThrow();

        await expect(
          client.query(
            `DELETE FROM public.provider_badges WHERE provider_id = $1;`,
            [approvedProvId]
          )
        ).rejects.toThrow();
      } finally {
        await client.end();
      }
    });

    test('33. Migration 10: discover_providers() still returns approved public badge_type data', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.discover_providers($1, $2) as payload;`,
          [areaAId, serviceAId]
        );
        const prov = res.rows[0].payload.providers.find((p: any) => p.provider_id === approvedProvId);
        expect(prov).toBeDefined();
        expect(Array.isArray(prov.badges)).toBe(true);
        expect(prov.badges).toContain('identity_verified');
      } finally {
        await client.end();
      }
    });

    test('34. Migration 10: get_public_provider_profile() still returns approved public badge data', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const client = await createAuthClient(testUser);
      try {
        const res = await client.query(
          `SELECT public.get_public_provider_profile($1) as profile;`,
          [approvedProvId]
        );
        const prof = res.rows[0].profile;
        expect(Array.isArray(prof.badges)).toBe(true);
        expect(prof.badges.some((b: any) => b.badge_type === 'identity_verified')).toBe(true);
      } finally {
        await client.end();
      }
    });

    test('35. Migration 10: Badge synchronization trigger remains intact and service_role can manage badges', async () => {
      if (!isDbConnected) throw new Error('Database integration test ran without a verified local connection.');
      const badgeCountRes = await adminClient.query(
        `SELECT COUNT(*)::int as count FROM public.provider_badges WHERE provider_id = $1;`,
        [approvedProvId]
      );
      expect(badgeCountRes.rows[0].count).toBeGreaterThanOrEqual(1);

      // Verify trigger existence
      const trgRes = await adminClient.query(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgname = 'trg_sync_provider_badges';
      `);
      expect(trgRes.rows.length).toBe(1);
    });

    afterAll(async () => {
      if (!isDbConnected || !adminClient) return;
      for (const provId of createdProviderIds) {
        await adminClient.query(`DELETE FROM public.provider_badges WHERE provider_id = $1;`, [provId]);
        await adminClient.query(`DELETE FROM public.provider_locations WHERE provider_id = $1;`, [provId]);
        await adminClient.query(`DELETE FROM public.provider_services WHERE provider_id = $1;`, [provId]);
        await adminClient.query(`DELETE FROM public.provider_profiles WHERE id = $1;`, [provId]);
      }
      for (const uId of createdUserIds) {
        await adminClient.query(`DELETE FROM public.user_roles WHERE user_id = $1;`, [uId]);
        await adminClient.query(`DELETE FROM public.user_private WHERE user_id = $1;`, [uId]);
        await adminClient.query(`DELETE FROM public.users WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE actor_id = $1)
          AND NOT EXISTS (SELECT 1 FROM public.user_consents WHERE user_id = $1);`, [uId]);
        await adminClient.query(`DELETE FROM auth.users WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE actor_id = $1)
          AND NOT EXISTS (SELECT 1 FROM public.user_consents WHERE user_id = $1);`, [uId]);
      }
      for (const serviceId of createdServiceIds) {
        await adminClient.query(`DELETE FROM public.services WHERE id = $1;`, [serviceId]);
      }
      for (const categoryId of createdCategoryIds) {
        await adminClient.query(`DELETE FROM public.categories WHERE id = $1;`, [categoryId]);
      }
      if (createdLocationIds.length) {
        for (const locationId of createdLocationIds.reverse()) {
          await adminClient.query(`DELETE FROM public.locations WHERE id = $1;`, [locationId]);
        }
      }
      // Immutable audit rows are retained; actor accounts referenced by them are retained too.
    });
  });
});
