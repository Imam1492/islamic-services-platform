-- Migration: 20260926000000_08_authoritative_onboarding_status.sql
-- Description: Phase 3.2.2B — Minimal, Read-Only Authoritative Onboarding Status RPC
-- Allows authenticated client to query its own onboarding status authoritatively
-- without exposing public.users to direct client SELECT or bypassing least privilege.

-- ============================================================================
-- 1. AUTHORITATIVE ONBOARDING STATUS RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_onboarding_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid;
  v_onboarded_at timestamptz;
  v_user_exists boolean;
BEGIN
  -- 1. Identify caller strictly from authenticated identity
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required to retrieve onboarding status'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Read authoritative onboarded_at from public.users
  SELECT true, onboarded_at INTO v_user_exists, v_onboarded_at
  FROM public.users
  WHERE id = v_actor_id;

  -- 3. Fail-Closed: Missing user profile row is an integrity violation, not an unonboarded state
  IF v_user_exists IS NOT TRUE THEN
    RAISE EXCEPTION 'User profile not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- 4. Return strictly minimal, non-PII onboarding state
  RETURN jsonb_build_object(
    'is_onboarded', (v_onboarded_at IS NOT NULL),
    'onboarded_at', v_onboarded_at
  );
END;
$$;

-- Security hardening: revoke execute from public and anon, grant strictly to authenticated and service_role
REVOKE EXECUTE ON FUNCTION public.get_my_onboarding_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_onboarding_status() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_onboarding_status() TO authenticated, service_role;
