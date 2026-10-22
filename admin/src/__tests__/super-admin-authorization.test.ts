/**
 * @jest-environment node
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('../lib/supabase/server', () => ({ createClient: jest.fn() }));
jest.mock('next/navigation', () => ({
  redirect: jest.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  notFound: jest.fn(() => { throw new Error('not-found'); }),
}));

import { createClient } from '../lib/supabase/server';
import { checkCurrentSuperAdmin, requireSuperAdmin } from '../lib/auth/super-admin';
import { notFound, redirect } from 'next/navigation';

describe('server-side super-admin authorization', () => {
  const originalEnv = process.env;
  const getUser = jest.fn();
  const rpc = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-anon-key',
    };
    (createClient as jest.Mock).mockResolvedValue({ auth: { getUser }, rpc });
    getUser.mockResolvedValue({ data: { user: { id: 'verified-id' } }, error: null });
    rpc.mockResolvedValue({ data: false, error: null });
  });

  afterEach(() => { process.env = originalEnv; });

  it.each([
    ['user', { app_metadata: { role: 'user' } }],
    ['provider', { app_metadata: { role: 'provider' } }],
    ['area_admin', { app_metadata: { role: 'area_admin' } }],
    ['spoofed super_admin metadata', { user_metadata: { role: 'super_admin' } }],
  ])('denies %s when the authoritative RPC returns false', async (_name, metadata) => {
    getUser.mockResolvedValue({ data: { user: { id: 'verified-id', ...metadata } }, error: null });
    await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'forbidden' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('current_user_is_super_admin');
    expect(rpc.mock.calls[0]).toHaveLength(1);
  });

  it('allows access only when the server RPC returns true', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'authorized' });
    expect(rpc).toHaveBeenCalledWith('current_user_is_super_admin');
  });

  it('denies an absent or expired session without a role lookup', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new Error('Expired') });
    await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'unauthenticated' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails closed if session verification reports an error for a user', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'verified-id' } }, error: new Error('Auth error') });
    await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'unavailable' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'])(
    'fails closed when %s is missing', async (key) => {
      delete process.env[key];
      await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'unavailable' });
      expect(createClient).not.toHaveBeenCalled();
    }
  );

  it('fails closed on RPC errors, exceptions, missing data, and malformed results', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('RPC missing') });
    await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'unavailable' });
    rpc.mockRejectedValueOnce(new Error('RPC failed'));
    await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'unavailable' });
    rpc.mockResolvedValueOnce({ data: undefined, error: null });
    await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'unavailable' });
    rpc.mockResolvedValueOnce({ data: 'true', error: null });
    await expect(checkCurrentSuperAdmin()).resolves.toEqual({ status: 'unavailable' });
  });

  it('redirects anonymous users and hides users denied by the page boundary', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireSuperAdmin()).rejects.toThrow('redirect:/login');
    expect(redirect).toHaveBeenCalledWith('/login');
    getUser.mockResolvedValue({ data: { user: { id: 'ordinary' } }, error: null });
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(requireSuperAdmin()).rejects.toThrow('not-found');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('throws closed when the authorization service is unavailable', async () => {
    rpc.mockRejectedValue(new Error('unavailable'));
    await expect(requireSuperAdmin()).rejects.toThrow('Admin authorization could not be verified.');
  });
});
