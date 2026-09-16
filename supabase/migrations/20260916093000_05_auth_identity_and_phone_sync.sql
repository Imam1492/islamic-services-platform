-- Migration: 20260916093000_05_auth_identity_and_phone_sync.sql
-- Description: Phase 3.1 Step 2 — F-02 Authoritative Identity Synchronization
-- Securely synchronizes authoritative phone identity from auth.users into public.user_private.phone_e164
-- Restricts client-side mutation of user_private.phone_e164 to ensure database-level authority.

-- ============================================================================
-- 1. AUTHORITATIVE IDENTITY & PHONE SYNCHRONIZATION FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_phone text;
  v_full_name text;
BEGIN
  -- Extract and sanitize full name from raw_user_meta_data
  v_full_name := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
    NULLIF(TRIM(NEW.raw_user_meta_data->>'name'), ''),
    NULLIF(TRIM(split_part(NEW.email, '@', 1)), ''),
    'User'
  );

  -- Extract and sanitize phone number (NULL if absent or empty)
  v_phone := NULLIF(TRIM(NEW.phone), '');

  -- Validate E.164 format if phone is present; fallback safely to NULL if malformed
  IF v_phone IS NOT NULL AND NOT (v_phone ~ '^\+[1-9]\d{1,14}$') THEN
    RAISE WARNING 'User % registered with non-E.164 phone: %. Setting to NULL in user_private.', NEW.id, v_phone;
    v_phone := NULL;
  END IF;

  -- 1. Upsert public.users record
  INSERT INTO public.users (id, full_name, is_active)
  VALUES (NEW.id, v_full_name, true)
  ON CONFLICT (id) DO UPDATE
  SET
    full_name = CASE
      WHEN EXCLUDED.full_name <> 'User' THEN EXCLUDED.full_name
      ELSE public.users.full_name
    END,
    updated_at = now();

  -- 2. Ensure default user role exists in public.user_roles
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  -- 3. Synchronize phone into public.user_private authoritatively
  -- Set transaction-local flag so internal trigger permits authoritative sync
  PERFORM set_config('app.allow_phone_sync', 'true', true);

  INSERT INTO public.user_private (user_id, phone_e164)
  VALUES (NEW.id, v_phone)
  ON CONFLICT (user_id) DO UPDATE
  SET
    phone_e164 = EXCLUDED.phone_e164,
    updated_at = now();

  RETURN NEW;
END;
$$;

-- Security hardening: revoke execute from public, allow only internal auth roles
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_auth_user() TO postgres, supabase_auth_admin, service_role;

-- ============================================================================
-- 2. AUTH.USERS TRIGGERS (INSERT & UPDATE LIFECYCLE)
-- ============================================================================

-- Ensure insert trigger is attached to auth.users
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Attach trigger for legitimate phone updates and metadata updates on auth.users
DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE OF phone, raw_user_meta_data ON auth.users
  FOR EACH ROW
  WHEN (OLD.phone IS DISTINCT FROM NEW.phone OR OLD.raw_user_meta_data IS DISTINCT FROM NEW.raw_user_meta_data)
  EXECUTE FUNCTION public.handle_new_auth_user();

-- ============================================================================
-- 3. USER_PRIVATE TAMPER PROTECTION (PREVENT CLIENT SPOOFING OF PHONE_E164)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.protect_user_private_phone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Check if phone_e164 is being modified
  IF (TG_OP = 'INSERT' AND NEW.phone_e164 IS NOT NULL) OR
     (TG_OP = 'UPDATE' AND NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164) THEN
    
    -- If called by authenticated/anon client OR outside authoritative sync context:
    IF (auth.uid() IS NOT NULL OR current_user IN ('authenticated', 'anon') OR session_user IN ('authenticated', 'anon')) AND
       current_setting('app.allow_phone_sync', true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Direct client modification of phone_e164 is prohibited. Phone numbers are synchronized exclusively from verified Supabase Auth credentials.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.protect_user_private_phone() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protect_user_private_phone() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_user_private_phone() TO postgres, supabase_auth_admin, service_role;

DROP TRIGGER IF EXISTS trg_protect_user_private_phone ON public.user_private;
CREATE TRIGGER trg_protect_user_private_phone
  BEFORE INSERT OR UPDATE ON public.user_private
  FOR EACH ROW EXECUTE FUNCTION public.protect_user_private_phone();

-- Table and column grants for user_private
GRANT SELECT ON TABLE public.user_private TO authenticated;
GRANT UPDATE (updated_at) ON TABLE public.user_private TO authenticated;
GRANT INSERT (user_id) ON TABLE public.user_private TO authenticated;

-- Explicitly revoke write privileges on phone_e164 from client roles
REVOKE INSERT (phone_e164), UPDATE (phone_e164) ON TABLE public.user_private FROM anon, authenticated, PUBLIC;
