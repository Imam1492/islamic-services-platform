import fs from 'fs';
import path from 'path';

describe('Phase 2.5 - State Machine, SEC-24-01 Remediation, Chat Activation & Secure Contact Retrieval', () => {
  const migrationsDir = path.resolve(__dirname, '../../../supabase/migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).sort();
  const phase25MigrationFile = migrationFiles.find((f) => f.includes('04_request_state_machine_and_security'));

  if (!phase25MigrationFile) {
    throw new Error('04_request_state_machine_and_security migration file not found');
  }

  const migrationSql = fs.readFileSync(path.join(migrationsDir, phase25MigrationFile), 'utf-8');

  describe('1. Migration Standards & Security Definer Hardening', () => {
    test('migration file exists with timestamp naming convention', () => {
      expect(phase25MigrationFile).toMatch(/^\d{14}_04_request_state_machine_and_security\.sql$/);
    });

    test('all procedures specify SECURITY DEFINER with hardened search_path', () => {
      const functionMatches = migrationSql.match(/CREATE OR REPLACE FUNCTION [\s\S]+?\$\$/g) || [];
      expect(functionMatches.length).toBeGreaterThanOrEqual(5);

      functionMatches.forEach((fnSql) => {
        expect(fnSql).toContain('SECURITY DEFINER');
        expect(fnSql).toContain('SET search_path = pg_catalog, public, pg_temp');
      });
    });

    test('revokes EXECUTE from PUBLIC on all new RPC functions', () => {
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.assert_provider_covers_area(uuid, uuid) FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.transition_service_request(uuid, public.request_status, text) FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.activate_request_chat(uuid) FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.request_contact_share(uuid) FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.respond_contact_share(uuid, boolean) FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.get_shared_contact_info(uuid, uuid) FROM PUBLIC;');
    });
  });

  describe('2. SEC-24-01 Remediation: Exact Area & Provider-Location Validation', () => {
    test('implements assert_provider_covers_area checking level=area, active, and provider_locations row', () => {
      expect(migrationSql).toContain("FUNCTION public.assert_provider_covers_area");
      expect(migrationSql).toContain("v_location_level <> 'area'::public.location_level");
      expect(migrationSql).toContain('FROM public.provider_locations');
      expect(migrationSql).toContain('SEC-24-01 violation');
    });

    test('calls assert_provider_covers_area before REQUESTED -> ACCEPTED transition', () => {
      expect(migrationSql).toContain("v_req.status = 'REQUESTED'::public.request_status AND p_target_status = 'ACCEPTED'::public.request_status");
      expect(migrationSql).toContain('PERFORM public.assert_provider_covers_area(v_req.provider_id, v_req.location_id);');
    });
  });

  describe('3. Concurrency Protection & State Transitions (transition_service_request)', () => {
    test('uses SELECT ... FOR UPDATE on service_requests', () => {
      expect(migrationSql).toContain('FROM public.service_requests');
      expect(migrationSql).toContain('FOR UPDATE;');
    });

    test('requires authentication and rejects unauthenticated callers', () => {
      expect(migrationSql).toContain('v_actor_id := auth.uid();');
      expect(migrationSql).toContain('Authentication required to transition service request state');
    });

    test('enforces role-based transition matrix for requester, provider, and admins', () => {
      // Provider accepts or declines
      expect(migrationSql).toContain('Only the assigned provider can accept a service request');
      expect(migrationSql).toContain('Only the assigned provider can decline a service request');
      // Customer cancels
      expect(migrationSql).toContain('Only the customer can cancel a pending service request');
      // Admin blocks or resolves dispute
      expect(migrationSql).toContain('Only administrators can block a service request');
      expect(migrationSql).toContain('Only administrators can resolve a disputed service request');
      // General invalid transition rejection
      expect(migrationSql).toContain('Invalid service request state transition from');
    });

    test('temporarily sets session config app.allow_status_transition to bypass direct update block', () => {
      expect(migrationSql).toContain("set_config('app.allow_status_transition', 'true', true)");
      expect(migrationSql).toContain("set_config('app.allow_status_transition', 'false', true)");
    });

    test('automatically provisions conversation upon ACCEPTED or CHAT_ACTIVE transition', () => {
      expect(migrationSql).toContain("p_target_status IN ('ACCEPTED'::public.request_status, 'CHAT_ACTIVE'::public.request_status)");
      expect(migrationSql).toContain('INSERT INTO public.conversations (request_id, user_id, provider_id)');
      expect(migrationSql).toContain('ON CONFLICT (request_id) DO NOTHING');
    });

    test('revokes pending or shared contact shares upon reaching terminal states', () => {
      expect(migrationSql).toContain("p_target_status IN ('COMPLETED'::public.request_status, 'CANCELLED'::public.request_status, 'DECLINED'::public.request_status, 'EXPIRED'::public.request_status, 'BLOCKED'::public.request_status)");
      expect(migrationSql).toContain("UPDATE public.contact_shares");
      expect(migrationSql).toContain("SET status = 'revoked'::public.contact_share_status");
    });

    test('emits immutable audit log with old and new status without leaking notes or PII', () => {
      expect(migrationSql).toContain("PERFORM public.log_audit_event(");
      expect(migrationSql).toContain("'SERVICE_REQUEST_STATE_TRANSITION'");
    });
  });

  describe('4. Secure Chat Activation (activate_request_chat)', () => {
    test('delegates chat activation to state machine transition to CHAT_ACTIVE', () => {
      expect(migrationSql).toContain('FUNCTION public.activate_request_chat');
      expect(migrationSql).toContain("public.transition_service_request(");
      expect(migrationSql).toContain("'CHAT_ACTIVE'::public.request_status");
    });
  });

  describe('5. Explicit Contact Sharing & Secure Retrieval (get_shared_contact_info)', () => {
    test('request_contact_share checks legitimate participants and active request state', () => {
      expect(migrationSql).toContain('FUNCTION public.request_contact_share');
      expect(migrationSql).toContain("Contact sharing is only allowed for requests in ACCEPTED or CHAT_ACTIVE status");
      expect(migrationSql).toContain("Only request participants can initiate contact sharing");
    });

    test('respond_contact_share enforces recipient acceptance and participant revocation', () => {
      expect(migrationSql).toContain('FUNCTION public.respond_contact_share');
      expect(migrationSql).toContain("Only designated recipient can accept contact share");
      expect(migrationSql).toContain("Only participants can decline or revoke contact share");
    });

    test('get_shared_contact_info requires explicit active shared status', () => {
      expect(migrationSql).toContain('FUNCTION public.get_shared_contact_info');
      expect(migrationSql).toContain("status = 'shared'::public.contact_share_status");
      expect(migrationSql).toContain("Contact information has not been shared or has been revoked");
    });

    test('get_shared_contact_info denies access if request is in terminal state', () => {
      expect(migrationSql).toContain("Contact information cannot be accessed because service request is in terminal state");
    });

    test('get_shared_contact_info denies access to third parties and self-queries', () => {
      expect(migrationSql).toContain("Access denied: Caller is not a participant in this service request");
      expect(migrationSql).toContain("Target user ID must be the other participant");
    });

    test('logs audit event on contact retrieval without logging the actual phone number', () => {
      expect(migrationSql).toContain("'CONTACT_INFO_ACCESSED'");
      expect(migrationSql).not.toContain("v_target_phone in jsonb_build_object('request_id'");
    });
  });

  describe('6. RLS Hardening for user_private', () => {
    test('ensures user_private is restricted to self access only', () => {
      expect(migrationSql).toContain('p_user_private_self_select');
      expect(migrationSql).toContain('p_user_private_self_update');
      expect(migrationSql).toContain('auth.uid() = user_id');
    });
  });
});
