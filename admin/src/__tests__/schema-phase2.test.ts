import fs from 'fs';
import path from 'path';

describe('Phase 2.3 - Provider Profiles & Auditable Verification Engine Schema', () => {
  const migrationsDir = path.resolve(__dirname, '../../../supabase/migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).sort();
  const phase2MigrationFile = migrationFiles.find((f) => f.includes('02_providers_and_verification'));

  if (!phase2MigrationFile) {
    throw new Error('02_providers_and_verification migration file not found');
  }

  const migrationSql = fs.readFileSync(path.join(migrationsDir, phase2MigrationFile), 'utf-8');

  describe('1. Migration File & Execution Integrity', () => {
    test('migration file exists with valid timestamp naming convention', () => {
      expect(phase2MigrationFile).toMatch(/^\d{14}_02_providers_and_verification\.sql$/);
    });

    test('retains strict search_path on all SECURITY DEFINER functions', () => {
      const functionMatches = migrationSql.match(/CREATE OR REPLACE FUNCTION [\s\S]+?\$\$/g) || [];
      expect(functionMatches.length).toBeGreaterThanOrEqual(4);

      functionMatches.forEach((fnSql) => {
        expect(fnSql).toContain('SECURITY DEFINER');
        expect(fnSql).toContain('SET search_path = pg_catalog, public, pg_temp');
      });
    });

    test('revokes EXECUTE from PUBLIC on all new functions', () => {
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.validate_location_hierarchy() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.check_provider_status_transition() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.validate_provider_location_area() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.validate_provider_verification() FROM PUBLIC;');
      expect(migrationSql).toContain('REVOKE EXECUTE ON FUNCTION public.sync_provider_badges() FROM PUBLIC;');
    });
  });

  describe('2. Remediated Location Hierarchy (F-01)', () => {
    test('enforces country parent_id IS NULL and valid parent progression for state, city, area', () => {
      expect(migrationSql).toContain("NEW.level = 'country'::public.location_level");
      expect(migrationSql).toContain('Country locations must have parent_id as NULL');
      expect(migrationSql).toContain('A state must have a parent of level "country"');
      expect(migrationSql).toContain('A city must have a parent of level "state"');
      expect(migrationSql).toContain('An area must have a parent of level "city"');
      expect(migrationSql).toContain('A location cannot reference itself as its parent');
    });

    test('prevents updating parent level when child locations exist', () => {
      expect(migrationSql).toContain('TG_OP = \'UPDATE\' AND NEW.level <> OLD.level');
      expect(migrationSql).toContain('because % child location(s) depend on it');
    });
  });

  describe('3. Required ENUMs', () => {
    test('creates required status, decision, gender, verification, and badge enums', () => {
      expect(migrationSql).toContain("CREATE TYPE public.provider_status AS ENUM ('pending', 'area_reviewed', 'approved', 'suspended');");
      expect(migrationSql).toContain("CREATE TYPE public.verification_decision AS ENUM ('recommended', 'approved', 'rejected', 'more_info_needed');");
      expect(migrationSql).toContain("CREATE TYPE public.provider_gender AS ENUM ('male', 'female');");
      expect(migrationSql).toContain("CREATE TYPE public.verification_type AS ENUM ('identity', 'skill_qualification', 'community_vouch', 'background_check');");
      expect(migrationSql).toContain("CREATE TYPE public.badge_type AS ENUM ('identity_verified', 'skill_verified', 'community_vouched', 'background_checked');");
    });
  });

  describe('4. Provider Profiles Security & Privacy Invariants', () => {
    test('does NOT store phone numbers in provider_profiles', () => {
      const tableMatch = migrationSql.match(/CREATE TABLE public\.provider_profiles \(([\s\S]+?)\);/);
      expect(tableMatch).toBeTruthy();
      const tableBody = tableMatch ? tableMatch[1] : '';
      expect(tableBody).not.toContain('phone');
      expect(tableBody).not.toContain('mobile');
    });

    test('constrains years_experience between 0 and 80', () => {
      expect(migrationSql).toContain('CONSTRAINT chk_provider_years_experience CHECK (years_experience >= 0 AND years_experience <= 80)');
    });

    test('prevents providers from modifying their own verification status', () => {
      expect(migrationSql).toContain('Providers cannot modify their own verification status');
      expect(migrationSql).toContain('Only super administrators can promote provider status to "approved"');
    });
  });

  describe('5. Provider Locations & Area Validation', () => {
    test('enforces provider_locations references location of level "area"', () => {
      expect(migrationSql).toContain('CREATE TABLE public.provider_locations');
      expect(migrationSql).toContain('PRIMARY KEY (provider_id, location_id)');
      expect(migrationSql).toContain('Provider locations must reference a location of level "area"');
    });
  });

  describe('6. Auditable Verification Ledger & Reviewer Authority (F-04)', () => {
    test('creates private provider_verifications table with internal_notes', () => {
      expect(migrationSql).toContain('CREATE TABLE public.provider_verifications');
      expect(migrationSql).toContain('internal_notes text');
    });

    test('prevents provider from acting as own reviewer', () => {
      expect(migrationSql).toContain('A provider cannot act as their own reviewer');
    });

    test('enforces location consistency: provider must have declared the area', () => {
      expect(migrationSql).toContain('cannot create verification for undeclared location');
    });

    test('enforces F-04: area admin must possess area_admin role AND assigned to target area', () => {
      expect(migrationSql).toContain("role = 'area_admin'::public.app_role");
      expect(migrationSql).toContain('is not assigned to area % and cannot verify providers in this area');
    });
  });

  describe('7. Derived Public Badges & Revocation Logic', () => {
    test('enforces unique badge per provider', () => {
      expect(migrationSql).toContain('CONSTRAINT uq_provider_badge UNIQUE (provider_id, badge_type)');
    });

    test('implements deterministic badge mapping from approved verifications', () => {
      expect(migrationSql).toContain("'identity'::public.verification_type AS v_type, 'identity_verified'::public.badge_type AS b_type");
      expect(migrationSql).toContain("'skill_qualification'::public.verification_type, 'skill_verified'::public.badge_type");
      expect(migrationSql).toContain("'community_vouch'::public.verification_type, 'community_vouched'::public.badge_type");
      expect(migrationSql).toContain("'background_check'::public.verification_type, 'background_checked'::public.badge_type");
    });

    test('derives badge on approved decision and revokes badge when no approved record remains', () => {
      expect(migrationSql).toContain("decision = 'approved'::public.verification_decision");
      expect(migrationSql).toContain('ON CONFLICT (provider_id, badge_type) DO NOTHING');
      expect(migrationSql).toContain('DELETE FROM public.provider_badges');
    });
  });

  describe('8. Permissions & RLS Posture', () => {
    test('enables RLS on all 5 new tables', () => {
      expect(migrationSql).toContain('ALTER TABLE public.provider_profiles ENABLE ROW LEVEL SECURITY;');
      expect(migrationSql).toContain('ALTER TABLE public.provider_locations ENABLE ROW LEVEL SECURITY;');
      expect(migrationSql).toContain('ALTER TABLE public.provider_services ENABLE ROW LEVEL SECURITY;');
      expect(migrationSql).toContain('ALTER TABLE public.provider_verifications ENABLE ROW LEVEL SECURITY;');
      expect(migrationSql).toContain('ALTER TABLE public.provider_badges ENABLE ROW LEVEL SECURITY;');
    });

    test('revokes direct mutation on provider_badges from anon and authenticated', () => {
      expect(migrationSql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.provider_badges FROM anon, authenticated;');
    });

    test('keeps provider_verifications completely private (no grants to anon or authenticated)', () => {
      expect(migrationSql).not.toContain('GRANT SELECT ON TABLE public.provider_verifications TO authenticated');
      expect(migrationSql).not.toContain('GRANT SELECT ON TABLE public.provider_verifications TO anon');
    });
  });

  describe('9. Algorithmic State Simulation of Badge Derivation & Revocation', () => {
    interface VerificationRecord {
      id: string;
      provider_id: string;
      verification_type: 'identity' | 'skill_qualification' | 'community_vouch' | 'background_check';
      decision: 'recommended' | 'approved' | 'rejected' | 'more_info_needed';
    }

    const computeBadges = (verifications: VerificationRecord[], providerId: string): string[] => {
      const mapping: Record<string, string> = {
        identity: 'identity_verified',
        skill_qualification: 'skill_verified',
        community_vouch: 'community_vouched',
        background_check: 'background_checked',
      };

      const badges: Set<string> = new Set();

      for (const [vType, badgeType] of Object.entries(mapping)) {
        const hasApproved = verifications.some(
          (v) => v.provider_id === providerId && v.verification_type === vType && v.decision === 'approved'
        );
        if (hasApproved) {
          badges.add(badgeType);
        }
      }

      return Array.from(badges).sort();
    };

    test('adds badge when approved verification is inserted', () => {
      const verifications: VerificationRecord[] = [
        { id: '1', provider_id: 'p1', verification_type: 'identity', decision: 'approved' },
      ];
      expect(computeBadges(verifications, 'p1')).toEqual(['identity_verified']);
    });

    test('does not add badge if decision is recommended or more_info_needed', () => {
      const verifications: VerificationRecord[] = [
        { id: '1', provider_id: 'p1', verification_type: 'identity', decision: 'recommended' },
        { id: '2', provider_id: 'p1', verification_type: 'skill_qualification', decision: 'more_info_needed' },
      ];
      expect(computeBadges(verifications, 'p1')).toEqual([]);
    });

    test('retaining badge if one verification is rejected but another approved verification exists', () => {
      const verifications: VerificationRecord[] = [
        { id: '1', provider_id: 'p1', verification_type: 'identity', decision: 'approved' },
        { id: '2', provider_id: 'p1', verification_type: 'identity', decision: 'rejected' },
      ];
      expect(computeBadges(verifications, 'p1')).toEqual(['identity_verified']);
    });

    test('revoking badge when only approved verification is changed to rejected', () => {
      const verifications: VerificationRecord[] = [
        { id: '1', provider_id: 'p1', verification_type: 'identity', decision: 'rejected' },
      ];
      expect(computeBadges(verifications, 'p1')).toEqual([]);
    });

    test('deduplicates badges across multiple approved verifications of the same type', () => {
      const verifications: VerificationRecord[] = [
        { id: '1', provider_id: 'p1', verification_type: 'identity', decision: 'approved' },
        { id: '2', provider_id: 'p1', verification_type: 'identity', decision: 'approved' },
      ];
      expect(computeBadges(verifications, 'p1')).toEqual(['identity_verified']);
    });
  });
});
