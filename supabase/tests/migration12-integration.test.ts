/**
 * Migration 12 Reproducible PostgreSQL 15 / 16 / 17 Integration Test Suite
 *
 * Requirements verified against isolated, disposable PostgreSQL databases:
 * 1. Compatible with PostgreSQL 15, 16, and 17 in isolated disposable databases.
 * 2. Applies migrations 01–11 in chronological order, then applies Migration 12.
 * 3. Verifies idempotent reapplication, rollback, re-rollback, function ownership,
 *    RLS behavior, execute permissions, and mid-execution failure atomicity.
 * 4. Verifies documented migration-runner role configurations (postgres NOSUPERUSER
 *    CREATEROLE and supabase_admin SUPERUSER) and explicitly verifies that unsupported
 *    cross-runner configurations (apply as supabase_admin -> re-apply/rollback as
 *    non-superuser postgres) fail safely without partial state changes.
 * 5. Never skips or reports a passing result when PostgreSQL is unavailable.
 */

import { Client, ClientConfig } from 'pg';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ADMIN_DB_URL =
  process.env.M12_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';

const EXPECTED_PG_MAJOR = process.env.EXPECTED_PG_MAJOR
  ? parseInt(process.env.EXPECTED_PG_MAJOR, 10)
  : undefined;

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
const ROLLBACK_DIR = path.resolve(__dirname, '../rollback');

const MIGRATION_01_TO_11_FILES = [
  '20260915212448_01_core_and_locations.sql',
  '20260915214519_02_providers_and_verification.sql',
  '20260915215639_03_requests_chat_and_audit.sql',
  '20260916085135_04_request_state_machine_and_security.sql',
  '20260916093000_05_auth_identity_and_phone_sync.sql',
  '20260916100000_06_least_privilege_chat_and_provider_access.sql',
  '20260925000000_07_user_onboarding_and_consent.sql',
  '20260926000000_08_authoritative_onboarding_status.sql',
  '20261005000000_09_catalog_and_discovery.sql',
  '20261005010000_10_revoke_direct_provider_badges_select.sql',
  '20261018000000_11_contact_share_security_hardening.sql',
];

const MIGRATION_12_FILE = '20261022000000_12_super_admin_authorization.sql';
const ROLLBACK_12_FILE = '20261022000000_12_super_admin_authorization_down.sql';

function readMigrationSql(fileName: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), 'utf8');
}

function readRollbackSql(fileName: string): string {
  return fs.readFileSync(path.join(ROLLBACK_DIR, fileName), 'utf8');
}

function buildConnectionConfig(baseConnectionString: string, overrides: { user?: string; password?: string; database?: string }): ClientConfig {
  const url = new URL(baseConnectionString);
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? parseInt(url.port, 10) : 5432,
    user: overrides.user ?? (decodeURIComponent(url.username) || 'supabase_admin'),
    password: overrides.password ?? (decodeURIComponent(url.password) || 'postgres'),
    database: overrides.database ?? (url.pathname.replace(/^\//, '') || 'postgres'),
  };
}

describe('Migration 12: Reproducible PostgreSQL 15/16/17 Integration Suite', () => {
  let maintenanceClient: Client;
  let serverVersionNum = 0;
  let serverMajorVersion = 0;
  let postgresWasSuperuser = false;
  const createdDatabases: string[] = [];

  async function connectRole(dbName: string, roleName: 'supabase_admin' | 'postgres'): Promise<Client> {
    const client = new Client(
      buildConnectionConfig(ADMIN_DB_URL, {
        user: roleName,
        password: process.env.PGPASSWORD || 'postgres',
        database: dbName,
      })
    );
    await client.connect();
    return client;
  }

  /**
   * Cleans up cluster-wide role admin_super_admin_lookup_owner across any prior disposable scenario
   * and drops the disposable database.
   */
  async function dropDisposableDatabase(dbName: string): Promise<void> {
    const superClient = await connectRole(dbName, 'supabase_admin');
    try {
      await superClient.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'admin_super_admin_lookup_owner') THEN
            EXECUTE 'DROP OWNED BY admin_super_admin_lookup_owner CASCADE';
            EXECUTE 'DROP ROLE IF EXISTS admin_super_admin_lookup_owner';
          END IF;
        END
        $$;
      `);
    } finally {
      await superClient.end();
    }

    await maintenanceClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
  }

  /**
   * Creates an isolated disposable database, provisions the Supabase auth schema/roles,
   * and applies Migrations 01–11 as the specified runner.
   */
  async function createDisposableEnvWithMigrations01To11(
    initialRunner: 'postgres' | 'supabase_admin' = 'postgres'
  ): Promise<string> {
    // Ensure cluster role admin_super_admin_lookup_owner is absent before starting a fresh isolated scenario
    await maintenanceClient.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'admin_super_admin_lookup_owner') THEN
          EXECUTE 'DROP OWNED BY admin_super_admin_lookup_owner CASCADE';
          EXECUTE 'DROP ROLE IF EXISTS admin_super_admin_lookup_owner';
        END IF;
      END
      $$;
    `);

    const dbName = `m12_iso_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await maintenanceClient.query(`CREATE DATABASE ${dbName} OWNER postgres;`);
    createdDatabases.push(dbName);

    const superClient = await connectRole(dbName, 'supabase_admin');
    try {
      await superClient.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        ALTER SCHEMA public OWNER TO postgres;
        GRANT ALL ON SCHEMA public TO postgres WITH GRANT OPTION;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

        CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_admin;

        CREATE TABLE IF NOT EXISTS auth.users (
          id uuid PRIMARY KEY,
          email text,
          phone text,
          raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        ALTER TABLE auth.users OWNER TO postgres;

        CREATE OR REPLACE FUNCTION auth.uid()
        RETURNS uuid
        LANGUAGE sql
        STABLE
        AS $fn$
          SELECT COALESCE(
            NULLIF(current_setting('request.jwt.claim.sub', true), ''),
            (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          )::uuid;
        $fn$;

        ALTER FUNCTION auth.uid() OWNER TO supabase_admin;

        GRANT USAGE ON SCHEMA auth TO postgres WITH GRANT OPTION;
        GRANT ALL ON TABLE auth.users TO postgres, supabase_auth_admin, service_role WITH GRANT OPTION;
        GRANT EXECUTE ON FUNCTION auth.uid() TO postgres WITH GRANT OPTION;

        GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
        GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      `);
    } finally {
      await superClient.end();
    }

    const runnerClient = await connectRole(dbName, initialRunner);
    try {
      for (const file of MIGRATION_01_TO_11_FILES) {
        const sql = readMigrationSql(file);
        await runnerClient.query(sql);
      }
    } finally {
      await runnerClient.end();
    }

    return dbName;
  }

  beforeAll(async () => {
    // Connect to maintenance DB; fail hard if PostgreSQL is unreachable (never skip)
    maintenanceClient = new Client(buildConnectionConfig(ADMIN_DB_URL, {}));
    try {
      await maintenanceClient.connect();
    } catch (err: any) {
      throw new Error(
        `PostgreSQL integration database connection required at ${ADMIN_DB_URL}. ` +
          `Integration tests must not be skipped or reported as passing when PostgreSQL is unavailable. ` +
          `Original error: ${err?.message || String(err)}`
      );
    }

    const verRes = await maintenanceClient.query(`
      SELECT
        current_setting('server_version_num')::int AS ver_num,
        (current_setting('server_version_num')::int / 10000) AS major_ver;
    `);
    serverVersionNum = verRes.rows[0].ver_num;
    serverMajorVersion = verRes.rows[0].major_ver;

    expect([15, 16, 17]).toContain(serverMajorVersion);
    if (EXPECTED_PG_MAJOR !== undefined) {
      expect(serverMajorVersion).toBe(EXPECTED_PG_MAJOR);
    }

    // Ensure cluster roles exist matching Supabase's role model:
    // - supabase_admin: SUPERUSER CREATEDB CREATEROLE LOGIN
    // - postgres: NOSUPERUSER CREATEDB CREATEROLE INHERIT LOGIN
    // - anon, authenticated, service_role, supabase_auth_admin
    await maintenanceClient.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin') THEN
          CREATE ROLE supabase_admin WITH LOGIN PASSWORD 'postgres' SUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS;
        ELSE
          ALTER ROLE supabase_admin WITH LOGIN PASSWORD 'postgres' SUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN NOINHERIT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN NOINHERIT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'supabase_auth_admin') THEN
          CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'postgres') THEN
          CREATE ROLE postgres WITH LOGIN PASSWORD 'postgres' NOSUPERUSER CREATEDB CREATEROLE INHERIT;
        END IF;
      END
      $$;
    `);

    const pgRoleRes = await maintenanceClient.query(`
      SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = 'postgres';
    `);
    postgresWasSuperuser = Boolean(pgRoleRes.rows[0]?.rolsuper);

    // Reconnect as supabase_admin so we can enforce postgres as NOSUPERUSER CREATEROLE
    await maintenanceClient.end();
    maintenanceClient = await connectRole('postgres', 'supabase_admin');

    await maintenanceClient.query(`
      ALTER ROLE postgres WITH LOGIN PASSWORD 'postgres' NOSUPERUSER CREATEDB CREATEROLE INHERIT;
      GRANT anon, authenticated, service_role, supabase_auth_admin TO postgres WITH ADMIN OPTION;
    `);
  });

  afterAll(async () => {
    if (maintenanceClient) {
      for (const dbName of createdDatabases.splice(0, createdDatabases.length)) {
        try {
          await dropDisposableDatabase(dbName);
        } catch {
          // Best-effort cleanup on teardown
        }
      }
      if (postgresWasSuperuser) {
        try {
          await maintenanceClient.query(`ALTER ROLE postgres WITH SUPERUSER;`);
        } catch {
          // Ignore if unable to restore
        }
      }
      await maintenanceClient.end();
    }
  });

  test('M12-INT-01: Applies Migrations 01–11 then Migration 12 as postgres (NOSUPERUSER CREATEROLE) and hardens owner role, function, RLS policy, and pg_auth_members', async () => {
    const dbName = await createDisposableEnvWithMigrations01To11('postgres');
    const pgClient = await connectRole(dbName, 'postgres');

    try {
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));

      // Verify session role context was restored to postgres
      const ctxRes = await pgClient.query(`
        SELECT current_user AS curr_user, current_setting('role', true) AS active_role;
      `);
      expect(ctxRes.rows[0].curr_user).toBe('postgres');
      expect(['none', '', 'postgres']).toContain(ctxRes.rows[0].active_role);

      // Verify owner role attributes
      const roleRes = await pgClient.query(`
        SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
        FROM pg_catalog.pg_roles
        WHERE rolname = 'admin_super_admin_lookup_owner';
      `);
      expect(roleRes.rows.length).toBe(1);
      expect(roleRes.rows[0]).toEqual({
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      });

      // Verify runtime privileges for admin_super_admin_lookup_owner
      const privRes = await pgClient.query(`
        SELECT
          has_schema_privilege('admin_super_admin_lookup_owner', 'public', 'USAGE') AS public_usage,
          has_schema_privilege('admin_super_admin_lookup_owner', 'public', 'CREATE') AS public_create,
          has_schema_privilege('admin_super_admin_lookup_owner', 'auth', 'USAGE') AS auth_usage,
          has_function_privilege('admin_super_admin_lookup_owner', 'auth.uid()', 'EXECUTE') AS auth_uid_exec,
          has_column_privilege('admin_super_admin_lookup_owner', 'public.user_roles', 'user_id', 'SELECT') AS select_user_id,
          has_column_privilege('admin_super_admin_lookup_owner', 'public.user_roles', 'role', 'SELECT') AS select_role,
          has_table_privilege('admin_super_admin_lookup_owner', 'public.user_roles', 'INSERT') AS insert_roles,
          has_table_privilege('admin_super_admin_lookup_owner', 'public.user_roles', 'UPDATE') AS update_roles,
          has_table_privilege('admin_super_admin_lookup_owner', 'public.user_roles', 'DELETE') AS delete_roles;
      `);
      expect(privRes.rows[0]).toEqual({
        public_usage: true,
        public_create: false,
        auth_usage: true,
        auth_uid_exec: true,
        select_user_id: true,
        select_role: true,
        insert_roles: false,
        update_roles: false,
        delete_roles: false,
      });

      // Verify function ownership and configuration
      const fnRes = await pgClient.query(`
        SELECT r.rolname AS owner_name, p.prosecdef, p.provolatile, p.proconfig
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE p.oid = 'public.current_user_is_super_admin()'::regprocedure;
      `);
      expect(fnRes.rows.length).toBe(1);
      expect(fnRes.rows[0].owner_name).toBe('admin_super_admin_lookup_owner');
      expect(fnRes.rows[0].prosecdef).toBe(true);
      expect(fnRes.rows[0].provolatile).toBe('s');
      expect(fnRes.rows[0].proconfig).toEqual(
        expect.arrayContaining(['search_path=pg_catalog, pg_temp', 'row_security=on'])
      );

      // Verify RLS policy on public.user_roles
      const polRes = await pgClient.query(`
        SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public' AND tablename = 'user_roles';
      `);
      expect(polRes.rows.length).toBe(1);
      expect(polRes.rows[0].policyname).toBe('p_user_roles_select_own_super_admin');
      expect(polRes.rows[0].roles).toEqual(['admin_super_admin_lookup_owner']);
      expect(polRes.rows[0].cmd).toBe('SELECT');

      // Verify pg_auth_members at rest across PG 15 vs PG 16/17
      if (serverVersionNum >= 160000) {
        const memRes = await pgClient.query(`
          SELECT r.rolname AS member_name, m.admin_option, m.inherit_option, m.set_option
          FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles r ON r.oid = m.member
          WHERE m.roleid = 'admin_super_admin_lookup_owner'::regrole;
        `);
        expect(memRes.rows.length).toBe(1);
        expect(memRes.rows[0]).toEqual({
          member_name: 'postgres',
          admin_option: true,
          inherit_option: false,
          set_option: false,
        });
      } else {
        const memRes = await pgClient.query(`
          SELECT m.member
          FROM pg_catalog.pg_auth_members m
          WHERE m.roleid = 'admin_super_admin_lookup_owner'::regrole;
        `);
        expect(memRes.rows.length).toBe(0);
      }
    } finally {
      await pgClient.end();
      await dropDisposableDatabase(dbName);
    }
  });

  test('M12-INT-02: Enforces RLS behavior and EXECUTE permission matrix for current_user_is_super_admin()', async () => {
    const dbName = await createDisposableEnvWithMigrations01To11('postgres');
    const pgClient = await connectRole(dbName, 'postgres');

    const superAdminId = '10000000-0000-4000-8000-000000000001';
    const areaAdminId = '10000000-0000-4000-8000-000000000002';
    const providerId = '10000000-0000-4000-8000-000000000003';
    const customerId = '10000000-0000-4000-8000-000000000004';

    try {
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));

      // Seed users via auth.users (triggers public.handle_new_auth_user())
      for (const [id, name, phone] of [
        [superAdminId, 'Super Admin', '+12025550901'],
        [areaAdminId, 'Area Admin', '+12025550902'],
        [providerId, 'Provider User', '+12025550903'],
        [customerId, 'Customer User', '+12025550904'],
      ]) {
        await pgClient.query(
          `INSERT INTO auth.users (id, email, phone, raw_user_meta_data)
           VALUES ($1, $2, $3, $4::jsonb);`,
          [id, `${id}@example.com`, phone, JSON.stringify({ full_name: name })]
        );
      }

      await pgClient.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'super_admin');`, [superAdminId]);
      await pgClient.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'area_admin');`, [areaAdminId]);
      await pgClient.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'provider');`, [providerId]);

      // Verify function ACL matrix via has_function_privilege
      const fnAclRes = await pgClient.query(`
        SELECT
          has_function_privilege('authenticated', 'public.current_user_is_super_admin()', 'EXECUTE') AS auth_exec,
          has_function_privilege('anon', 'public.current_user_is_super_admin()', 'EXECUTE') AS anon_exec,
          has_function_privilege('service_role', 'public.current_user_is_super_admin()', 'EXECUTE') AS sr_exec;
      `);
      expect(fnAclRes.rows[0]).toEqual({
        auth_exec: true,
        anon_exec: false,
        sr_exec: false,
      });

      // Evaluate as authenticated for each user
      await pgClient.query(`SET ROLE authenticated;`);

      await pgClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [superAdminId]);
      const saRes = await pgClient.query(`SELECT public.current_user_is_super_admin() AS is_sa;`);
      expect(saRes.rows[0].is_sa).toBe(true);

      await pgClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [areaAdminId]);
      const aaRes = await pgClient.query(`SELECT public.current_user_is_super_admin() AS is_sa;`);
      expect(aaRes.rows[0].is_sa).toBe(false);

      await pgClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [providerId]);
      const prRes = await pgClient.query(`SELECT public.current_user_is_super_admin() AS is_sa;`);
      expect(prRes.rows[0].is_sa).toBe(false);

      await pgClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [customerId]);
      const cuRes = await pgClient.query(`SELECT public.current_user_is_super_admin() AS is_sa;`);
      expect(cuRes.rows[0].is_sa).toBe(false);

      await pgClient.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      const nullRes = await pgClient.query(`SELECT public.current_user_is_super_admin() AS is_sa;`);
      expect(nullRes.rows[0].is_sa).toBe(false);

      await pgClient.query(`RESET ROLE;`);

      // Verify anon and service_role are denied execution
      await pgClient.query(`SET ROLE anon;`);
      await expect(pgClient.query(`SELECT public.current_user_is_super_admin();`)).rejects.toThrow(
        /permission denied/i
      );
      await pgClient.query(`RESET ROLE;`);

      await pgClient.query(`SET ROLE service_role;`);
      await expect(pgClient.query(`SELECT public.current_user_is_super_admin();`)).rejects.toThrow(
        /permission denied/i
      );
      await pgClient.query(`RESET ROLE;`);
    } finally {
      await pgClient.end();
      await dropDisposableDatabase(dbName);
    }
  });

  test('M12-INT-03: Supports idempotent reapplication and pre-existing function ownership transfer', async () => {
    const dbName = await createDisposableEnvWithMigrations01To11('postgres');
    const pgClient = await connectRole(dbName, 'postgres');

    try {
      // Simulate a pre-existing function owned by postgres prior to first Migration 12 run
      await pgClient.query(`
        CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
        RETURNS boolean
        LANGUAGE sql
        STABLE
        AS $$ SELECT false; $$;
      `);

      // First apply: transfers ownership from postgres to admin_super_admin_lookup_owner and replaces body
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));

      // Second apply (repeat run when already owned by admin_super_admin_lookup_owner):
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));

      const fnRes = await pgClient.query(`
        SELECT r.rolname AS owner_name
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE p.oid = 'public.current_user_is_super_admin()'::regprocedure;
      `);
      expect(fnRes.rows[0].owner_name).toBe('admin_super_admin_lookup_owner');

      // Ensure no active INHERIT/SET membership remains after repeat run
      const activeMemRes = await pgClient.query(`
        SELECT COUNT(*)::int AS cnt
        FROM pg_catalog.pg_auth_members m
        WHERE m.roleid = 'admin_super_admin_lookup_owner'::regrole
          AND (
            CASE
              WHEN current_setting('server_version_num')::int >= 160000
              THEN (m.inherit_option OR m.set_option OR NOT m.admin_option)
              ELSE true
            END
          );
      `);
      expect(activeMemRes.rows[0].cnt).toBe(0);
    } finally {
      await pgClient.end();
      await dropDisposableDatabase(dbName);
    }
  });

  test('M12-INT-04: Rolls back cleanly, supports idempotent re-rollback, and re-applies cleanly', async () => {
    const dbName = await createDisposableEnvWithMigrations01To11('postgres');
    const pgClient = await connectRole(dbName, 'postgres');

    try {
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));
      await pgClient.query(readRollbackSql(ROLLBACK_12_FILE));

      // Verify function, policy, and role are completely removed
      const stateAfterRollback = await pgClient.query(`
        SELECT
          to_regprocedure('public.current_user_is_super_admin()') AS fn_oid,
          to_regrole('admin_super_admin_lookup_owner') AS role_oid,
          (
            SELECT COUNT(*)::int
            FROM pg_catalog.pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'user_roles'
              AND policyname = 'p_user_roles_select_own_super_admin'
          ) AS policy_count;
      `);
      expect(stateAfterRollback.rows[0]).toEqual({
        fn_oid: null,
        role_oid: null,
        policy_count: 0,
      });

      // Second rollback (idempotency check)
      await pgClient.query(readRollbackSql(ROLLBACK_12_FILE));

      // Re-apply Migration 12 after rollback
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));

      const stateAfterReapply = await pgClient.query(`
        SELECT
          to_regprocedure('public.current_user_is_super_admin()') IS NOT NULL AS fn_exists,
          to_regrole('admin_super_admin_lookup_owner') IS NOT NULL AS role_exists;
      `);
      expect(stateAfterReapply.rows[0]).toEqual({
        fn_exists: true,
        role_exists: true,
      });
    } finally {
      await pgClient.end();
      await dropDisposableDatabase(dbName);
    }
  });

  test('M12-INT-05: Supports documented runner workflows (postgres -> supabase_admin and supabase_admin -> supabase_admin)', async () => {
    const dbName = await createDisposableEnvWithMigrations01To11('postgres');
    const pgClient = await connectRole(dbName, 'postgres');
    const superClient = await connectRole(dbName, 'supabase_admin');

    try {
      // Workflow A: Apply as postgres, re-apply and roll back as supabase_admin
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));
      await superClient.query(readMigrationSql(MIGRATION_12_FILE));
      await superClient.query(readRollbackSql(ROLLBACK_12_FILE));

      const checkA = await superClient.query(`
        SELECT to_regrole('admin_super_admin_lookup_owner') AS role_oid;
      `);
      expect(checkA.rows[0].role_oid).toBeNull();

      // Workflow B: Apply as supabase_admin, re-apply as supabase_admin, roll back as supabase_admin
      await superClient.query(readMigrationSql(MIGRATION_12_FILE));
      await superClient.query(readMigrationSql(MIGRATION_12_FILE));
      await superClient.query(readRollbackSql(ROLLBACK_12_FILE));

      const checkB = await superClient.query(`
        SELECT to_regrole('admin_super_admin_lookup_owner') AS role_oid;
      `);
      expect(checkB.rows[0].role_oid).toBeNull();
    } finally {
      await pgClient.end();
      await superClient.end();
      await dropDisposableDatabase(dbName);
    }
  });

  test('M12-INT-06: Rejects unsupported cross-runner workflow (apply as supabase_admin -> re-apply or roll back as non-superuser postgres) safely', async () => {
    const dbName = await createDisposableEnvWithMigrations01To11('postgres');
    const pgClient = await connectRole(dbName, 'postgres');
    const superClient = await connectRole(dbName, 'supabase_admin');

    try {
      // Apply Migration 12 as superuser supabase_admin
      await superClient.query(readMigrationSql(MIGRATION_12_FILE));

      // Attempt re-apply as non-superuser postgres -> must fail early with 42501
      let reapplyErr: any = null;
      try {
        await pgClient.query(readMigrationSql(MIGRATION_12_FILE));
      } catch (err) {
        reapplyErr = err;
      }
      expect(reapplyErr).not.toBeNull();
      expect(reapplyErr.code).toBe('42501');
      expect(reapplyErr.message).toMatch(/Unsupported cross-runner state/i);

      // Attempt rollback as non-superuser postgres -> must fail early with 42501
      let rollbackErr: any = null;
      try {
        await pgClient.query(readRollbackSql(ROLLBACK_12_FILE));
      } catch (err) {
        rollbackErr = err;
      }
      expect(rollbackErr).not.toBeNull();
      expect(rollbackErr.code).toBe('42501');
      expect(rollbackErr.message).toMatch(/Unsupported cross-runner rollback/i);

      // Verify database was NOT left half-rolled-back and no active membership was left behind
      const intactRes = await superClient.query(`
        SELECT
          to_regprocedure('public.current_user_is_super_admin()') IS NOT NULL AS fn_exists,
          to_regrole('admin_super_admin_lookup_owner') IS NOT NULL AS role_exists,
          (
            SELECT COUNT(*)::int
            FROM pg_catalog.pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'user_roles'
              AND policyname = 'p_user_roles_select_own_super_admin'
          ) AS policy_count,
          (
            SELECT COUNT(*)::int
            FROM pg_catalog.pg_auth_members
            WHERE roleid = 'admin_super_admin_lookup_owner'::regrole
          ) AS member_count;
      `);
      expect(intactRes.rows[0]).toEqual({
        fn_exists: true,
        role_exists: true,
        policy_count: 1,
        member_count: 0,
      });
    } finally {
      await pgClient.end();
      await superClient.end();
      await dropDisposableDatabase(dbName);
    }
  });

  test('M12-INT-07: Enforces pre-flight grant-option checks and repurpose/dependency guards', async () => {
    const dbName = await createDisposableEnvWithMigrations01To11('postgres');
    const pgClient = await connectRole(dbName, 'postgres');
    const superClient = await connectRole(dbName, 'supabase_admin');

    try {
      // 1. Revoke GRANT OPTION for EXECUTE on auth.uid() from postgres (retaining plain EXECUTE)
      await superClient.query(`
        REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION auth.uid() FROM postgres;
      `);

      let grantOptErr: any = null;
      try {
        await pgClient.query(readMigrationSql(MIGRATION_12_FILE));
      } catch (err) {
        grantOptErr = err;
      }
      expect(grantOptErr).not.toBeNull();
      expect(grantOptErr.code).toBe('42501');
      expect(grantOptErr.message).toMatch(/lacks grant-option authority on auth\.uid\(\)/i);

      // Verify no partial role or policy was created
      const afterGrantOptFail = await pgClient.query(`
        SELECT to_regrole('admin_super_admin_lookup_owner') AS role_oid;
      `);
      expect(afterGrantOptFail.rows[0].role_oid).toBeNull();

      // Restore GRANT OPTION on auth.uid()
      await superClient.query(`
        GRANT EXECUTE ON FUNCTION auth.uid() TO postgres WITH GRANT OPTION;
      `);

      // 2. Apply Migration 12, then attach an unexpected table owned by admin_super_admin_lookup_owner
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));
      await superClient.query(`
        CREATE TABLE public.unexpected_dep_table (id int);
        ALTER TABLE public.unexpected_dep_table OWNER TO admin_super_admin_lookup_owner;
      `);

      await expect(pgClient.query(readMigrationSql(MIGRATION_12_FILE))).rejects.toMatchObject({
        code: '55006',
      });
      await expect(pgClient.query(readRollbackSql(ROLLBACK_12_FILE))).rejects.toMatchObject({
        code: '55006',
      });

      await superClient.query(`DROP TABLE public.unexpected_dep_table;`);
    } finally {
      await pgClient.end();
      await superClient.end();
      await dropDisposableDatabase(dbName);
    }
  });

  test('M12-INT-08: Enforces full transactional atomicity on mid-execution failure in both up and rollback migrations', async () => {
    const dbName = await createDisposableEnvWithMigrations01To11('postgres');
    const pgClient = await connectRole(dbName, 'postgres');
    const superClient = await connectRole(dbName, 'supabase_admin');

    try {
      // 1. Up-migration mid-execution failure after SET ROLE and CREATE FUNCTION (on ALTER FUNCTION)
      await superClient.query(`
        CREATE OR REPLACE FUNCTION public.test_fail_on_alter_fn()
        RETURNS event_trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF current_user = 'admin_super_admin_lookup_owner' THEN
            RAISE EXCEPTION 'Simulated failure inside Step 4 after SET ROLE'
              USING ERRCODE = 'XX000';
          END IF;
        END;
        $$;

        CREATE EVENT TRIGGER trg_fail_on_alter_fn
          ON ddl_command_end
          WHEN TAG IN ('ALTER FUNCTION')
          EXECUTE FUNCTION public.test_fail_on_alter_fn();
      `);

      await expect(pgClient.query(readMigrationSql(MIGRATION_12_FILE))).rejects.toThrow(
        /Simulated failure inside Step 4 after SET ROLE/
      );

      // Verify entire DO $migration12$ rolled back atomically and session role was restored
      const postUpFail = await pgClient.query(`
        SELECT
          current_user AS curr_user,
          current_setting('role', true) AS active_role,
          to_regrole('admin_super_admin_lookup_owner') AS role_oid,
          to_regprocedure('public.current_user_is_super_admin()') AS fn_oid,
          (
            SELECT COUNT(*)::int
            FROM pg_catalog.pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'user_roles'
              AND policyname = 'p_user_roles_select_own_super_admin'
          ) AS policy_count;
      `);
      expect(postUpFail.rows[0].curr_user).toBe('postgres');
      expect(['none', '', 'postgres']).toContain(postUpFail.rows[0].active_role);
      expect(postUpFail.rows[0].role_oid).toBeNull();
      expect(postUpFail.rows[0].fn_oid).toBeNull();
      expect(postUpFail.rows[0].policy_count).toBe(0);

      await superClient.query(`
        DROP EVENT TRIGGER trg_fail_on_alter_fn;
        DROP FUNCTION public.test_fail_on_alter_fn();
      `);

      // 2. Apply Migration 12 cleanly, then inject mid-rollback failure during DROP POLICY
      await pgClient.query(readMigrationSql(MIGRATION_12_FILE));

      await superClient.query(`
        CREATE OR REPLACE FUNCTION public.test_fail_on_drop_policy()
        RETURNS event_trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM pg_event_trigger_dropped_objects()
            WHERE object_type = 'policy'
              AND object_name = 'p_user_roles_select_own_super_admin'
          ) THEN
            RAISE EXCEPTION 'Simulated failure inside Step 3 during DROP POLICY'
              USING ERRCODE = 'XX000';
          END IF;
        END;
        $$;

        CREATE EVENT TRIGGER trg_fail_on_drop_policy
          ON sql_drop
          EXECUTE FUNCTION public.test_fail_on_drop_policy();
      `);

      await expect(pgClient.query(readRollbackSql(ROLLBACK_12_FILE))).rejects.toThrow(
        /Simulated failure inside Step 3 during DROP POLICY/
      );

      // Verify entire DO $rollback12$ rolled back atomically: function, policy, role, and dormant membership remain intact
      const postRollbackFail = await pgClient.query(`
        SELECT
          current_user AS curr_user,
          current_setting('role', true) AS active_role,
          to_regrole('admin_super_admin_lookup_owner') IS NOT NULL AS role_exists,
          to_regprocedure('public.current_user_is_super_admin()') IS NOT NULL AS fn_exists,
          (
            SELECT COUNT(*)::int
            FROM pg_catalog.pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'user_roles'
              AND policyname = 'p_user_roles_select_own_super_admin'
          ) AS policy_count,
          (
            SELECT COUNT(*)::int
            FROM pg_catalog.pg_auth_members m
            WHERE m.roleid = 'admin_super_admin_lookup_owner'::regrole
              AND (
                CASE
                  WHEN current_setting('server_version_num')::int >= 160000
                  THEN (m.inherit_option OR m.set_option OR NOT m.admin_option)
                  ELSE true
                END
              )
          ) AS active_member_count;
      `);
      expect(postRollbackFail.rows[0]).toEqual({
        curr_user: 'postgres',
        active_role: postRollbackFail.rows[0].active_role,
        role_exists: true,
        fn_exists: true,
        policy_count: 1,
        active_member_count: 0,
      });
      expect(['none', '', 'postgres']).toContain(postRollbackFail.rows[0].active_role);

      await superClient.query(`
        DROP EVENT TRIGGER trg_fail_on_drop_policy;
        DROP FUNCTION public.test_fail_on_drop_policy();
      `);
    } finally {
      await pgClient.end();
      await superClient.end();
      await dropDisposableDatabase(dbName);
    }
  });
});
