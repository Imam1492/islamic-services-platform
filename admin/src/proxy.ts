import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

// Next.js 16 uses the Proxy convention (middleware was renamed/deprecated).
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
