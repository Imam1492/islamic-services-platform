-- Migration 12: expose a least-privilege server-side super-admin check.
-- The no-login owner role can read only the caller's super_admin role row via RLS.

CREATE ROLE admin_super_admin_lookup_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public, auth TO admin_super_admin_lookup_owner;
GRANT USAGE ON TYPE public.app_role TO admin_super_admin_lookup_owner;
GRANT EXECUTE ON FUNCTION auth.uid() TO admin_super_admin_lookup_owner;
GRANT SELECT ON TABLE public.user_roles TO admin_super_admin_lookup_owner;

CREATE POLICY p_user_roles_super_admin_lookup
  ON public.user_roles
  FOR SELECT
  TO admin_super_admin_lookup_owner
  USING (
    user_id = auth.uid()
    AND role = 'super_admin'::public.app_role
  );

-- PostgreSQL requires CREATE on the target schema when transferring function ownership.
GRANT CREATE ON SCHEMA public TO admin_super_admin_lookup_owner;

CREATE FUNCTION public.current_user_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles AS ur
    WHERE ur.user_id = auth.uid()
      AND ur.role = 'super_admin'::public.app_role
  );
$$;

ALTER FUNCTION public.current_user_is_super_admin()
  OWNER TO admin_super_admin_lookup_owner;
REVOKE CREATE ON SCHEMA public FROM admin_super_admin_lookup_owner;

REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO authenticated;
