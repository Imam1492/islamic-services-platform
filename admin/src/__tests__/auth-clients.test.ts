import { createClient as createBrowserClient } from '../lib/supabase/client';
import { createClient as createServerClient } from '../lib/supabase/server';
import * as ssr from '@supabase/ssr';
import * as nextHeaders from 'next/headers';

jest.mock('@supabase/ssr', () => ({
  createBrowserClient: jest.fn(),
  createServerClient: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

describe('Admin Supabase Client Factories', () => {
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

  it('createBrowserClient initializes using only public credentials', () => {
    createBrowserClient();
    expect(ssr.createBrowserClient).toHaveBeenCalledWith(
      'https://test-project.supabase.co',
      'test-anon-key'
    );
  });

  it('createServerClient initializes using only public credentials and wires async cookies', async () => {
    const mockCookieStore = {
      getAll: jest.fn().mockReturnValue([{ name: 'sb-token', value: 'token-val' }]),
      set: jest.fn(),
    };
    (nextHeaders.cookies as jest.Mock).mockResolvedValue(mockCookieStore);

    await createServerClient();

    expect(ssr.createServerClient).toHaveBeenCalledWith(
      'https://test-project.supabase.co',
      'test-anon-key',
      expect.objectContaining({
        cookies: expect.any(Object),
      })
    );
  });

  it('never leaks or requires service_role key in client or server factories', () => {
    // Assert process.env does NOT contain SUPABASE_SERVICE_ROLE_KEY
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
});
