-- Migration: 02_providers_and_verification
-- Description: Remediates F-01 location hierarchy; implements provider profiles, provider locations,
--              provider services, auditable verification ledger, and derived public badges.

-- ============================================================================
-- 1. REMEDIATION OF F-01: LOCATION HIERARCHY ENFORCEMENT
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_location_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  parent_level public.location_level;
  parent_active boolean;
  child_count integer;
BEGIN
  -- 1. Reject direct self-reference
  IF NEW.parent_id IS NOT NULL AND NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'A location cannot reference itself as its parent (id: %)', NEW.id;
  END IF;

  -- 2. Strict hierarchy level validation
  IF NEW.level = 'country'::public.location_level THEN
    IF NEW.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'Country locations must have parent_id as NULL, found: %', NEW.parent_id;
    END IF;
  ELSE
    -- state, city, and area MUST have a non-null parent
    IF NEW.parent_id IS NULL THEN
      RAISE EXCEPTION 'Locations of level "%" must have a non-null parent_id', NEW.level;
    END IF;

    SELECT level, is_active INTO parent_level, parent_active
    FROM public.locations
    WHERE id = NEW.parent_id;

    IF parent_level IS NULL THEN
      RAISE EXCEPTION 'Parent location with ID % does not exist', NEW.parent_id;
    END IF;

    IF NOT parent_active AND NEW.is_active THEN
      RAISE EXCEPTION 'Cannot attach active location "%" to inactive parent location %', NEW.name, NEW.parent_id;
    END IF;

    IF NEW.level = 'state'::public.location_level AND parent_level <> 'country'::public.location_level THEN
      RAISE EXCEPTION 'A state must have a parent of level "country", found: %', parent_level;
    ELSIF NEW.level = 'city'::public.location_level AND parent_level <> 'state'::public.location_level THEN
      RAISE EXCEPTION 'A city must have a parent of level "state", found: %', parent_level;
    ELSIF NEW.level = 'area'::public.location_level AND parent_level <> 'city'::public.location_level THEN
      RAISE EXCEPTION 'An area must have a parent of level "city", found: %', parent_level;
    END IF;
  END IF;

  -- 3. On UPDATE, prevent level modification that would break existing child relationships
  IF TG_OP = 'UPDATE' AND NEW.level <> OLD.level THEN
    SELECT count(*) INTO child_count
    FROM public.locations
    WHERE parent_id = NEW.id;

    IF child_count > 0 THEN
      RAISE EXCEPTION 'Cannot modify level of location % from "%" to "%" because % child location(s) depend on it',
        NEW.id, OLD.level, NEW.level, child_count;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_location_hierarchy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_location_hierarchy() TO authenticated, service_role, postgres;

CREATE TRIGGER trg_validate_location_hierarchy
  BEFORE INSERT OR UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.validate_location_hierarchy();

-- ============================================================================
-- 2. NEW ENUMS
-- ============================================================================

CREATE TYPE public.provider_status AS ENUM ('pending', 'area_reviewed', 'approved', 'suspended');
CREATE TYPE public.verification_decision AS ENUM ('recommended', 'approved', 'rejected', 'more_info_needed');
CREATE TYPE public.provider_gender AS ENUM ('male', 'female');
CREATE TYPE public.verification_type AS ENUM ('identity', 'skill_qualification', 'community_vouch', 'background_check');
CREATE TYPE public.badge_type AS ENUM ('identity_verified', 'skill_verified', 'community_vouched', 'background_checked');

-- ============================================================================
-- 3. PROVIDER PROFILES
-- ============================================================================

CREATE TABLE public.provider_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  bio text,
  gender public.provider_gender NOT NULL DEFAULT 'male'::public.provider_gender,
  years_experience integer NOT NULL DEFAULT 0,
  status public.provider_status NOT NULL DEFAULT 'pending'::public.provider_status,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_provider_years_experience CHECK (years_experience >= 0 AND years_experience <= 80)
);

CREATE INDEX idx_provider_profiles_user_id ON public.provider_profiles(user_id);
CREATE INDEX idx_provider_profiles_status ON public.provider_profiles(status);
CREATE INDEX idx_provider_profiles_gender ON public.provider_profiles(gender);

CREATE TRIGGER trg_provider_profiles_updated_at
  BEFORE UPDATE ON public.provider_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Prevent providers from directly self-promoting their own status
CREATE OR REPLACE FUNCTION public.check_provider_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_user_id uuid;
  is_admin boolean := false;
BEGIN
  -- If status has not changed, allow update
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  current_user_id := auth.uid();

  -- If called from a user session
  IF current_user_id IS NOT NULL THEN
    -- Check if user is the provider attempting to modify their own status
    IF current_user_id = OLD.user_id THEN
      RAISE EXCEPTION 'Providers cannot modify their own verification status';
    END IF;

    -- Check if user is super_admin or area_admin
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = current_user_id
        AND role IN ('super_admin'::public.app_role, 'area_admin'::public.app_role)
    ) INTO is_admin;

    IF NOT is_admin THEN
      RAISE EXCEPTION 'Only authorized administrators can modify provider status';
    END IF;

    -- Only super_admin can set status to approved
    IF NEW.status = 'approved'::public.provider_status THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = current_user_id
          AND role = 'super_admin'::public.app_role
      ) THEN
        RAISE EXCEPTION 'Only super administrators can promote provider status to "approved"';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_provider_status_transition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_provider_status_transition() TO authenticated, service_role, postgres;

CREATE TRIGGER trg_check_provider_status_transition
  BEFORE UPDATE ON public.provider_profiles
  FOR EACH ROW EXECUTE FUNCTION public.check_provider_status_transition();

-- ============================================================================
-- 4. PROVIDER LOCATIONS
-- ============================================================================

CREATE TABLE public.provider_locations (
  provider_id uuid NOT NULL REFERENCES public.provider_profiles(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, location_id)
);

CREATE INDEX idx_provider_locations_provider ON public.provider_locations(provider_id);
CREATE INDEX idx_provider_locations_location ON public.provider_locations(location_id);

-- Enforce that provider_locations for V1 MUST reference an Area
CREATE OR REPLACE FUNCTION public.validate_provider_location_area()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_level public.location_level;
  target_active boolean;
BEGIN
  SELECT level, is_active INTO target_level, target_active
  FROM public.locations
  WHERE id = NEW.location_id;

  IF target_level IS NULL THEN
    RAISE EXCEPTION 'Location with ID % does not exist', NEW.location_id;
  END IF;

  IF target_level <> 'area'::public.location_level THEN
    RAISE EXCEPTION 'Provider locations must reference a location of level "area", found: %', target_level;
  END IF;

  IF NOT target_active THEN
    RAISE EXCEPTION 'Cannot associate a provider with an inactive area (id: %)', NEW.location_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_provider_location_area() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_provider_location_area() TO authenticated, service_role, postgres;

CREATE TRIGGER trg_validate_provider_location_area
  BEFORE INSERT OR UPDATE ON public.provider_locations
  FOR EACH ROW EXECUTE FUNCTION public.validate_provider_location_area();

-- ============================================================================
-- 5. PROVIDER SERVICES
-- ============================================================================

CREATE TABLE public.provider_services (
  provider_id uuid NOT NULL REFERENCES public.provider_profiles(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, service_id)
);

CREATE INDEX idx_provider_services_provider ON public.provider_services(provider_id);
CREATE INDEX idx_provider_services_service ON public.provider_services(service_id);

-- ============================================================================
-- 6. AUDITABLE VERIFICATION LEDGER (PRIVATE)
-- ============================================================================

CREATE TABLE public.provider_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.provider_profiles(id) ON DELETE RESTRICT,
  reviewer_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  verification_type public.verification_type NOT NULL,
  decision public.verification_decision NOT NULL,
  internal_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_provider_verifications_provider ON public.provider_verifications(provider_id);
CREATE INDEX idx_provider_verifications_reviewer ON public.provider_verifications(reviewer_id);
CREATE INDEX idx_provider_verifications_location ON public.provider_verifications(location_id);
CREATE INDEX idx_provider_verifications_decision ON public.provider_verifications(decision);
CREATE INDEX idx_provider_verifications_type ON public.provider_verifications(verification_type);

CREATE TRIGGER trg_provider_verifications_updated_at
  BEFORE UPDATE ON public.provider_verifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Enforce verification constraints, location consistency, self-review guard, and F-04 area admin authority
CREATE OR REPLACE FUNCTION public.validate_provider_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_level public.location_level;
  provider_user_id uuid;
  is_super_admin boolean := false;
  is_area_admin boolean := false;
  has_area_assignment boolean := false;
  has_declared_location boolean := false;
BEGIN
  -- 1. Location MUST be of level 'area'
  SELECT level INTO target_level
  FROM public.locations
  WHERE id = NEW.location_id;

  IF target_level IS NULL THEN
    RAISE EXCEPTION 'Verification location % does not exist', NEW.location_id;
  END IF;

  IF target_level <> 'area'::public.location_level THEN
    RAISE EXCEPTION 'Provider verifications must target a location of level "area", found: %', target_level;
  END IF;

  -- 2. Fetch provider's user_id
  SELECT user_id INTO provider_user_id
  FROM public.provider_profiles
  WHERE id = NEW.provider_id;

  IF provider_user_id IS NULL THEN
    RAISE EXCEPTION 'Provider profile % does not exist', NEW.provider_id;
  END IF;

  -- 3. Self-review prevention: A provider MUST NOT be able to review their own profile
  IF NEW.reviewer_id = provider_user_id THEN
    RAISE EXCEPTION 'A provider cannot act as their own reviewer (provider user: %, reviewer: %)',
      provider_user_id, NEW.reviewer_id;
  END IF;

  -- 4. Location consistency: Provider MUST have declared provider_locations for this area
  SELECT EXISTS (
    SELECT 1 FROM public.provider_locations
    WHERE provider_id = NEW.provider_id
      AND location_id = NEW.location_id
  ) INTO has_declared_location;

  IF NOT has_declared_location THEN
    RAISE EXCEPTION 'Provider % has not declared service in area %; cannot create verification for undeclared location',
      NEW.provider_id, NEW.location_id;
  END IF;

  -- 5. Reviewer authorization check (F-04 enforcement)
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.reviewer_id AND role = 'super_admin'::public.app_role
  ) INTO is_super_admin;

  IF NOT is_super_admin THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = NEW.reviewer_id AND role = 'area_admin'::public.app_role
    ) INTO is_area_admin;

    IF NOT is_area_admin THEN
      RAISE EXCEPTION 'Reviewer % does not possess an administrative role', NEW.reviewer_id;
    END IF;

    -- Area admin MUST have explicit assignment to this target area
    SELECT EXISTS (
      SELECT 1 FROM public.admin_area_assignments
      WHERE user_id = NEW.reviewer_id AND location_id = NEW.location_id
    ) INTO has_area_assignment;

    IF NOT has_area_assignment THEN
      RAISE EXCEPTION 'Area admin % is not assigned to area % and cannot verify providers in this area',
        NEW.reviewer_id, NEW.location_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_provider_verification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_provider_verification() TO authenticated, service_role, postgres;

CREATE TRIGGER trg_validate_provider_verification
  BEFORE INSERT OR UPDATE ON public.provider_verifications
  FOR EACH ROW EXECUTE FUNCTION public.validate_provider_verification();

-- ============================================================================
-- 7. PUBLIC BADGES (STRICTLY DERIVED DATA)
-- ============================================================================

CREATE TABLE public.provider_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.provider_profiles(id) ON DELETE CASCADE,
  badge_type public.badge_type NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_provider_badge UNIQUE (provider_id, badge_type)
);

CREATE INDEX idx_provider_badges_provider ON public.provider_badges(provider_id);
CREATE INDEX idx_provider_badges_type ON public.provider_badges(badge_type);

-- Badge synchronization trigger: Derives and synchronizes badges on INSERT, UPDATE, DELETE
CREATE OR REPLACE FUNCTION public.sync_provider_badges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_provider_id uuid;
  v_rec record;
  qualifying_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_provider_id := OLD.provider_id;
  ELSE
    target_provider_id := NEW.provider_id;
  END IF;

  -- Explicit deterministic mapping:
  -- identity           + approved -> identity_verified
  -- skill_qualification+ approved -> skill_verified
  -- community_vouch    + approved -> community_vouched
  -- background_check   + approved -> background_checked
  FOR v_rec IN (
    SELECT 'identity'::public.verification_type AS v_type, 'identity_verified'::public.badge_type AS b_type
    UNION ALL
    SELECT 'skill_qualification'::public.verification_type, 'skill_verified'::public.badge_type
    UNION ALL
    SELECT 'community_vouch'::public.verification_type, 'community_vouched'::public.badge_type
    UNION ALL
    SELECT 'background_check'::public.verification_type, 'background_checked'::public.badge_type
  ) LOOP
    SELECT count(*) INTO qualifying_count
    FROM public.provider_verifications
    WHERE provider_id = target_provider_id
      AND verification_type = v_rec.v_type
      AND decision = 'approved'::public.verification_decision;

    IF qualifying_count > 0 THEN
      INSERT INTO public.provider_badges (provider_id, badge_type, granted_at)
      VALUES (target_provider_id, v_rec.b_type, now())
      ON CONFLICT (provider_id, badge_type) DO NOTHING;
    ELSE
      DELETE FROM public.provider_badges
      WHERE provider_id = target_provider_id
        AND badge_type = v_rec.b_type;
    END IF;
  END LOOP;

  -- If an UPDATE modifies provider_id, also recompute for the old provider
  IF TG_OP = 'UPDATE' AND OLD.provider_id <> NEW.provider_id THEN
    FOR v_rec IN (
      SELECT 'identity'::public.verification_type AS v_type, 'identity_verified'::public.badge_type AS b_type
      UNION ALL
      SELECT 'skill_qualification'::public.verification_type, 'skill_verified'::public.badge_type
      UNION ALL
      SELECT 'community_vouch'::public.verification_type, 'community_vouched'::public.badge_type
      UNION ALL
      SELECT 'background_check'::public.verification_type, 'background_checked'::public.badge_type
    ) LOOP
      SELECT count(*) INTO qualifying_count
      FROM public.provider_verifications
      WHERE provider_id = OLD.provider_id
        AND verification_type = v_rec.v_type
        AND decision = 'approved'::public.verification_decision;

      IF qualifying_count > 0 THEN
        INSERT INTO public.provider_badges (provider_id, badge_type, granted_at)
        VALUES (OLD.provider_id, v_rec.b_type, now())
        ON CONFLICT (provider_id, badge_type) DO NOTHING;
      ELSE
        DELETE FROM public.provider_badges
        WHERE provider_id = OLD.provider_id
          AND badge_type = v_rec.b_type;
      END IF;
    END LOOP;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_provider_badges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_provider_badges() TO postgres, authenticated, service_role;

CREATE TRIGGER trg_sync_provider_badges
  AFTER INSERT OR UPDATE OR DELETE ON public.provider_verifications
  FOR EACH ROW EXECUTE FUNCTION public.sync_provider_badges();

-- ============================================================================
-- 8. ROW LEVEL SECURITY & STRICT ACCESS PRIVILEGES
-- ============================================================================

-- Enable RLS on all newly created tables (default deny posture)
ALTER TABLE public.provider_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_badges ENABLE ROW LEVEL SECURITY;

-- Revoke all table privileges from PUBLIC and anon
REVOKE ALL ON TABLE public.provider_profiles FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.provider_locations FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.provider_services FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.provider_verifications FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.provider_badges FROM PUBLIC, anon;

-- Explicit privilege grants
-- Badges: Public projection, readable by anon and authenticated; NEVER directly writable
GRANT SELECT ON TABLE public.provider_badges TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.provider_badges FROM anon, authenticated;

-- Catalog & profile reads (subject to RLS in Phase 2.4+)
GRANT SELECT ON TABLE public.provider_profiles TO authenticated;
GRANT SELECT ON TABLE public.provider_locations TO authenticated, anon;
GRANT SELECT ON TABLE public.provider_services TO authenticated, anon;

-- provider_verifications is PRIVATE. Zero permissions granted to anon or authenticated.
-- Only service_role and internal triggers/functions execute queries against it.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
