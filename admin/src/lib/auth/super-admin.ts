import 'server-only';

import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export type SuperAdminAuthorization =
  | { status: 'authorized' }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'unavailable' };

/** Performs the authoritative, server-side authentication and role check. */
export async function checkCurrentSuperAdmin(): Promise<SuperAdminAuthorization> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { status: 'unavailable' };
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();

    if (!data?.user) return { status: 'unauthenticated' };
    if (error) return { status: 'unavailable' };

    const { data: isSuperAdmin, error: roleError } = await supabase.rpc(
      'current_user_is_super_admin'
    );

    if (roleError || typeof isSuperAdmin !== 'boolean') {
      return { status: 'unavailable' };
    }

    return isSuperAdmin ? { status: 'authorized' } : { status: 'forbidden' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Page/action boundary. Call independently of Proxy for every privileged operation. */
export async function requireSuperAdmin(): Promise<void> {
  const result = await checkCurrentSuperAdmin();

  if (result.status === 'authorized') return;
  if (result.status === 'unauthenticated') redirect('/login');
  if (result.status === 'forbidden') notFound();

  throw new Error('Admin authorization could not be verified.');
}
