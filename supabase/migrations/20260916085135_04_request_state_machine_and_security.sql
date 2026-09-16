-- Migration: 04_request_state_machine_and_security
-- Description: State-machine transition procedures, SEC-24-01 remediation (exact area validation),
--              secure chat activation, explicit contact sharing authorization, and secure contact retrieval RPC.

-- ============================================================================
-- 1. SEC-24-01 REMEDIATION: AREA-LEVEL & PROVIDER-LOCATION VALIDATION
-- ============================================================================

-- Function to verify that a provider has declared and active coverage for an exact Area location
CREATE OR REPLACE FUNCTION public.assert_provider_covers_area(
  p_provider_id uuid,
  p_location_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_location_level public.location_level;
  v_location_active boolean;
  v_has_coverage boolean;
BEGIN
  -- 1. Confirm location exists, is active, and is of level 'area'
  SELECT level, is_active INTO v_location_level, v_location_active
  FROM public.locations
  WHERE id = p_location_id;

  IF v_location_level IS NULL THEN
    RAISE EXCEPTION 'Location with ID % does not exist', p_location_id;
  END IF;

  IF v_location_level <> 'area'::public.location_level THEN
    RAISE EXCEPTION 'Location must be of level "area", found: %', v_location_level;
  END IF;

  IF NOT v_location_active THEN
    RAISE EXCEPTION 'Location % is inactive', p_location_id;
  END IF;

  -- 2. Verify provider has declared active coverage for this exact area
  SELECT EXISTS (
    SELECT 1 FROM public.provider_locations
    WHERE provider_id = p_provider_id
      AND location_id = p_location_id
  ) INTO v_has_coverage;

  IF NOT v_has_coverage THEN
    RAISE EXCEPTION 'Provider % has not declared coverage for Area % (SEC-24-01 violation)', p_provider_id, p_location_id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_provider_covers_area(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_provider_covers_area(uuid, uuid) TO authenticated, service_role, postgres;

-- ============================================================================
-- 2. SECURE REQUEST STATE-MACHINE TRANSITION RPC
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
  -- REQUESTED -> ACCEPTED
  IF v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'ACCEPTED'::public.request_status THEN
    IF v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only the assigned provider can accept a service request';
    END IF;

    -- Provider must be approved
    IF v_provider_status <> 'approved'::public.provider_status THEN
      RAISE EXCEPTION 'Provider is not in approved status (current: %)', v_provider_status;
    END IF;

    -- SEC-24-01: Provider must have declared coverage for the exact requested Area
    PERFORM public.assert_provider_covers_area(v_req.provider_id, v_req.location_id);

  -- REQUESTED -> DECLINED
  ELSIF v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'DECLINED'::public.request_status THEN
    IF v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only the assigned provider can decline a service request';
    END IF;

  -- REQUESTED -> CANCELLED (Customer withdraws before acceptance)
  ELSIF v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'CANCELLED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only the customer can cancel a pending service request';
    END IF;

  -- REQUESTED -> EXPIRED (System / Admin / Participant expiration)
  ELSIF v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'EXPIRED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin AND NOT v_is_area_admin THEN
      RAISE EXCEPTION 'Unauthorized to expire service request';
    END IF;

  -- ACCEPTED -> CHAT_ACTIVE
  ELSIF v_req.status = 'ACCEPTED'::public.request_status AND p_target_status = 'CHAT_ACTIVE'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only request participants can activate chat';
    END IF;

  -- ACCEPTED -> CANCELLED
  ELSIF v_req.status = 'ACCEPTED'::public.request_status AND p_target_status = 'CANCELLED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only request participants or super admins can cancel an accepted request';
    END IF;

  -- CHAT_ACTIVE -> COMPLETED
  ELSIF v_req.status = 'CHAT_ACTIVE'::public.request_status AND p_target_status = 'COMPLETED'::public.request_status THEN
    -- Either participant can mark complete, or admin
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only request participants or super admins can complete a service request';
    END IF;

  -- CHAT_ACTIVE -> DISPUTED
  ELSIF v_req.status = 'CHAT_ACTIVE'::public.request_status AND p_target_status = 'DISPUTED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin AND NOT v_is_area_admin THEN
      RAISE EXCEPTION 'Only request participants or admins can dispute an active request';
    END IF;

  -- CHAT_ACTIVE -> CANCELLED
  ELSIF v_req.status = 'CHAT_ACTIVE'::public.request_status AND p_target_status = 'CANCELLED'::public.request_status THEN
    IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id AND NOT v_is_super_admin THEN
      RAISE EXCEPTION 'Only request participants or super admins can cancel an active request';
    END IF;

  -- ANY ACTIVE -> BLOCKED (Moderation / Admin enforcement)
  ELSIF p_target_status = 'BLOCKED'::public.request_status THEN
    IF NOT v_is_super_admin AND NOT v_is_area_admin THEN
      RAISE EXCEPTION 'Only administrators can block a service request';
    END IF;

  -- DISPUTED -> COMPLETED or CANCELLED (Resolution by admin)
  ELSIF v_req.status = 'DISPUTED'::public.request_status AND p_target_status IN ('COMPLETED'::public.request_status, 'CANCELLED'::public.request_status) THEN
    IF NOT v_is_super_admin AND NOT v_is_area_admin THEN
      RAISE EXCEPTION 'Only administrators can resolve a disputed service request';
    END IF;

  ELSE
    RAISE EXCEPTION 'Invalid service request state transition from % to %', v_req.status, p_target_status;
  END IF;

  -- 7. Execute status transition with local session bypass flag
  PERFORM set_config('app.allow_status_transition', 'true', true);

  UPDATE public.service_requests
  SET status = p_target_status,
      updated_at = now()
  WHERE id = v_req.id;

  PERFORM set_config('app.allow_status_transition', 'false', true);

  -- 8. If transitioning to ACCEPTED or CHAT_ACTIVE, guarantee conversation provision
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

  -- 9. If request reached a terminal state (COMPLETED, CANCELLED, DECLINED, EXPIRED, BLOCKED),
  -- revoke any active contact shares to ensure contact info cannot linger
  IF p_target_status IN ('COMPLETED'::public.request_status, 'CANCELLED'::public.request_status, 'DECLINED'::public.request_status, 'EXPIRED'::public.request_status, 'BLOCKED'::public.request_status) THEN
    UPDATE public.contact_shares
    SET status = 'revoked'::public.contact_share_status,
        updated_at = now()
    WHERE request_id = v_req.id
      AND status IN ('pending'::public.contact_share_status, 'shared'::public.contact_share_status);
  END IF;

  -- 10. Audit event recording
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
-- 3. SECURE CHAT ACTIVATION RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.activate_request_chat(
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Activates chat by transitioning state to CHAT_ACTIVE via state machine
  v_result := public.transition_service_request(
    p_request_id,
    'CHAT_ACTIVE'::public.request_status,
    'Chat activated by participant'
  );

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.activate_request_chat(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.activate_request_chat(uuid) TO authenticated, service_role, postgres;

-- ============================================================================
-- 4. EXPLICIT CONTACT SHARING & RETRIEVAL RPCS (ZERO-PII IN CHAT)
-- ============================================================================

-- Function to initiate contact share
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

-- Function to respond to a contact share request (accept or revoke)
CREATE OR REPLACE FUNCTION public.respond_contact_share(
  p_share_id uuid,
  p_accept boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid;
  v_share public.contact_shares%ROWTYPE;
  v_new_status public.contact_share_status;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_share
  FROM public.contact_shares
  WHERE id = p_share_id
  FOR UPDATE;

  IF v_share.id IS NULL THEN
    RAISE EXCEPTION 'Contact share request % does not exist', p_share_id;
  END IF;

  IF p_accept THEN
    -- Only recipient can accept
    IF v_actor_id <> v_share.recipient_id THEN
      RAISE EXCEPTION 'Only designated recipient can accept contact share';
    END IF;

    IF v_share.status <> 'pending'::public.contact_share_status THEN
      RAISE EXCEPTION 'Only pending contact share can be accepted (current: %)', v_share.status;
    END IF;

    v_new_status := 'shared'::public.contact_share_status;
  ELSE
    -- Either party can revoke or decline
    IF v_actor_id <> v_share.recipient_id AND v_actor_id <> v_share.sharer_id THEN
      RAISE EXCEPTION 'Only participants can decline or revoke contact share';
    END IF;

    v_new_status := 'revoked'::public.contact_share_status;
  END IF;

  UPDATE public.contact_shares
  SET status = v_new_status,
      updated_at = now()
  WHERE id = p_share_id;

  RETURN jsonb_build_object(
    'id', v_share.id,
    'request_id', v_share.request_id,
    'status', v_new_status
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.respond_contact_share(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_contact_share(uuid, boolean) TO authenticated, service_role, postgres;

-- SECURE RPC: Retrieve shared contact information
-- Zero PII in public tables; only accessible if explicit shared status exists and request is active
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

  -- 1. Fetch service request
  SELECT * INTO v_req
  FROM public.service_requests
  WHERE id = p_request_id;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Service request % does not exist', p_request_id;
  END IF;

  -- 2. Check active request status (must not be in terminal state)
  IF v_req.status IN ('DECLINED'::public.request_status, 'CANCELLED'::public.request_status, 'EXPIRED'::public.request_status, 'BLOCKED'::public.request_status) THEN
    RAISE EXCEPTION 'Contact information cannot be accessed because service request is in terminal state "%"', v_req.status;
  END IF;

  -- 3. Resolve provider owner
  SELECT user_id INTO v_provider_owner_id
  FROM public.provider_profiles
  WHERE id = v_req.provider_id;

  -- 4. Verify caller is a legitimate participant
  IF v_actor_id <> v_req.user_id AND v_actor_id <> v_provider_owner_id THEN
    RAISE EXCEPTION 'Access denied: Caller is not a participant in this service request';
  END IF;

  -- 5. Caller cannot request their own contact info via this RPC (they own it already)
  IF v_actor_id = p_target_user_id THEN
    RAISE EXCEPTION 'Target user ID must be the other participant';
  END IF;

  -- 6. Verify target is the legitimate other participant
  IF NOT (
    (v_actor_id = v_req.user_id AND p_target_user_id = v_provider_owner_id) OR
    (v_actor_id = v_provider_owner_id AND p_target_user_id = v_req.user_id)
  ) THEN
    RAISE EXCEPTION 'Target user is not a valid counterpart in this service request';
  END IF;

  -- 7. Verify explicit, active contact sharing approval
  -- The target user must have shared their contact with the caller (or reciprocal active share)
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

  -- 8. Retrieve target profile & quarantined private phone
  SELECT full_name INTO v_target_name
  FROM public.users
  WHERE id = p_target_user_id;

  SELECT phone_e164 INTO v_target_phone
  FROM public.user_private
  WHERE user_id = p_target_user_id;

  -- Log audit event for contact data view (strictly without logging the phone number itself)
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

-- ============================================================================
-- 5. RLS HARDENING FOR USER_PRIVATE
-- ============================================================================

-- Secure policy on user_private so users can view and update their own record
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_private' AND policyname = 'p_user_private_self_select'
  ) THEN
    CREATE POLICY p_user_private_self_select
      ON public.user_private
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_private' AND policyname = 'p_user_private_self_update'
  ) THEN
    CREATE POLICY p_user_private_self_update
      ON public.user_private
      FOR UPDATE
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_private' AND policyname = 'p_user_private_self_insert'
  ) THEN
    CREATE POLICY p_user_private_self_insert
      ON public.user_private
      FOR INSERT
      TO authenticated
      WITH CHECK (auth.uid() = user_id);
  END IF;
END;
$$;
