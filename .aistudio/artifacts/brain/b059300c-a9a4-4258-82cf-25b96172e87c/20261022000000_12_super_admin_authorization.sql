-- Migration: 20261022000000_12_super_admin_authorization.sql
-- Description: Dedicated least-privilege super_admin authorization helper and RLS policy:
--   1. Creates dedicated NOLOGIN, least-privilege owner role (admin_super_admin_lookup_owner)
--      with NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, NOBYPASSRLS.
--   2. Grants only USAGE on schema public (plus temporary CREATE during ownership transfer)
--      and SELECT (user_id, role) on public.user_roles to admin_super_admin_lookup_owner.
--   3. Creates restricted RLS policy on public.user_roles allowing admin_super_admin_lookup_owner
--      to read only the authenticated caller's own super_admin role row.
--   4. Creates zero-argument SECURITY DEFINER helper public.current_user_is_super_admin()
--      with hardened search_path and row_security = on.
--   5. Uses a PostgreSQL-version-aware DO block (PG 16+ INHERIT TRUE, SET TRUE; PG 15 standard grant)
--      so CREATEROLE migration runners (such as Supabase's postgres role) can transfer function
--      ownership and configure function ACLs without SQLSTATE 42501, then revokes temporary
--      INHERIT and SET options while preserving ADMIN OPTION required for rollback.

-- ============================================================================
-- 1. DEDICATED LEAST-PRIVILEGE OWNER ROLE
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'admin_super_admin_lookup_owner'
  ) THEN
    CREATE ROLE admin_super_admin_lookup_owner
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  ELSE
    ALTER ROLE admin_super_admin_lookup_owner
      WITH NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END
$$;

-- Ensure clean baseline privileges for the dedicated owner role.
-- Temporary CREATE on schema public is required by PostgreSQL's AlterFunctionOwner_internal
-- when the migration runner role is non-privileged; it is revoked in the cleanup step.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM admin_super_admin_lookup_owner;
REVOKE ALL ON SCHEMA public FROM admin_super_admin_lookup_owner;
GRANT USAGE, CREATE ON SCHEMA public TO admin_super_admin_lookup_owner;
GRANT SELECT (user_id, role) ON TABLE public.user_roles TO admin_super_admin_lookup_owner;

-- ============================================================================
-- 2. RESTRICTED RLS POLICY ON PUBLIC.USER_ROLES
-- ============================================================================

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_user_roles_select_own_super_admin ON public.user_roles;
CREATE POLICY p_user_roles_select_own_super_admin
  ON public.user_roles
  FOR SELECT
  TO admin_super_admin_lookup_owner
  USING (
    user_id = auth.uid()
    AND role = 'super_admin'::public.app_role
  );

-- ============================================================================
-- 3. HARDENED SUPER_ADMIN AUTHORIZATION HELPER FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = on
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF v_actor_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = v_actor_id
      AND ur.role = 'super_admin'::public.app_role
  );
END;
$$;

-- ============================================================================
-- 4. VERSION-AWARE OWNERSHIP TRANSFER & FUNCTION ACL HARDENING
-- ============================================================================

-- On PostgreSQL 16+, CREATEROLE roles receive automatic membership
-- in newly created roles with ADMIN TRUE, INHERIT FALSE, SET FALSE.
-- PostgreSQL requires SET TRUE to execute ALTER FUNCTION ... OWNER TO <role>,
-- and INHERIT TRUE to manage GRANT/REVOKE ACLs on the function after ownership transfer.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format(
      'GRANT admin_super_admin_lookup_owner TO %I WITH INHERIT TRUE, SET TRUE',
      current_user
    );
  ELSE
    EXECUTE format(
      'GRANT admin_super_admin_lookup_owner TO %I',
      current_user
    );
  END IF;
END
$$;

ALTER FUNCTION public.current_user_is_super_admin() OWNER TO admin_super_admin_lookup_owner;

REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM anon;
REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM service_role;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO authenticated;

-- ============================================================================
-- 5. PRIVILEGE & MEMBERSHIP CLEANUP
-- ============================================================================

-- Revoke temporary CREATE privilege on schema public from the owner role
REVOKE CREATE ON SCHEMA public FROM admin_super_admin_lookup_owner;

-- Revoke temporary INHERIT and SET options on PostgreSQL 16+ (preserving ADMIN OPTION
-- so the migration runner can administer/drop the role in rollbacks), or revoke
-- direct role membership on PostgreSQL 15.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format(
      'REVOKE INHERIT OPTION FOR admin_super_admin_lookup_owner FROM %I',
      current_user
    );
    EXECUTE format(
      'REVOKE SET OPTION FOR admin_super_admin_lookup_owner FROM %I',
      current_user
    );
  ELSE
    EXECUTE format(
      'REVOKE admin_super_admin_lookup_owner FROM %I',
      current_user
    );
  END IF;
END
$$;
