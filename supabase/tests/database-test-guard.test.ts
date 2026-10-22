import {
  DEFAULT_LOCAL_DATABASE_URL,
  resolveLocalDatabaseTestUrl,
  shouldRunDatabaseIntegrationTests,
} from './database-test-guard';

describe('database test target guard', () => {
  test('uses the repository documented local default', () => {
    expect(resolveLocalDatabaseTestUrl(undefined)).toBe(DEFAULT_LOCAL_DATABASE_URL);
  });

  test.each([
    ['IPv4 loopback', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'],
    ['IPv6 loopback', 'postgres://postgres:local-pass@[::1]:54322/postgres'],
  ])('accepts approved %s target', (_label, url) => {
    expect(resolveLocalDatabaseTestUrl(url)).toBe(url);
  });

  test.each([
    ['hosted Supabase hostname', 'postgresql://postgres:secret@db.example.supabase.co:54322/postgres'],
    ['remote IP', 'postgresql://postgres:secret@203.0.113.8:54322/postgres'],
    ['hostname alias', 'postgresql://postgres:secret@localhost:54322/postgres'],
    ['unexpected port', 'postgresql://postgres:secret@127.0.0.1:5432/postgres'],
    ['unexpected database', 'postgresql://postgres:secret@127.0.0.1:54322/other'],
    ['unexpected role', 'postgresql://other:secret@127.0.0.1:54322/postgres'],
    ['connection options', 'postgresql://postgres:secret@127.0.0.1:54322/postgres?sslmode=require'],
    ['keyword DSN', 'host=127.0.0.1 port=54322 dbname=postgres user=postgres'],
    ['malformed URL', 'not a connection URL'],
    ['empty configured target', '   '],
  ])('rejects %s without echoing target credentials', (_label, url) => {
    try {
      resolveLocalDatabaseTestUrl(url);
      throw new Error('Expected the target guard to reject the URL');
    } catch (error) {
      expect((error as Error).message).toMatch(/Refusing database test connection/);
      expect((error as Error).message).not.toContain('secret');
      expect((error as Error).message).not.toContain(url);
    }
  });
});

describe('database integration test runner mode', () => {
  test('skips by default outside CI', () => {
    expect(shouldRunDatabaseIntegrationTests({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('allows explicit local opt-in', () => {
    expect(shouldRunDatabaseIntegrationTests({ RUN_DATABASE_TESTS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  test('requires integration tests in CI regardless of local opt-in', () => {
    expect(shouldRunDatabaseIntegrationTests({ CI: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
