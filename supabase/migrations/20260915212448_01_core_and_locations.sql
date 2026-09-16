-- Migration: 01_core_and_locations
-- Description: Foundational core entities, location hierarchy, user management, and security triggers

-- 1. ENUMS
CREATE TYPE public.location_level AS ENUM ('country', 'state', 'city', 'area');
CREATE TYPE public.app_role AS ENUM ('super_admin', 'area_admin', 'provider', 'user');

-- 2. HELPER FUNCTIONS
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 3. TABLES

-- Locations Hierarchy Table
CREATE TABLE public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  level public.location_level NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_prevent_self_reference CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX idx_locations_parent_id ON public.locations(parent_id);
CREATE INDEX idx_locations_level ON public.locations(level);
CREATE INDEX idx_locations_is_active ON public.locations(is_active);

CREATE TRIGGER trg_locations_updated_at
  BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Public Users Profile Table (1:1 with auth.users)
CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_is_active ON public.users(is_active);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- User Private Data Table (Restricted access, PII)
CREATE TABLE public.user_private (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  phone_e164 text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_private_phone_e164_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9]\d{1,14}$')
);

CREATE TRIGGER trg_user_private_updated_at
  BEFORE UPDATE ON public.user_private
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- User Roles Table (Many-to-Many / Multi-role RBAC)
CREATE TABLE public.user_roles (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX idx_user_roles_role ON public.user_roles(role);

-- Admin Area Assignments Table (Scoping area admins to specific area locations)
CREATE TABLE public.admin_area_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_admin_area_assignment UNIQUE (user_id, location_id)
);

CREATE INDEX idx_admin_area_assignments_user ON public.admin_area_assignments(user_id);
CREATE INDEX idx_admin_area_assignments_location ON public.admin_area_assignments(location_id);

-- Area Level Validation Trigger for admin_area_assignments
CREATE OR REPLACE FUNCTION public.validate_admin_area_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_level public.location_level;
BEGIN
  SELECT level INTO target_level
  FROM public.locations
  WHERE id = NEW.location_id;

  IF target_level IS NULL THEN
    RAISE EXCEPTION 'Location with ID % does not exist', NEW.location_id;
  END IF;

  IF target_level <> 'area'::public.location_level THEN
    RAISE EXCEPTION 'Admin area assignment must target a location of level "area", found: %', target_level;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_admin_area_assignment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_admin_area_assignment() TO authenticated, service_role;

CREATE TRIGGER trg_validate_admin_area_assignment
  BEFORE INSERT OR UPDATE ON public.admin_area_assignments
  FOR EACH ROW EXECUTE FUNCTION public.validate_admin_area_assignment();

-- Categories Table
CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_categories_is_active ON public.categories(is_active);

CREATE TRIGGER trg_categories_updated_at
  BEFORE UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Services Table
CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_services_category_id ON public.services(category_id);
CREATE INDEX idx_services_is_active ON public.services(is_active);

CREATE TRIGGER trg_services_updated_at
  BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. AUTH SYNC TRIGGER
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.users (id, full_name, is_active)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
      NULLIF(TRIM(NEW.raw_user_meta_data->>'name'), ''),
      NULLIF(TRIM(split_part(NEW.email, '@', 1)), ''),
      'User'
    ),
    true
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Revoke execute from public
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_auth_user() TO postgres, supabase_auth_admin, service_role;

-- Attach trigger to auth.users
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- 5. ROW LEVEL SECURITY (RLS) ACTIVATION
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_area_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

-- 6. PERMISSIONS & ACCESS CONTROL
REVOKE ALL ON TABLE public.locations FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.users FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.user_private FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.user_roles FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.admin_area_assignments FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.categories FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.services FROM PUBLIC, anon;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON TABLE public.locations, public.categories, public.services TO anon, authenticated;
GRANT SELECT ON TABLE public.users TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
