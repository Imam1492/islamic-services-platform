import fs from 'node:fs';
import path from 'node:path';

describe('Migration 12 super-admin RPC security', () => {
  const root = path.resolve(__dirname, '../../..');
  const migration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20261022000000_12_super_admin_authorization.sql'),
    'utf8'
  );
  const rollback = fs.readFileSync(
    path.join(root, 'supabase/rollback/20261022000000_12_super_admin_authorization_down.sql'),
    'utf8'
  );

  it('defines a no-argument boolean RPC tied to auth.uid and super_admin only', () => {
    expect(migration).toMatch(/FUNCTION\s+public\.current_user_is_super_admin\s*\(\)\s*RETURNS\s+boolean/i);
    expect(migration).toContain('ur.user_id = auth.uid()');
    expect(migration).toContain("ur.role = 'super_admin'::public.app_role");
    expect(migration).not.toMatch(/current_user_is_super_admin\s*\([^)]*uuid/i);
    expect(migration).not.toMatch(/raw_user_meta_data|raw_app_meta_data|user_metadata|app_metadata/i);
    expect(migration).not.toMatch(/EXECUTE\s+format|\bEXECUTE\s+['"`]/i);
  });

  it('uses a non-login, non-bypass owner and keeps user_roles closed to authenticated SELECT', () => {
    expect(migration).toMatch(/CREATE ROLE admin_super_admin_lookup_owner\s+NOLOGIN[^;]*NOBYPASSRLS/i);
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(migration).not.toMatch(/SET search_path\s*=\s*[^\n]*\bpublic\b/i);
    expect(migration).toContain('SET row_security = on');
    expect(migration).toContain('OWNER TO admin_super_admin_lookup_owner');
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.current_user_is_super_admin\(\) FROM PUBLIC, anon/i);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.current_user_is_super_admin\(\) TO authenticated/i);
    expect(migration).not.toMatch(/GRANT\s+SELECT[^;]*public\.user_roles[^;]*TO\s+authenticated/i);
  });

  it('rolls back only objects and privileges introduced by this migration', () => {
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.current_user_is_super_admin()');
    expect(rollback).toContain('DROP POLICY IF EXISTS p_user_roles_super_admin_lookup ON public.user_roles');
    expect(rollback).toContain('DROP ROLE IF EXISTS admin_super_admin_lookup_owner');
    expect(rollback).not.toMatch(/\b(DROP TABLE|DELETE FROM|TRUNCATE)\b/i);
  });
});
