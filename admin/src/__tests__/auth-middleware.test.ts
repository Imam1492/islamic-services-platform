/**
 * @jest-environment node
 */
import { updateSession } from '../lib/supabase/middleware';
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(),
}));

describe('Admin Authentication Middleware & Route Protection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('redirects unauthenticated user accessing /dashboard to /login with redirectTo parameter', async () => {
    (createServerClient as jest.Mock).mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: new Error('Unauthorized'),
        }),
      },
    });

    const request = new NextRequest('http://localhost:3000/dashboard/overview');
    const response = await updateSession(request);

    expect(response.status).toBe(307); // NextResponse.redirect default
    const location = response.headers.get('location');
    expect(location).toContain('/login?redirectTo=%2Fdashboard%2Foverview');
  });

  it('allows authenticated user to access /dashboard', async () => {
    (createServerClient as jest.Mock).mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: 'admin-user-uuid', email: 'admin@example.com' } },
          error: null,
        }),
      },
    });

    const request = new NextRequest('http://localhost:3000/dashboard');
    const response = await updateSession(request);

    // Passes through without redirect
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows unauthenticated user to access public routes like / or /login without redirect', async () => {
    (createServerClient as jest.Mock).mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: null,
        }),
      },
    });

    const requestRoot = new NextRequest('http://localhost:3000/');
    const responseRoot = await updateSession(requestRoot);
    expect(responseRoot.status).toBe(200);
    expect(responseRoot.headers.get('location')).toBeNull();

    const requestLogin = new NextRequest('http://localhost:3000/login');
    const responseLogin = await updateSession(requestLogin);
    expect(responseLogin.status).toBe(200);
    expect(responseLogin.headers.get('location')).toBeNull();
  });

  it('handles missing environment variables safely without crashing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const request = new NextRequest('http://localhost:3000/dashboard');
    const response = await updateSession(request);

    expect(response.status).toBe(200);
    expect(createServerClient).not.toHaveBeenCalled();
  });
});
