import fs from 'fs';
import path from 'path';

describe('Phase 2.4 - State-Machine Requests, Private Chat, Audit Logs & Contact Sharing', () => {
  const migrationsDir = path.resolve(__dirname, '../../../supabase/migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).sort();
  const phase24MigrationFile = migrationFiles.find((f) => f.includes('03_requests_chat_and_audit'));

  if (!phase24MigrationFile) {
    throw new Error('03_requests_chat_and_audit migration file not found');
  }

  const migrationSql = fs.readFileSync(path.join(migrationsDir, phase24MigrationFile), 'utf-8');

  describe('1. Migration File & Security Definer Hardening', () => {
    test('migration file exists with valid timestamp naming convention', () => {
      expect(phase24MigrationFile).toMatch(/^\d{14}_03_requests_chat_and_audit\.sql$/);
    });

    test('retains strict search_path on all SECURITY DEFINER functions', () => {
      const functionMatches = migrationSql.match(/CREATE OR REPLACE FUNCTION [\s\S]+?\$\$/g) || [];
      expect(functionMatches.length).toBeGreaterThanOrEqual(6);

      functionMatches.forEach((fnSql) => {
        expect(fnSql).toContain('SECURITY DEFINER');
        expect(fnSql).toContain('SET search_path = pg_catalog, public, pg_temp');
      });
    });

    test('revokes EXECUTE from PUBLIC on all new functions', () => {
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.prevent_audit_log_mutation() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.validate_service_request() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.check_request_status_update() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.enforce_conversation_participants() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.validate_and_lock_message() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.validate_contact_share() FROM PUBLIC;');
    });
  });

  describe('2. State Machine ENUMs & Integrity', () => {
    test('creates request_status enum with all required states and no redundant PENDING', () => {
      expect(migrationSql).toContain("CREATE TYPE public.request_status AS ENUM (");
      expect(migrationSql).toContain("'REQUESTED'");
      expect(migrationSql).toContain("'ACCEPTED'");
      expect(migrationSql).toContain("'CHAT_ACTIVE'");
      expect(migrationSql).toContain("'COMPLETED'");
      expect(migrationSql).toContain("'DECLINED'");
      expect(migrationSql).toContain("'CANCELLED'");
      expect(migrationSql).toContain("'EXPIRED'");
      expect(migrationSql).toContain("'BLOCKED'");
      expect(migrationSql).toContain("'DISPUTED'");
      expect(migrationSql).not.toContain("'PENDING'");
    });

    test('creates contact_share_status enum with pending, shared, revoked', () => {
      expect(migrationSql).toContain("CREATE TYPE public.contact_share_status AS ENUM (");
      expect(migrationSql).toContain("'pending'");
      expect(migrationSql).toContain("'shared'");
      expect(migrationSql).toContain("'revoked'");
    });
  });

  describe('3. Service Requests & State Machine Preparation', () => {
    test('enforces foreign keys to users, provider_profiles, services, and locations', () => {
      expect(migrationSql).toContain('user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT');
      expect(migrationSql).toContain('provider_id uuid NOT NULL REFERENCES public.provider_profiles(id) ON DELETE RESTRICT');
      expect(migrationSql).toContain('service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT');
      expect(migrationSql).toContain('location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT');
    });

    test('enforces Area level location and rejects street/address fields', () => {
      expect(migrationSql).toContain("target_level <> 'area'::public.location_level");
      expect(migrationSql).toContain('Service request location must be of level "area"');
      const tableMatch = migrationSql.match(/CREATE TABLE public\.service_requests \(([\s\S]+?)\);/);
      expect(tableMatch).toBeTruthy();
      const tableBody = tableMatch ? tableMatch[1] : '';
      expect(tableBody).not.toContain('street');
      expect(tableBody).not.toContain('address');
    });

    test('prohibits direct client updates to service_requests.status', () => {
      expect(migrationSql).toContain("current_setting('app.allow_status_transition', true) IS DISTINCT FROM 'true'");
      expect(migrationSql).toContain('Direct update of service_requests.status is prohibited');
    });

    test('prevents self-requests where requester owns the provider profile', () => {
      expect(migrationSql).toContain('Users cannot create service requests for their own provider profile');
    });
  });

  describe('4. Private 1-to-1 Chat Engine', () => {
    test('enforces exactly one conversation per request via UNIQUE(request_id)', () => {
      expect(migrationSql).toContain('request_id uuid NOT NULL UNIQUE REFERENCES public.service_requests(id) ON DELETE CASCADE');
    });

    test('auto-derives and enforces conversation participants from service request', () => {
      expect(migrationSql).toContain('NEW.user_id := req_user_id;');
      expect(migrationSql).toContain('NEW.provider_id := req_provider_id;');
    });

    test('restricts message content to text-only with bounded length', () => {
      expect(migrationSql).toContain('content text NOT NULL');
      expect(migrationSql).toContain('CONSTRAINT chk_message_content CHECK (char_length(trim(content)) > 0 AND char_length(content) <= 4000)');
      const messagesMatch = migrationSql.match(/CREATE TABLE public\.messages \(([\s\S]+?)\);/);
      const msgBody = messagesMatch ? messagesMatch[1] : '';
      expect(msgBody).not.toContain('attachment');
      expect(msgBody).not.toContain('image');
      expect(msgBody).not.toContain('audio');
    });

    test('prevents sender spoofing and validates conversation membership', () => {
      expect(migrationSql).toContain('NEW.sender_id <> conv_user_id AND NEW.sender_id <> conv_provider_user_id');
      expect(migrationSql).toContain('auth.uid() IS NOT NULL AND NEW.sender_id <> auth.uid()');
      expect(migrationSql).toContain('cannot send messages impersonating sender');
    });

    test('locks messages as immutable (edits and deletions prohibited)', () => {
      expect(migrationSql).toContain("TG_OP = 'UPDATE' OR TG_OP = 'DELETE'");
      expect(migrationSql).toContain('Chat messages are immutable. Edits and deletions are prohibited.');
    });
  });

  describe('5. Zero-PII Contact Sharing', () => {
    test('does NOT store phone numbers or PII in contact_shares', () => {
      const contactShareMatch = migrationSql.match(/CREATE TABLE public\.contact_shares \(([\s\S]+?)\);/);
      const body = contactShareMatch ? contactShareMatch[1] : '';
      expect(body).not.toContain('phone');
      expect(body).not.toContain('whatsapp');
      expect(body).not.toContain('email');
    });

    test('enforces distinct actors and uniqueness per request and direction', () => {
      expect(migrationSql).toContain('CONSTRAINT uq_contact_shares_direction UNIQUE (request_id, sharer_id, recipient_id)');
      expect(migrationSql).toContain('CONSTRAINT chk_contact_shares_distinct_actors CHECK (sharer_id <> recipient_id)');
    });

    test('requires recipient confirmation for transitioning to shared', () => {
      expect(migrationSql).toContain("current_user_id <> OLD.recipient_id");
      expect(migrationSql).toContain('Only the designated recipient can approve contact sharing');
    });
  });

  describe('6. Immutable Audit Logs Engine', () => {
    test('creates audit_logs with identity primary key and jsonb payloads', () => {
      expect(migrationSql).toContain('id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
      expect(migrationSql).toContain('old_data jsonb');
      expect(migrationSql).toContain('new_data jsonb');
    });

    test('revokes INSERT, UPDATE, DELETE, TRUNCATE on audit_logs from public, anon, authenticated', () => {
      expect(migrationSql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM PUBLIC, anon, authenticated;');
      expect(migrationSql).toContain('REVOKE ALL ON TABLE public.audit_logs FROM PUBLIC, anon, authenticated;');
    });

    test('blocks client mutation via immutable trigger', () => {
      expect(migrationSql).toContain('Audit logs are strictly append-only and immutable');
    });
  });

  describe('7. Row Level Security Posture', () => {
    test('enables RLS on all five new tables', () => {
      expect(migrationSql).toContain('ALTER TABLE public.service_requests ENABLE ROW LEVEL SECURITY;');
      expect(migrationSql).toContain('ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;');
      expect(migrationSql).toContain('ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;');
      expect(migrationSql).toContain('ALTER TABLE public.contact_shares ENABLE ROW LEVEL SECURITY;');
      expect(migrationSql).toContain('ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;');
    });

    test('implements strict participant isolation on service requests and chat', () => {
      expect(migrationSql).toContain('CREATE POLICY p_service_requests_select_requester');
      expect(migrationSql).toContain('CREATE POLICY p_service_requests_select_provider');
      expect(migrationSql).toContain('CREATE POLICY p_conversations_select_participant');
      expect(migrationSql).toContain('CREATE POLICY p_messages_select_participant');
      expect(migrationSql).toContain('CREATE POLICY p_contact_shares_select_participant');
    });
  });
});
