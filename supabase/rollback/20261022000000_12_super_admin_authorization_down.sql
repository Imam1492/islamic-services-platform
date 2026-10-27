-- Rollback Migration: 20261022000000_12_super_admin_authorization_down.sql
-- Description: Safely rolls back Migration 12 (20261022000000_12_super_admin_authorization.sql):
--   1. Verifies runner authority (ADMIN OPTION or rolsuper for role administration/drop on PG 16+,
--      CREATEROLE or rolsuper on PG 15, ownership of public.user_roles when the policy exists,
--      and grantor authority via aclexplode to revoke all privileges granted to
--      admin_super_admin_lookup_owner) before making any changes.
--   2. Verifies via pg_auth_members and pg_shdepend that admin_super_admin_lookup_owner has no
--      unexpected role memberships, members, owned objects, or dependencies outside Migration 12.
--   3. Executes temporary membership grant, function drop (switching to admin_super_admin_lookup_owner
--      inside a subtransaction EXCEPTION block and restoring the prior role context), policy drop,
--      privilege revocations, and role removal atomically inside a single DO block so rollback
--      cannot leave the database half-rolled-back or leave active INHERIT/SET membership on error.

DO $rollback12$
DECLARE
  v_role_oid oid;
  v_runner_oid oid;
  v_curr_db_oid oid;
  v_fn_oid oid;
  v_fn_owner name;
  v_auth_uid_oid oid;
  v_user_roles_oid oid;
  v_user_roles_owner oid;
  v_public_ns_oid oid;
  v_auth_ns_oid oid;
  v_unrevokable_grantor name;
  v_is_rolsuper boolean := false;
  v_has_createrole boolean := false;
  v_target_is_rolsuper boolean := false;
  v_prior_role text := current_setting('role', true);
BEGIN
  -- ==========================================================================
  -- 1. PRE-FLIGHT AUTHORITY, ROLE MEMBERSHIP & DEPENDENCY SCOPE GUARDS
  -- ==========================================================================

  SELECT r.oid, r.rolsuper, r.rolcreaterole
  INTO v_runner_oid, v_is_rolsuper, v_has_createrole
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user;

  v_fn_oid := to_regprocedure('public.current_user_is_super_admin()');
  v_auth_uid_oid := to_regprocedure('auth.uid()');
  v_user_roles_oid := to_regclass('public.user_roles');
  v_public_ns_oid := to_regnamespace('public');
  v_auth_ns_oid := to_regnamespace('auth');

  -- Pre-flight check on function ownership before modifying roles or objects:
  -- Refuse to proceed if public.current_user_is_super_admin() is owned by an unexpected role
  -- or a role for which current_user lacks ownership privileges.
  IF v_fn_oid IS NOT NULL THEN
    SELECT r.rolname INTO v_fn_owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_fn_oid;

    IF v_fn_owner <> 'admin_super_admin_lookup_owner' THEN
      IF v_fn_owner NOT IN (current_user, 'postgres', 'supabase_admin') THEN
        RAISE EXCEPTION 'Refusing to roll back public.current_user_is_super_admin(): owned by unexpected role "%"',
          v_fn_owner
          USING ERRCODE = '55006';
      END IF;

      IF NOT pg_catalog.pg_has_role(current_user, v_fn_owner, 'USAGE') THEN
        RAISE EXCEPTION 'Cannot drop pre-existing function public.current_user_is_super_admin() owned by "%": current_user "%" lacks USAGE/INHERIT privilege on owner role',
          v_fn_owner, current_user
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- Verify current_user can drop p_user_roles_select_own_super_admin if it exists on public.user_roles
  IF v_user_roles_oid IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy pol
    WHERE pol.polrelid = v_user_roles_oid
      AND pol.polname = 'p_user_roles_select_own_super_admin'
  ) THEN
    SELECT c.relowner INTO v_user_roles_owner
    FROM pg_catalog.pg_class c
    WHERE c.oid = v_user_roles_oid;

    IF NOT pg_catalog.pg_has_role(current_user, v_user_roles_owner, 'USAGE') THEN
      RAISE EXCEPTION 'Cannot drop policy p_user_roles_select_own_super_admin: current_user "%" lacks ownership privileges on public.user_roles',
        current_user
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT oid, rolsuper INTO v_role_oid, v_target_is_rolsuper
  FROM pg_catalog.pg_roles
  WHERE rolname = 'admin_super_admin_lookup_owner';

  IF v_role_oid IS NOT NULL THEN
    IF v_target_is_rolsuper THEN
      RAISE EXCEPTION 'Refusing to roll back role admin_super_admin_lookup_owner: role has rolsuper attribute'
        USING ERRCODE = '55006';
    END IF;

    -- Verify runner has authority to GRANT membership and DROP ROLE.
    -- On PostgreSQL 16+, a non-rolsuper CREATEROLE runner must directly hold ADMIN OPTION on the role.
    IF NOT v_is_rolsuper THEN
      IF NOT v_has_createrole THEN
        RAISE EXCEPTION 'Cannot drop role admin_super_admin_lookup_owner: current_user "%" lacks CREATEROLE privilege',
          current_user
          USING ERRCODE = '42501';
      END IF;

      IF current_setting('server_version_num')::int >= 160000 AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members m
        WHERE m.roleid = v_role_oid
          AND m.member = v_runner_oid
          AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'Unsupported cross-runner rollback on PostgreSQL 16+: current_user "%" lacks direct ADMIN OPTION on role admin_super_admin_lookup_owner',
          current_user
          USING ERRCODE = '42501';
      END IF;

      -- Verify current_user can revoke all ACL entries granted to admin_super_admin_lookup_owner
      -- (In PostgreSQL, a non-rolsuper REVOKE only removes ACL items where the caller has
      -- USAGE/INHERIT on the original grantor; unrevoked ACL items cause DROP ROLE to fail).
      SELECT gr.rolname INTO v_unrevokable_grantor
      FROM (
        SELECT acl.grantor, acl.grantee
        FROM pg_catalog.pg_namespace n
        CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) AS acl
        WHERE n.oid IN (v_public_ns_oid, v_auth_ns_oid)
        UNION ALL
        SELECT acl.grantor, acl.grantee
        FROM pg_catalog.pg_class c
        CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
        WHERE c.oid = v_user_roles_oid
        UNION ALL
        SELECT acl.grantor, acl.grantee
        FROM pg_catalog.pg_attribute a
        CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
        WHERE a.attrelid = v_user_roles_oid AND a.attnum > 0 AND NOT a.attisdropped
        UNION ALL
        SELECT acl.grantor, acl.grantee
        FROM pg_catalog.pg_proc p
        CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
        WHERE p.oid = v_auth_uid_oid
      ) acl_entries
      JOIN pg_catalog.pg_roles gr ON gr.oid = acl_entries.grantor
      WHERE acl_entries.grantee = v_role_oid
        AND NOT pg_catalog.pg_has_role(current_user, acl_entries.grantor, 'USAGE')
      LIMIT 1;

      IF v_unrevokable_grantor IS NOT NULL THEN
        RAISE EXCEPTION 'Unsupported cross-runner rollback: privileges for admin_super_admin_lookup_owner were granted by "%", and current_user "%" lacks authority to revoke them before DROP ROLE',
          v_unrevokable_grantor, current_user
          USING ERRCODE = '42501';
      END IF;
    END IF;

    SELECT oid INTO v_curr_db_oid
    FROM pg_catalog.pg_database
    WHERE datname = current_database();

    -- Guard 1: Refuse to modify or drop the role if it is a member of any other role
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members
      WHERE member = v_role_oid
    ) THEN
      RAISE EXCEPTION 'Refusing to roll back role admin_super_admin_lookup_owner: role is a member of another role'
        USING ERRCODE = '55006';
    END IF;

    -- Guard 2: Refuse to modify or drop the role if any role outside the documented
    -- Supabase migration/admin roles holds membership, or if any member holds active
    -- INHERIT/SET options (or non-admin membership) at rest on PG 16+.
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid = m.member
      WHERE m.roleid = v_role_oid
        AND r.rolname NOT IN (current_user, 'postgres', 'supabase_admin')
    ) THEN
      RAISE EXCEPTION 'Refusing to roll back role admin_super_admin_lookup_owner: unexpected role membership found'
        USING ERRCODE = '55006';
    END IF;

    IF current_setting('server_version_num')::int >= 160000 THEN
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members m
        WHERE m.roleid = v_role_oid
          AND (m.inherit_option OR m.set_option OR NOT m.admin_option)
      ) THEN
        RAISE EXCEPTION 'Refusing to roll back role admin_super_admin_lookup_owner: unexpected active INHERIT/SET membership option found'
          USING ERRCODE = '55006';
      END IF;
    END IF;

    -- Guard 3: Refuse to modify or drop the role if it owns any object other than public.current_user_is_super_admin()
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_shdepend sd
      WHERE sd.refclassid = 'pg_catalog.pg_authid'::regclass
        AND sd.refobjid = v_role_oid
        AND sd.deptype = 'o'
        AND NOT (
          v_fn_oid IS NOT NULL
          AND sd.dbid = v_curr_db_oid
          AND sd.classid = 'pg_catalog.pg_proc'::regclass
          AND sd.objid = v_fn_oid
        )
    ) THEN
      RAISE EXCEPTION 'Refusing to roll back role admin_super_admin_lookup_owner: role owns unexpected database objects'
        USING ERRCODE = '55006';
    END IF;

    -- Guard 4: Refuse to modify or drop the role if it has unexpected non-ownership dependencies
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_shdepend sd
      WHERE sd.refclassid = 'pg_catalog.pg_authid'::regclass
        AND sd.refobjid = v_role_oid
        AND sd.deptype <> 'o'
        AND NOT (
          sd.dbid = v_curr_db_oid
          AND (
            (
              sd.deptype = 'a'
              AND sd.classid = 'pg_catalog.pg_namespace'::regclass
              AND (
                (v_public_ns_oid IS NOT NULL AND sd.objid = v_public_ns_oid)
                OR (v_auth_ns_oid IS NOT NULL AND sd.objid = v_auth_ns_oid)
              )
            )
            OR (
              sd.deptype = 'a'
              AND sd.classid = 'pg_catalog.pg_class'::regclass
              AND v_user_roles_oid IS NOT NULL
              AND sd.objid = v_user_roles_oid
            )
            OR (
              sd.deptype = 'a'
              AND sd.classid = 'pg_catalog.pg_proc'::regclass
              AND (
                (v_auth_uid_oid IS NOT NULL AND sd.objid = v_auth_uid_oid)
                OR (v_fn_oid IS NOT NULL AND sd.objid = v_fn_oid)
              )
            )
            OR (
              sd.deptype = 'r'
              AND sd.classid = 'pg_catalog.pg_policy'::regclass
              AND v_user_roles_oid IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM pg_catalog.pg_policy pol
                WHERE pol.oid = sd.objid
                  AND pol.polrelid = v_user_roles_oid
                  AND pol.polname = 'p_user_roles_select_own_super_admin'
              )
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'Refusing to roll back role admin_super_admin_lookup_owner: role has unexpected object dependencies'
        USING ERRCODE = '55006';
    END IF;

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

  -- ==========================================================================
  -- 2. DROP SUPER_ADMIN AUTHORIZATION HELPER FUNCTION
  -- ==========================================================================

  IF v_fn_owner = 'admin_super_admin_lookup_owner' THEN
    BEGIN
      SET ROLE admin_super_admin_lookup_owner;
      DROP FUNCTION IF EXISTS public.current_user_is_super_admin();
    EXCEPTION
      WHEN OTHERS THEN
        IF v_prior_role IS NULL OR v_prior_role = 'none' OR v_prior_role = '' THEN
          RESET ROLE;
        ELSE
          EXECUTE format('SET ROLE %I', v_prior_role);
        END IF;
        RAISE;
    END;

    IF v_prior_role IS NULL OR v_prior_role = 'none' OR v_prior_role = '' THEN
      RESET ROLE;
    ELSE
      EXECUTE format('SET ROLE %I', v_prior_role);
    END IF;
  ELSIF v_fn_owner IS NOT NULL THEN
    DROP FUNCTION IF EXISTS public.current_user_is_super_admin();
  END IF;

  -- ==========================================================================
  -- 3. DROP RESTRICTED RLS POLICY ON PUBLIC.USER_ROLES
  -- ==========================================================================

  IF v_user_roles_oid IS NOT NULL THEN
    DROP POLICY IF EXISTS p_user_roles_select_own_super_admin ON public.user_roles;
  END IF;

  -- ==========================================================================
  -- 4. REVOKE PRIVILEGES & DROP DEDICATED OWNER ROLE
  -- ==========================================================================

  IF v_role_oid IS NOT NULL THEN
    IF v_user_roles_oid IS NOT NULL THEN
      REVOKE ALL ON TABLE public.user_roles FROM admin_super_admin_lookup_owner;
    END IF;
    IF v_auth_uid_oid IS NOT NULL THEN
      REVOKE ALL ON FUNCTION auth.uid() FROM admin_super_admin_lookup_owner;
    END IF;
    IF v_auth_ns_oid IS NOT NULL THEN
      REVOKE ALL ON SCHEMA auth FROM admin_super_admin_lookup_owner;
    END IF;
    IF v_public_ns_oid IS NOT NULL THEN
      REVOKE ALL ON SCHEMA public FROM admin_super_admin_lookup_owner;
    END IF;

    DROP ROLE IF EXISTS admin_super_admin_lookup_owner;
  END IF;
END
$rollback12$;
