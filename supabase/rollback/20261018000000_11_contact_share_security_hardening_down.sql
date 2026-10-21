-- Rollback Migration: 20261018000000_11_contact_share_security_hardening_down.sql
-- Description: Reverts Migration 11 back to baseline state (Migrations 01-10):
--   1. Restores table grants (GRANT UPDATE ON public.contact_shares TO authenticated).
--   2. Restores RLS policy p_contact_shares_update_participant from Migration 03.
--   3. Restores GRANT UPDATE (status) ON public.service_requests TO authenticated and check_request_status_update() from Migration 03.
--   4. Restores EXECUTE ON public.log_audit_event to authenticated from Migration 03.
--   5. Restores EXECUTE ON public.assert_provider_covers_area from Migration 04.
--   6. Restores original public.validate_contact_share() from Migration 03.
--   7. Restores original public.request_contact_share() from Migration 04.
--   8. Restores original privileges on public.respond_contact_share() from Migration 04.
--   9. Restores original public.transition_service_request() from Migration 04.
--  10. Restores original public.get_shared_contact_info() from Migration 04.
--
-- ============================================================================
-- DOCUMENTATION OF SECURITY WEAKNESSES RESTORED BY THIS ROLLBACK SCRIPT:
-- ============================================================================
-- 1. Table UPDATE Exposure: Restores direct UPDATE privileges on public.contact_shares
--    to authenticated clients, bypassing server-side RPC validation and concurrency locks.
-- 2. Audit Trail Tampering: Restores client-side EXECUTE on public.log_audit_event,
--    enabling authenticated users to inject arbitrary fabricated audit entries.
-- 3. Anonymous Oracle Enumeration: Reverts explicit anon revocation on assert_provider_covers_area
--    and get_shared_contact_info, relying solely on default schema inheritance.
-- 4. Post-Completion Contact Leakage: Reverts get_shared_contact_info to pre-Migration-11
--    code which omits COMPLETED from its terminal status check.
-- 5. Race Condition Exposure: Reverts request_contact_share to pre-Migration-11 code
--    without FOR SHARE parent request locking, risking contact share survival across terminal transitions.
-- 6. Key Mutability: Reverts validate_contact_share to pre-Migration-11 code which does
--    not prevent altering request_id, sharer_id, or recipient_id via UPDATE.
-- 7. Custom GUC Reliance: Restores app.allow_status_transition session setting reliance on
--    service_requests status updates and lifecycle transitions, exposing GUC forging attack surface.
-- ============================================================================

-- ============================================================================
-- 1. RESTORE TABLE PRIVILEGES & RLS POLICIES: CONTACT SHARES
-- ============================================================================

GRANT UPDATE ON TABLE public.contact_shares TO authenticated;

DROP POLICY IF EXISTS p_contact_shares_update_participant ON public.contact_shares;

CREATE POLICY p_contact_shares_update_participant
  ON public.contact_shares
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = recipient_id OR auth.uid() = sharer_id)
  WITH CHECK (auth.uid() = recipient_id OR auth.uid() = sharer_id);


-- ============================================================================
-- 1b. RESTORE SERVICE_REQUESTS STATUS PRIVILEGES & TRIGGER (FROM MIGRATION 03)
-- ============================================================================

GRANT UPDATE (status) ON TABLE public.service_requests TO authenticated;

CREATE OR REPLACE FUNCTION public.check_request_status_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_user_id uuid;
BEGIN
  -- If status has not changed, allow other column updates (e.g. notes or updated_at)
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Verify authorized transition context
  -- Phase 2.5 state machine sets session flag 'app.allow_status_transition' = 'true'
  IF current_setting('app.allow_status_transition', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Direct update of service_requests.status is prohibited. State transitions must be executed through authorized transition procedures.';
  END IF;

  -- Log audit event for status change (strictly without notes/PII)
  current_user_id := auth.uid();
  PERFORM public.log_audit_event(
    current_user_id,
    'REQUEST_STATUS_CHANGED',
    'service_requests',
    NEW.id,
    jsonb_build_object('old_status', OLD.status),
    jsonb_build_object('new_status', NEW.status)
  );

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_request_status_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_request_status_update() TO authenticated, service_role, postgres;


-- ============================================================================
-- 2. RESTORE AUDIT LOGGING PRIVILEGES
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) TO authenticated, service_role, postgres;


-- ============================================================================
-- 3. RESTORE AREA VALIDATION PRIVILEGES
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.assert_provider_covers_area(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_provider_covers_area(uuid, uuid) TO authenticated, service_role, postgres;


-- ============================================================================
-- 4. RESTORE PRE-MIGRATION VALIDATE_CONTACT_SHARE (FROM MIGRATION 03)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_contact_share()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  req_user_id uuid;
  prov_user_id uuid;
  req_status public.request_status;
  current_user_id uuid;
BEGIN
  -- 1. Fetch request participants and status
  SELECT sr.user_id, p.user_id, sr.status
  INTO req_user_id, prov_user_id, req_status
  FROM public.service_requests sr
  JOIN public.provider_profiles p ON p.id = sr.provider_id
  WHERE sr.id = NEW.request_id;

  IF req_user_id IS NULL THEN
    RAISE EXCEPTION 'Service request % does not exist', NEW.request_id;
  END IF;

  -- 2. Ensure request is active
  IF req_status NOT IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status) THEN
    RAISE EXCEPTION 'Contact sharing is only permitted for requests in ACCEPTED or CHAT_ACTIVE status (current status: %)', req_status;
  END IF;

  -- 3. Ensure sharer and recipient are the exact pair of legitimate participants
  IF NOT (
    (NEW.sharer_id = req_user_id AND NEW.recipient_id = prov_user_id) OR
    (NEW.sharer_id = prov_user_id AND NEW.recipient_id = req_user_id)
  ) THEN
    RAISE EXCEPTION 'Contact sharing can only be established between the legitimate request participants';
  END IF;

  current_user_id := auth.uid();

  -- 4. Enforce session permissions on INSERT
  IF TG_OP = 'INSERT' THEN
    IF current_user_id IS NOT NULL AND NEW.sharer_id <> current_user_id THEN
      RAISE EXCEPTION 'Cannot initiate a contact share on behalf of another user';
    END IF;

    IF NEW.status <> 'pending'::public.contact_share_status THEN
      RAISE EXCEPTION 'New contact share requests must start in "pending" status';
    END IF;

    -- Audit log initiation (zero PII)
    PERFORM public.log_audit_event(
      COALESCE(current_user_id, NEW.sharer_id),
      'CONTACT_SHARE_REQUESTED',
      'contact_shares',
      NEW.id,
      NULL,
      jsonb_build_object('request_id', NEW.request_id, 'status', NEW.status)
    );
  END IF;

  -- 5. Enforce state transition rules on UPDATE
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status THEN
    IF current_user_id IS NOT NULL THEN
      -- Recipient confirmation required to transition to 'shared'
      IF NEW.status = 'shared'::public.contact_share_status THEN
        IF current_user_id <> OLD.recipient_id THEN
          RAISE EXCEPTION 'Only the designated recipient can approve contact sharing';
        END IF;
        IF OLD.status <> 'pending'::public.contact_share_status THEN
          RAISE EXCEPTION 'Only pending contact shares can be approved';
        END IF;
      -- Either party can revoke sharing
      ELSIF NEW.status = 'revoked'::public.contact_share_status THEN
        IF current_user_id <> OLD.sharer_id AND current_user_id <> OLD.recipient_id THEN
          RAISE EXCEPTION 'Only participants can revoke contact sharing';
        END IF;
      ELSE
        RAISE EXCEPTION 'Invalid contact share status transition from % to %', OLD.status, NEW.status;
      END IF;
    END IF;

    -- Audit log status change (zero PII)
    PERFORM public.log_audit_event(
      COALESCE(current_user_id, NEW.sharer_id),
      'CONTACT_SHARE_STATUS_CHANGED',
      'contact_shares',
      NEW.id,
      jsonb_build_object('old_status', OLD.status),
      jsonb_build_object('new_status', NEW.status)
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_contact_share() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_contact_share() TO authenticated, service_role, postgres;


-- ============================================================================
-- 5. RESTORE PRE-MIGRATION REQUEST_CONTACT_SHARE (FROM MIGRATION 04)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.request_contact_share(
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid;
  v_req public.service_requests%ROWTYPE;
  v_provider_owner_id uuid;
  v_recipient_id uuid;
  v_share_id uuid;
  v_existing_status public.contact_share_status;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_req
  FROM public.service_requests
  WHERE id = p_request_id;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Service request % does not exist', p_request_id;
  END IF;

  IF v_req.status NOT IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status) THEN
    RAISE EXCEPTION 'Contact sharing is only allowed for requests in ACCEPTED or CHAT_ACTIVE status (current: %)', v_req.status;
  END IF;

  SELECT user_id INTO v_provider_owner_id
  FROM public.provider_profiles
  WHERE id = v_req.provider_id;

  -- Establish recipient based on actor
  IF v_actor_id = v_req.user_id THEN
    v_recipient_id := v_provider_owner_id;
  ELSIF v_actor_id = v_provider_owner_id THEN
    v_recipient_id := v_req.user_id;
  ELSE
    RAISE EXCEPTION 'Only request participants can initiate contact sharing';
  END IF;

  -- Check existing share state
  SELECT id, status INTO v_share_id, v_existing_status
  FROM public.contact_shares
  WHERE request_id = p_request_id
    AND sharer_id = v_actor_id
    AND recipient_id = v_recipient_id;

  IF v_share_id IS NOT NULL THEN
    IF v_existing_status = 'shared'::public.contact_share_status THEN
      RETURN jsonb_build_object('id', v_share_id, 'status', 'shared', 'message', 'Contact already shared');
    ELSIF v_existing_status = 'pending'::public.contact_share_status THEN
      RETURN jsonb_build_object('id', v_share_id, 'status', 'pending', 'message', 'Contact share already pending');
    ELSE
      -- If previously revoked, re-request
      UPDATE public.contact_shares
      SET status = 'pending'::public.contact_share_status,
          updated_at = now()
      WHERE id = v_share_id;

      RETURN jsonb_build_object('id', v_share_id, 'status', 'pending', 'message', 'Contact share re-requested');
    END IF;
  END IF;

  INSERT INTO public.contact_shares (request_id, sharer_id, recipient_id, status)
  VALUES (p_request_id, v_actor_id, v_recipient_id, 'pending'::public.contact_share_status)
  RETURNING id INTO v_share_id;

  RETURN jsonb_build_object(
    'id', v_share_id,
    'request_id', p_request_id,
    'status', 'pending'
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_contact_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_contact_share(uuid) TO authenticated, service_role, postgres;


-- ============================================================================
-- 6. RESTORE PRE-MIGRATION RESPOND_CONTACT_SHARE PRIVILEGES (FROM MIGRATION 04)
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.respond_contact_share(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_contact_share(uuid, boolean) TO authenticated, service_role, postgres;


-- ============================================================================
-- 7. RESTORE PRE-MIGRATION TRANSITION_SERVICE_REQUEST (FROM MIGRATION 04)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.transition_service_request(
  p_request_id uuid,
  p_target_status public.request_status,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid;
  v_req public.service_requests%ROWTYPE;
  v_provider_owner_id uuid;
  v_provider_status public.provider_status;
  v_is_super_admin boolean := false;
  v_is_area_admin boolean := false;
  v_conversation_id uuid;
BEGIN
  -- 1. Identify actor
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required to transition service request state';
  END IF;

  -- 2. Concurrency Control: Lock the service request row exclusively
  SELECT * INTO v_req
  FROM public.service_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Service request % does not exist', p_request_id;
  END IF;

  -- 3. Resolve provider owner and status
  SELECT user_id, status INTO v_provider_owner_id, v_provider_status
  FROM public.provider_profiles
  WHERE id = v_req.provider_id;

  IF v_provider_owner_id IS NULL THEN
    RAISE EXCEPTION 'Associated provider profile % does not exist', v_req.provider_id;
  END IF;

  -- 4. Check administrative roles
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_actor_id AND role = 'super_admin'::public.app_role
  ) INTO v_is_super_admin;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.admin_area_assignments aaa ON aaa.user_id = ur.user_id
    WHERE ur.user_id = v_actor_id
      AND ur.role = 'area_admin'::public.app_role
      AND aaa.location_id = v_req.location_id
  ) INTO v_is_area_admin;

  -- 5. No-op if target status is identical
  IF v_req.status = p_target_status THEN
    RETURN jsonb_build_object(
      'request_id', v_req.id,
      'status', v_req.status,
      'message', 'Status already at target state'
    );
  END IF;

  -- 6. State Machine Validation & Authorization Matrix
  IF v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'ACCEPTED'::public.request_status THEN
    IF v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only the assigned provider can accept a service request';
    END IF;

    IF v_provider_status <> 'approved'::public.provider_status THEN
      RAISE EXCEPTION 'Provider is not in approved status (current: %)', v_provider_status;
    END IF;

    PERFORM public.assert_provider_covers_area(v_req.provider_id, v_req.location_id);

  ELSIF v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'DECLINED'::public.request_status THEN
    IF v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only the assigned provider can decline a service request';
    END IF;

  ELSIF v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'CANCELLED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only the customer can cancel a pending service request';
    END IF;

  ELSIF v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'EXPIRED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin AND NOT v_is_area_admin THEN
      RAISE EXCEPTION 'Unauthorized to expire service request';
    END IF;

  ELSIF v_req.status = 'ACCEPTED'::public.request_status AND p_target_status = 'CHAT_ACTIVE'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only request participants can activate chat';
    END IF;

  ELSIF v_req.status = 'ACCEPTED'::public.request_status AND p_target_status = 'CANCELLED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only request participants or super admins can cancel an accepted request';
    END IF;

  ELSIF v_req.status = 'CHAT_ACTIVE'::public.request_status AND p_target_status = 'COMPLETED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only request participants or super admins can complete a service request';
    END IF;

  ELSIF v_req.status = 'CHAT_ACTIVE'::public.request_status AND p_target_status = 'DISPUTED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin AND NOT v_is_area_admin THEN
      RAISE EXCEPTION 'Only request participants or admins can dispute an active request';
    END IF;

  ELSIF v_req.status = 'CHAT_ACTIVE'::public.request_status AND p_target_status = 'CANCELLED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only request participants or super admins can cancel an active request';
    END IF;

  ELSIF p_target_status = 'BLOCKED'::public.request_status THEN
    IF NOT v_is_super_admin AND NOT v_is_area_admin THEN
      RAISE EXCEPTION 'Only administrators can block a service request';
    END IF;

  ELSIF v_req.status = 'DISPUTED'::public.request_status AND p_target_status IN ('COMPLETED'::public.request_status, 'CANCELLED'::public.request_status) THEN
    IF NOT v_is_super_admin AND NOT v_is_area_admin THEN
      RAISE EXCEPTION 'Only administrators can resolve a disputed service request';
    END IF;

  ELSE
    RAISE EXCEPTION 'Invalid service request state transition from % to %', v_req.status, p_target_status;
  END IF;

  PERFORM set_config('app.allow_status_transition', 'true', true);

  UPDATE public.service_requests
  SET status = p_target_status,
      updated_at = now()
  WHERE id = v_req.id;

  PERFORM set_config('app.allow_status_transition', 'false', true);

  IF p_target_status IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status) THEN
    INSERT INTO public.conversations (request_id, user_id, provider_id)
    VALUES (v_req.id, v_req.user_id, v_req.provider_id)
    ON CONFLICT (request_id) DO NOTHING
    RETURNING id INTO v_conversation_id;

    IF v_conversation_id IS NULL THEN
      SELECT id INTO v_conversation_id
      FROM public.conversations
      WHERE request_id = v_req.id;
    END IF;
  END IF;

  IF p_target_status IN ('COMPLETED'::public.request_status, 'CANCELLED'::public.request_status, 'DECLINED'::public.request_status, 'EXPIRED'::public.request_status, 'BLOCKED'::public.request_status) THEN
    UPDATE public.contact_shares
    SET status = 'revoked'::public.contact_share_status,
        updated_at = now()
    WHERE request_id = v_req.id
      AND status IN ('pending'::public.contact_share_status, 'shared'::public.contact_share_status);
  END IF;

  PERFORM public.log_audit_event(
    v_actor_id,
    'SERVICE_REQUEST_STATE_TRANSITION',
    'service_requests',
    v_req.id,
    jsonb_build_object('old_status', v_req.status),
    jsonb_build_object(
      'new_status', p_target_status,
      'reason', p_reason
    )
  );

  RETURN jsonb_build_object(
    'request_id', v_req.id,
    'old_status', v_req.status,
    'new_status', p_target_status,
    'conversation_id', v_conversation_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.transition_service_request(uuid, public.request_status, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_service_request(uuid, public.request_status, text) TO authenticated, service_role, postgres;


-- ============================================================================
-- 8. RESTORE PRE-MIGRATION GET_SHARED_CONTACT_INFO (FROM MIGRATION 04)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_shared_contact_info(
  p_request_id uuid,
  p_target_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid;
  v_req public.service_requests%ROWTYPE;
  v_provider_owner_id uuid;
  v_is_shared boolean := false;
  v_target_name text;
  v_target_phone text;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_req
  FROM public.service_requests
  WHERE id = p_request_id;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Service request % does not exist', p_request_id;
  END IF;

  IF v_req.status IN ('DECLINED'::public.request_status, 'CANCELLED'::public.request_status, 'EXPIRED'::public.request_status, 'BLOCKED'::public.request_status) THEN
    RAISE EXCEPTION 'Contact information cannot be accessed because service request is in terminal state "%"', v_req.status;
  END IF;

  SELECT user_id INTO v_provider_owner_id
  FROM public.provider_profiles
  WHERE id = v_req.provider_id;

  IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id THEN
    RAISE EXCEPTION 'Access denied: Caller is not a participant in this service request';
  END IF;

  IF v_actor_id = p_target_user_id THEN
    RAISE EXCEPTION 'Target user ID must be the other participant';
  END IF;

  IF NOT (
    (v_actor_id = v_req.user_id AND p_target_user_id = v_provider_owner_id) OR
    (v_actor_id = v_provider_owner_id AND p_target_user_id = v_req.user_id)
  ) THEN
    RAISE EXCEPTION 'Target user is not a valid counterpart in this service request';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.contact_shares
    WHERE request_id = p_request_id
      AND sharer_id = p_target_user_id
      AND recipient_id = v_actor_id
      AND status = 'shared'::public.contact_share_status
  ) INTO v_is_shared;

  IF NOT v_is_shared THEN
    RAISE EXCEPTION 'Contact information has not been shared or has been revoked (status not shared)';
  END IF;

  SELECT full_name INTO v_target_name
  FROM public.users
  WHERE id = p_target_user_id;

  SELECT phone_e164 INTO v_target_phone
  FROM public.user_private
  WHERE user_id = p_target_user_id;

  PERFORM public.log_audit_event(
    v_actor_id,
    'CONTACT_INFO_ACCESSED',
    'user_private',
    p_target_user_id,
    NULL,
    jsonb_build_object('request_id', p_request_id)
  );

  RETURN jsonb_build_object(
    'user_id', p_target_user_id,
    'full_name', v_target_name,
    'phone_e164', v_target_phone
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_shared_contact_info(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_contact_info(uuid, uuid) TO authenticated, service_role, postgres;
