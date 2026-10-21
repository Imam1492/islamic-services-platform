-- ============================================================================
-- STAGING DATABASE SECURITY HARDENING TEST SUITE
-- File: supabase/tests/staging_security_hardening.sql
--
-- Validates:
--   1. Genuine Role Privileges: anon execution denied on log_audit_event (42501).
--   2. Genuine Role Privileges: anon execution denied on assert_provider_covers_area (42501).
--   3. Genuine Role Privileges: anon execution denied on get_shared_contact_info (42501).
--   4. Genuine Role Privileges: authenticated direct UPDATE denied on contact_shares (42501).
--   5. Genuine Role Privileges: authenticated direct EXECUTE denied on log_audit_event (42501).
--   6. Contact Share Lifecycle: customer initiates share (status pending).
--   7. Negative Authorization: non-recipient cannot approve share (P0001).
--   8. Functional Authorization: designated recipient approves share (status shared).
--   9. Functional Workflow: revocation and sharer re-request (revoked -> pending).
--  10. Negative Authorization: non-sharer cannot re-request revoked share (P0001/42501).
--  11. Negative Authorization: forging app.allow_status_transition cannot revoke share (P0001).
--  12. Negative Integrity: immutability of id, created_at, request_id, sharer_id, recipient_id (P0001).
--  13. Privacy Protection: get_shared_contact_info denied when request is COMPLETED (P0001).
--  14. Atomicity & Rollback: terminal transition failure rolls back request and share status.
--  15. Lifecycle Concurrency: request_contact_share rejected on terminal requests (P0001).
--
-- SAFETY & ISOLATION:
--   - Uses 100% test-owned, isolated fixtures with dynamically generated unique IDs (gen_random_uuid()).
--   - Compatible with auth trigger handle_new_auth_user() on auth.users inserts (avoids duplicate inserts).
--   - Results recorded in pg_temp table accessible to test roles; no savepoint rollbacks erase failures.
--   - Role checks execute via top-level SET LOCAL ROLE without invalid SECURITY DEFINER wrappers.
--   - Wrapped entirely in BEGIN ... ROLLBACK; leaves zero test artifacts in database.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ----------------------------------------------------------------------------
-- TEMPORARY RESULT & FIXTURE TRACKER
-- Accessible across role switches to record test outcomes and share isolated dynamic IDs
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE pg_temp.staging_test_results (
  test_num int PRIMARY KEY,
  test_name text NOT NULL,
  passed boolean NOT NULL,
  details text NOT NULL
);

CREATE TEMP TABLE pg_temp.staging_test_fixtures (
  customer_id uuid NOT NULL,
  provider_user_id uuid NOT NULL,
  provider_profile_id uuid NOT NULL,
  third_party_id uuid NOT NULL,
  country_id uuid NOT NULL,
  state_id uuid NOT NULL,
  city_id uuid NOT NULL,
  area_id uuid NOT NULL,
  category_id uuid NOT NULL,
  service_id uuid NOT NULL,
  request_id uuid NOT NULL,
  share_id uuid,
  atomicity_req_id uuid NOT NULL,
  atomicity_share_id uuid,
  terminal_race_req_id uuid NOT NULL
);

-- Grant privileges so anon and authenticated sessions can record test results
GRANT ALL ON pg_temp.staging_test_results TO anon, authenticated, PUBLIC;
GRANT ALL ON pg_temp.staging_test_fixtures TO anon, authenticated, PUBLIC;

-- ----------------------------------------------------------------------------
-- PROVISION ISOLATED TEST FIXTURES
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_country_id uuid := gen_random_uuid();
  v_state_id uuid := gen_random_uuid();
  v_city_id uuid := gen_random_uuid();
  v_area_id uuid := gen_random_uuid();
  v_category_id uuid := gen_random_uuid();
  v_service_id uuid := gen_random_uuid();
  v_customer_id uuid := gen_random_uuid();
  v_provider_user_id uuid := gen_random_uuid();
  v_provider_profile_id uuid := gen_random_uuid();
  v_third_party_id uuid := gen_random_uuid();
  v_request_id uuid := gen_random_uuid();
  v_atomicity_req_id uuid := gen_random_uuid();
  v_terminal_race_req_id uuid := gen_random_uuid();
  v_res jsonb;
BEGIN
  -- 1. Provision dedicated, isolated 4-level location hierarchy with unique IDs
  INSERT INTO public.locations (id, name, level, parent_id)
  VALUES (v_country_id, 'Staging Test Country', 'country', NULL);

  INSERT INTO public.locations (id, name, level, parent_id)
  VALUES (v_state_id, 'Staging Test State', 'state', v_country_id);

  INSERT INTO public.locations (id, name, level, parent_id)
  VALUES (v_city_id, 'Staging Test City', 'city', v_state_id);

  INSERT INTO public.locations (id, name, level, parent_id)
  VALUES (v_area_id, 'Staging Test Area', 'area', v_city_id);

  -- 2. Provision dedicated, isolated category and service with unique IDs
  INSERT INTO public.categories (id, name, slug)
  VALUES (v_category_id, 'Staging Test Category', format('staging-cat-%s', v_category_id));

  INSERT INTO public.services (id, category_id, name, slug)
  VALUES (v_service_id, v_category_id, 'Staging Test Service', format('staging-srv-%s', v_service_id));

  -- 3. Provision test users via auth.users with E.164 phone and metadata.
  -- The on_auth_user_created trigger invokes handle_new_auth_user(), which authoritatively
  -- populates public.users, public.user_roles ('user'), and public.user_private (with phone_e164).
  INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
  VALUES
    (v_customer_id, format('staging_cust_%s@example.com', substr(v_customer_id::text, 1, 8)), '+12025550181', '{"full_name": "Staging Customer"}'::jsonb),
    (v_provider_user_id, format('staging_prov_%s@example.com', substr(v_provider_user_id::text, 1, 8)), '+12025550182', '{"full_name": "Staging Provider"}'::jsonb),
    (v_third_party_id, format('staging_third_%s@example.com', substr(v_third_party_id::text, 1, 8)), '+12025550183', '{"full_name": "Staging Third Party"}'::jsonb);

  -- Assign provider role to provider user (default 'user' role was created by handle_new_auth_user)
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_provider_user_id, 'provider'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  -- 4. Create provider profile & location coverage
  INSERT INTO public.provider_profiles (id, user_id, bio, gender, years_experience, status)
  VALUES (v_provider_profile_id, v_provider_user_id, 'Staging Test Provider', 'male', 5, 'approved');

  INSERT INTO public.provider_locations (provider_id, location_id)
  VALUES (v_provider_profile_id, v_area_id);

  -- 5. Create primary service request & advance through approved RPCs to CHAT_ACTIVE
  INSERT INTO public.service_requests (id, user_id, provider_id, service_id, location_id, status, notes)
  VALUES (v_request_id, v_customer_id, v_provider_profile_id, v_service_id, v_area_id, 'REQUESTED', 'Staging Request');

  -- Advance to ACCEPTED as provider via transition_service_request
  PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_res := public.transition_service_request(v_request_id, 'ACCEPTED'::public.request_status, 'Accepting for staging test');

  -- Advance to CHAT_ACTIVE as customer via activate_request_chat
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
  v_res := public.activate_request_chat(v_request_id);

  -- Store generated fixture UUIDs for subsequent test steps
  INSERT INTO pg_temp.staging_test_fixtures (
    customer_id,
    provider_user_id,
    provider_profile_id,
    third_party_id,
    country_id,
    state_id,
    city_id,
    area_id,
    category_id,
    service_id,
    request_id,
    share_id,
    atomicity_req_id,
    atomicity_share_id,
    terminal_race_req_id
  ) VALUES (
    v_customer_id,
    v_provider_user_id,
    v_provider_profile_id,
    v_third_party_id,
    v_country_id,
    v_state_id,
    v_city_id,
    v_area_id,
    v_category_id,
    v_service_id,
    v_request_id,
    NULL,
    v_atomicity_req_id,
    NULL,
    v_terminal_race_req_id
  );
END;
$$;


-- ----------------------------------------------------------------------------
-- TEST 1: Genuine anon Execution - log_audit_event Prohibited (42501)
-- ----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $$
DECLARE
  v_customer_id uuid;
  v_passed boolean := false;
  v_details text := 'Unexpectedly succeeded';
BEGIN
  SELECT customer_id INTO v_customer_id FROM pg_temp.staging_test_fixtures;
  BEGIN
    PERFORM public.log_audit_event(
      v_customer_id,
      'TEST_ACTION',
      'test_entity',
      v_customer_id,
      NULL,
      NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_passed := true;
    v_details := 'Rejected with 42501 (insufficient_privilege)';
  WHEN OTHERS THEN
    v_passed := false;
    v_details := format('Unexpected error %s: %s', SQLSTATE, SQLERRM);
  END;

  INSERT INTO pg_temp.staging_test_results VALUES (1, 'anon execution prohibited on log_audit_event', v_passed, v_details);
  IF v_passed THEN
    RAISE NOTICE 'Test 1 [PASS]: Genuine anon execution on log_audit_event rejected with 42501 (insufficient_privilege)';
  ELSE
    RAISE NOTICE 'Test 1 [FAIL]: anon was able to execute log_audit_event: %', v_details;
  END IF;
END;
$$;
RESET ROLE;


-- ----------------------------------------------------------------------------
-- TEST 2: Genuine anon Execution - assert_provider_covers_area Prohibited (42501)
-- ----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $$
DECLARE
  v_provider_profile_id uuid;
  v_area_id uuid;
  v_passed boolean := false;
  v_details text := 'Unexpectedly succeeded';
BEGIN
  SELECT provider_profile_id, area_id INTO v_provider_profile_id, v_area_id FROM pg_temp.staging_test_fixtures;
  BEGIN
    PERFORM public.assert_provider_covers_area(v_provider_profile_id, v_area_id);
  EXCEPTION WHEN insufficient_privilege THEN
    v_passed := true;
    v_details := 'Rejected with 42501 (insufficient_privilege)';
  WHEN OTHERS THEN
    v_passed := false;
    v_details := format('Unexpected error %s: %s', SQLSTATE, SQLERRM);
  END;

  INSERT INTO pg_temp.staging_test_results VALUES (2, 'anon execution prohibited on assert_provider_covers_area', v_passed, v_details);
  IF v_passed THEN
    RAISE NOTICE 'Test 2 [PASS]: Genuine anon execution on assert_provider_covers_area rejected with 42501 (insufficient_privilege)';
  ELSE
    RAISE NOTICE 'Test 2 [FAIL]: anon was able to execute assert_provider_covers_area: %', v_details;
  END IF;
END;
$$;
RESET ROLE;


-- ----------------------------------------------------------------------------
-- TEST 3: Genuine anon Execution - get_shared_contact_info Prohibited (42501)
-- ----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $$
DECLARE
  v_request_id uuid;
  v_customer_id uuid;
  v_passed boolean := false;
  v_details text := 'Unexpectedly succeeded';
BEGIN
  SELECT request_id, customer_id INTO v_request_id, v_customer_id FROM pg_temp.staging_test_fixtures;
  BEGIN
    PERFORM public.get_shared_contact_info(v_request_id, v_customer_id);
  EXCEPTION WHEN insufficient_privilege THEN
    v_passed := true;
    v_details := 'Rejected with 42501 (insufficient_privilege)';
  WHEN OTHERS THEN
    v_passed := false;
    v_details := format('Unexpected error %s: %s', SQLSTATE, SQLERRM);
  END;

  INSERT INTO pg_temp.staging_test_results VALUES (3, 'anon execution prohibited on get_shared_contact_info', v_passed, v_details);
  IF v_passed THEN
    RAISE NOTICE 'Test 3 [PASS]: Genuine anon execution on get_shared_contact_info rejected with 42501 (insufficient_privilege)';
  ELSE
    RAISE NOTICE 'Test 3 [FAIL]: anon was able to execute get_shared_contact_info: %', v_details;
  END IF;
END;
$$;
RESET ROLE;


-- ----------------------------------------------------------------------------
-- TEST 4: Genuine authenticated Execution - Direct contact_shares UPDATE Prohibited (42501)
-- ----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
DO $$
DECLARE
  v_customer_id uuid;
BEGIN
  SELECT customer_id INTO v_customer_id FROM pg_temp.staging_test_fixtures;
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
END;
$$;

DO $$
DECLARE
  v_passed boolean := false;
  v_details text := 'Unexpectedly succeeded';
BEGIN
  BEGIN
    UPDATE public.contact_shares SET status = 'shared' WHERE 1=1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_passed := true;
    v_details := 'Rejected with 42501 (insufficient_privilege)';
  WHEN OTHERS THEN
    v_passed := false;
    v_details := format('Unexpected error %s: %s', SQLSTATE, SQLERRM);
  END;

  INSERT INTO pg_temp.staging_test_results VALUES (4, 'authenticated direct UPDATE prohibited on contact_shares', v_passed, v_details);
  IF v_passed THEN
    RAISE NOTICE 'Test 4 [PASS]: Direct table UPDATE on public.contact_shares rejected with 42501 under authenticated';
  ELSE
    RAISE NOTICE 'Test 4 [FAIL]: authenticated was able to directly UPDATE public.contact_shares: %', v_details;
  END IF;
END;
$$;
RESET ROLE;


-- ----------------------------------------------------------------------------
-- TEST 5: Genuine authenticated Execution - Direct log_audit_event Prohibited (42501)
-- ----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
DO $$
DECLARE
  v_customer_id uuid;
BEGIN
  SELECT customer_id INTO v_customer_id FROM pg_temp.staging_test_fixtures;
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
END;
$$;

DO $$
DECLARE
  v_customer_id uuid;
  v_passed boolean := false;
  v_details text := 'Unexpectedly succeeded';
BEGIN
  SELECT customer_id INTO v_customer_id FROM pg_temp.staging_test_fixtures;
  BEGIN
    PERFORM public.log_audit_event(
      v_customer_id,
      'FORGED_EVENT',
      'users',
      v_customer_id,
      NULL,
      NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_passed := true;
    v_details := 'Rejected with 42501 (insufficient_privilege)';
  WHEN OTHERS THEN
    v_passed := false;
    v_details := format('Unexpected error %s: %s', SQLSTATE, SQLERRM);
  END;

  INSERT INTO pg_temp.staging_test_results VALUES (5, 'authenticated direct EXECUTE prohibited on log_audit_event', v_passed, v_details);
  IF v_passed THEN
    RAISE NOTICE 'Test 5 [PASS]: Direct EXECUTE on public.log_audit_event rejected with 42501 under authenticated';
  ELSE
    RAISE NOTICE 'Test 5 [FAIL]: authenticated was able to execute log_audit_event directly: %', v_details;
  END IF;
END;
$$;
RESET ROLE;


-- ----------------------------------------------------------------------------
-- TESTS 6 - 13: CONTACT SHARE LIFECYCLE, INTEGRITY & AUTHORIZATION
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_customer_id uuid;
  v_provider_user_id uuid;
  v_third_party_id uuid;
  v_request_id uuid;
  v_share_id uuid;
  v_res jsonb;
  v_status text;
  v_expected_failed boolean;
  v_sqlstate text;
  v_errmsg text;
  v_subtest_passed boolean;
BEGIN
  SELECT customer_id, provider_user_id, third_party_id, request_id
  INTO v_customer_id, v_provider_user_id, v_third_party_id, v_request_id
  FROM pg_temp.staging_test_fixtures;

  -- --------------------------------------------------------------------------
  -- TEST 6: Customer initiates contact share via request_contact_share RPC
  -- --------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  v_res := public.request_contact_share(v_request_id);
  v_share_id := (v_res->>'id')::uuid;

  IF v_share_id IS NOT NULL AND (v_res->>'status') = 'pending' THEN
    INSERT INTO pg_temp.staging_test_results VALUES (6, 'Customer initiates contact share (pending)', true, format('Created share %s', v_share_id));
    RAISE NOTICE 'Test 6 [PASS]: Customer initiated contact share in pending status (id: %)', v_share_id;
    UPDATE pg_temp.staging_test_fixtures SET share_id = v_share_id;
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (6, 'Customer initiates contact share (pending)', false, format('Unexpected result: %s', v_res));
    RAISE NOTICE 'Test 6 [FAIL]: Customer contact share failed: %', v_res;
  END IF;

  -- --------------------------------------------------------------------------
  -- TEST 7: Negative Authorization - Third party cannot approve contact share
  -- --------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_third_party_id::text, true);

  v_expected_failed := false;
  BEGIN
    PERFORM public.respond_contact_share(v_share_id, true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate = 'P0001' AND v_errmsg ILIKE '%designated recipient%' THEN
      v_expected_failed := true;
    END IF;
  END;

  IF v_expected_failed THEN
    INSERT INTO pg_temp.staging_test_results VALUES (7, 'Third party cannot approve contact share', true, 'Rejected with P0001');
    RAISE NOTICE 'Test 7 [PASS]: Third-party approval correctly rejected with P0001';
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (7, 'Third party cannot approve contact share', false, 'Allowed or unexpected error');
    RAISE NOTICE 'Test 7 [FAIL]: Third-party approval was permitted or failed unexpectedly';
  END IF;

  -- --------------------------------------------------------------------------
  -- TEST 8: Functional Authorization - Designated provider approves contact share
  -- --------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);

  v_res := public.respond_contact_share(v_share_id, true);
  SELECT status::text INTO v_status FROM public.contact_shares WHERE id = v_share_id;

  IF v_status = 'shared' THEN
    INSERT INTO pg_temp.staging_test_results VALUES (8, 'Designated recipient approves contact share (shared)', true, 'Status transitioned to shared');
    RAISE NOTICE 'Test 8 [PASS]: Provider approved contact share; status transitioned to shared';
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (8, 'Designated recipient approves contact share (shared)', false, format('Status is %s', v_status));
    RAISE NOTICE 'Test 8 [FAIL]: Status did not transition to shared, found: %', v_status;
  END IF;

  -- --------------------------------------------------------------------------
  -- TEST 9: Functional Workflow - Revocation & Sharer Re-request
  -- --------------------------------------------------------------------------
  -- Customer revokes sharing
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
  PERFORM public.respond_contact_share(v_share_id, false);

  SELECT status::text INTO v_status FROM public.contact_shares WHERE id = v_share_id;
  IF v_status <> 'revoked' THEN
    INSERT INTO pg_temp.staging_test_results VALUES (9, 'Revocation and re-request workflow', false, format('Revocation failed: status is %s', v_status));
    RAISE NOTICE 'Test 9 [FAIL]: Revocation failed, found %', v_status;
  ELSE
    -- Customer re-requests the revoked share
    v_res := public.request_contact_share(v_request_id);
    SELECT status::text INTO v_status FROM public.contact_shares WHERE id = v_share_id;

    IF v_status = 'pending' THEN
      INSERT INTO pg_temp.staging_test_results VALUES (9, 'Revocation and re-request workflow', true, 'Revoked and re-requested to pending');
      RAISE NOTICE 'Test 9 [PASS]: Customer successfully revoked and re-requested contact share';
    ELSE
      INSERT INTO pg_temp.staging_test_results VALUES (9, 'Revocation and re-request workflow', false, format('Re-request failed: status is %s', v_status));
      RAISE NOTICE 'Test 9 [FAIL]: Re-request failed, found status: %', v_status;
    END IF;
  END IF;

  -- --------------------------------------------------------------------------
  -- TEST 10: Negative Authorization - Non-sharer cannot re-request revoked share
  -- --------------------------------------------------------------------------
  -- Provider revokes the share again
  PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);
  PERFORM public.respond_contact_share(v_share_id, false);

  -- Third-party attempts to re-request
  PERFORM set_config('request.jwt.claim.sub', v_third_party_id::text, true);
  v_expected_failed := false;
  BEGIN
    PERFORM public.request_contact_share(v_request_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate = 'P0001' AND v_errmsg ILIKE '%participants can initiate%' THEN
      v_expected_failed := true;
    END IF;
  END;

  IF v_expected_failed THEN
    INSERT INTO pg_temp.staging_test_results VALUES (10, 'Non-sharer cannot re-request revoked share', true, 'Rejected with P0001');
    RAISE NOTICE 'Test 10 [PASS]: Non-sharer re-request rejected with P0001';
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (10, 'Non-sharer cannot re-request revoked share', false, 'Allowed or unexpected error');
    RAISE NOTICE 'Test 10 [FAIL]: Non-sharer re-request permitted or failed unexpectedly';
  END IF;

  -- --------------------------------------------------------------------------
  -- TEST 11: Negative Authorization - Forging app.allow_status_transition Fails
  -- An authenticated non-participant setting app.allow_status_transition = 'true'
  -- must NEVER bypass participant revocation checks.
  -- --------------------------------------------------------------------------
  -- Sharer re-requests and recipient approves to get share into 'shared' state
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
  v_res := public.request_contact_share(v_request_id);
  PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);
  PERFORM public.respond_contact_share(v_share_id, true);

  -- Third party attempts revocation while setting forgeable session setting
  PERFORM set_config('request.jwt.claim.sub', v_third_party_id::text, true);
  v_expected_failed := false;
  BEGIN
    PERFORM set_config('app.allow_status_transition', 'true', true);
    UPDATE public.contact_shares
    SET status = 'revoked'::public.contact_share_status
    WHERE id = v_share_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    -- validate_contact_share() raises P0001 or 42501 for unauthorized revocation
    IF v_sqlstate IN ('P0001', '42501') AND v_errmsg ILIKE '%revoke contact sharing%' THEN
      v_expected_failed := true;
    END IF;
  END;
  PERFORM set_config('app.allow_status_transition', 'false', true);

  IF v_expected_failed THEN
    INSERT INTO pg_temp.staging_test_results VALUES (11, 'Forging app.allow_status_transition cannot bypass participant revocation', true, 'Rejected with P0001');
    RAISE NOTICE 'Test 11 [PASS]: Non-participant setting app.allow_status_transition=true rejected from revoking share';
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (11, 'Forging app.allow_status_transition cannot bypass participant revocation', false, 'Allowed revocation via forged setting');
    RAISE NOTICE 'Test 11 [FAIL]: Forged app.allow_status_transition permitted unauthorized revocation';
  END IF;

  -- --------------------------------------------------------------------------
  -- TEST 12: Negative Integrity - Immutability of ALL Promised Columns
  -- (id, created_at, request_id, sharer_id, recipient_id)
  -- --------------------------------------------------------------------------
  v_subtest_passed := true;

  -- 12a: id immutability
  BEGIN
    UPDATE public.contact_shares SET id = gen_random_uuid() WHERE id = v_share_id;
    v_subtest_passed := false;
    RAISE NOTICE 'Test 12a FAIL: Alteration of contact_shares.id was permitted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate <> 'P0001' OR v_errmsg NOT ILIKE '%Cannot modify id%' THEN
      v_subtest_passed := false;
      RAISE NOTICE 'Test 12a FAIL: Unexpected error for id immutability: % %', v_sqlstate, v_errmsg;
    END IF;
  END;

  -- 12b: created_at immutability
  BEGIN
    UPDATE public.contact_shares SET created_at = now() - interval '1 day' WHERE id = v_share_id;
    v_subtest_passed := false;
    RAISE NOTICE 'Test 12b FAIL: Alteration of contact_shares.created_at was permitted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate <> 'P0001' OR v_errmsg NOT ILIKE '%Cannot modify created_at%' THEN
      v_subtest_passed := false;
      RAISE NOTICE 'Test 12b FAIL: Unexpected error for created_at immutability: % %', v_sqlstate, v_errmsg;
    END IF;
  END;

  -- 12c: request_id immutability
  BEGIN
    UPDATE public.contact_shares SET request_id = gen_random_uuid() WHERE id = v_share_id;
    v_subtest_passed := false;
    RAISE NOTICE 'Test 12c FAIL: Alteration of contact_shares.request_id was permitted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate <> 'P0001' OR v_errmsg NOT ILIKE '%Cannot modify request_id%' THEN
      v_subtest_passed := false;
      RAISE NOTICE 'Test 12c FAIL: Unexpected error for request_id immutability: % %', v_sqlstate, v_errmsg;
    END IF;
  END;

  -- 12d: sharer_id immutability
  BEGIN
    UPDATE public.contact_shares SET sharer_id = v_third_party_id WHERE id = v_share_id;
    v_subtest_passed := false;
    RAISE NOTICE 'Test 12d FAIL: Alteration of contact_shares.sharer_id was permitted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate <> 'P0001' OR v_errmsg NOT ILIKE '%Cannot modify sharer_id%' THEN
      v_subtest_passed := false;
      RAISE NOTICE 'Test 12d FAIL: Unexpected error for sharer_id immutability: % %', v_sqlstate, v_errmsg;
    END IF;
  END;

  -- 12e: recipient_id immutability
  BEGIN
    UPDATE public.contact_shares SET recipient_id = v_third_party_id WHERE id = v_share_id;
    v_subtest_passed := false;
    RAISE NOTICE 'Test 12e FAIL: Alteration of contact_shares.recipient_id was permitted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate <> 'P0001' OR v_errmsg NOT ILIKE '%Cannot modify recipient_id%' THEN
      v_subtest_passed := false;
      RAISE NOTICE 'Test 12e FAIL: Unexpected error for recipient_id immutability: % %', v_sqlstate, v_errmsg;
    END IF;
  END;

  IF v_subtest_passed THEN
    INSERT INTO pg_temp.staging_test_results VALUES (12, 'Immutability of id, created_at, request_id, sharer_id, recipient_id', true, 'All 5 immutable columns rejected alteration with P0001');
    RAISE NOTICE 'Test 12 [PASS]: Contact share key immutability enforced for all promised columns';
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (12, 'Immutability of id, created_at, request_id, sharer_id, recipient_id', false, 'One or more immutable columns allowed alteration');
    RAISE NOTICE 'Test 12 [FAIL]: Contact share immutability check failed for one or more columns';
  END IF;

  -- --------------------------------------------------------------------------
  -- TEST 13: Privacy - get_shared_contact_info Denied in COMPLETED Terminal State
  -- --------------------------------------------------------------------------
  -- Re-share contact
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
  v_res := public.request_contact_share(v_request_id);
  PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);
  PERFORM public.respond_contact_share(v_share_id, true);

  -- Transition request to COMPLETED (triggers atomic contact share revocation)
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
  PERFORM public.transition_service_request(v_request_id, 'COMPLETED'::public.request_status, 'Completed test request');

  -- Provider attempts to retrieve contact info on COMPLETED request
  v_expected_failed := false;
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);
    PERFORM public.get_shared_contact_info(v_request_id, v_customer_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate = 'P0001' AND v_errmsg ILIKE '%terminal state%' THEN
      v_expected_failed := true;
    END IF;
  END;

  IF v_expected_failed THEN
    INSERT INTO pg_temp.staging_test_results VALUES (13, 'get_shared_contact_info denied in COMPLETED terminal state', true, 'Rejected with P0001');
    RAISE NOTICE 'Test 13 [PASS]: Contact retrieval correctly denied in COMPLETED state';
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (13, 'get_shared_contact_info denied in COMPLETED terminal state', false, 'Allowed retrieval or unexpected error');
    RAISE NOTICE 'Test 13 [FAIL]: Contact retrieval on COMPLETED request was permitted or failed unexpectedly';
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- TEST 14: Atomicity - Terminal State Transition Rollback on Failure
-- (Uses isolated fixture advanced via approved RPCs; uses strongly typed
-- public.request_status variable to prevent jsonb/enum mismatch)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_customer_id uuid;
  v_provider_user_id uuid;
  v_provider_profile_id uuid;
  v_area_id uuid;
  v_service_id uuid;
  v_atomicity_req_id uuid;
  v_atomicity_share_id uuid;
  v_res jsonb;
  v_status public.request_status;
  v_share_status public.contact_share_status;
  v_expected_failed boolean := false;
  v_sqlstate text;
  v_errmsg text;
BEGIN
  SELECT customer_id, provider_user_id, provider_profile_id, area_id, service_id, atomicity_req_id
  INTO v_customer_id, v_provider_user_id, v_provider_profile_id, v_area_id, v_service_id, v_atomicity_req_id
  FROM pg_temp.staging_test_fixtures;

  -- 1. Setup isolated request fixture for Test 14 with fresh generated ID
  INSERT INTO public.service_requests (id, user_id, provider_id, service_id, location_id, status, notes)
  VALUES (v_atomicity_req_id, v_customer_id, v_provider_profile_id, v_service_id, v_area_id, 'REQUESTED', 'Atomicity Test Request');

  -- 2. Advance through approved state-machine RPCs to ACCEPTED as Provider
  PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM public.transition_service_request(v_atomicity_req_id, 'ACCEPTED'::public.request_status, 'Accepting for atomicity test');

  -- 3. Advance to CHAT_ACTIVE as Customer via activate_request_chat
  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
  PERFORM public.activate_request_chat(v_atomicity_req_id);

  -- 4. Initiate contact share as Customer
  v_res := public.request_contact_share(v_atomicity_req_id);
  v_atomicity_share_id := (v_res->>'id')::uuid;

  UPDATE pg_temp.staging_test_fixtures SET atomicity_share_id = v_atomicity_share_id;

  -- 5. Approve contact share as Provider
  PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);
  PERFORM public.respond_contact_share(v_atomicity_share_id, true);

  -- Verify initial fixture state is strictly CHAT_ACTIVE and contact share is 'shared'
  SELECT status INTO v_status FROM public.service_requests WHERE id = v_atomicity_req_id;
  SELECT status INTO v_share_status FROM public.contact_shares WHERE id = v_atomicity_share_id;

  IF v_status <> 'CHAT_ACTIVE'::public.request_status OR v_share_status <> 'shared'::public.contact_share_status THEN
    RAISE EXCEPTION 'Atomicity setup prerequisite failure: status=%, share_status=%', v_status, v_share_status;
  END IF;

  -- 6. Dynamically install test failure trigger on contact_shares to simulate failure during terminal cleanup
  EXECUTE '
    CREATE OR REPLACE FUNCTION pg_temp.fail_contact_share_update()
    RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF NEW.status = ''revoked'' THEN
        RAISE EXCEPTION ''Simulated contact_shares revocation failure for atomicity test'';
      END IF;
      RETURN NEW;
    END;
    $f$;
  ';

  EXECUTE '
    CREATE TRIGGER trg_test_fail_contact_share
    BEFORE UPDATE ON public.contact_shares
    FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_contact_share_update();
  ';

  -- 7. Attempt terminal transition to CANCELLED as customer (triggers contact-share revocation)
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
    PERFORM public.transition_service_request(v_atomicity_req_id, 'CANCELLED'::public.request_status, 'Test cancellation failure');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_errmsg ILIKE '%Simulated contact_shares revocation failure%' THEN
      v_expected_failed := true;
    END IF;
  END;

  -- 8. Clean up dynamic test trigger and function immediately
  EXECUTE 'DROP TRIGGER IF EXISTS trg_test_fail_contact_share ON public.contact_shares;';
  EXECUTE 'DROP FUNCTION IF EXISTS pg_temp.fail_contact_share_update();';

  -- 9. Verify request status rolled back and remains CHAT_ACTIVE using strongly typed variable v_status
  IF v_expected_failed THEN
    SELECT status INTO v_status FROM public.service_requests WHERE id = v_atomicity_req_id;
    SELECT status INTO v_share_status FROM public.contact_shares WHERE id = v_atomicity_share_id;

    IF v_status = 'CHAT_ACTIVE'::public.request_status AND v_share_status = 'shared'::public.contact_share_status THEN
      INSERT INTO pg_temp.staging_test_results VALUES (14, 'Terminal transition atomicity & rollback on failure', true, 'Request stayed CHAT_ACTIVE and share stayed shared');
      RAISE NOTICE 'Test 14 [PASS]: Terminal transition failed atomically and rolled back request status to CHAT_ACTIVE';
    ELSE
      INSERT INTO pg_temp.staging_test_results VALUES (14, 'Terminal transition atomicity & rollback on failure', false, format('Request status: %s, Share status: %s', v_status, v_share_status));
      RAISE NOTICE 'Test 14 [FAIL]: Status did not rollback; found req=% share=%', v_status, v_share_status;
    END IF;
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (14, 'Terminal transition atomicity & rollback on failure', false, 'Simulated exception did not trigger');
    RAISE NOTICE 'Test 14 [FAIL]: Simulated exception did not trigger';
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- TEST 15: Lifecycle Concurrency - Terminal Transition Locks Out Contact Sharing
-- Verifies that request_contact_share cannot be initiated on a terminal request,
-- eliminating any race window where a contact share could survive terminal completion.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_customer_id uuid;
  v_provider_user_id uuid;
  v_provider_profile_id uuid;
  v_area_id uuid;
  v_service_id uuid;
  v_race_req_id uuid;
  v_expected_failed boolean := false;
  v_sqlstate text;
  v_errmsg text;
  v_active_share_cnt int;
BEGIN
  SELECT customer_id, provider_user_id, provider_profile_id, area_id, service_id, terminal_race_req_id
  INTO v_customer_id, v_provider_user_id, v_provider_profile_id, v_area_id, v_service_id, v_race_req_id
  FROM pg_temp.staging_test_fixtures;

  -- 1. Setup request and advance through approved state machine to COMPLETED
  INSERT INTO public.service_requests (id, user_id, provider_id, service_id, location_id, status, notes)
  VALUES (v_race_req_id, v_customer_id, v_provider_profile_id, v_service_id, v_area_id, 'REQUESTED', 'Lifecycle Concurrency Race Fixture');

  PERFORM set_config('request.jwt.claim.sub', v_provider_user_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM public.transition_service_request(v_race_req_id, 'ACCEPTED'::public.request_status, 'Accepting for concurrency test');

  PERFORM set_config('request.jwt.claim.sub', v_customer_id::text, true);
  PERFORM public.activate_request_chat(v_race_req_id);

  -- Transition directly to terminal COMPLETED status
  PERFORM public.transition_service_request(v_race_req_id, 'COMPLETED'::public.request_status, 'Completed request for concurrency test');

  -- 2. Attempt to initiate contact share on the COMPLETED request
  -- Must be strictly rejected by request_contact_share()
  BEGIN
    PERFORM public.request_contact_share(v_race_req_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_errmsg = MESSAGE_TEXT;
    IF v_sqlstate = 'P0001' AND v_errmsg ILIKE '%ACCEPTED or CHAT_ACTIVE status%' THEN
      v_expected_failed := true;
    END IF;
  END;

  -- 3. Verify zero active contact shares exist for this request
  SELECT count(*) INTO v_active_share_cnt
  FROM public.contact_shares
  WHERE request_id = v_race_req_id
    AND status IN ('pending'::public.contact_share_status, 'shared'::public.contact_share_status);

  IF v_expected_failed AND v_active_share_cnt = 0 THEN
    INSERT INTO pg_temp.staging_test_results VALUES (15, 'request_contact_share strictly rejected on terminal requests', true, 'Rejected with P0001; 0 active shares survived');
    RAISE NOTICE 'Test 15 [PASS]: request_contact_share rejected on terminal request and zero active shares survived';
  ELSE
    INSERT INTO pg_temp.staging_test_results VALUES (15, 'request_contact_share strictly rejected on terminal requests', false, format('Expected rejection: %s, Active shares: %s', v_expected_failed, v_active_share_cnt));
    RAISE NOTICE 'Test 15 [FAIL]: Share allowed on terminal request or active shares found: %', v_active_share_cnt;
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- FINAL RESULTS SUMMARY
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_total int;
  v_passed int;
  v_failed int;
  r record;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE passed), count(*) FILTER (WHERE NOT passed)
  INTO v_total, v_passed, v_failed
  FROM pg_temp.staging_test_results;

  RAISE NOTICE '============================================================';
  RAISE NOTICE 'STAGING SECURITY HARDENING RESULTS: % Total, % Passed, % Failed',
    v_total, v_passed, v_failed;
  RAISE NOTICE '============================================================';

  FOR r IN SELECT test_num, test_name, passed, details FROM pg_temp.staging_test_results ORDER BY test_num LOOP
    IF r.passed THEN
      RAISE NOTICE '  Test %: [PASS] % - %', r.test_num, r.test_name, r.details;
    ELSE
      RAISE NOTICE '  Test %: [FAIL] % - %', r.test_num, r.test_name, r.details;
    END IF;
  END LOOP;

  RAISE NOTICE '============================================================';

  IF v_failed > 0 OR v_total < 15 THEN
    RAISE EXCEPTION 'Staging security test suite failed with % failure(s) out of % tests', v_failed, v_total;
  END IF;
END;
$$;

-- Cleanly rollback all staging fixtures and modifications
ROLLBACK;
