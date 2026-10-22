import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Updates session cookies and enforces authentication on protected routes.
 * Uses supabase.auth.getUser() to cryptographically validate the user session
 * on the server, avoiding untrusted local session claims.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const isProtectedPath =
    request.nextUrl.pathname === '/dashboard' ||
    request.nextUrl.pathname.startsWith('/dashboard/');
  const supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isProtectedPath) {
      return new NextResponse('Admin authentication is unavailable.', { status: 503 });
    }
    return supabaseResponse;
  }

  if (!isProtectedPath) return supabaseResponse;

  let responseWithCookies = supabaseResponse;
  try {
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          responseWithCookies = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            responseWithCookies.cookies.set(name, value, options)
          );
        },
      },
    });

    // Early authentication gate only. Role authorization is repeated by the
    // dashboard server component and must also guard future server operations.
    const { data, error } = await supabase.auth.getUser();

    if (error || !data?.user) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirectTo', request.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }

    return responseWithCookies;
  } catch {
    // Authentication service/configuration failures must never pass a
    // protected request through.
    return new NextResponse('Admin authentication is unavailable.', { status: 503 });
  }
}
