-- Migration: 20261018000000_11_contact_share_security_hardening.sql
-- Description: Complete security hardening for contact sharing, request state machine, and audit logging:
--   1. Revoke client-side direct UPDATE on public.contact_shares and drop participant UPDATE policy.
--   2. Revoke direct EXECUTE on public.log_audit_event from authenticated and anon to prevent forged audit events.
--   3. Explicitly revoke anonymous EXECUTE on public.assert_provider_covers_area to prevent oracle enumeration.
--   4. Revoke direct client UPDATE (status) on public.service_requests and harden check_request_status_update(),
--      completely eliminating obsolete, client-forgeable app.allow_status_transition custom GUCs.
--   5. Update public.validate_contact_share() to enforce immutability of all promised immutable columns
--      (id, created_at, request_id, sharer_id, recipient_id), allow sharer re-request of revoked shares,
--      and enforce verified role/participant lifecycle revocation without relying on forgeable session settings.
--   6. Update public.request_contact_share() with FOR SHARE parent request locking (eliminating lifecycle transition races)
--      and FOR UPDATE / ON CONFLICT concurrency control on uq_contact_shares_direction.
--   7. Update public.respond_contact_share() with FOR UPDATE locking and explicit privilege matrix.
--   8. Update public.transition_service_request() preserving verified user_roles schema, atomic terminal contact-share cleanup,
--      and removing obsolete GUC manipulation.
--   9. Update public.get_shared_contact_info() to include COMPLETED in terminal status restriction, ensure explicit anon revocation.

-- ============================================================================
-- 1. TABLE PRIVILEGES & RLS POLICIES: CONTACT SHARES
-- ============================================================================

-- Revoke direct UPDATE from client roles to ensure all status changes flow through vetted RPCs
REVOKE UPDATE ON TABLE public.contact_shares FROM authenticated;

-- Drop the direct participant UPDATE policy as direct updates are now prohibited
DROP POLICY IF EXISTS p_contact_shares_update_participant ON public.contact_shares;


-- ============================================================================
-- 2. AUDIT LOGGING HARDENING: LOG_AUDIT_EVENT
-- ============================================================================

-- Prevent authenticated and anonymous clients from directly generating fabricated audit log records.
-- Internal triggers and SECURITY DEFINER procedures running as postgres/service_role continue to log events safely.
REVOKE EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) TO service_role, postgres;


-- ============================================================================
-- 3. AREA VALIDATION HARDENING: ASSERT_PROVIDER_COVERS_AREA
-- ============================================================================

-- Close anonymous execution oracle on assert_provider_covers_area
REVOKE EXECUTE ON FUNCTION public.assert_provider_covers_area(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_provider_covers_area(uuid, uuid) TO authenticated, service_role, postgres;


-- ============================================================================
-- 3b. DIRECT SERVICE REQUEST STATUS UPDATE PROTECTION & OBSOLETE GUC REMOVAL
-- ============================================================================

-- Close vulnerability where authenticated clients could forge app.allow_status_transition
-- to bypass state machine checks. Authoritative state machine transitions must be executed
-- exclusively through transition_service_request().
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

  -- Direct client modification of service_requests.status is prohibited.
  -- State transitions must be executed exclusively through authorized transition procedures.
  IF current_user IN ('authenticated', 'anon') OR session_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Direct update of service_requests.status is prohibited. State transitions must be executed through authorized transition procedures.'
      USING ERRCODE = '42501';
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

REVOKE EXECUTE ON FUNCTION public.check_request_status_update() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_request_status_update() TO authenticated, service_role, postgres;

-- Explicitly revoke column-level UPDATE privilege on status from client roles
REVOKE UPDATE (status) ON TABLE public.service_requests FROM authenticated, anon, PUBLIC;


-- ============================================================================
-- 4. CONTACT SHARE VALIDATION TRIGGER: VALIDATE_CONTACT_SHARE
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

  -- 2. Ensure request is active for initiating, approving, or re-requesting contact sharing.
  -- Revocation (status = 'revoked') is explicitly permitted when transitioning to or already in a terminal state.
  IF NEW.status <> 'revoked'::public.contact_share_status THEN
    IF req_status NOT IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status) THEN
      RAISE EXCEPTION 'Contact sharing is only permitted for requests in ACCEPTED or CHAT_ACTIVE status (current status: %)', req_status;
    END IF;
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

  -- 5. Enforce immutability and state transition rules on UPDATE
  IF TG_OP = 'UPDATE' THEN
    -- Verify immutability of EVERY promised immutable column
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Cannot modify id of an existing contact share';
    END IF;

    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Cannot modify created_at of an existing contact share';
    END IF;

    IF NEW.request_id IS DISTINCT FROM OLD.request_id THEN
      RAISE EXCEPTION 'Cannot modify request_id of an existing contact share';
    END IF;

    IF NEW.sharer_id IS DISTINCT FROM OLD.sharer_id THEN
      RAISE EXCEPTION 'Cannot modify sharer_id of an existing contact share';
    END IF;

    IF NEW.recipient_id IS DISTINCT FROM OLD.recipient_id THEN
      RAISE EXCEPTION 'Cannot modify recipient_id of an existing contact share';
    END IF;

    IF NEW.status <> OLD.status THEN
      IF current_user_id IS NOT NULL THEN
        -- Recipient confirmation required to transition to 'shared'
        IF NEW.status = 'shared'::public.contact_share_status THEN
          IF current_user_id <> OLD.recipient_id THEN
            RAISE EXCEPTION 'Only the designated recipient can approve contact sharing';
          END IF;
          IF OLD.status <> 'pending'::public.contact_share_status THEN
            RAISE EXCEPTION 'Only pending contact shares can be approved';
          END IF;
        -- Either party can revoke sharing, or an authorized administrator during a terminal request lifecycle transition
        ELSIF NEW.status = 'revoked'::public.contact_share_status THEN
          -- Non-participant revocation is strictly restricted to:
          -- 1. Verified super_admin
          -- 2. Authorized area_admin during a terminal request lifecycle transition
          -- Note: Never trusts forgeable session settings like app.allow_status_transition.
          IF current_user_id <> OLD.sharer_id AND current_user_id <> OLD.recipient_id THEN
            IF NOT EXISTS (
              SELECT 1 FROM public.user_roles
              WHERE user_id = current_user_id AND role = 'super_admin'::public.app_role
            ) AND NOT (
              req_status IN ('COMPLETED'::public.request_status, 'CANCELLED'::public.request_status, 'DECLINED'::public.request_status, 'EXPIRED'::public.request_status, 'BLOCKED'::public.request_status)
              AND EXISTS (
                SELECT 1 FROM public.user_roles ur
                JOIN public.admin_area_assignments aaa ON aaa.user_id = ur.user_id
                JOIN public.service_requests sr ON sr.location_id = aaa.location_id
                WHERE ur.user_id = current_user_id
                  AND ur.role = 'area_admin'::public.app_role
                  AND sr.id = NEW.request_id
              )
            ) THEN
              RAISE EXCEPTION 'Only participants or authorized administrators during terminal request transitions can revoke contact sharing';
            END IF;
          END IF;
        -- Sharer can re-request a previously revoked share (revoked -> pending)
        ELSIF NEW.status = 'pending'::public.contact_share_status THEN
          IF OLD.status <> 'revoked'::public.contact_share_status THEN
            RAISE EXCEPTION 'Only revoked contact shares can be re-requested';
          END IF;
          IF current_user_id <> OLD.sharer_id THEN
            RAISE EXCEPTION 'Only the sharer can re-request a revoked contact share';
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
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_contact_share() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_contact_share() TO authenticated, service_role, postgres;


-- ============================================================================
-- 5. CONTACT SHARE RPC: REQUEST_CONTACT_SHARE
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

  -- Acquire shared lock on the parent service request to synchronize with concurrent state transitions.
  -- This guarantees that transition_service_request (which takes FOR UPDATE) cannot transition the request
  -- to a terminal state while a contact share is being created/re-requested, eliminating lifecycle race leaks.
  SELECT * INTO v_req
  FROM public.service_requests
  WHERE id = p_request_id
  FOR SHARE;

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

  -- Lock existing share row if present to eliminate race conditions
  SELECT id, status INTO v_share_id, v_existing_status
  FROM public.contact_shares
  WHERE request_id = p_request_id
    AND sharer_id = v_actor_id
    AND recipient_id = v_recipient_id
  FOR UPDATE;

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

  -- First-time insertion with safe conflict handling against uq_contact_shares_direction
  INSERT INTO public.contact_shares (request_id, sharer_id, recipient_id, status)
  VALUES (p_request_id, v_actor_id, v_recipient_id, 'pending'::public.contact_share_status)
  ON CONFLICT ON CONSTRAINT uq_contact_shares_direction
  DO UPDATE SET updated_at = now()
  RETURNING id, status INTO v_share_id, v_existing_status;

  RETURN jsonb_build_object(
    'id', v_share_id,
    'request_id', p_request_id,
    'status', v_existing_status
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_contact_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_contact_share(uuid) TO authenticated, service_role, postgres;


-- ============================================================================
-- 6. CONTACT SHARE RPC: RESPOND_CONTACT_SHARE
-- ============================================================================

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
    -- Only designated recipient can accept
    IF v_actor_id <> v_share.recipient_id THEN
      RAISE EXCEPTION 'Only designated recipient can accept contact share';
    END IF;

    IF v_share.status <> 'pending'::public.contact_share_status THEN
      RAISE EXCEPTION 'Only pending contact share can be accepted (current: %)', v_share.status;
    END IF;

    v_new_status := 'shared'::public.contact_share_status;
  ELSE
    -- Either participant can decline or revoke
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

REVOKE EXECUTE ON FUNCTION public.respond_contact_share(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_contact_share(uuid, boolean) TO authenticated, service_role, postgres;


-- ============================================================================
-- 7. REQUEST STATE MACHINE RPC: TRANSITION_SERVICE_REQUEST
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

  -- 4. Check administrative roles using verified live schema (public.user_roles)
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

  -- 7. Execute status transition directly as SECURITY DEFINER
  UPDATE public.service_requests
  SET status = p_target_status,
      updated_at = now()
  WHERE id = v_req.id;

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
  -- revoke any active contact shares atomically within the same transaction.
  -- Lifecycle revocation is validated by validate_contact_share() via authorized actor roles
  -- (participant/super_admin/area_admin) and terminal request state, without trusting forgeable settings.
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

REVOKE EXECUTE ON FUNCTION public.transition_service_request(uuid, public.request_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_service_request(uuid, public.request_status, text) TO authenticated, service_role, postgres;


-- ============================================================================
-- 8. CONTACT RETRIEVAL RPC: GET_SHARED_CONTACT_INFO
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

  -- 1. Fetch service request
  SELECT * INTO v_req
  FROM public.service_requests
  WHERE id = p_request_id;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Service request % does not exist', p_request_id;
  END IF;

  -- 2. Check active request status (must not be in any terminal state, including COMPLETED)
  IF v_req.status IN ('COMPLETED'::public.request_status, 'DECLINED'::public.request_status, 'CANCELLED'::public.request_status, 'EXPIRED'::public.request_status, 'BLOCKED'::public.request_status) THEN
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

  -- 5. Caller cannot request their own contact info via this RPC
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

REVOKE EXECUTE ON FUNCTION public.get_shared_contact_info(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_shared_contact_info(uuid, uuid) TO authenticated, service_role, postgres;
