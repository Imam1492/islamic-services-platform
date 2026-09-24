-- Migration: 20260925000000_07_user_onboarding_and_consent.sql
-- Description: Phase 3.2 Step 2A — Database Onboarding & Consent Foundation
-- Adds public.users.onboarded_at, immutable public.user_consents ledger,
-- and the hardened complete_user_onboarding(...) SECURITY DEFINER RPC.

-- ============================================================================
-- 1. EXTEND PUBLIC.USERS WITH ONBOARDED_AT
-- ============================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_onboarded_at
  ON public.users (onboarded_at)
  WHERE onboarded_at IS NOT NULL;

-- Ensure authenticated role has NO update privilege on public.users
REVOKE UPDATE, INSERT, DELETE ON TABLE public.users FROM anon, authenticated, PUBLIC;

-- ============================================================================
-- 2. IMMUTABLE USER CONSENT LEDGER (PUBLIC.USER_CONSENTS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tos_version text NOT NULL,
  privacy_policy_version text NOT NULL,
  adult_acknowledgement_given boolean NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- Validation constraints
  CONSTRAINT chk_user_consents_tos_version
    CHECK (length(trim(tos_version)) > 0 AND length(tos_version) <= 50),
  CONSTRAINT chk_user_consents_privacy_version
    CHECK (length(trim(privacy_policy_version)) > 0 AND length(privacy_policy_version) <= 50),
  CONSTRAINT chk_user_consents_adult_only
    CHECK (adult_acknowledgement_given = true)
);

CREATE INDEX IF NOT EXISTS idx_user_consents_user_id
  ON public.user_consents (user_id);
CREATE INDEX IF NOT EXISTS idx_user_consents_accepted_at
  ON public.user_consents (accepted_at DESC);

-- ============================================================================
-- 3. CONSENT IMMUTABILITY TRIGGER (DEFENSE-IN-DEPTH)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prevent_user_consents_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'User consent records are strictly append-only and immutable. UPDATE and DELETE are prohibited.'
    USING ERRCODE = '42501';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_user_consents_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_user_consents_mutation() TO postgres, supabase_auth_admin, service_role;

DROP TRIGGER IF EXISTS trg_prevent_user_consents_mutation ON public.user_consents;
CREATE TRIGGER trg_prevent_user_consents_mutation
  BEFORE UPDATE OR DELETE ON public.user_consents
  FOR EACH ROW EXECUTE FUNCTION public.prevent_user_consents_mutation();

-- ============================================================================
-- 4. RLS & ACCESS CONTROL FOR USER_CONSENTS
-- ============================================================================

ALTER TABLE public.user_consents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_consents FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.user_consents TO authenticated;
GRANT ALL ON TABLE public.user_consents TO service_role;

-- Users may only view their own consent history
DROP POLICY IF EXISTS p_user_consents_self_select ON public.user_consents;
CREATE POLICY p_user_consents_self_select
  ON public.user_consents
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Explicitly revoke write grants to prevent any client direct mutation
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_consents FROM anon, authenticated, PUBLIC;

-- ============================================================================
-- 5. HARDENED ONE-TIME ONBOARDING RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_user_onboarding(
  p_full_name text,
  p_tos_version text,
  p_privacy_policy_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid;
  v_user public.users%ROWTYPE;
  v_clean_name text;
  v_clean_tos text;
  v_clean_privacy text;
  v_timestamp timestamptz;
  v_consent_id uuid;
BEGIN
  -- 1. Identify caller strictly from authenticated identity
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required to complete onboarding'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Concurrency Lock: Lock the caller's row in public.users exclusively
  SELECT * INTO v_user
  FROM public.users
  WHERE id = v_actor_id
  FOR UPDATE;

  -- 3. Verify user profile exists
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'User profile % not found', v_actor_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 4. Idempotency & One-Time Boundary: Check if user has already completed onboarding
  IF v_user.onboarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'User % has already completed onboarding', v_actor_id
      USING ERRCODE = '23505';
  END IF;

  -- 5. Strict Input Validation: Full Name (2-100 characters, trimmed)
  v_clean_name := trim(p_full_name);
  IF v_clean_name IS NULL OR length(v_clean_name) < 2 OR length(v_clean_name) > 100 THEN
    RAISE EXCEPTION 'Full name must be between 2 and 100 characters'
      USING ERRCODE = '22023';
  END IF;

  -- 6. Strict Input Validation: Terms of Service version (1-50 characters)
  v_clean_tos := trim(p_tos_version);
  IF v_clean_tos IS NULL OR length(v_clean_tos) < 1 OR length(v_clean_tos) > 50 THEN
    RAISE EXCEPTION 'Terms of Service version must be between 1 and 50 characters'
      USING ERRCODE = '22023';
  END IF;

  -- 7. Strict Input Validation: Privacy Policy version (1-50 characters)
  v_clean_privacy := trim(p_privacy_policy_version);
  IF v_clean_privacy IS NULL OR length(v_clean_privacy) < 1 OR length(v_clean_privacy) > 50 THEN
    RAISE EXCEPTION 'Privacy Policy version must be between 1 and 50 characters'
      USING ERRCODE = '22023';
  END IF;

  -- 8. Generate database timestamp
  v_timestamp := clock_timestamp();

  -- 9. Insert exactly one immutable consent record (server-controlled timestamps & adult flag)
  INSERT INTO public.user_consents (
    user_id,
    tos_version,
    privacy_policy_version,
    adult_acknowledgement_given,
    accepted_at
  )
  VALUES (
    v_actor_id,
    v_clean_tos,
    v_clean_privacy,
    true,
    v_timestamp
  )
  RETURNING id INTO v_consent_id;

  -- 10. Update user profile with validated name and onboarding timestamp atomically
  UPDATE public.users
  SET full_name = v_clean_name,
      onboarded_at = v_timestamp,
      updated_at = v_timestamp
  WHERE id = v_actor_id;

  -- 11. Record immutable audit event (strictly zero unnecessary PII; full name excluded)
  PERFORM public.log_audit_event(
    v_actor_id,
    'USER_ONBOARDING_COMPLETED',
    'users',
    v_actor_id,
    jsonb_build_object('previously_onboarded', false),
    jsonb_build_object(
      'tos_version', v_clean_tos,
      'privacy_policy_version', v_clean_privacy,
      'adult_acknowledgement_given', true,
      'consent_id', v_consent_id,
      'name_char_length', length(v_clean_name)
    )
  );

  -- 12. Return atomic success payload
  RETURN jsonb_build_object(
    'status', 'success',
    'user_id', v_actor_id,
    'onboarded_at', v_timestamp,
    'consent_id', v_consent_id
  );
END;
$$;

-- Security hardening: revoke execute from public and anon, grant strictly to authenticated and service_role
REVOKE EXECUTE ON FUNCTION public.complete_user_onboarding(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_user_onboarding(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_user_onboarding(text, text, text) TO authenticated, service_role;
