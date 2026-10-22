-- Roll back only the objects introduced by Migration 12.

DROP FUNCTION IF EXISTS public.current_user_is_super_admin();
DROP POLICY IF EXISTS p_user_roles_super_admin_lookup ON public.user_roles;

REVOKE SELECT ON TABLE public.user_roles FROM admin_super_admin_lookup_owner;
REVOKE EXECUTE ON FUNCTION auth.uid() FROM admin_super_admin_lookup_owner;
REVOKE USAGE ON TYPE public.app_role FROM admin_super_admin_lookup_owner;
REVOKE USAGE ON SCHEMA public, auth FROM admin_super_admin_lookup_owner;
REVOKE CREATE ON SCHEMA public FROM admin_super_admin_lookup_owner;

DROP ROLE IF EXISTS admin_super_admin_lookup_owner;
