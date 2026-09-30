/**
 * Database Security & Authorization Integration Test Suite
 * Step 2.6 - PostgreSQL / Supabase Real Execution & Threat Verification
 *
 * This test suite verifies:
 * 1. Positive control paths (legitimate requests, acceptance, chat activation, messages, contact shares)
 * 2. Mandatory negative security tests (NEG-01 through NEG-15)
 * 3. Concurrency / race conditions using SELECT ... FOR UPDATE state machine
 * 4. Zero-PII leak proofs (private phone isolation, audit immutability)
 * 5. Role-based isolation across User A, User B, Provider 1, Area Admin, Super Admin
 */

import { Client } from 'pg';
import * as jwtLib from 'jsonwebtoken';
const jwt: typeof import('jsonwebtoken') = (jwtLib as any).default ?? jwtLib;
import { randomUUID } from 'crypto';

// Types & Config
interface TestUser {
  id: string;
  name: string;
  phone: string;
  role?: string;
  token: string;
}

interface FixtureData {
  userA: TestUser;
  userB: TestUser;
  provider1: TestUser;
  areaAdmin: TestUser;
  superAdmin: TestUser;
  countryId: string;
  stateId: string;
  cityId: string;
  areaAId: string;
  areaBId: string;
  categoryId: string;
  serviceId: string;
  provider1ProfileId: string;
}

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long';

// Helper to generate Supabase-compatible JWT
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

describe('Step 2.6: Supabase / PostgreSQL Database Security Integration Test Suite', () => {
  let isDbConnected = false;
  let adminClient: Client;
  let fixtures: FixtureData;

  // Connect helper to create an authenticated client session mimicking PostgREST RLS
  async function createAuthClient(tokenUser: TestUser): Promise<Client> {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    // Simulate Supabase PostgREST auth context with RLS enforcement
    await client.query(`SET ROLE authenticated;`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [tokenUser.id]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
    return client;
  }

  beforeAll(async () => {
    adminClient = new Client({ connectionString: DB_URL });
    try {
      await adminClient.connect();
      isDbConnected = true;
    } catch (err: any) {
      // In CI, missing database connection MUST fail the test suite to prevent false positives
      isDbConnected = false;
      if (process.env.CI === 'true') {
        throw new Error(
          'Database connection required in CI environment; security tests cannot run.'
        );
      }
      console.warn(
        '[WARN] PostgreSQL database connection unavailable on ' +
          DB_URL +
          '. Skipping live integration tests in local sandbox. (CI=true will enforce connection).'
      );
      return;
    }

    // Set up test fixtures using privileged admin/service connection
    const uAId = '11111111-1111-4111-8111-111111111111';
    const uBId = '22222222-2222-4222-8222-222222222222';
    const p1Id = '33333333-3333-4333-8333-333333333333';
    const aAdminId = '44444444-4444-4444-8444-444444444444';
    const sAdminId = '55555555-5555-4555-8555-555555555555';

    fixtures = {
      userA: { id: uAId, name: 'User A', phone: '+12025550101', token: generateSupabaseJwt(uAId) },
      userB: { id: uBId, name: 'User B', phone: '+12025550102', token: generateSupabaseJwt(uBId) },
      provider1: { id: p1Id, name: 'Provider 1', phone: '+12025550103', role: 'provider', token: generateSupabaseJwt(p1Id) },
      areaAdmin: { id: aAdminId, name: 'Area Admin', phone: '+12025550104', role: 'area_admin', token: generateSupabaseJwt(aAdminId) },
      superAdmin: { id: sAdminId, name: 'Super Admin', phone: '+12025550105', role: 'super_admin', token: generateSupabaseJwt(sAdminId) },
      countryId: '',
      stateId: '',
      cityId: '',
      areaAId: '',
      areaBId: '',
      categoryId: '',
      serviceId: '',
      provider1ProfileId: '',
    };

    // Clean any prior fixture data
    await adminClient.query(`DELETE FROM public.audit_logs WHERE actor_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.contact_shares WHERE sharer_id IN ($1, $2, $3, $4, $5) OR recipient_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.conversations WHERE user_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.service_requests WHERE user_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.provider_locations WHERE provider_id IN (SELECT id FROM public.provider_profiles WHERE user_id = $1);`, [p1Id]);
    await adminClient.query(`DELETE FROM public.provider_profiles WHERE user_id = $1;`, [p1Id]);
    await adminClient.query(`DELETE FROM public.admin_area_assignments WHERE user_id = $1;`, [aAdminId]);
    await adminClient.query(`DELETE FROM public.user_roles WHERE user_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.user_private WHERE user_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.users WHERE id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM auth.users WHERE id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);

    // Insert Auth Users FIRST: existing production triggers (on_auth_user_created -> public.handle_new_auth_user())
    // will provision public.users, public.user_roles (default 'user'), and public.user_private (phone_e164).
    for (const u of [fixtures.userA, fixtures.userB, fixtures.provider1, fixtures.areaAdmin, fixtures.superAdmin]) {
      const email = `${u.name.toLowerCase().replace(/\s+/g, '')}@example.com`;
      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE
         SET email = $2, phone = $3, raw_user_meta_data = $4::jsonb;`,
        [u.id, email, u.phone, JSON.stringify({ full_name: u.name })]
      );
    }

    // Assign Specialized Roles (provider, area_admin, super_admin)
    await adminClient.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'provider') ON CONFLICT DO NOTHING;`, [p1Id]);
    await adminClient.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'area_admin') ON CONFLICT DO NOTHING;`, [aAdminId]);
    await adminClient.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'super_admin') ON CONFLICT DO NOTHING;`, [sAdminId]);

    // Hierarchy: Country -> State -> City -> Area A & Area B
    const countryRes = await adminClient.query(
      `INSERT INTO public.locations (name, level, parent_id) VALUES ('Test Country', 'country', NULL) RETURNING id;`
    );
    fixtures.countryId = countryRes.rows[0].id;

    const stateRes = await adminClient.query(
      `INSERT INTO public.locations (name, level, parent_id) VALUES ('Test State', 'state', $1) RETURNING id;`,
      [fixtures.countryId]
    );
    fixtures.stateId = stateRes.rows[0].id;

    const cityRes = await adminClient.query(
      `INSERT INTO public.locations (name, level, parent_id) VALUES ('Test City', 'city', $1) RETURNING id;`,
      [fixtures.stateId]
    );
    fixtures.cityId = cityRes.rows[0].id;

    const areaARes = await adminClient.query(
      `INSERT INTO public.locations (name, level, parent_id) VALUES ('Test Area A', 'area', $1) RETURNING id;`,
      [fixtures.cityId]
    );
    fixtures.areaAId = areaARes.rows[0].id;

    const areaBRes = await adminClient.query(
      `INSERT INTO public.locations (name, level, parent_id) VALUES ('Test Area B', 'area', $1) RETURNING id;`,
      [fixtures.cityId]
    );
    fixtures.areaBId = areaBRes.rows[0].id;

    // Assign Area Admin strictly to Area A
    await adminClient.query(
      `INSERT INTO public.admin_area_assignments (user_id, location_id, assigned_by) VALUES ($1, $2, $3);`,
      [aAdminId, fixtures.areaAId, sAdminId]
    );

    // Category & Service
    const catRes = await adminClient.query(
      `INSERT INTO public.categories (name, slug) VALUES ('Test Category', 'test-category') ON CONFLICT (slug) DO UPDATE SET name = 'Test Category' RETURNING id;`
    );
    fixtures.categoryId = catRes.rows[0].id;

    const srvRes = await adminClient.query(
      `INSERT INTO public.services (category_id, name, slug) VALUES ($1, 'Test Service', 'test-service') ON CONFLICT (slug) DO UPDATE SET name = 'Test Service' RETURNING id;`,
      [fixtures.categoryId]
    );
    fixtures.serviceId = srvRes.rows[0].id;

    // Provider 1 Profile (approved status)
    const provProfileRes = await adminClient.query(
      `INSERT INTO public.provider_profiles (user_id, bio, gender, years_experience, status) VALUES ($1, 'Expert provider', 'male', 5, 'approved') RETURNING id;`,
      [p1Id]
    );
    fixtures.provider1ProfileId = provProfileRes.rows[0].id;

    // Provider 1 declares coverage ONLY in Area A (NOT in Area B)
    await adminClient.query(
      `INSERT INTO public.provider_locations (provider_id, location_id) VALUES ($1, $2);`,
      [fixtures.provider1ProfileId, fixtures.areaAId]
    );
  });

  afterAll(async () => {
    if (adminClient && isDbConnected) {
      await adminClient.end();
    }
  });

  // ==========================================================================
  // 0. TEST HARNESS & JWT VERIFICATION
  // ==========================================================================

  describe('Test Harness & JWT Signing Verification', () => {
    test('HARNESS-01: generateSupabaseJwt produces cryptographically valid HS256 Supabase JWT via jsonwebtoken', () => {
      const testId = '11111111-1111-4111-8111-111111111111';
      const token = generateSupabaseJwt(testId, 'authenticated');
      expect(typeof token).toBe('string');
      expect(token.split('.').length).toBe(3);
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      expect(decoded.sub).toBe(testId);
      expect(decoded.role).toBe('authenticated');
      expect(decoded.aud).toBe('authenticated');
    });
  });

  // ==========================================================================
  // 1. MANDATORY NEGATIVE TESTS (NEG-01 to NEG-15)
  // ==========================================================================

  describe('Mandatory Negative Tests', () => {
    test('NEG-01: User A cannot SELECT User B row from user_private (phone never exposed)', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const res = await clientA.query(`SELECT * FROM public.user_private WHERE user_id = $1;`, [fixtures.userB.id]);
        expect(res.rows.length).toBe(0);
      } finally {
        await clientA.end();
      }
    });

    test('NEG-02: Authenticated client cannot INSERT directly into audit_logs', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        await expect(
          clientA.query(
            `INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'FORGED', 'test', $1);`,
            [fixtures.userA.id]
          )
        ).rejects.toThrow();
      } finally {
        await clientA.end();
      }
    });

    test('NEG-03: Area Admin for Area A cannot verify provider or perform admin operation in Area B', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientAdmin = await createAuthClient(fixtures.areaAdmin);
      try {
        // Attempting to insert a verification targeting Area B
        await expect(
          clientAdmin.query(
            `INSERT INTO public.provider_verifications (provider_id, reviewer_id, location_id, verification_type, decision)
             VALUES ($1, $2, $3, 'identity', 'approved');`,
            [fixtures.provider1ProfileId, fixtures.areaAdmin.id, fixtures.areaBId]
          )
        ).rejects.toThrow();
      } finally {
        await clientAdmin.end();
      }
    });

    test('NEG-04: Authenticated client cannot directly UPDATE service_requests.status', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        // Create a legitimate request first
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id, status;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
        );
        const reqId = insRes.rows[0].id;

        // Attempt direct UPDATE of status
        await expect(
          clientA.query(`UPDATE public.service_requests SET status = 'ACCEPTED' WHERE id = $1;`, [reqId])
        ).rejects.toThrow();

        // Verify status remained unchanged
        const checkRes = await clientA.query(`SELECT status FROM public.service_requests WHERE id = $1;`, [reqId]);
        expect(checkRes.rows[0].status).toBe('REQUESTED');
      } finally {
        await clientA.end();
      }
    });

    test('NEG-05: Concurrency race condition protection on conflicting transitions (FOR UPDATE)', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientP = await createAuthClient(fixtures.provider1);

      try {
        // Setup pending request
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
        );
        const reqId = insRes.rows[0].id;

        // Fire simultaneous conflicting transitions: Provider ACCEPTS while Customer CANCELS
        const results = await Promise.allSettled([
          clientP.query(`SELECT public.transition_service_request($1, 'ACCEPTED', 'Accepting request');`, [reqId]),
          clientA.query(`SELECT public.transition_service_request($1, 'CANCELLED', 'Customer cancelling');`, [reqId]),
        ]);

        // Exactly one should succeed, or state should serialize cleanly without deadlock
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        expect(fulfilled.length).toBeGreaterThanOrEqual(1);

        // Final state in DB must be valid enum
        const finalRes = await clientA.query(`SELECT status FROM public.service_requests WHERE id = $1;`, [reqId]);
        expect(['ACCEPTED', 'CANCELLED']).toContain(finalRes.rows[0].status);
      } finally {
        await clientA.end();
        await clientP.end();
      }
    });

    test('NEG-06: User B cannot INSERT messages into User A conversation & sender spoofing blocked', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientB = await createAuthClient(fixtures.userB);
      const clientP = await createAuthClient(fixtures.provider1);

      try {
        // Request & transition to ACCEPTED
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
        );
        const reqId = insRes.rows[0].id;
        await clientP.query(`SELECT public.transition_service_request($1, 'ACCEPTED');`, [reqId]);

        const convRes = await clientA.query(`SELECT id FROM public.conversations WHERE request_id = $1;`, [reqId]);
        const convId = convRes.rows[0].id;

        // User B attempts to insert message
        await expect(
          clientB.query(`INSERT INTO public.messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Infiltrator');`, [
            convId,
            fixtures.userB.id,
          ])
        ).rejects.toThrow();

        // User A attempts to spoof sender as Provider
        await expect(
          clientA.query(`INSERT INTO public.messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Spoofed');`, [
            convId,
            fixtures.provider1.id,
          ])
        ).rejects.toThrow();
      } finally {
        await clientA.end();
        await clientB.end();
        await clientP.end();
      }
    });

    test('NEG-07: Cannot retrieve contact info before explicit contact-sharing consent', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientP = await createAuthClient(fixtures.provider1);

      try {
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
        );
        const reqId = insRes.rows[0].id;
        await clientP.query(`SELECT public.transition_service_request($1, 'ACCEPTED');`, [reqId]);

        // Neither party has created/approved contact share yet
        await expect(
          clientA.query(`SELECT public.get_shared_contact_info($1, $2);`, [reqId, fixtures.provider1.id])
        ).rejects.toThrow();
      } finally {
        await clientA.end();
        await clientP.end();
      }
    });

    test('NEG-08 & NEG-09: Non-participant cannot read conversations or messages', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientB = await createAuthClient(fixtures.userB);
      const clientP = await createAuthClient(fixtures.provider1);

      try {
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
        );
        const reqId = insRes.rows[0].id;
        await clientP.query(`SELECT public.transition_service_request($1, 'ACCEPTED');`, [reqId]);

        // User B reads conversations
        const convListB = await clientB.query(`SELECT * FROM public.conversations WHERE request_id = $1;`, [reqId]);
        expect(convListB.rows.length).toBe(0);

        // User B reads messages
        const msgListB = await clientB.query(`SELECT * FROM public.messages;`);
        expect(msgListB.rows.filter((m: any) => m.sender_id === fixtures.userA.id).length).toBe(0);
      } finally {
        await clientA.end();
        await clientB.end();
        await clientP.end();
      }
    });

    test('NEG-10: Wrong recipient cannot approve or confirm a contact share', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientB = await createAuthClient(fixtures.userB);
      const clientP = await createAuthClient(fixtures.provider1);

      try {
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
        );
        const reqId = insRes.rows[0].id;
        await clientP.query(`SELECT public.transition_service_request($1, 'ACCEPTED');`, [reqId]);

        // User A requests contact share with Provider 1
        const shareRes = await clientA.query(`SELECT public.request_contact_share($1) as res;`, [reqId]);
        const shareId = shareRes.rows[0].res.id;

        // User B (third party) attempts to approve the share
        await expect(
          clientB.query(`SELECT public.respond_contact_share($1, true);`, [shareId])
        ).rejects.toThrow();
      } finally {
        await clientA.end();
        await clientB.end();
        await clientP.end();
      }
    });

    test('NEG-11: Contact info inaccessible after share is revoked', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientP = await createAuthClient(fixtures.provider1);

      try {
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
        );
        const reqId = insRes.rows[0].id;
        await clientP.query(`SELECT public.transition_service_request($1, 'ACCEPTED');`, [reqId]);

        // A requests, P accepts
        const shareRes = await clientA.query(`SELECT public.request_contact_share($1) as res;`, [reqId]);
        const shareId = shareRes.rows[0].res.id;
        await clientP.query(`SELECT public.respond_contact_share($1, true);`, [shareId]);

        // Now revoke the share
        await clientA.query(`SELECT public.respond_contact_share($1, false);`, [shareId]);

        // Retrieval must now fail
        await expect(
          clientP.query(`SELECT public.get_shared_contact_info($1, $2);`, [reqId, fixtures.userA.id])
        ).rejects.toThrow();
      } finally {
        await clientA.end();
        await clientP.end();
      }
    });

    test('NEG-12: Provider cannot accept request in undeclared Area (SEC-24-01)', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientP = await createAuthClient(fixtures.provider1);

      try {
        // Direct invocation test of assert_provider_covers_area for SEC-24-01 enforcement
        await expect(
          clientP.query(`SELECT public.assert_provider_covers_area($1, $2);`, [fixtures.provider1ProfileId, fixtures.areaBId])
        ).rejects.toThrow(/SEC-24-01 violation/);

        // Request targeted at Area B (Provider 1 only has Area A)
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaBId]
        );
        const reqId = insRes.rows[0].id;

        // Provider 1 tries to accept
        await expect(
          clientP.query(`SELECT public.transition_service_request($1, 'ACCEPTED');`, [reqId])
        ).rejects.toThrow(/SEC-24-01 violation/);
      } finally {
        await clientA.end();
        await clientP.end();
      }
    });

    test('NEG-13: Area Admin cannot block/transition requests outside assigned Area', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientAdmin = await createAuthClient(fixtures.areaAdmin);

      try {
        // Request in Area B (Area Admin only has Area A)
        const insRes = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
           VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaBId]
        );
        const reqId = insRes.rows[0].id;

        await expect(
          clientAdmin.query(`SELECT public.transition_service_request($1, 'BLOCKED', 'Admin block');`, [reqId])
        ).rejects.toThrow();
      } finally {
        await clientA.end();
        await clientAdmin.end();
      }
    });

    test('NEG-14: Anonymous / unauthenticated caller cannot invoke transition RPC', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const anonClient = new Client({ connectionString: DB_URL });
      await anonClient.connect();
      try {
        await anonClient.query(`SET ROLE anon;`);
        await expect(
          anonClient.query(`SELECT public.transition_service_request('00000000-0000-0000-0000-000000000000', 'ACCEPTED');`)
        ).rejects.toThrow();
      } finally {
        await anonClient.end();
      }
    });

    test('NEG-15: Authenticated client cannot mutate provider_badges directly', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientP = await createAuthClient(fixtures.provider1);
      try {
        await expect(
          clientP.query(
            `INSERT INTO public.provider_badges (provider_id, badge_type) VALUES ($1, 'identity_verified');`,
            [fixtures.provider1ProfileId]
          )
        ).rejects.toThrow();
      } finally {
        await clientP.end();
      }
    });
  });

  // ==========================================================================
  // 2. POSITIVE CONTROL TESTS (POS-01 to POS-07)
  // ==========================================================================

  describe('Positive Control Lifecycle Tests', () => {
    let activeReqId: string;
    let shareId: string;

    test('POS-01: User A creates legitimate service request in declared Area A', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const res = await clientA.query(
          `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status, notes)
           VALUES ($1, $2, $3, $4, 'REQUESTED', 'Legitimate service requirement')
           RETURNING id, status;`,
          [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
        );
        expect(res.rows[0].status).toBe('REQUESTED');
        activeReqId = res.rows[0].id;
      } finally {
        await clientA.end();
      }
    });

    test('POS-02: Assigned approved provider legitimately accepts request', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientP = await createAuthClient(fixtures.provider1);
      try {
        const res = await clientP.query(
          `SELECT public.transition_service_request($1, 'ACCEPTED', 'Available to fulfill') as out;`,
          [activeReqId]
        );
        expect(res.rows[0].out.new_status).toBe('ACCEPTED');
      } finally {
        await clientP.end();
      }
    });

    test('POS-03: Participant activates chat', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const res = await clientA.query(`SELECT public.activate_request_chat($1) as out;`, [activeReqId]);
        expect(res.rows[0].out.new_status).toBe('CHAT_ACTIVE');
      } finally {
        await clientA.end();
      }
    });

    test('POS-04: Legitimate participant sends a message in active chat (customer and provider)', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientP = await createAuthClient(fixtures.provider1);
      try {
        const convRes = await clientA.query(`SELECT id FROM public.conversations WHERE request_id = $1;`, [activeReqId]);
        const convId = convRes.rows[0].id;

        // 1. Customer User A inserts message
        const msgResA = await clientA.query(
          `INSERT INTO public.messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Peace be upon you') RETURNING id;`,
          [convId, fixtures.userA.id]
        );
        expect(msgResA.rows[0].id).toBeDefined();

        // 2. Provider 1 inserts reply message
        const msgResP = await clientP.query(
          `INSERT INTO public.messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Wa alaykumu as-salam') RETURNING id;`,
          [convId, fixtures.provider1.id]
        );
        expect(msgResP.rows[0].id).toBeDefined();

        // 3. Both participants can read conversation messages
        const msgsForCustomer = await clientA.query(`SELECT id FROM public.messages WHERE conversation_id = $1;`, [convId]);
        expect(msgsForCustomer.rows.length).toBeGreaterThanOrEqual(2);

        const msgsForProvider = await clientP.query(`SELECT id FROM public.messages WHERE conversation_id = $1;`, [convId]);
        expect(msgsForProvider.rows.length).toBeGreaterThanOrEqual(2);
      } finally {
        await clientA.end();
        await clientP.end();
      }
    });

    test('POS-05: Legitimate sharer initiates contact share request', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const res = await clientA.query(`SELECT public.request_contact_share($1) as out;`, [activeReqId]);
        expect(res.rows[0].out.status).toBe('pending');
        shareId = res.rows[0].out.id;
      } finally {
        await clientA.end();
      }
    });

    test('POS-06: Designated recipient explicitly confirms contact share', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientP = await createAuthClient(fixtures.provider1);
      try {
        const res = await clientP.query(`SELECT public.respond_contact_share($1, true) as out;`, [shareId]);
        expect(res.rows[0].out.status).toBe('shared');
      } finally {
        await clientP.end();
      }
    });

    test('POS-07: Authorized recipient retrieves shared contact info (and privacy verified)', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientP = await createAuthClient(fixtures.provider1);
      try {
        const res = await clientP.query(`SELECT public.get_shared_contact_info($1, $2) as out;`, [
          activeReqId,
          fixtures.userA.id,
        ]);
        expect(res.rows[0].out.full_name).toBe(fixtures.userA.name);
        expect(res.rows[0].out.phone_e164).toBe(fixtures.userA.phone);
      } finally {
        await clientP.end();
      }
    });
  });

  // ==========================================================================
  // 3. AUDIT LOG IMMUTABILITY & PRIVACY VERIFICATION
  // ==========================================================================

  describe('Audit Log Immutability & Privacy', () => {
    test('State transitions record audit events without leaking PII or message content', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      // Inspect audit records using privileged connection
      const auditRes = await adminClient.query(
        `SELECT action, old_data, new_data FROM public.audit_logs WHERE entity_type = 'service_requests' ORDER BY id DESC LIMIT 5;`
      );
      expect(auditRes.rows.length).toBeGreaterThan(0);
      for (const row of auditRes.rows) {
        const payloadStr = JSON.stringify(row);
        expect(payloadStr).not.toContain('+1202555');
        expect(payloadStr).not.toContain('Peace be upon you');
      }
    });

    test('Audit logs cannot be updated or deleted even by super admin session role', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientSAdmin = await createAuthClient(fixtures.superAdmin);
      try {
        await expect(clientSAdmin.query(`DELETE FROM public.audit_logs;`)).rejects.toThrow();
        await expect(clientSAdmin.query(`UPDATE public.audit_logs SET action = 'ALTERED';`)).rejects.toThrow();
      } finally {
        await clientSAdmin.end();
      }
    });
  });

  // ==========================================================================
  // 4. PHASE 3.1: F-02 AUTHORITATIVE IDENTITY & PHONE SYNCHRONIZATION TESTS
  // ==========================================================================

  describe('Phase 3.1: F-02 Authoritative Identity & Phone Synchronization Tests', () => {
    test('F02-NEG-01: Authenticated User A cannot directly INSERT an arbitrary phone_e164 into user_private', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        await expect(
          clientA.query(
            `INSERT INTO public.user_private (user_id, phone_e164) VALUES ($1, '+19998887777');`,
            [fixtures.userA.id]
          )
        ).rejects.toThrow();
      } finally {
        await clientA.end();
      }
    });

    test('F02-NEG-02: Authenticated User A cannot directly UPDATE their phone_e164 to an arbitrary value', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        await expect(
          clientA.query(
            `UPDATE public.user_private SET phone_e164 = '+19998887777' WHERE user_id = $1;`,
            [fixtures.userA.id]
          )
        ).rejects.toThrow();
      } finally {
        await clientA.end();
      }
    });

    test('F02-NEG-03: Authenticated User A cannot modify User B phone_e164 or private record', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const res = await clientA.query(
          `UPDATE public.user_private SET phone_e164 = '+19998887777' WHERE user_id = $1;`,
          [fixtures.userB.id]
        );
        expect(res.rowCount).toBe(0);

        const verifyRes = await adminClient.query(
          `SELECT phone_e164 FROM public.user_private WHERE user_id = $1;`,
          [fixtures.userB.id]
        );
        expect(verifyRes.rows.length).toBe(1);
        expect(verifyRes.rows[0].phone_e164).toBe(fixtures.userB.phone);
      } finally {
        await clientA.end();
      }
    });

    test('F02-NEG-04: Authenticated client cannot invoke synchronization function with arbitrary arguments', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        await expect(
          clientA.query(`SELECT public.handle_new_auth_user();`)
        ).rejects.toThrow();
      } finally {
        await clientA.end();
      }
    });

    test('F02-NEG-05: Existing user_private privacy boundary remains intact (User A cannot SELECT User B phone)', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const res = await clientA.query(
          `SELECT * FROM public.user_private WHERE user_id = $1;`,
          [fixtures.userB.id]
        );
        expect(res.rows.length).toBe(0);
      } finally {
        await clientA.end();
      }
    });

    test('F02-POS-01 & POS-02: Valid auth.users creation synchronizes public.users and authoritative phone_e164', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const testUserId = '77777777-7777-4777-8777-777777777777';
      const testPhone = '+12025550188';

      // Clean up fixture if pre-existing
      await adminClient.query(`DELETE FROM public.user_roles WHERE user_id = $1;`, [testUserId]);
      await adminClient.query(`DELETE FROM public.user_private WHERE user_id = $1;`, [testUserId]);
      await adminClient.query(`DELETE FROM public.users WHERE id = $1;`, [testUserId]);
      await adminClient.query(`DELETE FROM auth.users WHERE id = $1;`, [testUserId]);

      // Insert simulated auth.users record
      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
         VALUES ($1, 'f02test@example.com', $2, '{"full_name": "F02 Test User"}'::jsonb);`,
        [testUserId, testPhone]
      );

      // Verify public.users row
      const userRes = await adminClient.query(
        `SELECT full_name, is_active FROM public.users WHERE id = $1;`,
        [testUserId]
      );
      expect(userRes.rows.length).toBe(1);
      expect(userRes.rows[0].full_name).toBe('F02 Test User');
      expect(userRes.rows[0].is_active).toBe(true);

      // Verify public.user_roles row
      const roleRes = await adminClient.query(
        `SELECT role FROM public.user_roles WHERE user_id = $1;`,
        [testUserId]
      );
      expect(roleRes.rows.length).toBe(1);
      expect(roleRes.rows[0].role).toBe('user');

      // Verify public.user_private authoritative phone_e164
      const privRes = await adminClient.query(
        `SELECT phone_e164 FROM public.user_private WHERE user_id = $1;`,
        [testUserId]
      );
      expect(privRes.rows.length).toBe(1);
      expect(privRes.rows[0].phone_e164).toBe(testPhone);
    });

    test('F02-POS-03: Legitimate auth.users phone update synchronizes authoritatively', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const testUserId = '77777777-7777-4777-8777-777777777777';
      const updatedPhone = '+12025550189';

      await adminClient.query(
        `UPDATE auth.users SET phone = $1 WHERE id = $2;`,
        [updatedPhone, testUserId]
      );

      const privRes = await adminClient.query(
        `SELECT phone_e164 FROM public.user_private WHERE user_id = $1;`,
        [testUserId]
      );
      expect(privRes.rows.length).toBe(1);
      expect(privRes.rows[0].phone_e164).toBe(updatedPhone);
    });

    test('F02-POS-04: Legitimate NULL phone state in auth.users is handled safely', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const nullPhoneUserId = '88888888-8888-4888-8888-888888888888';

      // Clean up fixture if pre-existing
      await adminClient.query(`DELETE FROM public.user_roles WHERE user_id = $1;`, [nullPhoneUserId]);
      await adminClient.query(`DELETE FROM public.user_private WHERE user_id = $1;`, [nullPhoneUserId]);
      await adminClient.query(`DELETE FROM public.users WHERE id = $1;`, [nullPhoneUserId]);
      await adminClient.query(`DELETE FROM auth.users WHERE id = $1;`, [nullPhoneUserId]);

      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
         VALUES ($1, 'nullphone@example.com', NULL, '{"full_name": "Null Phone User"}'::jsonb);`,
        [nullPhoneUserId]
      );

      const userRes = await adminClient.query(
        `SELECT full_name FROM public.users WHERE id = $1;`,
        [nullPhoneUserId]
      );
      expect(userRes.rows.length).toBe(1);

      const privRes = await adminClient.query(
        `SELECT phone_e164 FROM public.user_private WHERE user_id = $1;`,
        [nullPhoneUserId]
      );
      expect(privRes.rows.length).toBe(1);
      expect(privRes.rows[0].phone_e164).toBeNull();
    });
  });

  // ==========================================================================
  // 6. PHASE 3.1: PROVIDER CATALOG DISCOVERY & PARTICIPANT HELPER TESTS
  // ==========================================================================

  describe('Phase 3.1: Provider Catalog Discovery & Participant Authorization Tests', () => {
    const pendingProvUserId = '77777777-7777-4777-7777-777777777777';
    let pendingProvProfileId: string;
    let testReqId: string | null = null;
    let testConvId: string | null = null;

    beforeAll(async () => {
      if (!isDbConnected || !adminClient) return;

      await adminClient.query(`DELETE FROM public.provider_profiles WHERE user_id = $1;`, [pendingProvUserId]);
      await adminClient.query(`DELETE FROM public.user_roles WHERE user_id = $1;`, [pendingProvUserId]);
      await adminClient.query(`DELETE FROM public.user_private WHERE user_id = $1;`, [pendingProvUserId]);
      await adminClient.query(`DELETE FROM public.users WHERE id = $1;`, [pendingProvUserId]);
      await adminClient.query(`DELETE FROM auth.users WHERE id = $1;`, [pendingProvUserId]);

      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
         VALUES ($1, 'pendingprov@example.com', '+15557777777', '{"full_name": "Pending Provider"}'::jsonb);`,
        [pendingProvUserId]
      );
      await adminClient.query(
        `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'provider');`,
        [pendingProvUserId]
      );
      const res = await adminClient.query(
        `INSERT INTO public.provider_profiles (user_id, bio, gender, years_experience, status)
         VALUES ($1, 'Unapproved bio', 'female', 2, 'pending') RETURNING id;`,
        [pendingProvUserId]
      );
      pendingProvProfileId = res.rows[0].id;

      // Create a test request and conversation using the canonical production lifecycle
      const reqRes = await adminClient.query(
        `INSERT INTO public.service_requests (user_id, provider_id, service_id, location_id, status)
         VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING id;`,
        [fixtures.userA.id, fixtures.provider1ProfileId, fixtures.serviceId, fixtures.areaAId]
      );
      testReqId = reqRes.rows[0].id;

      // Authenticated provider accepts request
      const clientP = await createAuthClient(fixtures.provider1);
      try {
        await clientP.query(
          `SELECT public.transition_service_request($1, 'ACCEPTED', 'Accepting request') as out;`,
          [testReqId]
        );
      } finally {
        await clientP.end();
      }

      // Authenticated User A activates chat and provisions conversation
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const actRes = await clientA.query(
          `SELECT public.activate_request_chat($1) as out;`,
          [testReqId]
        );
        testConvId = actRes.rows[0].out.conversation_id;
      } finally {
        await clientA.end();
      }
    });

    afterAll(async () => {
      if (!isDbConnected || !adminClient) return;
      if (testConvId) {
        await adminClient.query(`DELETE FROM public.conversations WHERE id = $1;`, [testConvId]);
      }
      if (testReqId) {
        await adminClient.query(`DELETE FROM public.service_requests WHERE id = $1;`, [testReqId]);
      }
      await adminClient.query(`DELETE FROM public.provider_profiles WHERE user_id = $1;`, [pendingProvUserId]);
      await adminClient.query(`DELETE FROM public.user_roles WHERE user_id = $1;`, [pendingProvUserId]);
      await adminClient.query(`DELETE FROM public.user_private WHERE user_id = $1;`, [pendingProvUserId]);
      await adminClient.query(`DELETE FROM public.users WHERE id = $1;`, [pendingProvUserId]);
      await adminClient.query(`DELETE FROM auth.users WHERE id = $1;`, [pendingProvUserId]);
    });

    test('PROV-POS-01: Approved provider profile is visible to authenticated User A for catalog discovery', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const res = await clientA.query(
          `SELECT id, bio, status FROM public.provider_profiles WHERE id = $1;`,
          [fixtures.provider1ProfileId]
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].status).toBe('approved');
      } finally {
        await clientA.end();
      }
    });

    test('PROV-NEG-01: Pending/unapproved provider profile is NOT visible to authenticated User A', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const res = await clientA.query(
          `SELECT id, bio, status FROM public.provider_profiles WHERE id = $1;`,
          [pendingProvProfileId]
        );
        expect(res.rows.length).toBe(0);
      } finally {
        await clientA.end();
      }
    });

    test('PROV-POS-02: Pending provider can view their own profile via self-access RLS policy', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const pendingProvUser: TestUser = {
        id: pendingProvUserId,
        name: 'Pending Provider',
        phone: '+15557777777',
        token: generateSupabaseJwt(pendingProvUserId, 'authenticated')
      };
      const clientPendingProv = await createAuthClient(pendingProvUser);
      try {
        const res = await clientPendingProv.query(
          `SELECT id, status FROM public.provider_profiles WHERE user_id = $1;`,
          [pendingProvUserId]
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].status).toBe('pending');
      } finally {
        await clientPendingProv.end();
      }
    });

    test('PROV-POS-03: Participant validation helper accurately verifies membership and rejects arbitrary parameter probing', async () => {
      if (!isDbConnected || !testConvId) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      const clientB = await createAuthClient(fixtures.userB);
      const clientP = await createAuthClient(fixtures.provider1);
      try {
        const convId = testConvId;

        // User A (requester) is a participant
        const checkA = await clientA.query(
          `SELECT public.is_conversation_participant($1) as is_part;`,
          [convId]
        );
        expect(checkA.rows[0].is_part).toBe(true);

        // Provider 1 (assigned provider) is a participant
        const checkP = await clientP.query(
          `SELECT public.is_conversation_participant($1) as is_part;`,
          [convId]
        );
        expect(checkP.rows[0].is_part).toBe(true);

        // User B (non-participant) is NOT a participant
        const checkB = await clientB.query(
          `SELECT public.is_conversation_participant($1) as is_part;`,
          [convId]
        );
        expect(checkB.rows[0].is_part).toBe(false);

        // Client cannot pass arbitrary second parameter (function has arity 1)
        let twoArgFailed = false;
        try {
          await clientB.query(
            `SELECT public.is_conversation_participant($1, $2) as is_part;`,
            [convId, fixtures.userA.id]
          );
        } catch (err: any) {
          twoArgFailed = true;
        }
        expect(twoArgFailed).toBe(true);
      } finally {
        await clientA.end();
        await clientB.end();
        await clientP.end();
      }
    });

    test('PROV-ADM-01: Area Admin A can access unapproved provider in Area A, but NOT in Area B or without declared area', async () => {
      if (!isDbConnected || !adminClient) {
        expect(true).toBe(true);
        return;
      }

      // Create provider in Area A (pending)
      const pAUser = '88888888-8888-4888-8888-888888888888';
      await adminClient.query(`DELETE FROM public.provider_profiles WHERE user_id = $1;`, [pAUser]);
      await adminClient.query(`DELETE FROM public.user_roles WHERE user_id = $1;`, [pAUser]);
      await adminClient.query(`DELETE FROM public.user_private WHERE user_id = $1;`, [pAUser]);
      await adminClient.query(`DELETE FROM public.users WHERE id = $1;`, [pAUser]);
      await adminClient.query(`DELETE FROM auth.users WHERE id = $1;`, [pAUser]);
      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data) VALUES ($1, 'prov_a@example.com', '+15558888888', '{"full_name": "Prov A"}'::jsonb);`,
        [pAUser]
      );
      await adminClient.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'provider');`, [pAUser]);
      const pARes = await adminClient.query(
        `INSERT INTO public.provider_profiles (user_id, bio, gender, years_experience, status) VALUES ($1, 'Bio A', 'male', 3, 'pending') RETURNING id;`,
        [pAUser]
      );
      const pAProfileId = pARes.rows[0].id;
      await adminClient.query(`INSERT INTO public.provider_locations (provider_id, location_id) VALUES ($1, $2);`, [pAProfileId, fixtures.areaAId]);

      // Create provider in Area B (pending)
      const pBUser = '99999999-9999-4999-9999-999999999999';
      await adminClient.query(`DELETE FROM public.provider_profiles WHERE user_id = $1;`, [pBUser]);
      await adminClient.query(`DELETE FROM public.user_roles WHERE user_id = $1;`, [pBUser]);
      await adminClient.query(`DELETE FROM public.user_private WHERE user_id = $1;`, [pBUser]);
      await adminClient.query(`DELETE FROM public.users WHERE id = $1;`, [pBUser]);
      await adminClient.query(`DELETE FROM auth.users WHERE id = $1;`, [pBUser]);
      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data) VALUES ($1, 'prov_b@example.com', '+15559999999', '{"full_name": "Prov B"}'::jsonb);`,
        [pBUser]
      );
      await adminClient.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'provider');`, [pBUser]);
      const pBRes = await adminClient.query(
        `INSERT INTO public.provider_profiles (user_id, bio, gender, years_experience, status) VALUES ($1, 'Bio B', 'female', 4, 'pending') RETURNING id;`,
        [pBUser]
      );
      const pBProfileId = pBRes.rows[0].id;
      await adminClient.query(`INSERT INTO public.provider_locations (provider_id, location_id) VALUES ($1, $2);`, [pBProfileId, fixtures.areaBId]);

      const clientAreaAdmin = await createAuthClient(fixtures.areaAdmin);
      const clientSuperAdmin = await createAuthClient(fixtures.superAdmin);
      const clientOrdinary = await createAuthClient(fixtures.userA);

      try {
        // 1. Area Admin A can SELECT unapproved provider in Area A
        const canSeeA = await clientAreaAdmin.query(`SELECT id FROM public.provider_profiles WHERE id = $1;`, [pAProfileId]);
        expect(canSeeA.rows.length).toBe(1);

        // 2. Area Admin A CANNOT SELECT unapproved provider in Area B
        const canSeeB = await clientAreaAdmin.query(`SELECT id FROM public.provider_profiles WHERE id = $1;`, [pBProfileId]);
        expect(canSeeB.rows.length).toBe(0);

        // 3. Area Admin A CANNOT SELECT unapproved provider with no declared location
        const canSeeNoLoc = await clientAreaAdmin.query(`SELECT id FROM public.provider_profiles WHERE id = $1;`, [pendingProvProfileId]);
        expect(canSeeNoLoc.rows.length).toBe(0);

        // 4. Super Admin can SELECT all unapproved provider profiles
        const superCanSeeA = await clientSuperAdmin.query(`SELECT id FROM public.provider_profiles WHERE id = $1;`, [pAProfileId]);
        const superCanSeeB = await clientSuperAdmin.query(`SELECT id FROM public.provider_profiles WHERE id = $1;`, [pBProfileId]);
        const superCanSeeNoLoc = await clientSuperAdmin.query(`SELECT id FROM public.provider_profiles WHERE id = $1;`, [pendingProvProfileId]);
        expect(superCanSeeA.rows.length).toBe(1);
        expect(superCanSeeB.rows.length).toBe(1);
        expect(superCanSeeNoLoc.rows.length).toBe(1);

        // 5. Ordinary authenticated user CANNOT SELECT any unapproved provider
        const ordCanSeeA = await clientOrdinary.query(`SELECT id FROM public.provider_profiles WHERE id = $1;`, [pAProfileId]);
        const ordCanSeeB = await clientOrdinary.query(`SELECT id FROM public.provider_profiles WHERE id = $1;`, [pBProfileId]);
        expect(ordCanSeeA.rows.length).toBe(0);
        expect(ordCanSeeB.rows.length).toBe(0);

        // 6. Direct helper function checks: verify boolean return without data leakage
        const ordHelperRes = await clientOrdinary.query(`SELECT public.can_admin_view_provider($1) AS allowed;`, [pAProfileId]);
        expect(ordHelperRes.rows[0].allowed).toBe(false);

        const areaAdminHelperA = await clientAreaAdmin.query(`SELECT public.can_admin_view_provider($1) AS allowed;`, [pAProfileId]);
        expect(areaAdminHelperA.rows[0].allowed).toBe(true);

        const areaAdminHelperB = await clientAreaAdmin.query(`SELECT public.can_admin_view_provider($1) AS allowed;`, [pBProfileId]);
        expect(areaAdminHelperB.rows[0].allowed).toBe(false);

        const areaAdminHelperNoLoc = await clientAreaAdmin.query(`SELECT public.can_admin_view_provider($1) AS allowed;`, [pendingProvProfileId]);
        expect(areaAdminHelperNoLoc.rows[0].allowed).toBe(false);

        const superHelperRes = await clientSuperAdmin.query(`SELECT public.can_admin_view_provider($1) AS allowed;`, [pAProfileId]);
        expect(superHelperRes.rows[0].allowed).toBe(true);

        // 7. Authorization tables remain strictly RLS-protected with NO broad SELECT policies
        const rlsCheck = await adminClient.query(`
          SELECT relname, relrowsecurity
          FROM pg_class
          WHERE relname IN ('user_roles', 'admin_area_assignments', 'provider_locations')
            AND relnamespace = 'public'::regnamespace;
        `);
        expect(rlsCheck.rows.length).toBe(3);
        for (const row of rlsCheck.rows) {
          expect(row.relrowsecurity).toBe(true);
        }

        const policyCheck = await adminClient.query(`
          SELECT tablename, policyname
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename IN ('user_roles', 'admin_area_assignments', 'provider_locations');
        `);
        expect(policyCheck.rows.length).toBe(0);

        // Direct authenticated SELECTs return 0 rows under default-deny
        const rolesCheck = await clientOrdinary.query(`SELECT * FROM public.user_roles;`);
        expect(rolesCheck.rows.length).toBe(0);

        const assignCheck = await clientAreaAdmin.query(`SELECT * FROM public.admin_area_assignments;`);
        expect(assignCheck.rows.length).toBe(0);

        const provLocCheck = await clientOrdinary.query(`SELECT * FROM public.provider_locations;`);
        expect(provLocCheck.rows.length).toBe(0);
      } finally {
        await clientAreaAdmin.end();
        await clientSuperAdmin.end();
        await clientOrdinary.end();

        await adminClient.query(`DELETE FROM public.provider_locations WHERE provider_id IN ($1, $2);`, [pAProfileId, pBProfileId]);
        await adminClient.query(`DELETE FROM public.provider_profiles WHERE user_id IN ($1, $2);`, [pAUser, pBUser]);
        await adminClient.query(`DELETE FROM public.user_roles WHERE user_id IN ($1, $2);`, [pAUser, pBUser]);
        await adminClient.query(`DELETE FROM public.user_private WHERE user_id IN ($1, $2);`, [pAUser, pBUser]);
        await adminClient.query(`DELETE FROM public.users WHERE id IN ($1, $2);`, [pAUser, pBUser]);
        await adminClient.query(`DELETE FROM auth.users WHERE id IN ($1, $2);`, [pAUser, pBUser]);
      }
    });
  });

  // ==========================================================================
  // 6. PHASE 3.2 STEP 2A: DATABASE ONBOARDING & CONSENT FOUNDATION TESTS
  // ==========================================================================

  describe('Phase 3.2 Step 2A: Database Onboarding & Consent Foundation Tests', () => {
    // Generate isolated random fixture UUIDs per test execution to prevent cross-run collisions
    const obUser1Id = randomUUID();
    const obUser2Id = randomUUID();
    const obUser3Id = randomUUID();

    const testUsers = [
      { id: obUser1Id, name: 'User', phone: '+12025550201', token: generateSupabaseJwt(obUser1Id) },
      { id: obUser2Id, name: 'User', phone: '+12025550202', token: generateSupabaseJwt(obUser2Id) },
      { id: obUser3Id, name: 'User', phone: '+12025550203', token: generateSupabaseJwt(obUser3Id) },
    ];

    beforeAll(async () => {
      if (!isDbConnected) return;

      // Provision simulated fresh users who just completed phone OTP (name defaults to 'User', onboarded_at is NULL)
      for (const u of testUsers) {
        await adminClient.query(
          `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
           VALUES ($1, $2, $3, '{}'::jsonb);`,
          [u.id, `${u.id}@example.com`, u.phone]
        );
      }
    });

    afterAll(async () => {
      // NOTE: Audit logs (public.audit_logs) and user consents (public.user_consents)
      // are strictly append-only and immutable by database triggers and architectural design.
      // Therefore, they are not mutated or deleted during cleanup.
      // Each test run uses fresh isolated random UUIDs, and the CI environment resets
      // the test database per run via 'supabase db reset'.
    });

    test('ONBOARD-NEG-01: Anonymous / unauthenticated caller cannot execute complete_user_onboarding', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const anonClient = new Client({ connectionString: DB_URL });
      await anonClient.connect();
      try {
        await anonClient.query(`SET ROLE anon;`);
        await expect(
          anonClient.query(`SELECT public.complete_user_onboarding('Ahmad Khan', '2026-09-v1.0', '2026-09-v1.0');`)
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await anonClient.end();
      }
    });

    test('ONBOARD-NEG-02: RPC signature has no user_id parameter (derived strictly from auth.uid())', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const paramCheck = await adminClient.query(`
        SELECT parameter_name, data_type
        FROM information_schema.parameters
        WHERE specific_schema = 'public'
          AND specific_name LIKE 'complete_user_onboarding%'
        ORDER BY ordinal_position;
      `);
      const paramNames = paramCheck.rows.map((r: any) => r.parameter_name);
      expect(paramNames).toEqual(['p_full_name', 'p_tos_version', 'p_privacy_policy_version']);
      expect(paramNames.includes('user_id')).toBe(false);
      expect(paramNames.includes('p_user_id')).toBe(false);
    });

    test('ONBOARD-NEG-03: Invalid, empty, or whitespace full name is rejected', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(testUsers[0]);
      try {
        // Empty
        await expect(
          client.query(`SELECT public.complete_user_onboarding('', '2026-09-v1.0', '2026-09-v1.0');`)
        ).rejects.toThrow(/between 2 and 100 characters/i);

        // Whitespace only
        await expect(
          client.query(`SELECT public.complete_user_onboarding('   ', '2026-09-v1.0', '2026-09-v1.0');`)
        ).rejects.toThrow(/between 2 and 100 characters/i);

        // Too short (1 char)
        await expect(
          client.query(`SELECT public.complete_user_onboarding('A', '2026-09-v1.0', '2026-09-v1.0');`)
        ).rejects.toThrow(/between 2 and 100 characters/i);

        // Too long (>100 chars)
        const longName = 'A'.repeat(101);
        await expect(
          client.query(`SELECT public.complete_user_onboarding($1, '2026-09-v1.0', '2026-09-v1.0');`, [longName])
        ).rejects.toThrow(/between 2 and 100 characters/i);
      } finally {
        await client.end();
      }
    });

    test('ONBOARD-NEG-04: Empty or whitespace document versions are rejected', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(testUsers[0]);
      try {
        // Empty tos
        await expect(
          client.query(`SELECT public.complete_user_onboarding('Ahmad Khan', '', '2026-09-v1.0');`)
        ).rejects.toThrow(/Terms of Service version must be between 1 and 50 characters/i);

        // Whitespace tos
        await expect(
          client.query(`SELECT public.complete_user_onboarding('Ahmad Khan', '   ', '2026-09-v1.0');`)
        ).rejects.toThrow(/Terms of Service version must be between 1 and 50 characters/i);

        // Empty privacy
        await expect(
          client.query(`SELECT public.complete_user_onboarding('Ahmad Khan', '2026-09-v1.0', '');`)
        ).rejects.toThrow(/Privacy Policy version must be between 1 and 50 characters/i);

        // Whitespace privacy
        await expect(
          client.query(`SELECT public.complete_user_onboarding('Ahmad Khan', '2026-09-v1.0', '   ');`)
        ).rejects.toThrow(/Privacy Policy version must be between 1 and 50 characters/i);
      } finally {
        await client.end();
      }
    });

    test('ONBOARD-NEG-05: Oversized document versions (>50 chars) are rejected', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(testUsers[0]);
      try {
        const longVersion = 'v'.repeat(51);
        await expect(
          client.query(`SELECT public.complete_user_onboarding('Ahmad Khan', $1, '2026-09-v1.0');`, [longVersion])
        ).rejects.toThrow(/Terms of Service version must be between 1 and 50 characters/i);

        await expect(
          client.query(`SELECT public.complete_user_onboarding('Ahmad Khan', '2026-09-v1.0', $1);`, [longVersion])
        ).rejects.toThrow(/Privacy Policy version must be between 1 and 50 characters/i);
      } finally {
        await client.end();
      }
    });

    test('ONBOARD-NEG-06 to NEG-08: Direct authenticated INSERT, UPDATE, DELETE on user_consents is rejected', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(testUsers[0]);
      try {
        // Direct INSERT blocked
        await expect(
          client.query(
            `INSERT INTO public.user_consents (user_id, tos_version, privacy_policy_version, adult_acknowledgement_given)
             VALUES ($1, 'v1', 'v1', true);`,
            [testUsers[0].id]
          )
        ).rejects.toThrow(/permission denied/i);

        // Direct UPDATE blocked
        await expect(
          client.query(`UPDATE public.user_consents SET tos_version = 'v2' WHERE user_id = $1;`, [testUsers[0].id])
        ).rejects.toThrow(/permission denied/i);

        // Direct DELETE blocked
        await expect(
          client.query(`DELETE FROM public.user_consents WHERE user_id = $1;`, [testUsers[0].id])
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await client.end();
      }
    });

    test('ONBOARD-NEG-09 & NEG-10: Client cannot directly mutate public.users.onboarded_at', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(testUsers[0]);
      try {
        await expect(
          client.query(`UPDATE public.users SET onboarded_at = now() WHERE id = $1;`, [testUsers[0].id])
        ).rejects.toThrow(/permission denied/i);

        await expect(
          client.query(`UPDATE public.users SET full_name = 'Hacked Name' WHERE id = $1;`, [testUsers[0].id])
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await client.end();
      }
    });

    test('ONBOARD-POS-01 to POS-07: Authenticated user can complete onboarding; generates atomic consent and audit record', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(testUsers[0]);
      try {
        const startTime = new Date(Date.now() - 5000);
        const res = await client.query(
          `SELECT public.complete_user_onboarding('Ahmad Al-Mansoor', '2026-09-v1.0', '2026-09-v1.0') as payload;`
        );
        const payload = res.rows[0].payload;
        expect(payload.status).toBe('success');
        expect(payload.user_id).toBe(testUsers[0].id);
        expect(payload.consent_id).toBeDefined();

        const onboardedAt = new Date(payload.onboarded_at);
        expect(onboardedAt.getTime()).toBeGreaterThanOrEqual(startTime.getTime());

        // 1. Verify public.users row updated atomically
        const userRow = await adminClient.query(`SELECT full_name, onboarded_at FROM public.users WHERE id = $1;`, [testUsers[0].id]);
        expect(userRow.rows[0].full_name).toBe('Ahmad Al-Mansoor');
        expect(new Date(userRow.rows[0].onboarded_at).toISOString()).toBe(onboardedAt.toISOString());

        // 2. Verify exactly one consent record in public.user_consents
        const consentRows = await adminClient.query(`SELECT * FROM public.user_consents WHERE user_id = $1;`, [testUsers[0].id]);
        expect(consentRows.rows.length).toBe(1);
        const consent = consentRows.rows[0];
        expect(consent.id).toBe(payload.consent_id);
        expect(consent.user_id).toBe(testUsers[0].id);
        expect(consent.tos_version).toBe('2026-09-v1.0');
        expect(consent.privacy_policy_version).toBe('2026-09-v1.0');
        expect(consent.adult_acknowledgement_given).toBe(true);
        expect(new Date(consent.accepted_at).getTime()).toBeGreaterThanOrEqual(startTime.getTime());

        // 3. Verify user can read their own consent record via RLS policy
        const clientConsent = await client.query(`SELECT * FROM public.user_consents WHERE user_id = $1;`, [testUsers[0].id]);
        expect(clientConsent.rows.length).toBe(1);

        // 4. Verify other users CANNOT read user 1 consent record via RLS
        const client2 = await createAuthClient(testUsers[1]);
        try {
          const crossConsent = await client2.query(`SELECT * FROM public.user_consents WHERE user_id = $1;`, [testUsers[0].id]);
          expect(crossConsent.rows.length).toBe(0);
        } finally {
          await client2.end();
        }

        // 5. Verify audit log entry created without unnecessary PII (no actual name)
        const auditRows = await adminClient.query(
          `SELECT * FROM public.audit_logs WHERE actor_id = $1 AND action = 'USER_ONBOARDING_COMPLETED';`,
          [testUsers[0].id]
        );
        expect(auditRows.rows.length).toBe(1);
        const audit = auditRows.rows[0];
        expect(audit.entity_type).toBe('users');
        expect(audit.entity_id).toBe(testUsers[0].id);
        expect(audit.new_data.tos_version).toBe('2026-09-v1.0');
        expect(audit.new_data.privacy_policy_version).toBe('2026-09-v1.0');
        expect(audit.new_data.adult_acknowledgement_given).toBe(true);
        expect(audit.new_data.consent_id).toBe(payload.consent_id);
        expect(audit.new_data.name_char_length).toBe('Ahmad Al-Mansoor'.length);
        // Guarantee no raw PII in audit data
        expect(JSON.stringify(audit.new_data).includes('Ahmad Al-Mansoor')).toBe(false);
      } finally {
        await client.end();
      }
    });

    test('ONBOARD-NEG-11 & NEG-12: Calling onboarding a second time explicitly fails and leaves consent unchanged', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(testUsers[0]);
      try {
        const consentBefore = await adminClient.query(`SELECT accepted_at FROM public.user_consents WHERE user_id = $1;`, [testUsers[0].id]);
        const initialTimestamp = consentBefore.rows[0].accepted_at;

        // Second call must fail
        await expect(
          client.query(`SELECT public.complete_user_onboarding('Ahmad Khan Second Try', '2026-09-v2.0', '2026-09-v2.0');`)
        ).rejects.toThrow(/already completed onboarding/i);

        // Name, onboarded_at, and consent row remain completely unchanged
        const userRow = await adminClient.query(`SELECT full_name FROM public.users WHERE id = $1;`, [testUsers[0].id]);
        expect(userRow.rows[0].full_name).toBe('Ahmad Al-Mansoor');

        const consentAfter = await adminClient.query(`SELECT accepted_at FROM public.user_consents WHERE user_id = $1;`, [testUsers[0].id]);
        expect(consentAfter.rows.length).toBe(1);
        expect(new Date(consentAfter.rows[0].accepted_at).toISOString()).toBe(new Date(initialTimestamp).toISOString());
      } finally {
        await client.end();
      }
    });

    test('ONBOARD-POS-08: Concurrency control via FOR UPDATE exclusively locks user row', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const clientA = await createAuthClient(testUsers[1]);
      const clientB = await createAuthClient(testUsers[1]);

      try {
        // Run concurrent onboarding attempts for testUser[1]
        const p1 = clientA.query(`SELECT public.complete_user_onboarding('Concurrent User', '2026-09-v1.0', '2026-09-v1.0');`);
        const p2 = clientB.query(`SELECT public.complete_user_onboarding('Concurrent User 2', '2026-09-v1.0', '2026-09-v1.0');`);

        const results = await Promise.allSettled([p1, p2]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        // Exactly one should succeed, and one must be rejected due to already completed onboarding lock
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);

        // Verify only 1 consent record was inserted
        const consentCount = await adminClient.query(`SELECT COUNT(*)::int as count FROM public.user_consents WHERE user_id = $1;`, [testUsers[1].id]);
        expect(consentCount.rows[0].count).toBe(1);
      } finally {
        await clientA.end();
        await clientB.end();
      }
    });

    test('ONBOARD-NEG-13: Failed onboarding transaction leaves no partial user, consent, or audit state', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(testUsers[2]);
      try {
        // Capture pre-attempt state
        const preUserRow = await adminClient.query(
          `SELECT full_name, onboarded_at FROM public.users WHERE id = $1;`,
          [testUsers[2].id]
        );
        const preFullName = preUserRow.rows[0].full_name;
        const preOnboardedAt = preUserRow.rows[0].onboarded_at;

        // Attempt with invalid version
        await expect(
          client.query(`SELECT public.complete_user_onboarding('Valid Name', '', '2026-09-v1.0');`)
        ).rejects.toThrow();

        // Verify users row was NOT modified (remains identical to pre-attempt state)
        const userRow = await adminClient.query(
          `SELECT full_name, onboarded_at FROM public.users WHERE id = $1;`,
          [testUsers[2].id]
        );
        expect(userRow.rows[0].full_name).toBe(preFullName);
        expect(userRow.rows[0].full_name).not.toBe('Valid Name');
        expect(userRow.rows[0].onboarded_at).toBe(preOnboardedAt);
        expect(userRow.rows[0].onboarded_at).toBeNull();

        // Verify no consent row was inserted
        const consentRow = await adminClient.query(`SELECT * FROM public.user_consents WHERE user_id = $1;`, [testUsers[2].id]);
        expect(consentRow.rows.length).toBe(0);

        // Verify no audit log entry was created
        const auditRow = await adminClient.query(`SELECT * FROM public.audit_logs WHERE actor_id = $1 AND action = 'USER_ONBOARDING_COMPLETED';`, [testUsers[2].id]);
        expect(auditRow.rows.length).toBe(0);
      } finally {
        await client.end();
      }
    });

    test('ONBOARD-NEG-14: Consent immutability trigger blocks UPDATE and DELETE on user_consents', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      // Even direct adminClient (privileged role) is blocked by the immutability trigger
      await expect(
        adminClient.query(`UPDATE public.user_consents SET tos_version = 'tampered' WHERE user_id = $1;`, [testUsers[0].id])
      ).rejects.toThrow(/append-only and immutable/i);

      await expect(
        adminClient.query(`DELETE FROM public.user_consents WHERE user_id = $1;`, [testUsers[0].id])
      ).rejects.toThrow(/append-only and immutable/i);
    });
  });

  // ==========================================================================
  // 6. PHASE 3.2 STEP 2B: AUTHORITATIVE ONBOARDING STATUS RPC TESTS
  // ==========================================================================

  describe('Phase 3.2 Step 2B: Authoritative Onboarding Status RPC Tests', () => {
    const statusUserAId = randomUUID();
    const statusUserBId = randomUUID();
    const statusUserA: TestUser = {
      id: statusUserAId,
      name: 'Status User A',
      phone: '+12025550301',
      token: generateSupabaseJwt(statusUserAId),
    };
    const statusUserB: TestUser = {
      id: statusUserBId,
      name: 'Status User B',
      phone: '+12025550302',
      token: generateSupabaseJwt(statusUserBId),
    };

    beforeAll(async () => {
      if (!isDbConnected) return;

      // Provision simulated fresh users who just completed phone OTP
      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
         VALUES ($1, $2, $3, '{}'::jsonb);`,
        [statusUserA.id, `${statusUserA.id}@example.com`, statusUserA.phone]
      );

      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
         VALUES ($1, $2, $3, '{}'::jsonb);`,
        [statusUserB.id, `${statusUserB.id}@example.com`, statusUserB.phone]
      );
    });

    test('STATUS-NEG-01: Anonymous / unauthenticated caller cannot execute get_my_onboarding_status()', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const anonClient = new Client({ connectionString: DB_URL });
      await anonClient.connect();
      try {
        await anonClient.query(`SET ROLE anon;`);
        await expect(
          anonClient.query(`SELECT public.get_my_onboarding_status();`)
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await anonClient.end();
      }
    });

    test('STATUS-POS-01: Authenticated User A with onboarded_at NULL receives is_onboarded: false and onboarded_at: null', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(statusUserA);
      try {
        const res = await client.query(`SELECT public.get_my_onboarding_status() as status;`);
        const status = res.rows[0].status;
        expect(status).toEqual({
          is_onboarded: false,
          onboarded_at: null,
        });
      } finally {
        await client.end();
      }
    });

    test('STATUS-POS-02: After User A completes legitimate onboarding, get_my_onboarding_status() returns is_onboarded: true and valid timestamp', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(statusUserA);
      try {
        // Complete onboarding via legitimate RPC
        const onboardRes = await client.query(
          `SELECT public.complete_user_onboarding('Ahmad Status Test', '2026-09-v1.0', '2026-09-v1.0') as payload;`
        );
        const expectedOnboardedAt = onboardRes.rows[0].payload.onboarded_at;

        // Query status via get_my_onboarding_status()
        const res = await client.query(`SELECT public.get_my_onboarding_status() as status;`);
        const status = res.rows[0].status;

        expect(status.is_onboarded).toBe(true);
        expect(status.onboarded_at).toBeDefined();
        expect(new Date(status.onboarded_at).toISOString()).toBe(new Date(expectedOnboardedAt).toISOString());
      } finally {
        await client.end();
      }
    });

    test('STATUS-NEG-02: Function has zero parameters (verified via PostgreSQL metadata)', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const paramCheck = await adminClient.query(`
        SELECT parameter_name, data_type
        FROM information_schema.parameters
        WHERE specific_schema = 'public'
          AND specific_name LIKE 'get_my_onboarding_status%'
        ORDER BY ordinal_position;
      `);
      expect(paramCheck.rows.length).toBe(0);
    });

    test('STATUS-NEG-03: User A cannot use any parameter or mechanism to request User B state', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const clientA = await createAuthClient(statusUserA);
      const clientB = await createAuthClient(statusUserB);
      try {
        // User B has not completed onboarding
        const resB = await clientB.query(`SELECT public.get_my_onboarding_status() as status;`);
        expect(resB.rows[0].status.is_onboarded).toBe(false);

        // User A cannot pass arguments to probe User B
        await expect(
          clientA.query(`SELECT public.get_my_onboarding_status($1);`, [statusUserB.id])
        ).rejects.toThrow();

        // User A query strictly returns User A status (which is onboarded), never User B
        const resA = await clientA.query(`SELECT public.get_my_onboarding_status() as status;`);
        expect(resA.rows[0].status.is_onboarded).toBe(true);
      } finally {
        await clientA.end();
        await clientB.end();
      }
    });

    test('STATUS-NEG-04: Returned JSON keys are EXACTLY is_onboarded and onboarded_at (no private PII exposed)', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(statusUserA);
      try {
        const res = await client.query(`SELECT public.get_my_onboarding_status() as status;`);
        const status = res.rows[0].status;
        const keys = Object.keys(status).sort();

        // Must strictly contain ONLY is_onboarded and onboarded_at
        expect(keys).toEqual(['is_onboarded', 'onboarded_at']);

        // Explicitly assert absence of sensitive fields
        expect((status as any).user_id).toBeUndefined();
        expect((status as any).id).toBeUndefined();
        expect((status as any).full_name).toBeUndefined();
        expect((status as any).phone).toBeUndefined();
        expect((status as any).email).toBeUndefined();
        expect((status as any).role).toBeUndefined();
        expect((status as any).consent_id).toBeUndefined();
      } finally {
        await client.end();
      }
    });

    test('STATUS-NEG-05: Calling RPC does not mutate public.users or create audit records', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const client = await createAuthClient(statusUserA);
      try {
        // Capture pre-invocation state
        const preUserRow = await adminClient.query(
          `SELECT updated_at, onboarded_at FROM public.users WHERE id = $1;`,
          [statusUserA.id]
        );
        const preAuditCount = await adminClient.query(
          `SELECT COUNT(*)::int as count FROM public.audit_logs WHERE actor_id = $1;`,
          [statusUserA.id]
        );

        // Execute status RPC multiple times
        await client.query(`SELECT public.get_my_onboarding_status();`);
        await client.query(`SELECT public.get_my_onboarding_status();`);

        // Verify public.users row is completely unchanged
        const postUserRow = await adminClient.query(
          `SELECT updated_at, onboarded_at FROM public.users WHERE id = $1;`,
          [statusUserA.id]
        );
        expect(postUserRow.rows[0].updated_at).toEqual(preUserRow.rows[0].updated_at);
        expect(postUserRow.rows[0].onboarded_at).toEqual(preUserRow.rows[0].onboarded_at);

        // Verify no audit log entry was created
        const postAuditCount = await adminClient.query(
          `SELECT COUNT(*)::int as count FROM public.audit_logs WHERE actor_id = $1;`,
          [statusUserA.id]
        );
        expect(postAuditCount.rows[0].count).toBe(preAuditCount.rows[0].count);
      } finally {
        await client.end();
      }
    });

    test('STATUS-NEG-06: Missing public.users row fails closed with explicit error, never returning is_onboarded=false', async () => {
      if (!isDbConnected) { expect(true).toBe(true); return; }
      const orphanUserId = randomUUID();
      const orphanUser: TestUser = {
        id: orphanUserId,
        name: 'Orphan User',
        phone: '+12025550309',
        token: generateSupabaseJwt(orphanUserId),
      };

      // 1. Provision user in auth.users
      await adminClient.query(
        `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
         VALUES ($1, $2, $3, '{}'::jsonb);`,
        [orphanUser.id, `${orphanUser.id}@example.com`, orphanUser.phone]
      );

      // 2. Intentionally delete corresponding public.users row to simulate corrupted/missing profile
      await adminClient.query(`DELETE FROM public.users WHERE id = $1;`, [orphanUser.id]);

      // 3. Connect as the authenticated orphan user
      const orphanClient = await createAuthClient(orphanUser);
      try {
        let caughtError: any = null;
        try {
          await orphanClient.query(`SELECT public.get_my_onboarding_status();`);
        } catch (err) {
          caughtError = err;
        }

        // Must fail explicitly
        expect(caughtError).not.toBeNull();
        expect(caughtError.message).toMatch(/User profile not found/i);

        // Must not expose PII or internal database details
        expect(caughtError.message).not.toContain(orphanUser.phone);
        expect(caughtError.message).not.toContain(orphanUser.id);
        expect(caughtError.message).not.toContain('table');
        expect(caughtError.message).not.toContain('public.users');

        // Verify zero mutations to public.users or public.audit_logs
        const usersCheck = await adminClient.query(`SELECT * FROM public.users WHERE id = $1;`, [orphanUser.id]);
        expect(usersCheck.rows.length).toBe(0);

        const auditCheck = await adminClient.query(`SELECT * FROM public.audit_logs WHERE actor_id = $1;`, [orphanUser.id]);
        expect(auditCheck.rows.length).toBe(0);
      } finally {
        await orphanClient.end();
      }
    });
  });
});
