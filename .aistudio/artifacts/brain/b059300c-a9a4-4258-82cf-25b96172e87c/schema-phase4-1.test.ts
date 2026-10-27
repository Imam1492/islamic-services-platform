import * as fs from 'fs';
import * as path from 'path';

describe('Migration 12: Super Admin Authorization & Role Membership Static Audit', () => {
  const migrationsDir = path.resolve(__dirname, '../../../supabase/migrations');
  const rollbackDir = path.resolve(__dirname, '../../../supabase/rollback');

  const migration12Path = path.join(
    migrationsDir,
    '20261022000000_12_super_admin_authorization.sql'
  );
  const rollback12Path = path.join(
    rollbackDir,
    '20261022000000_12_super_admin_authorization_down.sql'
  );

  test('Migration 12 and Rollback 12 exist and are non-empty', () => {
    expect(fs.existsSync(migration12Path)).toBe(true);
    expect(fs.existsSync(rollback12Path)).toBe(true);
    expect(fs.statSync(migration12Path).size).toBeGreaterThan(500);
    expect(fs.statSync(rollback12Path).size).toBeGreaterThan(200);
  });

  test('Migration 12 preserves dedicated NOLOGIN least-privilege owner role contract', () => {
    const sql = fs.readFileSync(migration12Path, 'utf8');

    expect(sql).toContain('CREATE ROLE admin_super_admin_lookup_owner');
    expect(sql).toContain('NOLOGIN');
    expect(sql).toContain('NOSUPERUSER');
    expect(sql).toContain('NOCREATEDB');
    expect(sql).toContain('NOCREATEROLE');
    expect(sql).toContain('NOINHERIT');
    expect(sql).toContain('NOREPLICATION');
    expect(sql).toContain('NOBYPASSRLS');

    expect(sql).toContain('GRANT USAGE, CREATE ON SCHEMA public TO admin_super_admin_lookup_owner;');
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM admin_super_admin_lookup_owner;');
    expect(sql).toContain(
      'GRANT SELECT (user_id, role) ON TABLE public.user_roles TO admin_super_admin_lookup_owner;'
    );
  });

  test('Migration 12 defines hardened zero-argument current_user_is_super_admin() and restricted user_roles policy', () => {
    const sql = fs.readFileSync(migration12Path, 'utf8');

    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.current_user_is_super_admin\(\s*\)/);
    expect(sql).toContain('RETURNS boolean');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(sql).toContain('SET row_security = on');
    expect(sql).toContain('auth.uid()');

    expect(sql).toContain('CREATE POLICY p_user_roles_select_own_super_admin');
    expect(sql).toContain('ON public.user_roles');
    expect(sql).toContain('TO admin_super_admin_lookup_owner');
    expect(sql).toContain('user_id = auth.uid()');
    expect(sql).toContain("role = 'super_admin'::public.app_role");

    expect(sql).toContain('REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM anon;');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO authenticated;'
    );

    expect(sql).not.toMatch(/\bSUPERUSER\b/i);
    expect(sql).not.toMatch(/\bBYPASSRLS\b/i);
    expect(sql).not.toMatch(/\bCASCADE\b/i);
  });

  test('Migration 12 uses PG 16+ version-aware INHERIT/SET membership grant and cleanup', () => {
    const sql = fs.readFileSync(migration12Path, 'utf8');

    expect(sql).toContain("current_setting('server_version_num')::int >= 160000");
    expect(sql).toContain(
      "GRANT admin_super_admin_lookup_owner TO %I WITH INHERIT TRUE, SET TRUE"
    );
    expect(sql).toContain("GRANT admin_super_admin_lookup_owner TO %I");
    expect(sql).toContain(
      'ALTER FUNCTION public.current_user_is_super_admin() OWNER TO admin_super_admin_lookup_owner;'
    );
    expect(sql).toContain(
      'REVOKE INHERIT OPTION FOR admin_super_admin_lookup_owner FROM %I'
    );
    expect(sql).toContain(
      'REVOKE SET OPTION FOR admin_super_admin_lookup_owner FROM %I'
    );
    expect(sql).toContain('REVOKE admin_super_admin_lookup_owner FROM %I');
  });

  test('Rollback 12 safely grants membership before dropping function and role without CASCADE', () => {
    const sql = fs.readFileSync(rollback12Path, 'utf8');

    expect(sql).toContain("current_setting('server_version_num')::int >= 160000");
    expect(sql).toContain(
      "GRANT admin_super_admin_lookup_owner TO %I WITH INHERIT TRUE, SET TRUE"
    );
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.current_user_is_super_admin();');
    expect(sql).toContain(
      'DROP POLICY IF EXISTS p_user_roles_select_own_super_admin ON public.user_roles;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.user_roles FROM admin_super_admin_lookup_owner;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON SCHEMA public FROM admin_super_admin_lookup_owner;'
    );
    expect(sql).toContain('DROP ROLE IF EXISTS admin_super_admin_lookup_owner;');
    expect(sql).not.toMatch(/\bCASCADE\b/i);
  });
});
