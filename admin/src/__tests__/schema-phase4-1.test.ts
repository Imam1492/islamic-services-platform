import * as fs from 'fs';
import * as path from 'path';

describe('Migration 12: Super Admin Authorization & Role Membership Static Audit', () => {
  const migrationsDir = path.resolve(__dirname, '../../../supabase/migrations');
  const rollbackDir = path.resolve(__dirname, '../../../supabase/rollback');
  const dbTestsDir = path.resolve(__dirname, '../../../supabase/tests');

  const migration12Path = path.join(
    migrationsDir,
    '20261022000000_12_super_admin_authorization.sql'
  );
  const rollback12Path = path.join(
    rollbackDir,
    '20261022000000_12_super_admin_authorization_down.sql'
  );
  const dbSecurityTestPath = path.join(dbTestsDir, 'database-security.test.ts');

  test('Migration 12 and Rollback 12 exist and are non-empty', () => {
    expect(fs.existsSync(migration12Path)).toBe(true);
    expect(fs.existsSync(rollback12Path)).toBe(true);
    expect(fs.statSync(migration12Path).size).toBeGreaterThan(500);
    expect(fs.statSync(rollback12Path).size).toBeGreaterThan(200);
  });

  test('Migration 12 preserves dedicated NOLOGIN least-privilege owner role contract, repurpose guards, and explicit auth grants', () => {
    const sql = fs.readFileSync(migration12Path, 'utf8');

    expect(sql).toContain('CREATE ROLE admin_super_admin_lookup_owner');
    expect(sql).toContain('NOLOGIN');
    expect(sql).toContain('NOSUPERUSER');
    expect(sql).toContain('NOCREATEDB');
    expect(sql).toContain('NOCREATEROLE');
    expect(sql).toContain('NOINHERIT');
    expect(sql).toContain('NOREPLICATION');
    expect(sql).toContain('NOBYPASSRLS');

    // Repurpose safety guards, catalog/ACL grant-option checks, and direct runner ADMIN OPTION check
    expect(sql).toContain('pg_catalog.pg_shdepend');
    expect(sql).toContain('pg_catalog.pg_auth_members');
    expect(sql).toContain('pg_catalog.aclexplode');
    expect(sql).toContain('acl.is_grantable');
    expect(sql).toContain('AND m.member = v_runner_oid');
    expect(sql).toContain('AND m.admin_option');
    expect(sql).not.toMatch(/WITH\s+GRANT\s+OPTION/i);
    expect(sql).toContain('Refusing to repurpose existing role admin_super_admin_lookup_owner');

    // Explicit minimum permissions on public and auth schemas
    expect(sql).toContain('GRANT USAGE, CREATE ON SCHEMA public TO admin_super_admin_lookup_owner;');
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM admin_super_admin_lookup_owner;');
    expect(sql).toContain(
      'GRANT SELECT (user_id, role) ON TABLE public.user_roles TO admin_super_admin_lookup_owner;'
    );
    expect(sql).toContain('GRANT USAGE ON SCHEMA auth TO admin_super_admin_lookup_owner;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION auth.uid() TO admin_super_admin_lookup_owner;');
  });

  test('Migration 12 defines hardened zero-argument current_user_is_super_admin() with narrowest search_path and restricted user_roles policy', () => {
    const sql = fs.readFileSync(migration12Path, 'utf8');

    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.current_user_is_super_admin\(\s*\)/);
    expect(sql).toContain('RETURNS boolean');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, pg_temp');
    expect(sql).not.toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(sql).toContain('SET row_security = on');
    expect(sql).toContain('auth.uid()');

    expect(sql).toContain('CREATE POLICY p_user_roles_select_own_super_admin');
    expect(sql).toContain('ON public.user_roles');
    expect(sql).toContain('FOR SELECT');
    expect(sql).toContain('TO admin_super_admin_lookup_owner');
    expect(sql).toContain('user_id = auth.uid()');
    expect(sql).toContain("role = 'super_admin'::public.app_role");

    expect(sql).toContain('REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM anon;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM service_role;');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO authenticated;'
    );

    expect(sql).not.toMatch(/\bSUPERUSER\b/i);
    expect(sql).not.toMatch(/\bBYPASSRLS\b/i);
    expect(sql).not.toMatch(/\bCASCADE\b/i);
  });

  test('Migration 12 grants PG 16+ version-aware INHERIT/SET membership and switches role before function creation, then restores role and cleans up', () => {
    const sql = fs.readFileSync(migration12Path, 'utf8');

    expect(sql).toContain("current_setting('server_version_num')::int >= 160000");
    const grantIdx = sql.indexOf(
      'GRANT admin_super_admin_lookup_owner TO %I WITH INHERIT TRUE, SET TRUE'
    );
    const setRoleIdx = sql.indexOf('SET ROLE admin_super_admin_lookup_owner;');
    const createFnIdx = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()'
    );
    const alterOwnerIdx = sql.indexOf(
      'ALTER FUNCTION public.current_user_is_super_admin() OWNER TO admin_super_admin_lookup_owner;'
    );
    const resetRoleIdx = sql.indexOf('RESET ROLE;');
    const revokeCreateIdx = sql.indexOf(
      'REVOKE CREATE ON SCHEMA public FROM admin_super_admin_lookup_owner;'
    );

    expect(grantIdx).toBeGreaterThan(-1);
    expect(setRoleIdx).toBeGreaterThan(grantIdx);
    expect(createFnIdx).toBeGreaterThan(setRoleIdx);
    expect(alterOwnerIdx).toBeGreaterThan(createFnIdx);
    expect(resetRoleIdx).toBeGreaterThan(alterOwnerIdx);
    expect(revokeCreateIdx).toBeGreaterThan(resetRoleIdx);
    expect(sql).toContain('WHEN OTHERS THEN');
    expect(sql).not.toContain('set_config');

    expect(sql).toContain(
      'REVOKE INHERIT OPTION FOR admin_super_admin_lookup_owner FROM %I'
    );
    expect(sql).toContain(
      'REVOKE SET OPTION FOR admin_super_admin_lookup_owner FROM %I'
    );
    expect(sql).toContain('REVOKE admin_super_admin_lookup_owner FROM %I');
  });

  test('Rollback 12 verifies role membership and dependency scope, grants membership before dropping function, revokes auth/public grants, and avoids CASCADE', () => {
    const sql = fs.readFileSync(rollback12Path, 'utf8');

    expect(sql).toContain('pg_catalog.pg_auth_members');
    expect(sql).toContain(
      'Refusing to roll back role admin_super_admin_lookup_owner: role is a member of another role'
    );
    expect(sql).toContain(
      'Refusing to roll back role admin_super_admin_lookup_owner: unexpected role membership found'
    );
    expect(sql).toContain('pg_catalog.pg_shdepend');
    expect(sql).toContain(
      'Refusing to roll back role admin_super_admin_lookup_owner: role owns unexpected database objects'
    );
    expect(sql).toContain(
      'Refusing to roll back role admin_super_admin_lookup_owner: role has unexpected object dependencies'
    );
    expect(sql).toContain("current_setting('server_version_num')::int >= 160000");
    expect(sql).toContain(
      'GRANT admin_super_admin_lookup_owner TO %I WITH INHERIT TRUE, SET TRUE'
    );
    expect(sql).toContain('SET ROLE admin_super_admin_lookup_owner;');
    expect(sql).toContain('WHEN OTHERS THEN');
    expect(sql).toContain('RESET ROLE;');
    expect(sql).not.toContain('set_config');
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.current_user_is_super_admin();');
    expect(sql).toContain(
      'DROP POLICY IF EXISTS p_user_roles_select_own_super_admin ON public.user_roles;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.user_roles FROM admin_super_admin_lookup_owner;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION auth.uid() FROM admin_super_admin_lookup_owner;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON SCHEMA auth FROM admin_super_admin_lookup_owner;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON SCHEMA public FROM admin_super_admin_lookup_owner;'
    );
    expect(sql).toContain('DROP ROLE IF EXISTS admin_super_admin_lookup_owner;');
    expect(sql).not.toMatch(/\bCASCADE\b/i);
  });

  test('database-security.test.ts enforces strict policy assertions and fails M12-LIVE checks when DB is disconnected', () => {
    const testSrc = fs.readFileSync(dbSecurityTestPath, 'utf8');

    expect(testSrc).toContain("expect(userRolesPolicies.length).toBe(1);");
    expect(testSrc).not.toContain('expect(userRolesPolicies.length).toBeLessThanOrEqual(1);');
    expect(testSrc).toContain("expect(userRolesPolicies[0].policyname).toBe('p_user_roles_select_own_super_admin');");
    expect(testSrc).toContain("expect(userRolesPolicies[0].roles).toEqual(['admin_super_admin_lookup_owner']);");
    expect(testSrc).toContain("expect(userRolesPolicies[0].cmd).toBe('SELECT');");
    expect(testSrc).toContain(
      'Database connection required: M12-LIVE-01 cannot pass when PostgreSQL is unavailable.'
    );
    expect(testSrc).toContain(
      'Database connection required: M12-LIVE-02 cannot pass when PostgreSQL is unavailable.'
    );
    expect(testSrc).not.toContain('M12-STATIC-01');
  });

  test('migration12-integration.test.ts and CI workflow configure isolated PG 15, 16, and 17 integration tests that never pass when skipped', () => {
    const m12IntegrationPath = path.join(dbTestsDir, 'migration12-integration.test.ts');
    const ciWorkflowPath = path.resolve(__dirname, '../../../.github/workflows/ci.yml');

    expect(fs.existsSync(m12IntegrationPath)).toBe(true);
    expect(fs.existsSync(ciWorkflowPath)).toBe(true);

    const integrationSrc = fs.readFileSync(m12IntegrationPath, 'utf8');
    const ciSrc = fs.readFileSync(ciWorkflowPath, 'utf8');

    // Applies 01-11 then 12, tests reapplication, rollback, RLS, permissions, cross-runner rejection, and atomicity
    expect(integrationSrc).toContain('20260915212448_01_core_and_locations.sql');
    expect(integrationSrc).toContain('20261018000000_11_contact_share_security_hardening.sql');
    expect(integrationSrc).toContain('20261022000000_12_super_admin_authorization.sql');
    expect(integrationSrc).toContain('20261022000000_12_super_admin_authorization_down.sql');
    expect(integrationSrc).toContain('M12-INT-01');
    expect(integrationSrc).toContain('M12-INT-06');
    expect(integrationSrc).toContain('M12-INT-08');
    expect(integrationSrc).toContain(
      'Integration tests must not be skipped or reported as passing when PostgreSQL is unavailable.'
    );

    // CI workflow tests PostgreSQL 15, 16, and 17 in isolated service containers
    expect(ciSrc).toContain("pg_version: ['15', '16', '17']");
    expect(ciSrc).toContain('npm run test:m12:integration');
  });
});
