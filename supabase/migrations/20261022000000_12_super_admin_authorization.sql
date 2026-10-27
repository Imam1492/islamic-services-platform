-- Migration: 20261022000000_12_super_admin_authorization.sql
-- Description: Dedicated least-privilege super_admin authorization helper and RLS policy:
--   1. Verifies runner authority (role creation/administration, schema/table/function GRANT OPTION,
--      table ownership on public.user_roles, and pre-existing function ownership) before making changes.
--      Explicitly rejects unsupported cross-runner states where a non-rolsuper runner lacks
--      ADMIN OPTION on an existing admin_super_admin_lookup_owner role or lacks GRANT OPTION.
--   2. Creates dedicated NOLOGIN, least-privilege owner role (admin_super_admin_lookup_owner)
--      with NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, NOBYPASSRLS.
--      If the role already exists, verifies via pg_shdepend and pg_auth_members that it has
--      no unexpected owned objects, dependencies, or role memberships before reusing it.
--   3. Grants only minimum required privileges to admin_super_admin_lookup_owner:
--      - USAGE on schema public (plus temporary CREATE during function creation/ownership transfer)
--      - SELECT (user_id, role) on table public.user_roles
--      - USAGE on schema auth and EXECUTE on function auth.uid()
--   4. Creates restricted RLS policy on public.user_roles allowing admin_super_admin_lookup_owner
--      to read only the authenticated caller's own super_admin role row.
--   5. Grants temporary role membership (PG 16+ WITH INHERIT TRUE, SET TRUE; PG 15 standard grant),
--      switches via SET ROLE to admin_super_admin_lookup_owner inside an exception-safe subtransaction
--      block, creates/replaces public.current_user_is_super_admin() with narrowest search_path
--      (pg_catalog, pg_temp) and row_security = on, restricts EXECUTE exclusively to authenticated,
--      restores the prior role context, and revokes temporary CREATE, INHERIT, and SET privileges.

DO $migration12$
DECLARE
  v_role_oid oid;
  v_runner_oid oid;
  v_curr_db_oid oid;
  v_fn_oid oid;
  v_fn_owner name;
  v_auth_uid_oid oid;
  v_auth_uid_owner oid;
  v_user_roles_oid oid;
  v_user_roles_owner oid;
  v_public_ns_oid oid;
  v_public_ns_owner oid;
  v_auth_ns_oid oid;
  v_auth_ns_owner oid;
  v_unrevokable_grantor name;
  v_is_rolsuper boolean := false;
  v_has_createrole boolean := false;
  v_target_is_rolsuper boolean := false;
  v_prior_role text := current_setting('role', true);
  v_runner_user text := current_user;
  v_has_admin boolean := false;
BEGIN
  -- ==========================================================================
  -- 1. PRE-FLIGHT AUTHORITY & REPURPOSE SAFETY GUARDS
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

  IF v_user_roles_oid IS NULL OR v_auth_uid_oid IS NULL OR v_public_ns_oid IS NULL OR v_auth_ns_oid IS NULL THEN
    RAISE EXCEPTION 'Required prerequisite objects (schema public, schema auth, public.user_roles, or auth.uid()) do not exist'
      USING ERRCODE = '42P01';
  END IF;

  SELECT n.nspowner INTO v_public_ns_owner
  FROM pg_catalog.pg_namespace n
  WHERE n.oid = v_public_ns_oid;

  SELECT n.nspowner INTO v_auth_ns_owner
  FROM pg_catalog.pg_namespace n
  WHERE n.oid = v_auth_ns_oid;

  SELECT c.relowner INTO v_user_roles_owner
  FROM pg_catalog.pg_class c
  WHERE c.oid = v_user_roles_oid;

  SELECT p.proowner INTO v_auth_uid_owner
  FROM pg_catalog.pg_proc p
  WHERE p.oid = v_auth_uid_oid;

  -- Verify current_user owns public.user_roles (required for ALTER TABLE ... ENABLE RLS and CREATE/DROP POLICY)
  IF NOT pg_catalog.pg_has_role(current_user, v_user_roles_owner, 'USAGE') THEN
    RAISE EXCEPTION 'Cannot configure RLS policy on public.user_roles: current_user "%" lacks ownership privileges on public.user_roles',
      current_user
      USING ERRCODE = '42501';
  END IF;

  -- Verify current_user holds the base privileges on schema public, public.user_roles, schema auth, and auth.uid()
  IF NOT (
    pg_catalog.has_schema_privilege(current_user, v_public_ns_oid, 'USAGE')
    AND pg_catalog.has_schema_privilege(current_user, v_public_ns_oid, 'CREATE')
    AND pg_catalog.has_column_privilege(current_user, v_user_roles_oid, 'user_id', 'SELECT')
    AND pg_catalog.has_column_privilege(current_user, v_user_roles_oid, 'role', 'SELECT')
    AND pg_catalog.has_schema_privilege(current_user, v_auth_ns_oid, 'USAGE')
    AND pg_catalog.has_function_privilege(current_user, v_auth_uid_oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Cannot grant required runtime privileges to admin_super_admin_lookup_owner: current_user "%" lacks base privileges on schema public, public.user_roles, schema auth, or auth.uid()',
      current_user
      USING ERRCODE = '42501';
  END IF;

  -- Explicitly verify grant-option authority via object ownership or grantable ACL entries (is_grantable = true)
  -- for a role whose privileges current_user inherits (matching PostgreSQL select_best_grantor rules).
  IF NOT v_is_rolsuper THEN
    -- 1a. Grant-option authority for USAGE and CREATE on SCHEMA public
    IF NOT (
      pg_catalog.pg_has_role(current_user, v_public_ns_owner, 'USAGE')
      OR (
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace n
          CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) AS acl
          WHERE n.oid = v_public_ns_oid
            AND acl.privilege_type = 'USAGE'
            AND acl.is_grantable
            AND acl.grantee <> 0
            AND pg_catalog.pg_has_role(current_user, acl.grantee, 'USAGE')
        )
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace n
          CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) AS acl
          WHERE n.oid = v_public_ns_oid
            AND acl.privilege_type = 'CREATE'
            AND acl.is_grantable
            AND acl.grantee <> 0
            AND pg_catalog.pg_has_role(current_user, acl.grantee, 'USAGE')
        )
      )
    ) THEN
      RAISE EXCEPTION 'Cannot grant USAGE, CREATE on schema public: current_user "%" lacks grant-option authority on schema public',
        current_user
        USING ERRCODE = '42501';
    END IF;

    -- 1b. Grant-option authority for SELECT (user_id, role) on TABLE public.user_roles
    IF NOT (
      pg_catalog.pg_has_role(current_user, v_user_roles_owner, 'USAGE')
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class c
        CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
        WHERE c.oid = v_user_roles_oid
          AND acl.privilege_type = 'SELECT'
          AND acl.is_grantable
          AND acl.grantee <> 0
          AND pg_catalog.pg_has_role(current_user, acl.grantee, 'USAGE')
      )
      OR (
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute a
          CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
          WHERE a.attrelid = v_user_roles_oid
            AND a.attname = 'user_id'
            AND NOT a.attisdropped
            AND acl.privilege_type = 'SELECT'
            AND acl.is_grantable
            AND acl.grantee <> 0
            AND pg_catalog.pg_has_role(current_user, acl.grantee, 'USAGE')
        )
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute a
          CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
          WHERE a.attrelid = v_user_roles_oid
            AND a.attname = 'role'
            AND NOT a.attisdropped
            AND acl.privilege_type = 'SELECT'
            AND acl.is_grantable
            AND acl.grantee <> 0
            AND pg_catalog.pg_has_role(current_user, acl.grantee, 'USAGE')
        )
      )
    ) THEN
      RAISE EXCEPTION 'Cannot grant SELECT (user_id, role) on public.user_roles: current_user "%" lacks grant-option authority on public.user_roles',
        current_user
        USING ERRCODE = '42501';
    END IF;

    -- 1c. Grant-option authority for USAGE on SCHEMA auth
    IF NOT (
      pg_catalog.pg_has_role(current_user, v_auth_ns_owner, 'USAGE')
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace n
        CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) AS acl
        WHERE n.oid = v_auth_ns_oid
          AND acl.privilege_type = 'USAGE'
          AND acl.is_grantable
          AND acl.grantee <> 0
          AND pg_catalog.pg_has_role(current_user, acl.grantee, 'USAGE')
      )
    ) THEN
      RAISE EXCEPTION 'Cannot grant USAGE on schema auth: current_user "%" lacks grant-option authority on schema auth',
        current_user
        USING ERRCODE = '42501';
    END IF;

    -- 1d. Grant-option authority for EXECUTE on FUNCTION auth.uid()
    IF NOT (
      pg_catalog.pg_has_role(current_user, v_auth_uid_owner, 'USAGE')
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc p
        CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
        WHERE p.oid = v_auth_uid_oid
          AND acl.privilege_type = 'EXECUTE'
          AND acl.is_grantable
          AND acl.grantee <> 0
          AND pg_catalog.pg_has_role(current_user, acl.grantee, 'USAGE')
      )
    ) THEN
      RAISE EXCEPTION 'Cannot grant EXECUTE on function auth.uid(): current_user "%" lacks grant-option authority on auth.uid()',
        current_user
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Pre-flight check on pre-existing function ownership before making any changes:
  -- Refuse to proceed if public.current_user_is_super_admin() already exists and is owned
  -- by an unrelated role or a role for which current_user lacks ownership privileges.
  IF v_fn_oid IS NOT NULL THEN
    SELECT r.rolname INTO v_fn_owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_fn_oid;

    IF v_fn_owner <> 'admin_super_admin_lookup_owner' THEN
      IF v_fn_owner NOT IN (current_user, 'postgres', 'supabase_admin') THEN
        RAISE EXCEPTION 'Refusing to overwrite pre-existing function public.current_user_is_super_admin(): owned by unexpected role "%"',
          v_fn_owner
          USING ERRCODE = '55006';
      END IF;

      IF NOT pg_catalog.pg_has_role(current_user, v_fn_owner, 'USAGE') THEN
        RAISE EXCEPTION 'Cannot transfer ownership of pre-existing function public.current_user_is_super_admin() owned by "%": current_user "%" lacks USAGE/INHERIT privilege on owner role',
          v_fn_owner, current_user
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT oid, rolsuper INTO v_role_oid, v_target_is_rolsuper
  FROM pg_catalog.pg_roles
  WHERE rolname = 'admin_super_admin_lookup_owner';

  IF v_role_oid IS NULL THEN
    IF NOT (v_is_rolsuper OR v_has_createrole) THEN
      RAISE EXCEPTION 'Cannot create role admin_super_admin_lookup_owner: current_user "%" lacks CREATEROLE privilege',
        current_user
        USING ERRCODE = '42501';
    END IF;

    CREATE ROLE admin_super_admin_lookup_owner
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;

    SELECT oid INTO v_role_oid
    FROM pg_catalog.pg_roles
    WHERE rolname = 'admin_super_admin_lookup_owner';
  ELSE
    -- Refuse to repurpose a role that has rolsuper enabled
    IF v_target_is_rolsuper THEN
      RAISE EXCEPTION 'Refusing to repurpose existing role admin_super_admin_lookup_owner: role has rolsuper attribute'
        USING ERRCODE = '55006';
    END IF;

    -- Verify runner has authority to ALTER ROLE, GRANT/REVOKE membership, and clean up existing ACLs.
    -- On PostgreSQL 16+, a non-rolsuper CREATEROLE runner must directly hold ADMIN OPTION on the role.
    IF NOT v_is_rolsuper THEN
      IF NOT v_has_createrole THEN
        RAISE EXCEPTION 'Cannot administer existing role admin_super_admin_lookup_owner: current_user "%" lacks CREATEROLE privilege',
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
        RAISE EXCEPTION 'Unsupported cross-runner state on PostgreSQL 16+: current_user "%" lacks direct ADMIN OPTION on existing role admin_super_admin_lookup_owner',
          current_user
          USING ERRCODE = '42501';
      END IF;

      -- Verify current_user can revoke any pre-existing ACL entries on schema public and public.user_roles
      -- granted to admin_super_admin_lookup_owner (so baseline REVOKE ALL and Step 5 REVOKE CREATE succeed).
      SELECT gr.rolname INTO v_unrevokable_grantor
      FROM (
        SELECT acl.grantor, acl.grantee
        FROM pg_catalog.pg_namespace n
        CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) AS acl
        WHERE n.oid = v_public_ns_oid
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
      ) acl_entries
      JOIN pg_catalog.pg_roles gr ON gr.oid = acl_entries.grantor
      WHERE acl_entries.grantee = v_role_oid
        AND NOT pg_catalog.pg_has_role(current_user, acl_entries.grantor, 'USAGE')
      LIMIT 1;

      IF v_unrevokable_grantor IS NOT NULL THEN
        RAISE EXCEPTION 'Unsupported cross-runner state: existing privileges for admin_super_admin_lookup_owner on schema public or public.user_roles were granted by "%", and current_user "%" lacks authority to revoke them',
          v_unrevokable_grantor, current_user
          USING ERRCODE = '42501';
      END IF;
    END IF;

    SELECT oid INTO v_curr_db_oid
    FROM pg_catalog.pg_database
    WHERE datname = current_database();

    -- Guard 1: Role must not be a member of any other role
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members
      WHERE member = v_role_oid
    ) THEN
      RAISE EXCEPTION 'Refusing to repurpose existing role admin_super_admin_lookup_owner: role is a member of another role'
        USING ERRCODE = '55006';
    END IF;

    -- Guard 2: Only documented migration/admin roles may hold membership in this role,
    -- and no member may hold active INHERIT/SET options (or non-admin membership) at rest on PG 16+.
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid = m.member
      WHERE m.roleid = v_role_oid
        AND r.rolname NOT IN (current_user, 'postgres', 'supabase_admin')
    ) THEN
      RAISE EXCEPTION 'Refusing to repurpose existing role admin_super_admin_lookup_owner: unexpected role membership found'
        USING ERRCODE = '55006';
    END IF;

    IF current_setting('server_version_num')::int >= 160000 THEN
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members m
        WHERE m.roleid = v_role_oid
          AND (m.inherit_option OR m.set_option OR NOT m.admin_option)
      ) THEN
        RAISE EXCEPTION 'Refusing to repurpose existing role admin_super_admin_lookup_owner: unexpected active INHERIT/SET membership option found'
          USING ERRCODE = '55006';
      END IF;
    END IF;

    -- Guard 3: Role must not own any object other than public.current_user_is_super_admin()
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
      RAISE EXCEPTION 'Refusing to repurpose existing role admin_super_admin_lookup_owner: role owns unexpected database objects'
        USING ERRCODE = '55006';
    END IF;

    -- Guard 4: Role must not have unexpected non-ownership dependencies (policies, ACLs, etc.)
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
              AND (sd.objid = v_public_ns_oid OR sd.objid = v_auth_ns_oid)
            )
            OR (
              sd.deptype = 'a'
              AND sd.classid = 'pg_catalog.pg_class'::regclass
              AND sd.objid = v_user_roles_oid
            )
            OR (
              sd.deptype = 'a'
              AND sd.classid = 'pg_catalog.pg_proc'::regclass
              AND (
                sd.objid = v_auth_uid_oid
                OR (v_fn_oid IS NOT NULL AND sd.objid = v_fn_oid)
              )
            )
            OR (
              sd.deptype = 'r'
              AND sd.classid = 'pg_catalog.pg_policy'::regclass
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
      RAISE EXCEPTION 'Refusing to repurpose existing role admin_super_admin_lookup_owner: role has unexpected object dependencies'
        USING ERRCODE = '55006';
    END IF;

    ALTER ROLE admin_super_admin_lookup_owner
      WITH NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;

  -- Ensure clean baseline privileges for the dedicated owner role.
  -- Temporary CREATE on schema public is required by PostgreSQL for function creation /
  -- ownership transfer and is revoked in Step 5 after restoring the migration runner role.
  REVOKE ALL ON TABLE public.user_roles FROM admin_super_admin_lookup_owner;
  REVOKE ALL ON SCHEMA public FROM admin_super_admin_lookup_owner;

  GRANT USAGE, CREATE ON SCHEMA public TO admin_super_admin_lookup_owner;
  GRANT SELECT (user_id, role) ON TABLE public.user_roles TO admin_super_admin_lookup_owner;

  -- Explicit minimum auth schema and auth.uid() permissions required at runtime
  -- by the NOINHERIT owner role when executing current_user_is_super_admin() and
  -- evaluating p_user_roles_select_own_super_admin.
  GRANT USAGE ON SCHEMA auth TO admin_super_admin_lookup_owner;
  GRANT EXECUTE ON FUNCTION auth.uid() TO admin_super_admin_lookup_owner;

  -- ==========================================================================
  -- 2. RESTRICTED RLS POLICY ON PUBLIC.USER_ROLES
  -- ==========================================================================

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

  -- ==========================================================================
  -- 3. VERSION-AWARE TEMPORARY MEMBERSHIP & PRE-EXISTING OWNERSHIP TRANSFER
  -- ==========================================================================

  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format(
      'GRANT admin_super_admin_lookup_owner TO %I WITH INHERIT TRUE, SET TRUE',
      v_runner_user
    );
  ELSE
    EXECUTE format(
      'GRANT admin_super_admin_lookup_owner TO %I',
      v_runner_user
    );
  END IF;

  IF v_fn_oid IS NOT NULL AND v_fn_owner IS NOT NULL AND v_fn_owner <> 'admin_super_admin_lookup_owner' THEN
    EXECUTE format(
      'ALTER FUNCTION public.current_user_is_super_admin() OWNER TO %I',
      'admin_super_admin_lookup_owner'
    );
  END IF;

  -- ==========================================================================
  -- 4. HARDENED SUPER_ADMIN AUTHORIZATION HELPER FUNCTION & ACLS
  -- ==========================================================================

  BEGIN
    SET ROLE admin_super_admin_lookup_owner;

    -- All non-system references (auth.uid(), public.user_roles, public.app_role) are
    -- explicitly schema-qualified, allowing the narrowest search_path: pg_catalog, pg_temp.
    CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
    RETURNS boolean
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
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

    ALTER FUNCTION public.current_user_is_super_admin() OWNER TO admin_super_admin_lookup_owner;

    REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM anon;
    REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM service_role;
    GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO authenticated;
  EXCEPTION
    WHEN OTHERS THEN
      IF v_prior_role IS NULL OR v_prior_role = 'none' OR v_prior_role = '' THEN
        RESET ROLE;
      ELSE
        EXECUTE format('SET ROLE %I', v_prior_role);
      END IF;
      RAISE;
  END;

  -- ==========================================================================
  -- 5. RESTORE PRIOR ROLE CONTEXT & CLEAN UP TEMPORARY PRIVILEGES
  -- ==========================================================================

  IF v_prior_role IS NULL OR v_prior_role = 'none' OR v_prior_role = '' THEN
    RESET ROLE;
  ELSE
    EXECUTE format('SET ROLE %I', v_prior_role);
  END IF;

  -- Revoke temporary CREATE privilege on schema public from the owner role
  REVOKE CREATE ON SCHEMA public FROM admin_super_admin_lookup_owner;

  -- Clean up temporary INHERIT and SET membership granted in Step 3:
  -- On PostgreSQL 16+, pg_auth_members is keyed by (roleid, member, grantor).
  -- If the membership row granted by v_runner_oid itself holds admin_option = true,
  -- revoke only INHERIT OPTION and SET OPTION on that row; otherwise revoke the
  -- temporary self-granted membership row completely (preserving any separate
  -- grantor = 10 ADMIN OPTION row created by CREATE ROLE).
  IF current_setting('server_version_num')::int >= 160000 THEN
    SELECT COALESCE(BOOL_OR(m.admin_option), false) INTO v_has_admin
    FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = v_role_oid
      AND m.member = v_runner_oid
      AND m.grantor = v_runner_oid;

    IF v_has_admin THEN
      EXECUTE format(
        'REVOKE INHERIT OPTION FOR admin_super_admin_lookup_owner FROM %I',
        v_runner_user
      );
      EXECUTE format(
        'REVOKE SET OPTION FOR admin_super_admin_lookup_owner FROM %I',
        v_runner_user
      );
    ELSE
      EXECUTE format(
        'REVOKE admin_super_admin_lookup_owner FROM %I',
        v_runner_user
      );
    END IF;
  ELSE
    EXECUTE format(
      'REVOKE admin_super_admin_lookup_owner FROM %I',
      v_runner_user
    );
  END IF;
END
$migration12$;
