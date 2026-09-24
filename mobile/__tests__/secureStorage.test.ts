import { LargeSecureStoreAdapter } from '../src/lib/secureStorage';
import * as SecureStore from 'expo-secure-store';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    __store: store,
    __clear: () => store.clear(),
  };
});

describe('LargeSecureStoreAdapter', () => {
  beforeEach(() => {
    (SecureStore as unknown as { __clear: () => void }).__clear();
    jest.clearAllMocks();
  });

  it('stores and retrieves small values without chunking', async () => {
    const key = 'test_token';
    const value = 'sample-jwt-token-small';

    await LargeSecureStoreAdapter.setItem(key, value);
    const retrieved = await LargeSecureStoreAdapter.getItem(key);

    expect(retrieved).toBe(value);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(key, value);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      `${key}_chunk_count`,
      expect.anything()
    );
  });

  it('chunks large values exceeding 1800 characters across deterministic keys', async () => {
    const key = 'large_session';
    // Generate 4500-character payload (requires 3 chunks of 1800, 1800, 900)
    const value = 'A'.repeat(1800) + 'B'.repeat(1800) + 'C'.repeat(900);

    await LargeSecureStoreAdapter.setItem(key, value);
    const retrieved = await LargeSecureStoreAdapter.getItem(key);

    expect(retrieved).toBe(value);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(`${key}_chunk_0`, 'A'.repeat(1800));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(`${key}_chunk_1`, 'B'.repeat(1800));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(`${key}_chunk_2`, 'C'.repeat(900));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(`${key}_chunk_count`, '3');
  });

  it('cleans up chunked keys and count on removal', async () => {
    const key = 'large_session_to_delete';
    const value = 'X'.repeat(3000);

    await LargeSecureStoreAdapter.setItem(key, value);
    await LargeSecureStoreAdapter.removeItem(key);

    const retrieved = await LargeSecureStoreAdapter.getItem(key);
    expect(retrieved).toBeNull();

    const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
    expect(store.has(`${key}_chunk_0`)).toBe(false);
    expect(store.has(`${key}_chunk_count`)).toBe(false);
  });

  it('returns null gracefully when key does not exist', async () => {
    const retrieved = await LargeSecureStoreAdapter.getItem('non_existent_key');
    expect(retrieved).toBeNull();
  });

  it('returns null if any chunk is missing in a chunked record', async () => {
    const key = 'corrupt_session';
    const value = 'Y'.repeat(2500);

    await LargeSecureStoreAdapter.setItem(key, value);

    // Delete chunk 1
    const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
    store.delete(`${key}_chunk_1`);

    const retrieved = await LargeSecureStoreAdapter.getItem(key);
    expect(retrieved).toBeNull();
  });
});
