-- Migration: 10_revoke_direct_provider_badges_select
-- Description: Revokes direct authenticated SELECT access on public.provider_badges,
--              reinstates complete default-deny on the table, and confines badge
--              projection strictly to the authoritative SECURITY DEFINER discovery RPCs.

-- ============================================================================
-- 1. DROP MIGRATION 09 BADGE SELECT POLICY
-- ============================================================================

DROP POLICY IF EXISTS p_provider_badges_select ON public.provider_badges;

-- ============================================================================
-- 2. REVOKE DIRECT TABLE ACCESS FROM CLIENT ROLES
-- ============================================================================

-- Revoke SELECT from authenticated users
REVOKE SELECT ON TABLE public.provider_badges FROM authenticated;

-- Ensure anonymous and public access remains completely denied
REVOKE ALL ON TABLE public.provider_badges FROM PUBLIC, anon;

-- ============================================================================
-- 3. PRESERVE PRIVILEGED SERVICE ROLE ACCESS
-- ============================================================================

-- Service role retains necessary administrative read access
GRANT SELECT ON TABLE public.provider_badges TO service_role;
