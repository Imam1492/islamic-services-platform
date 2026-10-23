-- Rollback Migration: 20261022000000_12_super_admin_authorization_down.sql
-- Description: Safely rolls back Migration 12 (20261022000000_12_super_admin_authorization.sql):
--   1. Grants temporary membership (with INHERIT TRUE, SET TRUE on PG 16+) in
--      admin_super_admin_lookup_owner to current_user if the role exists, ensuring
--      CREATEROLE migration runners can drop the function owned by that role.
--   2. Drops public.current_user_is_super_admin() safely.
--   3. Drops RLS policy p_user_roles_select_own_super_admin on public.user_roles.
--   4. Revokes all table and schema privileges from admin_super_admin_lookup_owner
--      and drops the role cleanly.

-- ============================================================================
-- 1. GRANT TEMPORARY MEMBERSHIP TO DROP OWNED FUNCTION
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'admin_super_admin_lookup_owner'
  ) THEN
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
  END IF;
END
$$;

-- ============================================================================
-- 2. DROP SUPER_ADMIN AUTHORIZATION HELPER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.current_user_is_super_admin();

-- ============================================================================
-- 3. DROP RESTRICTED RLS POLICY ON PUBLIC.USER_ROLES
-- ============================================================================

DROP POLICY IF EXISTS p_user_roles_select_own_super_admin ON public.user_roles;

-- ============================================================================
-- 4. REVOKE PRIVILEGES & DROP DEDICATED OWNER ROLE
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'admin_super_admin_lookup_owner'
  ) THEN
    REVOKE ALL ON TABLE public.user_roles FROM admin_super_admin_lookup_owner;
    REVOKE ALL ON SCHEMA public FROM admin_super_admin_lookup_owner;
  END IF;
END
$$;

DROP ROLE IF EXISTS admin_super_admin_lookup_owner;
