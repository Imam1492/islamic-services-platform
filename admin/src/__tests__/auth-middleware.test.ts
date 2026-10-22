/**
 * @jest-environment node
 */
import { proxy, config } from '../proxy';
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

jest.mock('@supabase/ssr', () => ({ createServerClient: jest.fn() }));

describe('Admin Proxy authentication gate', () => {
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

  it('uses the Next.js 16 Proxy convention for dashboard paths', () => {
    expect(config.matcher).toEqual(['/dashboard/:path*']);
  });

  it('redirects anonymous and expired sessions to login', async () => {
    (createServerClient as jest.Mock).mockReturnValue({
      auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: new Error('Session expired') }) },
    });
    const response = await proxy(new NextRequest('http://localhost:3000/dashboard/overview'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login?redirectTo=%2Fdashboard%2Foverview');
  });

  it('passes a verified user through the early gate without checking role there', async () => {
    const rpc = jest.fn();
    (createServerClient as jest.Mock).mockReturnValue({
      auth: { getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'ordinary-user' } }, error: null }) },
      rpc,
    });
    const response = await proxy(new NextRequest('http://localhost:3000/dashboard'));
    expect(response.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['URL', 'NEXT_PUBLIC_SUPABASE_URL'],
    ['anon key', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  ])('fails closed when the Supabase %s is missing', async (_label, key) => {
    delete process.env[key];
    const response = await proxy(new NextRequest('http://localhost:3000/dashboard'));
    expect(response.status).toBe(503);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('leaves public routes available if Supabase configuration is missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const response = await proxy(new NextRequest('http://localhost:3000/login'));
    expect(response.status).toBe(200);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('fails closed if session verification throws', async () => {
    (createServerClient as jest.Mock).mockImplementation(() => { throw new Error('Auth service unavailable'); });
    const response = await proxy(new NextRequest('http://localhost:3000/dashboard'));
    expect(response.status).toBe(503);
  });

  it('does not treat unrelated dashboard-prefixed paths as protected', async () => {
    const response = await proxy(new NextRequest('http://localhost:3000/dashboard-preview'));
    expect(response.status).toBe(200);
    expect(createServerClient).not.toHaveBeenCalled();
  });
});
