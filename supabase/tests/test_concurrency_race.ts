/**
 * Concurrency & Race Condition Verification Test
 * File: supabase/tests/test_concurrency_race.ts
 *
 * Simulates:
 * 1. Two concurrent authenticated client sessions attempting to initiate
 *    a contact share request simultaneously for the exact same service request
 *    and customer identity (safe conflict handling, strict single-row creation, zero 23505).
 * 2. Deterministic lifecycle concurrency race between request_contact_share() and
 *    terminal transition_service_request() (guaranteeing that no pending/shared contact
 *    share can survive a terminal transition).
 *
 * Verifies:
 * - Compatible with authoritative auth trigger handle_new_auth_user() (no duplicate inserts).
 * - Complete administrative fixture isolation with fresh generated UUIDs (never reusing existing data).
 * - Comprehensive reverse-dependency cleanup auditing EVERY modified table:
 *   - messages verified independently of parent conversation existence
 *   - conversations tracked directly by captured ID
 *   - audit_logs, contact_shares, service_requests, provider profiles/locations, user accounts,
 *     services, categories, and full 4-level location hierarchy
 *   - fails if any test-owned rows remain across any table.
 */

import { Client } from 'pg';
import { randomUUID } from 'crypto';

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

// Helper to create an authenticated client session simulating PostgREST RLS
async function createAuthClient(userId: string): Promise<Client> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`SET ROLE authenticated;`);
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [userId]);
  await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
  return client;
}

async function runConcurrencyRaceTest() {
  console.log('============================================================');
  console.log('RUNNING CONCURRENCY RACE CONDITION TEST (test_concurrency_race.ts)');
  console.log('============================================================');

  const adminClient = new Client({ connectionString: DB_URL });
  let sessionA: Client | null = null;
  let sessionB: Client | null = null;

  // Freshly generated distinct UUIDs for customer, provider, and requests
  const customerId = randomUUID();
  const providerUserId = randomUUID();
  const providerProfileId = randomUUID();
  const requestId = randomUUID();
  const requestId2 = randomUUID();

  // Track location hierarchy fixtures for reverse-dependency cleanup
  const createdCountryId = randomUUID();
  const createdStateId = randomUUID();
  const createdCityId = randomUUID();
  const createdAreaId = randomUUID();
  const areaId = createdAreaId;

  // Track category and service fixtures for cleanup
  const createdCategoryId = randomUUID();
  const createdServiceId = randomUUID();
  const serviceId = createdServiceId;

  // Track created conversations and contact shares for cleanup verification
  let conversationId: string | null = null;
  let conversationId2: string | null = null;
  const observedShareIds: string[] = [];

  try {
    await adminClient.connect();
    console.log('[Setup] Connected administrative database client.');

    // 1. Provision dedicated, isolated 4-level location hierarchy
    console.log(`[Setup] Provisioning isolated location hierarchy (Area: ${createdAreaId})...`);
    await adminClient.query(
      `INSERT INTO public.locations (id, name, level, parent_id)
       VALUES ($1, 'Race Test Country', 'country', NULL);`,
      [createdCountryId]
    );

    await adminClient.query(
      `INSERT INTO public.locations (id, name, level, parent_id)
       VALUES ($1, 'Race Test State', 'state', $2);`,
      [createdStateId, createdCountryId]
    );

    await adminClient.query(
      `INSERT INTO public.locations (id, name, level, parent_id)
       VALUES ($1, 'Race Test City', 'city', $2);`,
      [createdCityId, createdStateId]
    );

    await adminClient.query(
      `INSERT INTO public.locations (id, name, level, parent_id)
       VALUES ($1, 'Race Test Area', 'area', $2);`,
      [createdAreaId, createdCityId]
    );

    // 2. Provision dedicated, isolated category and service fixtures
    const catSlug = `race-cat-${createdCategoryId.slice(0, 8)}`;
    const srvSlug = `race-srv-${createdServiceId.slice(0, 8)}`;

    await adminClient.query(
      `INSERT INTO public.categories (id, name, slug)
       VALUES ($1, 'Race Category', $2);`,
      [createdCategoryId, catSlug]
    );

    await adminClient.query(
      `INSERT INTO public.services (id, category_id, name, slug)
       VALUES ($1, $2, 'Race Service', $3);`,
      [createdServiceId, createdCategoryId, srvSlug]
    );
    console.log(`[Setup] Created catalog fixtures: Service ${createdServiceId} in Category ${createdCategoryId}`);

    // 3. Create fresh Auth Users with authoritative metadata and phone.
    // The on_auth_user_created trigger invokes handle_new_auth_user(), which authoritatively
    // populates public.users, public.user_roles ('user'), and public.user_private (with phone_e164).
    console.log(`[Setup] Administrative provisioning of Customer (${customerId}) & Provider (${providerUserId})...`);
    await adminClient.query(
      `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
       VALUES
         ($1, $2, '+12025550191', '{"full_name": "Race Customer"}'::jsonb),
         ($3, $4, '+12025550192', '{"full_name": "Race Provider"}'::jsonb);`,
      [
        customerId,
        `race_cust_${customerId.slice(0, 8)}@example.com`,
        providerUserId,
        `race_prov_${providerUserId.slice(0, 8)}@example.com`,
      ]
    );

    // Assign provider role to provider user (default 'user' role is created by handle_new_auth_user)
    await adminClient.query(
      `INSERT INTO public.user_roles (user_id, role)
       VALUES ($1, 'provider'::public.app_role)
       ON CONFLICT (user_id, role) DO NOTHING;`,
      [providerUserId]
    );

    // 4. Provision Provider Profile & Location Coverage administratively
    await adminClient.query(
      `INSERT INTO public.provider_profiles (id, user_id, bio, gender, years_experience, status)
       VALUES ($1, $2, 'Race Concurrency Provider', 'male', 5, 'approved');`,
      [providerProfileId, providerUserId]
    );

    await adminClient.query(
      `INSERT INTO public.provider_locations (provider_id, location_id)
       VALUES ($1, $2);`,
      [providerProfileId, areaId]
    );

    // 5. Establish Primary Service Request and Advance Controlled Lifecycle to CHAT_ACTIVE Administratively
    console.log(`[Setup] Administrative creation of Service Request (${requestId}) in REQUESTED status...`);
    await adminClient.query(
      `INSERT INTO public.service_requests (id, user_id, provider_id, service_id, location_id, status, notes)
       VALUES ($1, $2, $3, $4, $5, 'REQUESTED', 'Administrative Concurrency Race Fixture');`,
      [requestId, customerId, providerProfileId, serviceId, areaId]
    );

    console.log('[Setup] Administratively transitioning request to ACCEPTED as Provider...');
    await adminClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [providerUserId]);
    await adminClient.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
    await adminClient.query(
      `SELECT public.transition_service_request($1, 'ACCEPTED'::public.request_status, 'Administrative acceptance for test');`,
      [requestId]
    );

    console.log('[Setup] Administratively activating chat to CHAT_ACTIVE as Customer...');
    await adminClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [customerId]);
    await adminClient.query(`SELECT public.activate_request_chat($1);`, [requestId]);

    // Capture conversation ID directly for independent message/conversation tracking
    const convRes = await adminClient.query(
      `SELECT id FROM public.conversations WHERE request_id = $1;`,
      [requestId]
    );
    if (convRes.rows.length > 0) {
      conversationId = convRes.rows[0].id;
      console.log(`[Setup] Captured test conversation ID directly: ${conversationId}`);
    }

    // Verify request reached CHAT_ACTIVE
    const statusCheck = await adminClient.query(
      `SELECT status FROM public.service_requests WHERE id = $1;`,
      [requestId]
    );
    if (statusCheck.rows[0]?.status !== 'CHAT_ACTIVE') {
      throw new Error(`Prerequisite Failure: Expected request status CHAT_ACTIVE, got ${statusCheck.rows[0]?.status}`);
    }
    console.log('[Setup] Verified service request is in CHAT_ACTIVE status.');

    // --------------------------------------------------------------------------
    // PART 1: CONCURRENT SHARE REQUESTS (TWO CLIENTS, SAME REQUEST)
    // --------------------------------------------------------------------------
    console.log('[Part 1 Execution] Spawning two independent client sessions for the customer...');
    sessionA = await createAuthClient(customerId);
    sessionB = await createAuthClient(customerId);

    console.log('[Part 1 Execution] Firing concurrent request_contact_share calls simultaneously...');
    const startTime1 = Date.now();
    const [resultA, resultB] = await Promise.allSettled([
      sessionA.query(`SELECT public.request_contact_share($1) AS out;`, [requestId]),
      sessionB.query(`SELECT public.request_contact_share($1) AS out;`, [requestId]),
    ]);
    const durationMs1 = Date.now() - startTime1;
    console.log(`[Part 1 Execution] Both concurrent calls completed in ${durationMs1}ms.`);

    if (resultA.status === 'rejected') {
      throw new Error(`Session A failed with error: ${resultA.reason?.message}`);
    }
    if (resultB.status === 'rejected') {
      throw new Error(`Session B failed with error: ${resultB.reason?.message}`);
    }

    const outA = resultA.value.rows[0].out;
    const outB = resultB.value.rows[0].out;
    console.log('[Session A Output]:', JSON.stringify(outA));
    console.log('[Session B Output]:', JSON.stringify(outB));

    if (!outA?.id || !outB?.id) {
      throw new Error(`Assertion Failure: Expected share id from both sessions, got A: ${outA?.id}, B: ${outB?.id}`);
    }

    observedShareIds.push(outA.id, outB.id);

    if (outA.id !== outB.id) {
      throw new Error(`Assertion Failure: Session A created share ${outA.id} but Session B created ${outB.id} (duplicate rows!)`);
    }

    // Query database to verify strictly ONE row exists
    const sharesInDb = await adminClient.query(
      `SELECT id, status, sharer_id, recipient_id, created_at, updated_at
       FROM public.contact_shares
       WHERE request_id = $1;`,
      [requestId]
    );

    if (sharesInDb.rows.length !== 1) {
      throw new Error(`Assertion Failure: Expected exactly 1 contact share row, found ${sharesInDb.rows.length}`);
    }

    const row = sharesInDb.rows[0];
    if (row.status !== 'pending') {
      throw new Error(`Assertion Failure: Expected status 'pending', got '${row.status}'`);
    }
    if (row.sharer_id !== customerId) {
      throw new Error(`Assertion Failure: Expected sharer_id ${customerId}, got ${row.sharer_id}`);
    }
    if (row.recipient_id !== providerUserId) {
      throw new Error(`Assertion Failure: Expected recipient_id ${providerUserId}, got ${row.recipient_id}`);
    }
    console.log('[Part 1 Result]: PASS - Strict single-row creation, safe conflict resolution, zero 23505 errors.');

    // --------------------------------------------------------------------------
    // PART 2: LIFECYCLE CONCURRENCY RACE (SHARE REQUEST vs TERMINAL TRANSITION)
    // --------------------------------------------------------------------------
    console.log('\n[Part 2 Setup] Setting up second request for terminal transition race condition...');
    await adminClient.query(
      `INSERT INTO public.service_requests (id, user_id, provider_id, service_id, location_id, status, notes)
       VALUES ($1, $2, $3, $4, $5, 'REQUESTED', 'Terminal Concurrency Race Fixture');`,
      [requestId2, customerId, providerProfileId, serviceId, areaId]
    );

    // Advance requestId2 to CHAT_ACTIVE
    await adminClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [providerUserId]);
    await adminClient.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
    await adminClient.query(
      `SELECT public.transition_service_request($1, 'ACCEPTED'::public.request_status, 'Acceptance for race test');`,
      [requestId2]
    );

    await adminClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [customerId]);
    await adminClient.query(`SELECT public.activate_request_chat($1);`, [requestId2]);

    const convRes2 = await adminClient.query(
      `SELECT id FROM public.conversations WHERE request_id = $1;`,
      [requestId2]
    );
    if (convRes2.rows.length > 0) {
      conversationId2 = convRes2.rows[0].id;
      console.log(`[Part 2 Setup] Captured test conversation 2 ID directly: ${conversationId2}`);
    }

    console.log('[Part 2 Execution] Firing concurrent request_contact_share vs terminal transition_service_request...');
    const startTime2 = Date.now();
    const [shareRaceResult, terminalRaceResult] = await Promise.allSettled([
      sessionA.query(`SELECT public.request_contact_share($1) AS out;`, [requestId2]),
      sessionB.query(
        `SELECT public.transition_service_request($1, 'COMPLETED'::public.request_status, 'Race completion test') AS out;`,
        [requestId2]
      ),
    ]);
    const durationMs2 = Date.now() - startTime2;
    console.log(`[Part 2 Execution] Concurrent race completed in ${durationMs2}ms.`);

    if (shareRaceResult.status === 'fulfilled') {
      const shareOut = shareRaceResult.value.rows[0].out;
      if (shareOut?.id) {
        observedShareIds.push(shareOut.id);
      }
      console.log('[Part 2 Share Output]:', JSON.stringify(shareOut));
    } else {
      console.log('[Part 2 Share Rejection (Expected if terminal transition locked first)]:', shareRaceResult.reason?.message);
    }

    if (terminalRaceResult.status === 'fulfilled') {
      console.log('[Part 2 Terminal Output]:', JSON.stringify(terminalRaceResult.value.rows[0].out));
    } else {
      console.log('[Part 2 Terminal Error]:', terminalRaceResult.reason?.message);
    }

    // Critical Invariant: Verify that NO contact share on requestId2 survived in 'pending' or 'shared' status
    const lingeringActiveShares = await adminClient.query(
      `SELECT id, status FROM public.contact_shares
       WHERE request_id = $1 AND status IN ('pending', 'shared');`,
      [requestId2]
    );

    if (lingeringActiveShares.rows.length > 0) {
      throw new Error(
        `Assertion Failure: Lifecycle race leak! Found ${lingeringActiveShares.rows.length} pending/shared contact shares on completed request: ` +
        JSON.stringify(lingeringActiveShares.rows)
      );
    }

    // Check all shares for requestId2 to record IDs for cleanup
    const allSharesReq2 = await adminClient.query(
      `SELECT id, status FROM public.contact_shares WHERE request_id = $1;`,
      [requestId2]
    );
    for (const r of allSharesReq2.rows) {
      observedShareIds.push(r.id);
    }

    console.log('[Part 2 Result]: PASS - Zero active contact shares survived terminal transition.');

    console.log('============================================================');
    console.log('CONCURRENCY RACE TEST RESULT: ALL TESTS PASSED');
    console.log('Strict single-row creation, safe conflict resolution, zero 23505 errors, zero terminal race leaks.');
    console.log('============================================================');
  } catch (err: any) {
    console.error('============================================================');
    console.error('CONCURRENCY RACE TEST RESULT: FAIL');
    console.error('Error Details:', err.message);
    console.error('============================================================');
    process.exitCode = 1;
  } finally {
    console.log('[Cleanup] Executing verified administrative cleanup across all modified tables...');
    const cleanupFailures: string[] = [];

    const executeCleanupStep = async (stepName: string, queryText: string, params: any[] = []) => {
      try {
        await adminClient.query(queryText, params);
      } catch (err: any) {
        cleanupFailures.push(`[${stepName}] ${err.message}`);
      }
    };

    const reqIds = [requestId, requestId2];
    const convIds = [conversationId, conversationId2].filter((id): id is string => id !== null);

    // 1. Clean up audit logs created by test operations (scoped strictly to test actors & test request/share entities)
    await executeCleanupStep(
      'Delete audit_logs',
      `DELETE FROM public.audit_logs
       WHERE actor_id IN ($1, $2)
          OR (entity_type = 'service_requests' AND entity_id = ANY($3::uuid[]))
          OR (entity_type = 'contact_shares' AND entity_id = ANY($4::uuid[]));`,
      [customerId, providerUserId, reqIds, observedShareIds]
    );

    // 2. Delete contact_shares
    await executeCleanupStep(
      'Delete contact_shares',
      `DELETE FROM public.contact_shares WHERE request_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]);`,
      [reqIds, observedShareIds]
    );

    // 3. Delete messages independently by tracked conversation IDs and test senders
    if (convIds.length > 0) {
      await executeCleanupStep(
        'Delete messages by conversation_id',
        `DELETE FROM public.messages WHERE conversation_id = ANY($1::uuid[]);`,
        [convIds]
      );
    }
    await executeCleanupStep(
      'Delete messages by sender_id',
      `DELETE FROM public.messages WHERE sender_id IN ($1, $2);`,
      [customerId, providerUserId]
    );

    // 4. Delete conversations by tracked IDs and request IDs
    if (convIds.length > 0) {
      await executeCleanupStep(
        'Delete conversations by id',
        `DELETE FROM public.conversations WHERE id = ANY($1::uuid[]);`,
        [convIds]
      );
    }
    await executeCleanupStep(
      'Delete conversations by request_id',
      `DELETE FROM public.conversations WHERE request_id = ANY($1::uuid[]);`,
      [reqIds]
    );

    // 5. Cascaded deletion of domain fixtures in strict reverse dependency order
    await executeCleanupStep('Delete service_requests', `DELETE FROM public.service_requests WHERE id = ANY($1::uuid[]);`, [reqIds]);
    await executeCleanupStep('Delete provider_locations', `DELETE FROM public.provider_locations WHERE provider_id = $1;`, [providerProfileId]);
    await executeCleanupStep('Delete provider_profiles', `DELETE FROM public.provider_profiles WHERE id = $1;`, [providerProfileId]);
    await executeCleanupStep('Delete user_roles', `DELETE FROM public.user_roles WHERE user_id IN ($1, $2);`, [customerId, providerUserId]);
    await executeCleanupStep('Delete user_private', `DELETE FROM public.user_private WHERE user_id IN ($1, $2);`, [customerId, providerUserId]);
    await executeCleanupStep('Delete public.users', `DELETE FROM public.users WHERE id IN ($1, $2);`, [customerId, providerUserId]);
    await executeCleanupStep('Delete auth.users', `DELETE FROM auth.users WHERE id IN ($1, $2);`, [customerId, providerUserId]);

    // 6. Reverse-dependency deletion of catalog fixtures: service before category
    await executeCleanupStep('Delete created service', `DELETE FROM public.services WHERE id = $1;`, [createdServiceId]);
    await executeCleanupStep('Delete created category', `DELETE FROM public.categories WHERE id = $1;`, [createdCategoryId]);

    // 7. Strict reverse-dependency deletion of location hierarchy: area -> city -> state -> country
    await executeCleanupStep('Delete created area', `DELETE FROM public.locations WHERE id = $1;`, [createdAreaId]);
    await executeCleanupStep('Delete created city', `DELETE FROM public.locations WHERE id = $1;`, [createdCityId]);
    await executeCleanupStep('Delete created state', `DELETE FROM public.locations WHERE id = $1;`, [createdStateId]);
    await executeCleanupStep('Delete created country', `DELETE FROM public.locations WHERE id = $1;`, [createdCountryId]);

    // 8. Comprehensive Verification: Confirm zero test fixtures linger across EVERY single touched table
    try {
      const lingering: string[] = [];

      // Verify messages independently of conversation existence
      if (convIds.length > 0) {
        const msgConvCheck = await adminClient.query(
          `SELECT count(*)::int AS cnt FROM public.messages WHERE conversation_id = ANY($1::uuid[]);`,
          [convIds]
        );
        if (msgConvCheck.rows[0].cnt > 0) {
          lingering.push(`${msgConvCheck.rows[0].cnt} messages (by tracked conversation ID)`);
        }
      }

      const msgSenderCheck = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.messages WHERE sender_id IN ($1, $2);`,
        [customerId, providerUserId]
      );
      if (msgSenderCheck.rows[0].cnt > 0) {
        lingering.push(`${msgSenderCheck.rows[0].cnt} messages (by test senders)`);
      }

      // Verify conversations
      if (convIds.length > 0) {
        const convIdCheck = await adminClient.query(
          `SELECT count(*)::int AS cnt FROM public.conversations WHERE id = ANY($1::uuid[]);`,
          [convIds]
        );
        if (convIdCheck.rows[0].cnt > 0) {
          lingering.push(`${convIdCheck.rows[0].cnt} conversations (by tracked ID)`);
        }
      }

      const convReqCheck = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.conversations WHERE request_id = ANY($1::uuid[]);`,
        [reqIds]
      );
      if (convReqCheck.rows[0].cnt > 0) {
        lingering.push(`${convReqCheck.rows[0].cnt} conversations (by request ID)`);
      }

      // Verify contact_shares
      const shareCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.contact_shares WHERE request_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]);`,
        [reqIds, observedShareIds]
      );
      if (shareCount.rows[0].cnt > 0) {
        lingering.push(`${shareCount.rows[0].cnt} contact_shares`);
      }

      // Verify audit_logs
      const auditCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.audit_logs
         WHERE actor_id IN ($1, $2)
            OR (entity_type = 'service_requests' AND entity_id = ANY($3::uuid[]))
            OR (entity_type = 'contact_shares' AND entity_id = ANY($4::uuid[]));`,
        [customerId, providerUserId, reqIds, observedShareIds]
      );
      if (auditCount.rows[0].cnt > 0) {
        lingering.push(`${auditCount.rows[0].cnt} audit_logs`);
      }

      // Verify service_requests
      const reqCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.service_requests WHERE id = ANY($1::uuid[]);`,
        [reqIds]
      );
      if (reqCount.rows[0].cnt > 0) {
        lingering.push(`${reqCount.rows[0].cnt} service_requests`);
      }

      // Verify provider_locations & provider_profiles
      const provLocCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.provider_locations WHERE provider_id = $1;`,
        [providerProfileId]
      );
      if (provLocCount.rows[0].cnt > 0) {
        lingering.push(`${provLocCount.rows[0].cnt} provider_locations`);
      }

      const provProfCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.provider_profiles WHERE id = $1;`,
        [providerProfileId]
      );
      if (provProfCount.rows[0].cnt > 0) {
        lingering.push(`${provProfCount.rows[0].cnt} provider_profiles`);
      }

      // Verify user accounts across auth and public schemas
      const rolesCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.user_roles WHERE user_id IN ($1, $2);`,
        [customerId, providerUserId]
      );
      if (rolesCount.rows[0].cnt > 0) {
        lingering.push(`${rolesCount.rows[0].cnt} user_roles`);
      }

      const privCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.user_private WHERE user_id IN ($1, $2);`,
        [customerId, providerUserId]
      );
      if (privCount.rows[0].cnt > 0) {
        lingering.push(`${privCount.rows[0].cnt} user_private`);
      }

      const pubUserCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.users WHERE id IN ($1, $2);`,
        [customerId, providerUserId]
      );
      if (pubUserCount.rows[0].cnt > 0) {
        lingering.push(`${pubUserCount.rows[0].cnt} public.users`);
      }

      const authUserCount = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM auth.users WHERE id IN ($1, $2);`,
        [customerId, providerUserId]
      );
      if (authUserCount.rows[0].cnt > 0) {
        lingering.push(`${authUserCount.rows[0].cnt} auth.users`);
      }

      // Verify catalog fixtures
      const srvCheck = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.services WHERE id = $1;`,
        [createdServiceId]
      );
      if (srvCheck.rows[0].cnt > 0) {
        lingering.push(`${srvCheck.rows[0].cnt} services`);
      }

      const catCheck = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.categories WHERE id = $1;`,
        [createdCategoryId]
      );
      if (catCheck.rows[0].cnt > 0) {
        lingering.push(`${catCheck.rows[0].cnt} categories`);
      }

      // Verify all 4 locations in the created hierarchy
      const locIds = [createdAreaId, createdCityId, createdStateId, createdCountryId];
      const locCheck = await adminClient.query(
        `SELECT count(*)::int AS cnt FROM public.locations WHERE id = ANY($1::uuid[]);`,
        [locIds]
      );
      if (locCheck.rows[0].cnt > 0) {
        lingering.push(`${locCheck.rows[0].cnt} lingering locations in hierarchy`);
      }

      if (lingering.length > 0) {
        cleanupFailures.push(`Lingering fixtures detected after cleanup: ${lingering.join(', ')}`);
      } else {
        console.log('[Cleanup] Verification confirmed: Exactly 0 test fixtures remain across all tables (including audit_logs, messages, conversations, locations, and catalog).');
      }
    } catch (verifErr: any) {
      cleanupFailures.push(`[Verification Query Error] ${verifErr.message}`);
    }

    if (cleanupFailures.length > 0) {
      console.error('[Cleanup Failures Encountered]:\n' + cleanupFailures.join('\n'));
      process.exitCode = 1;
      throw new Error(`Cleanup Failure: Lingering fixtures detected or cleanup step failed:\n${cleanupFailures.join('\n')}`);
    } else {
      console.log('[Cleanup] Verified cleanup completed with 0 errors.');
    }

    await sessionA?.end().catch(() => {});
    await sessionB?.end().catch(() => {});
    await adminClient.end().catch(() => {});
    console.log('[Cleanup] All database client connections closed.');
  }
}

// Run test when executed directly
if (process.argv[1]?.endsWith('test_concurrency_race.ts')) {
  runConcurrencyRaceTest().then(() => {
    if (process.exitCode === 1) {
      process.exit(1);
    }
  });
}

export { runConcurrencyRaceTest };
