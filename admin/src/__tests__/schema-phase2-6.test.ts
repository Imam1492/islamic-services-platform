import fs from 'fs';
import path from 'path';

describe('Phase 2.6 - Integration Test Suite & CI Hardening Specification', () => {
  const rootDir = path.resolve(__dirname, '../../..');
  const dbTestFile = path.join(rootDir, 'supabase/tests/database-security.test.ts');
  const ciWorkflowFile = path.join(rootDir, '.github/workflows/ci.yml');
  const packageJsonFile = path.join(rootDir, 'package.json');

  describe('1. Database Security Integration Test Suite Structure', () => {
    test('supabase/tests/database-security.test.ts exists', () => {
      expect(fs.existsSync(dbTestFile)).toBe(true);
    });

    const testContent = fs.existsSync(dbTestFile) ? fs.readFileSync(dbTestFile, 'utf-8') : '';

    test('covers all mandatory negative tests (NEG-01 through NEG-15)', () => {
      for (let i = 1; i <= 15; i++) {
        const negId = `NEG-${String(i).padStart(2, '0')}`;
        expect(testContent).toContain(negId);
      }
    });

    test('covers all positive control lifecycle tests (POS-01 through POS-07)', () => {
      for (let i = 1; i <= 7; i++) {
        const posId = `POS-${String(i).padStart(2, '0')}`;
        expect(testContent).toContain(posId);
      }
    });

    test('tests real database operations against Postgres / Supabase roles', () => {
      expect(testContent).toContain('SET ROLE authenticated');
      expect(testContent).toContain('request.jwt.claim.sub');
      expect(testContent).toContain('transition_service_request');
      expect(testContent).toContain('activate_request_chat');
      expect(testContent).toContain('request_contact_share');
      expect(testContent).toContain('respond_contact_share');
      expect(testContent).toContain('get_shared_contact_info');
      expect(testContent).toContain('assert_provider_covers_area');
    });

    test('verifies zero PII leakage and audit log immutability', () => {
      expect(testContent).toContain('user_private');
      expect(testContent).toContain('audit_logs');
      expect(testContent).toContain('Audit Log Immutability & Privacy');
    });

    test('enforces hard failure in CI environment when database is unavailable (SEC-26-01)', () => {
      expect(testContent).toContain("process.env.CI === 'true'");
      expect(testContent).toContain('Database connection required in CI environment; security tests cannot run.');
    });
  });

  describe('2. Package.json Script Integration', () => {
    test('package.json contains test:db script', () => {
      const pkg = JSON.parse(fs.readFileSync(packageJsonFile, 'utf-8'));
      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts['test:db']).toBeDefined();
      expect(pkg.scripts['test:db']).toContain('database-security.test.ts');
    });
  });

  describe('3. CI Pipeline Integration (.github/workflows/ci.yml)', () => {
    test('ci.yml includes database security integration job', () => {
      const ciContent = fs.readFileSync(ciWorkflowFile, 'utf-8');
      expect(ciContent).toContain('database-security');
      expect(ciContent).toContain('supabase-action');
      expect(ciContent).toContain('test:db');
    });
  });
});
