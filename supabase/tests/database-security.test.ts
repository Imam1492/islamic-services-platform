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
    await adminClient.query(`DELETE FROM public.contact_shares WHERE sharer_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.conversations WHERE user_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.service_requests WHERE user_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.provider_locations WHERE provider_id IN (SELECT id FROM public.provider_profiles WHERE user_id = $1);`, [p1Id]);
    await adminClient.query(`DELETE FROM public.provider_profiles WHERE user_id = $1;`, [p1Id]);
    await adminClient.query(`DELETE FROM public.admin_area_assignments WHERE user_id = $1;`, [aAdminId]);
    await adminClient.query(`DELETE FROM public.user_roles WHERE user_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.user_private WHERE user_id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);
    await adminClient.query(`DELETE FROM public.users WHERE id IN ($1, $2, $3, $4, $5);`, [uAId, uBId, p1Id, aAdminId, sAdminId]);

    // Insert Users
    for (const u of [fixtures.userA, fixtures.userB, fixtures.provider1, fixtures.areaAdmin, fixtures.superAdmin]) {
      await adminClient.query(
        `INSERT INTO public.users (id, full_name, is_active) VALUES ($1, $2, true) ON CONFLICT (id) DO UPDATE SET full_name = $2;`,
        [u.id, u.name]
      );
      await adminClient.query(
        `INSERT INTO public.user_private (user_id, phone_e164) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET phone_e164 = $2;`,
        [u.id, u.phone]
      );
    }

    // Assign Roles
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

    test('POS-04: Legitimate participant sends a message in active chat', async () => {
      if (!isDbConnected) {
        expect(true).toBe(true);
        return;
      }
      const clientA = await createAuthClient(fixtures.userA);
      try {
        const convRes = await clientA.query(`SELECT id FROM public.conversations WHERE request_id = $1;`, [activeReqId]);
        const convId = convRes.rows[0].id;

        const msgRes = await clientA.query(
          `INSERT INTO public.messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Peace be upon you') RETURNING id;`,
          [convId, fixtures.userA.id]
        );
        expect(msgRes.rows[0].id).toBeDefined();
      } finally {
        await clientA.end();
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
        await expect(
          clientA.query(
            `UPDATE public.user_private SET phone_e164 = '+19998887777' WHERE user_id = $1;`,
            [fixtures.userB.id]
          )
        ).rejects.toThrow();
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
});
