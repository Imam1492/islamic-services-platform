-- Migration: 03_requests_chat_and_audit
-- Description: State-machine service requests, strict 1-to-1 private chat, immutable audit logs,
--              and zero-PII contact sharing ledger.

-- ============================================================================
-- 1. ENUMS
-- ============================================================================

CREATE TYPE public.request_status AS ENUM (
  'REQUESTED',
  'ACCEPTED',
  'CHAT_ACTIVE',
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
  'BLOCKED',
  'DISPUTED'
);

CREATE TYPE public.contact_share_status AS ENUM (
  'pending',
  'shared',
  'revoked'
);

-- ============================================================================
-- 2. AUDIT LOGS (IMMUTABLE, ZERO-PII LEDGER)
-- ============================================================================

CREATE TABLE public.audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_actor_id ON public.audit_logs(actor_id);
CREATE INDEX idx_audit_logs_entity ON public.audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON public.audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

-- Function to prevent modification or deletion of audit logs
CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs are strictly append-only and immutable. UPDATE, DELETE, and TRUNCATE are prohibited.';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_audit_log_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_audit_log_mutation() TO authenticated, service_role, postgres;

CREATE TRIGGER trg_prevent_audit_log_mutation
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();

-- Internal secure audit logging helper function
CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_actor_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_old_data jsonb DEFAULT NULL,
  p_new_data jsonb DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_log_id bigint;
BEGIN
  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (p_actor_id, p_action, p_entity_type, p_entity_id, p_old_data, p_new_data)
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) TO authenticated, service_role, postgres;

-- ============================================================================
-- 3. SERVICE REQUESTS
-- ============================================================================

CREATE TABLE public.service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  provider_id uuid NOT NULL REFERENCES public.provider_profiles(id) ON DELETE RESTRICT,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  status public.request_status NOT NULL DEFAULT 'REQUESTED'::public.request_status,
  event_date timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_service_request_notes_length CHECK (notes IS NULL OR char_length(notes) <= 2000)
);

CREATE INDEX idx_service_requests_user_id ON public.service_requests(user_id);
CREATE INDEX idx_service_requests_provider_id ON public.service_requests(provider_id);
CREATE INDEX idx_service_requests_service_id ON public.service_requests(service_id);
CREATE INDEX idx_service_requests_location_id ON public.service_requests(location_id);
CREATE INDEX idx_service_requests_status ON public.service_requests(status);
CREATE INDEX idx_service_requests_created_at ON public.service_requests(created_at DESC);

CREATE TRIGGER trg_service_requests_updated_at
  BEFORE UPDATE ON public.service_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Validate service request integrity and boundaries
CREATE OR REPLACE FUNCTION public.validate_service_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_level public.location_level;
  target_location_active boolean;
  provider_owner_id uuid;
  provider_curr_status public.provider_status;
BEGIN
  -- 1. Location must exist, be active, and be of level 'area'
  SELECT level, is_active INTO target_level, target_location_active
  FROM public.locations
  WHERE id = NEW.location_id;

  IF target_level IS NULL THEN
    RAISE EXCEPTION 'Location with ID % does not exist', NEW.location_id;
  END IF;

  IF target_level <> 'area'::public.location_level THEN
    RAISE EXCEPTION 'Service request location must be of level "area", found: %', target_level;
  END IF;

  IF NOT target_location_active THEN
    RAISE EXCEPTION 'Cannot create request in an inactive location (id: %)', NEW.location_id;
  END IF;

  -- 2. Fetch provider profile details
  SELECT user_id, status INTO provider_owner_id, provider_curr_status
  FROM public.provider_profiles
  WHERE id = NEW.provider_id;

  IF provider_owner_id IS NULL THEN
    RAISE EXCEPTION 'Provider profile % does not exist', NEW.provider_id;
  END IF;

  -- Self-request prevention: Requester cannot book themselves
  IF NEW.user_id = provider_owner_id THEN
    RAISE EXCEPTION 'Users cannot create service requests for their own provider profile';
  END IF;

  -- 3. Provider must be in an approved status to accept requests
  IF provider_curr_status <> 'approved'::public.provider_status THEN
    RAISE EXCEPTION 'Cannot submit service request to a provider who is not approved (current status: %)', provider_curr_status;
  END IF;

  -- 4. Initial status on INSERT must be REQUESTED
  IF TG_OP = 'INSERT' AND NEW.status <> 'REQUESTED'::public.request_status THEN
    RAISE EXCEPTION 'Initial status for new service requests must be "REQUESTED", found: %', NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_service_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_service_request() TO authenticated, service_role, postgres;

CREATE TRIGGER trg_validate_service_request
  BEFORE INSERT OR UPDATE ON public.service_requests
  FOR EACH ROW EXECUTE FUNCTION public.validate_service_request();

-- Prevent direct client updates to service_requests.status
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

CREATE TRIGGER trg_check_request_status_update
  BEFORE UPDATE ON public.service_requests
  FOR EACH ROW EXECUTE FUNCTION public.check_request_status_update();

-- ============================================================================
-- 4. PRIVATE 1-TO-1 CHAT: CONVERSATIONS & MESSAGES
-- ============================================================================

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES public.service_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  provider_id uuid NOT NULL REFERENCES public.provider_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_request_id ON public.conversations(request_id);
CREATE INDEX idx_conversations_user_id ON public.conversations(user_id);
CREATE INDEX idx_conversations_provider_id ON public.conversations(provider_id);

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Enforce that conversation participants strictly match the underlying service request
CREATE OR REPLACE FUNCTION public.enforce_conversation_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  req_user_id uuid;
  req_provider_id uuid;
  req_status public.request_status;
BEGIN
  SELECT user_id, provider_id, status
  INTO req_user_id, req_provider_id, req_status
  FROM public.service_requests
  WHERE id = NEW.request_id;

  IF req_user_id IS NULL THEN
    RAISE EXCEPTION 'Service request % does not exist', NEW.request_id;
  END IF;

  -- Ensure chat is only initiated for authorized states
  IF req_status NOT IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status) THEN
    RAISE EXCEPTION 'Conversations can only be initiated for requests in ACCEPTED or CHAT_ACTIVE status (current status: %)', req_status;
  END IF;

  -- Auto-derive / strictly enforce participants from the service request
  NEW.user_id := req_user_id;
  NEW.provider_id := req_provider_id;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_conversation_participants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_conversation_participants() TO authenticated, service_role, postgres;

CREATE TRIGGER trg_enforce_conversation_participants
  BEFORE INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_conversation_participants();

-- Text-only Messages table
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_message_content CHECK (char_length(trim(content)) > 0 AND char_length(content) <= 4000)
);

CREATE INDEX idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX idx_messages_sender_id ON public.messages(sender_id);
CREATE INDEX idx_messages_created_at ON public.messages(created_at ASC);

-- Enforce sender identity, legitimate conversation participation, and chat immutability
CREATE OR REPLACE FUNCTION public.validate_and_lock_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conv_user_id uuid;
  conv_provider_user_id uuid;
  req_status public.request_status;
BEGIN
  -- 1. Messages are immutable once posted (no UPDATE or DELETE by clients)
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Chat messages are immutable. Edits and deletions are prohibited.';
  END IF;

  -- 2. Resolve participants and request status from conversation
  SELECT c.user_id, p.user_id, sr.status
  INTO conv_user_id, conv_provider_user_id, req_status
  FROM public.conversations c
  JOIN public.provider_profiles p ON p.id = c.provider_id
  JOIN public.service_requests sr ON sr.id = c.request_id
  WHERE c.id = NEW.conversation_id;

  IF conv_user_id IS NULL THEN
    RAISE EXCEPTION 'Conversation % does not exist', NEW.conversation_id;
  END IF;

  -- 3. Sender MUST be one of the two legitimate participants
  IF NEW.sender_id <> conv_user_id AND NEW.sender_id <> conv_provider_user_id THEN
    RAISE EXCEPTION 'Sender % is not a participant in conversation %', NEW.sender_id, NEW.conversation_id;
  END IF;

  -- 4. Prevent sender spoofing if called in an authenticated session
  IF auth.uid() IS NOT NULL AND NEW.sender_id <> auth.uid() THEN
    RAISE EXCEPTION 'Authenticated user % cannot send messages impersonating sender %', auth.uid(), NEW.sender_id;
  END IF;

  -- 5. Chat must be in active status
  IF req_status NOT IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status) THEN
    RAISE EXCEPTION 'Messages cannot be sent because service request status is "%" (must be ACCEPTED or CHAT_ACTIVE)', req_status;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_lock_message() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_and_lock_message() TO authenticated, service_role, postgres;

CREATE TRIGGER trg_validate_and_lock_message
  BEFORE INSERT OR UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.validate_and_lock_message();

-- ============================================================================
-- 5. EXPLICIT CONTACT SHARING (ZERO-PII LEDGER)
-- ============================================================================

CREATE TABLE public.contact_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE CASCADE,
  sharer_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recipient_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status public.contact_share_status NOT NULL DEFAULT 'pending'::public.contact_share_status,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_contact_shares_direction UNIQUE (request_id, sharer_id, recipient_id),
  CONSTRAINT chk_contact_shares_distinct_actors CHECK (sharer_id <> recipient_id)
);

CREATE INDEX idx_contact_shares_request_id ON public.contact_shares(request_id);
CREATE INDEX idx_contact_shares_sharer_id ON public.contact_shares(sharer_id);
CREATE INDEX idx_contact_shares_recipient_id ON public.contact_shares(recipient_id);
CREATE INDEX idx_contact_shares_status ON public.contact_shares(status);

CREATE TRIGGER trg_contact_shares_updated_at
  BEFORE UPDATE ON public.contact_shares
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Validate contact sharing participants and workflow rules
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

CREATE TRIGGER trg_validate_contact_share
  BEFORE INSERT OR UPDATE ON public.contact_shares
  FOR EACH ROW EXECUTE FUNCTION public.validate_contact_share();

-- ============================================================================
-- 6. ROW LEVEL SECURITY (RLS) & ACCESS PERMISSIONS
-- ============================================================================

-- Enable RLS across all new tables
ALTER TABLE public.service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- AUDIT LOG PRIVILEGES: Completely restricted, immutable
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.audit_logs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.audit_logs TO service_role;

-- ----------------------------------------------------------------------------
-- SERVICE REQUESTS RLS POLICIES
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.service_requests FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.service_requests TO authenticated;
GRANT ALL ON TABLE public.service_requests TO service_role;

-- Requesters can see their own requests
CREATE POLICY p_service_requests_select_requester
  ON public.service_requests
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Providers can see requests directed to their provider profile
CREATE POLICY p_service_requests_select_provider
  ON public.service_requests
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.provider_profiles p
      WHERE p.id = service_requests.provider_id
        AND p.user_id = auth.uid()
    )
  );

-- Super admins and assigned area admins can see requests
CREATE POLICY p_service_requests_select_admin
  ON public.service_requests
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'super_admin'::public.app_role
    )
    OR
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.admin_area_assignments aaa ON aaa.user_id = ur.user_id
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'area_admin'::public.app_role
        AND aaa.location_id = service_requests.location_id
    )
  );

-- Requesters can insert new requests for themselves in REQUESTED status
CREATE POLICY p_service_requests_insert_requester
  ON public.service_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id AND status = 'REQUESTED'::public.request_status
  );

-- Direct client updates to status are prohibited (enforced by trigger).
-- Other non-status updates (e.g. notes) are allowed for the requester while in REQUESTED status.
CREATE POLICY p_service_requests_update_requester
  ON public.service_requests
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id AND status = 'REQUESTED'::public.request_status)
  WITH CHECK (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- CONVERSATIONS RLS POLICIES
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.conversations FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE public.conversations TO authenticated;
GRANT ALL ON TABLE public.conversations TO service_role;

-- Legitimate participants can select their conversation
CREATE POLICY p_conversations_select_participant
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM public.provider_profiles p
      WHERE p.id = conversations.provider_id
        AND p.user_id = auth.uid()
    )
  );

-- Legitimate participants can initiate a conversation when request is in active status
CREATE POLICY p_conversations_insert_participant
  ON public.conversations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (
      auth.uid() = user_id OR
      EXISTS (
        SELECT 1 FROM public.provider_profiles p
        WHERE p.id = conversations.provider_id
          AND p.user_id = auth.uid()
      )
    )
    AND
    EXISTS (
      SELECT 1 FROM public.service_requests sr
      WHERE sr.id = conversations.request_id
        AND sr.status IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status)
    )
  );

-- ----------------------------------------------------------------------------
-- MESSAGES RLS POLICIES
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.messages FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE public.messages TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.messages TO service_role;

-- Participants can read messages in their conversation
CREATE POLICY p_messages_select_participant
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.provider_profiles p ON p.id = c.provider_id
      WHERE c.id = messages.conversation_id
        AND (c.user_id = auth.uid() OR p.user_id = auth.uid())
    )
  );

-- Authenticated participant can send a message
CREATE POLICY p_messages_insert_sender
  ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.provider_profiles p ON p.id = c.provider_id
      JOIN public.service_requests sr ON sr.id = c.request_id
      WHERE c.id = messages.conversation_id
        AND (c.user_id = auth.uid() OR p.user_id = auth.uid())
        AND sr.status IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status)
    )
  );

-- ----------------------------------------------------------------------------
-- CONTACT SHARES RLS POLICIES
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.contact_shares FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.contact_shares TO authenticated;
REVOKE DELETE, TRUNCATE ON TABLE public.contact_shares FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.contact_shares TO service_role;

-- Participants can see contact shares for their request
CREATE POLICY p_contact_shares_select_participant
  ON public.contact_shares
  FOR SELECT
  TO authenticated
  USING (auth.uid() = sharer_id OR auth.uid() = recipient_id);

-- Sharer can initiate contact share
CREATE POLICY p_contact_shares_insert_sharer
  ON public.contact_shares
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = sharer_id AND
    status = 'pending'::public.contact_share_status AND
    EXISTS (
      SELECT 1 FROM public.service_requests sr
      JOIN public.provider_profiles p ON p.id = sr.provider_id
      WHERE sr.id = contact_shares.request_id
        AND sr.status IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status)
        AND (
          (sharer_id = sr.user_id AND recipient_id = p.user_id) OR
          (sharer_id = p.user_id AND recipient_id = sr.user_id)
        )
    )
  );

-- Recipient can accept (to 'shared') or either party can revoke
CREATE POLICY p_contact_shares_update_participant
  ON public.contact_shares
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = recipient_id OR auth.uid() = sharer_id)
  WITH CHECK (auth.uid() = recipient_id OR auth.uid() = sharer_id);
