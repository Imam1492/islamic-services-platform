-- Migration: 06_least_privilege_chat_and_provider_access
-- Description: Implement Option C least-privilege chat authorization and provider profile discovery policies.
-- 1. Creates single-parameter SECURITY DEFINER conversation participant validation helper (is_conversation_participant).
-- 2. Refactors p_messages_insert_sender and p_messages_select_participant to decouple customer authorization
--    from provider_profiles visibility while maintaining strict participant validation for providers.
-- 3. Refactors p_conversations_select_participant to leverage participant helper.
-- 4. Creates single-parameter SECURITY DEFINER admin provider visibility helper (can_admin_view_provider).
-- 5. Establishes exact-area discovery RLS policy on public.provider_profiles (approved catalog, self-access,
--    super_admin global access, and exact-area-only unapproved profile access for area_admin via helper).

-- ============================================================================
-- 1. SECURITY DEFINER PARTICIPANT VALIDATION HELPER (SINGLE PARAMETER)
-- ============================================================================

-- Drop 2-parameter version if exists
DROP FUNCTION IF EXISTS public.is_conversation_participant(uuid, uuid);

CREATE OR REPLACE FUNCTION public.is_conversation_participant(
  p_conversation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF p_conversation_id IS NULL OR v_actor_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.conversations c
    LEFT JOIN public.provider_profiles p ON p.id = c.provider_id
    WHERE c.id = p_conversation_id
      AND (c.user_id = v_actor_id OR p.user_id = v_actor_id)
  );
END;
$$;

-- Secure function permissions
REVOKE EXECUTE ON FUNCTION public.is_conversation_participant(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_conversation_participant(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_conversation_participant(uuid) TO authenticated, service_role, postgres;

-- ============================================================================
-- 2. REFACTOR MESSAGES RLS POLICIES (DECOUPLE CUSTOMER FROM PROVIDER_PROFILES)
-- ============================================================================

DROP POLICY IF EXISTS p_messages_insert_sender ON public.messages;
CREATE POLICY p_messages_insert_sender
  ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.service_requests sr ON sr.id = c.request_id
      WHERE c.id = messages.conversation_id
        AND sr.status IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status)
        AND (
          c.user_id = auth.uid()
          OR public.is_conversation_participant(c.id)
        )
    )
  );

DROP POLICY IF EXISTS p_messages_select_participant ON public.messages;
CREATE POLICY p_messages_select_participant
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (
          c.user_id = auth.uid()
          OR public.is_conversation_participant(c.id)
        )
    )
  );

-- ============================================================================
-- 3. REFACTOR CONVERSATIONS PARTICIPANT SELECT POLICY
-- ============================================================================

DROP POLICY IF EXISTS p_conversations_select_participant ON public.conversations;
CREATE POLICY p_conversations_select_participant
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR public.is_conversation_participant(conversations.id)
  );

-- ============================================================================
-- 4. SECURITY DEFINER ADMIN PROVIDER VISIBILITY HELPER
-- ============================================================================

DROP FUNCTION IF EXISTS public.can_admin_view_provider(uuid);

CREATE OR REPLACE FUNCTION public.can_admin_view_provider(
  p_provider_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF p_provider_id IS NULL OR v_actor_id IS NULL THEN
    RETURN false;
  END IF;

  -- 1. Super admin has global visibility over all provider profiles
  IF EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = v_actor_id
      AND ur.role = 'super_admin'::public.app_role
  ) THEN
    RETURN true;
  END IF;

  -- 2. Area admin can view provider profiles ONLY if provider declared an exact location
  --    that matches an admin_area_assignment for the caller
  IF EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = v_actor_id
      AND ur.role = 'area_admin'::public.app_role
  ) THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.provider_locations pl
      JOIN public.admin_area_assignments aaa ON aaa.location_id = pl.location_id
      WHERE pl.provider_id = p_provider_id
        AND aaa.user_id = v_actor_id
    );
  END IF;

  RETURN false;
END;
$$;

-- Secure helper function permissions
REVOKE EXECUTE ON FUNCTION public.can_admin_view_provider(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.can_admin_view_provider(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_admin_view_provider(uuid) TO authenticated, service_role, postgres;

-- ============================================================================
-- 5. EXACT-AREA DISCOVERY SELECT POLICY FOR PROVIDER_PROFILES
-- ============================================================================

DROP POLICY IF EXISTS p_provider_profiles_select ON public.provider_profiles;
CREATE POLICY p_provider_profiles_select
  ON public.provider_profiles
  FOR SELECT
  TO authenticated
  USING (
    -- 1. Approved provider profiles are visible for discovery
    status = 'approved'::public.provider_status
    -- 2. Provider can always view their own profile (any status)
    OR user_id = auth.uid()
    -- 3. Super admin & Area admin access via SECURITY DEFINER helper
    OR public.can_admin_view_provider(id)
  );

