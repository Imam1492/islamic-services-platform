/**
 * Local-only target and opt-in guard for PostgreSQL integration tests.
 * Keep this dependency free so direct tsx/Jest entry points validate before
 * constructing a pg Client or opening a socket.
 */
export const DEFAULT_LOCAL_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const APPROVED_LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
const UNSAFE_TARGET_MESSAGE =
  'Refusing database test connection: expected postgres user on local loopback port 54322, database postgres.';

export function resolveLocalDatabaseTestUrl(
  value: string | undefined = process.env.DATABASE_URL
): string {
  if (value !== undefined && value !== value.trim()) {
    throw new Error(UNSAFE_TARGET_MESSAGE);
  }
  const connectionUrl = value === undefined ? DEFAULT_LOCAL_DATABASE_URL : value;

  try {
    const parsed = new URL(connectionUrl);
    const valid =
      (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
      parsed.username === 'postgres' &&
      APPROVED_LOOPBACK_HOSTS.has(parsed.hostname) &&
      parsed.port === '54322' &&
      parsed.pathname === '/postgres' &&
      parsed.search === '' &&
      parsed.hash === '';

    if (valid) return connectionUrl;
  } catch {
    // Use one non-sensitive error for malformed and unsafe connection strings.
  }

  throw new Error(UNSAFE_TARGET_MESSAGE);
}

export function shouldRunDatabaseIntegrationTests(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  // CI always attempts the integration suite and fails if its local DB is down.
  // Local runs require an explicit opt-in so offline runs are reported as skips.
  return environment.CI === 'true' || environment.RUN_DATABASE_TESTS === 'true';
}
