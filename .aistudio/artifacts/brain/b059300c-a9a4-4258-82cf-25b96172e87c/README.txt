================================================================================
MIGRATION 12 TRANSFER PACKAGE — README
================================================================================

1. OVERVIEW & PROVENANCE
------------------------
This archive contains the Migration 12 changes saved in the Google AI Studio
workspace (`/app/applet`).

IMPORTANT:
- The AI Studio workspace was initialized from a static snapshot at Migration 11
  and does NOT contain a `.git` directory or connection to GitHub.
- None of the files or patches in this archive have been verified against the
  actual GitHub branch `Imam1492/islamic-services-platform`
  (`review/migration11-safe-release`, commit `62d958ec1940190ff7ee6eb3654313ab885f4f78`).
- Do NOT assume `database-security-test-changes.patch` applies cleanly to
  `review/migration11-safe-release` without manual review.

2. ARCHIVE PAYLOADS (4 PAYLOADS + THIS README)
----------------------------------------------
1) `supabase/migrations/20261022000000_12_super_admin_authorization.sql`
   - Complete current file (160 lines, 5,967 bytes).
   - Creates dedicated NOLOGIN least-privilege role `admin_super_admin_lookup_owner`
     (`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`).
   - Grants `USAGE, CREATE ON SCHEMA public` (temporary `CREATE` revoked in cleanup)
     and `SELECT (user_id, role) ON TABLE public.user_roles` to `admin_super_admin_lookup_owner`.
   - Creates restricted RLS policy `p_user_roles_select_own_super_admin` on
     `public.user_roles` (`FOR SELECT TO admin_super_admin_lookup_owner USING (user_id = auth.uid() AND role = 'super_admin'::public.app_role)`).
   - Creates `public.current_user_is_super_admin()` as a zero-argument `SECURITY DEFINER`,
     `STABLE` function with `SET search_path = pg_catalog, public, pg_temp` and
     `SET row_security = on`, checking only `auth.uid()`.
   - Uses a PostgreSQL-version-aware `DO` block (`WITH INHERIT TRUE, SET TRUE` on
     PostgreSQL 16+, standard grant on PostgreSQL 15) before
     `ALTER FUNCTION public.current_user_is_super_admin() OWNER TO admin_super_admin_lookup_owner;`
     to avoid `SQLSTATE 42501` (`must be able to SET ROLE "admin_super_admin_lookup_owner"`).
   - Revokes `ALL` on the function from `PUBLIC`, `anon`, and `service_role`, and
     grants `EXECUTE` only to `authenticated`.
   - Revokes temporary `CREATE ON SCHEMA public` from `admin_super_admin_lookup_owner`
     and revokes temporary `INHERIT OPTION` and `SET OPTION` on PG 16+ (or direct
     membership on PG 15) while preserving `ADMIN OPTION` on PG 16+ for rollback.

2) `supabase/rollback/20261022000000_12_super_admin_authorization_down.sql`
   - Complete current file (67 lines, 2,506 bytes).
   - Re-grants temporary role membership (`WITH INHERIT TRUE, SET TRUE` on PG 16+,
     or standard grant on PG 15) to `current_user` if `admin_super_admin_lookup_owner`
     exists so a non-superuser migration runner can drop the function owned by that role.
   - Drops `public.current_user_is_super_admin()` (without `CASCADE`).
   - Drops policy `p_user_roles_select_own_super_admin` on `public.user_roles`.
   - Revokes all privileges on `public.user_roles` and `SCHEMA public` from
     `admin_super_admin_lookup_owner` and drops `admin_super_admin_lookup_owner`.

3) `admin/src/__tests__/schema-phase4-1.test.ts`
   - Complete current file (111 lines, 4,842 bytes).
   - Offline Jest static contract test suite inspecting the Migration 12 up/down SQL files.

4) `database-security-test-changes.patch`
   - Unified diff patch containing ONLY the 3 hunks modified in
     `supabase/tests/database-security.test.ts` (with 6 lines of surrounding context):
     * Hunk 1 (around line 16): Adds `fs` and `path` imports.
     * Hunk 2 (around line 1308 in `PROV-ADM-01`): Updates the `pg_policies` check
       so `admin_area_assignments` and `provider_locations` still require 0 policies
       while `user_roles` permits `p_user_roles_select_own_super_admin`.
     * Hunk 3 (lines 1930-2125): Adds Section 7
       (`7. MIGRATION 12: SUPER ADMIN AUTHORIZATION & ROLE MEMBERSHIP TESTS`,
       tests `M12-STATIC-01` through `M12-STATIC-03`, `M12-LIVE-01`, and `M12-LIVE-02`).
   - Produced against the AI Studio workspace's 1,920-line Migration 11 baseline of
     `supabase/tests/database-security.test.ts`. NOT verified to apply cleanly to
     GitHub branch `review/migration11-safe-release`.

3. TEST COMMANDS ACTUALLY EXECUTED & RESULTS
--------------------------------------------
1) Offline Jest Unit / Static Contract Tests (EXECUTED TEST LOGIC — PASSED)
   Command (run from `/app/applet/admin`):
     npx jest src/__tests__/schema-phase4-1.test.ts --no-cache
   Result:
     PASS src/__tests__/schema-phase4-1.test.ts
     5 passed, 5 total (1 test suite passed).

2) Full Admin Jest Test Suite (EXECUTED TEST LOGIC — PASSED)
   Command (run from `/app/applet/admin`):
     npm test -- --watchAll=false
   Result:
     PASS (8 test suites passed, 95 tests passed, 0 failed).
     Note: Exercises static regex/filesystem checks against SQL files and mocked
     Next.js auth/middleware unit tests. Does NOT connect to PostgreSQL.

3) Root Jest Execution on `supabase/tests/database-security.test.ts` (EXECUTED STATIC TESTS; DB TESTS SKIPPED — PASSED)
   Command (run from `/app/applet`):
     npx jest supabase/tests/database-security.test.ts --no-cache
   Result:
     PASS supabase/tests/database-security.test.ts
     `M12-STATIC-01`, `M12-STATIC-02`, and `M12-STATIC-03` executed real assertions
     against the SQL files on disk; database-dependent tests (`PROV-ADM-01`,
     `M12-LIVE-01`, `M12-LIVE-02`, etc.) no-op'd via `if (!isDbConnected) return;`
     because no PostgreSQL server was running.

4) TypeScript & Build Checks (COMPILE / BUNDLE CHECK ONLY — PASSED)
   Commands:
     npm run lint (`tsc --noEmit`)
     npm run build (`vite build`)
   Result:
     Both succeeded with exit code 0.

5) Git Diff Whitespace Check (FAILED — NO GIT REPOSITORY)
   Command:
     git diff --check
   Result:
     Failed with `fatal: not a git repository (or any of the parent directories): .git`.

4. NO LIVE DATABASE VALIDATION PERFORMED
----------------------------------------
- No PostgreSQL instance, Docker daemon, or Supabase CLI runtime was used or
  connected to in this workspace.
- Database-dependent assertions in `supabase/tests/database-security.test.ts`
  (including `PROV-ADM-01`, `M12-LIVE-01`, and `M12-LIVE-02`) were NOT executed
  against a live database.
- Neither `20261022000000_12_super_admin_authorization.sql` nor
  `20261022000000_12_super_admin_authorization_down.sql` has been executed against
  PostgreSQL 15 or PostgreSQL 16+ in this workspace.
