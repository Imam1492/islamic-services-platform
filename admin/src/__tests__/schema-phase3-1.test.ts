import fs from 'fs';
import path from 'path';

describe('Phase 3.1: F-02 Authoritative Identity & Phone Synchronization Schema Audit', () => {
  const migrationsDir = path.resolve(__dirname, '../../../supabase/migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).sort();

  const phase31MigrationFile = migrationFiles.find((f) =>
    f.includes('05_auth_identity_and_phone_sync')
  );

  test('Migration 05 exists and is non-empty', () => {
    expect(phase31MigrationFile).toBeDefined();
    const filePath = path.join(migrationsDir, phase31MigrationFile!);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content.length).toBeGreaterThan(100);
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);
  });

  test('Exactly 7 canonical migrations exist in sequence (01, 02, 03, 04, 05, 06, 07)', () => {
    const sqlFiles = migrationFiles.filter((f) => f.endsWith('.sql'));
    expect(sqlFiles.length).toBe(7);
    expect(sqlFiles[0]).toContain('01_core_and_locations');
    expect(sqlFiles[1]).toContain('02_providers_and_verification');
    expect(sqlFiles[2]).toContain('03_requests_chat_and_audit');
    expect(sqlFiles[3]).toContain('04_request_state_machine_and_security');
    expect(sqlFiles[4]).toContain('05_auth_identity_and_phone_sync');
    expect(sqlFiles[5]).toContain('06_least_privilege_chat_and_provider_access');
    expect(sqlFiles[6]).toContain('07_user_onboarding_and_consent');

    // Confirm no 0-byte migrations
    for (const f of sqlFiles) {
      const stat = fs.statSync(path.join(migrationsDir, f));
      expect(stat.size).toBeGreaterThan(0);
    }
  });

  test('Migration 05 defines handle_new_auth_user with hardened SECURITY DEFINER and search_path', () => {
    const filePath = path.join(migrationsDir, phase31MigrationFile!);
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.handle_new_auth_user()');
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM anon, authenticated;');
  });

  test('Migration 05 attaches triggers to auth.users for both INSERT and UPDATE lifecycle events', () => {
    const filePath = path.join(migrationsDir, phase31MigrationFile!);
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE TRIGGER on_auth_user_created');
    expect(content).toContain('AFTER INSERT ON auth.users');
    expect(content).toContain('CREATE TRIGGER on_auth_user_updated');
    expect(content).toContain('AFTER UPDATE OF phone, raw_user_meta_data ON auth.users');
    expect(content).toContain('WHEN (OLD.phone IS DISTINCT FROM NEW.phone OR OLD.raw_user_meta_data IS DISTINCT FROM NEW.raw_user_meta_data)');
  });

  test('Migration 05 protects user_private.phone_e164 from client spoofing', () => {
    const filePath = path.join(migrationsDir, phase31MigrationFile!);
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('protect_user_private_phone()');
    expect(content).toContain('REVOKE INSERT (phone_e164), UPDATE (phone_e164) ON TABLE public.user_private FROM anon, authenticated, PUBLIC;');
    expect(content).toContain('CREATE TRIGGER trg_protect_user_private_phone');
    expect(content).toContain('BEFORE INSERT OR UPDATE ON public.user_private');
  });

  test('Migration 05 preserves safe E.164 format check and NULL handling', () => {
    const filePath = path.join(migrationsDir, phase31MigrationFile!);
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('^\\+[1-9]\\d{1,14}$');
    expect(content).toContain('NULLIF(TRIM(NEW.phone), \'\')');
  });
});
