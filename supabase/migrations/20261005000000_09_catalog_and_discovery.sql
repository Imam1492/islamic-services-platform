-- Migration: 09_catalog_and_discovery
-- Description: Establishes authenticated catalog RLS policies, performance indexes, and
--              hardened SECURITY DEFINER RPCs for provider discovery and public profile viewing.

-- ============================================================================
-- 1. CATALOG ACCESS CONTROL & RLS POLICIES (CORRECTION 1)
-- ============================================================================

-- Explicitly revoke catalog read access from PUBLIC and anon
REVOKE ALL ON TABLE public.locations FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.categories FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.services FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.provider_badges FROM PUBLIC, anon;

-- Grant SELECT only to authenticated users and service_role
GRANT SELECT ON TABLE public.locations TO authenticated;
GRANT SELECT ON TABLE public.categories TO authenticated;
GRANT SELECT ON TABLE public.services TO authenticated;
GRANT SELECT ON TABLE public.provider_badges TO authenticated;

-- Locations: Authenticated users can view only active locations
DROP POLICY IF EXISTS p_locations_select_active ON public.locations;
CREATE POLICY p_locations_select_active
  ON public.locations
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- Categories: Authenticated users can view only active categories
DROP POLICY IF EXISTS p_categories_select_active ON public.categories;
CREATE POLICY p_categories_select_active
  ON public.categories
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- Services: Authenticated users can view only active services with an active parent category
DROP POLICY IF EXISTS p_services_select_active ON public.services;
CREATE POLICY p_services_select_active
  ON public.services
  FOR SELECT
  TO authenticated
  USING (
    is_active = true
    AND EXISTS (
      SELECT 1
      FROM public.categories c
      WHERE c.id = services.category_id
        AND c.is_active = true
    )
  );

-- Provider Badges: Authenticated users can view badges strictly for approved providers
DROP POLICY IF EXISTS p_provider_badges_select ON public.provider_badges;
CREATE POLICY p_provider_badges_select
  ON public.provider_badges
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.provider_profiles p
      WHERE p.id = provider_badges.provider_id
        AND p.status = 'approved'::public.provider_status
    )
  );

-- ============================================================================
-- 2. DISCOVERY PERFORMANCE INDEXES
-- ============================================================================

-- Index on users(full_name) to support deterministic ordering by display_name
CREATE INDEX IF NOT EXISTS idx_users_full_name
  ON public.users(full_name);

-- Partial index on provider_profiles for approved discovery with gender and experience
CREATE INDEX IF NOT EXISTS idx_provider_profiles_approved_discovery
  ON public.provider_profiles(id, gender, years_experience)
  WHERE status = 'approved'::public.provider_status;

-- ============================================================================
-- 3. DISCOVERY RPC: public.discover_providers(...)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.discover_providers(
  p_area_id uuid,
  p_service_id uuid,
  p_gender public.provider_gender DEFAULT NULL,
  p_min_experience integer DEFAULT NULL,
  p_required_badges public.badge_type[] DEFAULT NULL,
  p_limit integer DEFAULT 15,
  p_cursor_display_name text DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_limit integer;
  v_results jsonb;
  v_has_more boolean := false;
  v_next_cursor jsonb := NULL;
  v_row_count integer := 0;
  v_records_json jsonb := '[]'::jsonb;
  r record;
BEGIN
  -- 1. Authentication check: Fail closed for unauthenticated callers
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate Area: Must be non-null, active, and level = 'area'
  IF p_area_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.locations
    WHERE id = p_area_id
      AND is_active = true
      AND level = 'area'::public.location_level
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive area location' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Validate Service: Must be non-null, active, and under an active category
  IF p_service_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.services s
    JOIN public.categories c ON c.id = s.category_id
    WHERE s.id = p_service_id
      AND s.is_active = true
      AND c.is_active = true
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive service' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Clamp pagination limit (1 to 50, default 15)
  IF p_limit IS NULL OR p_limit < 1 THEN
    v_limit := 15;
  ELSIF p_limit > 50 THEN
    v_limit := 50;
  ELSE
    v_limit := p_limit;
  END IF;

  -- 5. Query matching providers (fetch v_limit + 1 for has_more detection)
  FOR r IN
    SELECT
      p.id AS provider_id,
      u.full_name AS display_name,
      p.gender,
      p.bio,
      p.years_experience,
      COALESCE(
        (
          SELECT json_agg(pb.badge_type ORDER BY pb.badge_type)
          FROM public.provider_badges pb
          WHERE pb.provider_id = p.id
        ),
        '[]'::json
      ) AS badges
    FROM public.provider_profiles p
    JOIN public.users u ON u.id = p.user_id
    WHERE p.status = 'approved'::public.provider_status
      -- Area coverage validation: Provider serves the requested active area
      AND EXISTS (
        SELECT 1
        FROM public.provider_locations pl
        JOIN public.locations l ON l.id = pl.location_id
        WHERE pl.provider_id = p.id
          AND pl.location_id = p_area_id
          AND l.is_active = true
      )
      -- Service offering validation: Provider offers the requested active service
      AND EXISTS (
        SELECT 1
        FROM public.provider_services ps
        JOIN public.services s ON s.id = ps.service_id
        JOIN public.categories c ON c.id = s.category_id
        WHERE ps.provider_id = p.id
          AND ps.service_id = p_service_id
          AND s.is_active = true
          AND c.is_active = true
      )
      -- Optional gender filter
      AND (p_gender IS NULL OR p.gender = p_gender)
      -- Optional minimum experience filter
      AND (p_min_experience IS NULL OR p.years_experience >= p_min_experience)
      -- Optional required badges filter (provider must possess ALL specified badges)
      AND (
        p_required_badges IS NULL
        OR array_length(p_required_badges, 1) IS NULL
        OR (
          SELECT count(DISTINCT pb.badge_type)
          FROM public.provider_badges pb
          WHERE pb.provider_id = p.id
            AND pb.badge_type = ANY(p_required_badges)
        ) = array_length(p_required_badges, 1)
      )
      -- Keyset pagination cursor condition (display_name ASC, provider_id ASC)
      AND (
        p_cursor_display_name IS NULL
        OR (
          u.full_name > p_cursor_display_name
          OR (u.full_name = p_cursor_display_name AND p.id > p_cursor_id)
        )
      )
    ORDER BY u.full_name ASC, p.id ASC
    LIMIT (v_limit + 1)
  LOOP
    v_row_count := v_row_count + 1;
    IF v_row_count <= v_limit THEN
      v_records_json := v_records_json || jsonb_build_array(
        jsonb_build_object(
          'provider_id', r.provider_id,
          'display_name', r.display_name,
          'gender', r.gender,
          'bio', r.bio,
          'years_experience', r.years_experience,
          'badges', r.badges
        )
      );
    ELSE
      v_has_more := true;
    END IF;
  END LOOP;

  -- 6. Compute next_cursor if additional rows exist
  IF v_has_more AND jsonb_array_length(v_records_json) > 0 THEN
    v_next_cursor := jsonb_build_object(
      'display_name', v_records_json->-1->>'display_name',
      'provider_id', v_records_json->-1->>'provider_id'
    );
  END IF;

  RETURN jsonb_build_object(
    'providers', v_records_json,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor
  );
END;
$$;

-- Secure function permissions
REVOKE ALL ON FUNCTION public.discover_providers(uuid, uuid, public.provider_gender, integer, public.badge_type[], integer, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discover_providers(uuid, uuid, public.provider_gender, integer, public.badge_type[], integer, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.discover_providers(uuid, uuid, public.provider_gender, integer, public.badge_type[], integer, text, uuid) TO authenticated, service_role;

-- ============================================================================
-- 4. PROVIDER PROFILE RPC: public.get_public_provider_profile(...)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_provider_profile(
  p_provider_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_provider record;
  v_services jsonb := '[]'::jsonb;
  v_areas jsonb := '[]'::jsonb;
  v_badges jsonb := '[]'::jsonb;
BEGIN
  -- 1. Authentication check: Fail closed for unauthenticated callers
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- 2. Lookup provider: Must be approved (fail closed if not found or unapproved)
  IF p_provider_id IS NULL THEN
    RAISE EXCEPTION 'Provider not found or unavailable' USING ERRCODE = 'P0002';
  END IF;

  SELECT
    p.id AS provider_id,
    u.full_name AS display_name,
    p.gender,
    p.bio,
    p.years_experience
  INTO v_provider
  FROM public.provider_profiles p
  JOIN public.users u ON u.id = p.user_id
  WHERE p.id = p_provider_id
    AND p.status = 'approved'::public.provider_status;

  IF v_provider.provider_id IS NULL THEN
    RAISE EXCEPTION 'Provider not found or unavailable' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Query active services offered by provider
  SELECT COALESCE(
    json_agg(
      json_build_object(
        'id', s.id,
        'name', s.name,
        'slug', s.slug,
        'category_id', c.id,
        'category_name', c.name
      ) ORDER BY s.name ASC
    ),
    '[]'::json
  )
  INTO v_services
  FROM public.provider_services ps
  JOIN public.services s ON s.id = ps.service_id
  JOIN public.categories c ON c.id = s.category_id
  WHERE ps.provider_id = p_provider_id
    AND s.is_active = true
    AND c.is_active = true;

  -- 4. Query active areas declared by provider
  SELECT COALESCE(
    json_agg(
      json_build_object(
        'id', l.id,
        'name', l.name,
        'parent_id', l.parent_id
      ) ORDER BY l.name ASC
    ),
    '[]'::json
  )
  INTO v_areas
  FROM public.provider_locations pl
  JOIN public.locations l ON l.id = pl.location_id
  WHERE pl.provider_id = p_provider_id
    AND l.is_active = true;

  -- 5. Query approved public badges for provider
  SELECT COALESCE(
    json_agg(
      json_build_object(
        'badge_type', pb.badge_type,
        'granted_at', pb.granted_at
      ) ORDER BY pb.granted_at ASC
    ),
    '[]'::json
  )
  INTO v_badges
  FROM public.provider_badges pb
  WHERE pb.provider_id = p_provider_id;

  -- 6. Return curated public projection
  RETURN jsonb_build_object(
    'provider_id', v_provider.provider_id,
    'display_name', v_provider.display_name,
    'gender', v_provider.gender,
    'bio', v_provider.bio,
    'years_experience', v_provider.years_experience,
    'services', v_services,
    'areas', v_areas,
    'badges', v_badges
  );
END;
$$;

-- Secure function permissions
REVOKE ALL ON FUNCTION public.get_public_provider_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_provider_profile(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_public_provider_profile(uuid) TO authenticated, service_role;
