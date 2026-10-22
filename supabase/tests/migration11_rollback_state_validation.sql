-- Read-only catalog assertions for the intended service-request contract after
-- rollback. The historical Migration 03 table grant is deliberately narrowed
-- because its documented notes-edit capability does not require broad UPDATE.
-- This script performs no fixture writes and does not modify the schema.
-- The pre-11 migrations revoke PUBLIC EXECUTE on these routines but leave the
-- Supabase default explicit anon grants in place; Migration 11 revokes anon.

BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  v_failures text[] := ARRAY[]::text[];
  v_function record;
  v_policy record;
  v_function_oid oid;
  v_column text;
BEGIN
  -- Preserve SELECT/INSERT and the notes-only UPDATE contract on service_requests.
  IF NOT has_table_privilege('authenticated', 'public.service_requests', 'SELECT') THEN
    v_failures := array_append(v_failures, 'authenticated lacks service_requests SELECT');
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.service_requests', 'INSERT') THEN
    v_failures := array_append(v_failures, 'authenticated lacks service_requests INSERT');
  END IF;
  IF has_table_privilege('authenticated', 'public.service_requests', 'UPDATE') THEN
    v_failures := array_append(v_failures, 'authenticated unexpectedly has table-level service_requests UPDATE');
  END IF;
  IF has_table_privilege('anon', 'public.service_requests', 'UPDATE') THEN
    v_failures := array_append(v_failures, 'anon unexpectedly has service_requests UPDATE');
  END IF;
  IF NOT has_table_privilege('service_role', 'public.service_requests', 'UPDATE') THEN
    v_failures := array_append(v_failures, 'service_role lacks service_requests UPDATE');
  END IF;
  FOR v_column IN
    SELECT unnest(ARRAY['id', 'user_id', 'provider_id', 'service_id', 'location_id', 'status', 'event_date', 'notes', 'created_at', 'updated_at'])
  LOOP
    IF has_column_privilege('authenticated', 'public.service_requests', v_column, 'UPDATE')
       IS DISTINCT FROM (v_column = 'notes') THEN
      v_failures := array_append(v_failures, format('authenticated service_requests UPDATE privilege is incorrect for column %s', v_column));
    END IF;
    IF has_column_privilege('anon', 'public.service_requests', v_column, 'UPDATE') THEN
      v_failures := array_append(v_failures, format('anon unexpectedly has service_requests UPDATE on column %s', v_column));
    END IF;
  END LOOP;

  IF NOT has_table_privilege('authenticated', 'public.contact_shares', 'SELECT') THEN
    v_failures := array_append(v_failures, 'authenticated lacks contact_shares SELECT');
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.contact_shares', 'INSERT') THEN
    v_failures := array_append(v_failures, 'authenticated lacks contact_shares INSERT');
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.contact_shares', 'UPDATE') THEN
    v_failures := array_append(v_failures, 'authenticated lacks contact_shares UPDATE');
  END IF;
  IF has_table_privilege('anon', 'public.contact_shares', 'UPDATE') THEN
    v_failures := array_append(v_failures, 'anon unexpectedly has contact_shares UPDATE');
  END IF;
  IF NOT has_table_privilege('service_role', 'public.contact_shares', 'UPDATE') THEN
    v_failures := array_append(v_failures, 'service_role lacks contact_shares UPDATE');
  END IF;

  -- These are the affected routine grants restored by the down migration.
  FOR v_function IN
    SELECT routine_signature
    FROM (VALUES
      ('public.log_audit_event(uuid,text,text,uuid,jsonb,jsonb)'::text),
      ('public.assert_provider_covers_area(uuid,uuid)'),
      ('public.check_request_status_update()'),
      ('public.validate_contact_share()'),
      ('public.request_contact_share(uuid)'),
      ('public.respond_contact_share(uuid,boolean)'),
      ('public.transition_service_request(uuid,public.request_status,text)'),
      ('public.get_shared_contact_info(uuid,uuid)')
    ) AS routines(routine_signature)
  LOOP
    v_function_oid := to_regprocedure(v_function.routine_signature);
    IF v_function_oid IS NULL THEN
      v_failures := array_append(v_failures, 'missing routine ' || v_function.routine_signature);
      CONTINUE;
    END IF;

    IF NOT has_function_privilege('authenticated', v_function.routine_signature, 'EXECUTE') THEN
      v_failures := array_append(v_failures, 'authenticated lacks EXECUTE on ' || v_function.routine_signature);
    END IF;
    IF NOT has_function_privilege('anon', v_function.routine_signature, 'EXECUTE') THEN
      v_failures := array_append(v_failures, 'anon lacks pre-Migration-11 EXECUTE on ' || v_function.routine_signature);
    END IF;
    IF NOT has_function_privilege('service_role', v_function.routine_signature, 'EXECUTE') THEN
      v_failures := array_append(v_failures, 'service_role lacks EXECUTE on ' || v_function.routine_signature);
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
      WHERE p.oid = v_function_oid
        AND acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    ) THEN
      v_failures := array_append(v_failures, 'PUBLIC unexpectedly has EXECUTE on ' || v_function.routine_signature);
    END IF;
  END LOOP;

  -- Migration 11 drops this participant policy; Migration 03 creates it.
  SELECT roles, qual, with_check
  INTO v_policy
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'contact_shares'
    AND policyname = 'p_contact_shares_update_participant';

  IF NOT FOUND THEN
    v_failures := array_append(v_failures, 'p_contact_shares_update_participant is missing');
  ELSIF v_policy.roles <> ARRAY['authenticated']::name[]
     OR v_policy.qual NOT LIKE '%recipient_id%'
     OR v_policy.qual NOT LIKE '%sharer_id%'
     OR v_policy.with_check NOT LIKE '%recipient_id%'
     OR v_policy.with_check NOT LIKE '%sharer_id%' THEN
    v_failures := array_append(v_failures, 'p_contact_shares_update_participant does not match Migration 03 participant policy');
  END IF;

  SELECT roles, qual, with_check
  INTO v_policy
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'service_requests'
    AND policyname = 'p_service_requests_update_requester';

  IF NOT FOUND THEN
    v_failures := array_append(v_failures, 'p_service_requests_update_requester is missing');
  ELSIF v_policy.roles <> ARRAY['authenticated']::name[]
     OR v_policy.qual NOT LIKE '%auth.uid()%'
     OR v_policy.qual NOT LIKE '%user_id%'
     OR v_policy.qual NOT LIKE '%REQUESTED%'
     OR v_policy.with_check NOT LIKE '%auth.uid()%'
     OR v_policy.with_check NOT LIKE '%user_id%'
     OR v_policy.with_check NOT LIKE '%REQUESTED%' THEN
    v_failures := array_append(v_failures, 'p_service_requests_update_requester does not enforce requester ownership and REQUESTED state');
  END IF;

  IF cardinality(v_failures) > 0 THEN
    RAISE EXCEPTION 'Migration 11 rollback state validation failed: %', array_to_string(v_failures, '; ');
  END IF;

  RAISE NOTICE 'PASS: rollback grants and requester notes-only service-request policy are present';
END;
$$;

COMMIT;
