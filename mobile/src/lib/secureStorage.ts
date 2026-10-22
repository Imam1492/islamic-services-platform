import * as SecureStore from 'expo-secure-store';

/**
 * SecureStore chunking storage adapter.
 * iOS Keychain enforces a 2048-byte limit per item.
 * To safely persist Supabase sessions of arbitrary size without data truncation or corruption,
 * this adapter splits values larger than 1800 characters across deterministic chunk keys.
 */
const CHUNK_SIZE = 1800;

function invalidChunkMetadataError(): Error {
  return new Error('Secure storage contains invalid chunk metadata');
}

export const LargeSecureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    const chunkCountStr = await SecureStore.getItemAsync(`${key}_chunk_count`);
    if (chunkCountStr !== null) {
      if (!/^\d+$/.test(chunkCountStr)) throw invalidChunkMetadataError();
      const count = Number(chunkCountStr);
      if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
        throw invalidChunkMetadataError();
      }

      const chunkKeys = Array.from({ length: count }, (_, i) => `${key}_chunk_${i}`);
      const chunks = await Promise.all(chunkKeys.map((chunkKey) => SecureStore.getItemAsync(chunkKey)));
      if (chunks.some((chunk) => chunk === null)) {
        throw new Error('Secure storage contains an incomplete value');
      }
      return chunks.join('');
    }

    // A null result is reserved for confirmed absence. SecureStore read errors propagate.
    return await SecureStore.getItemAsync(key);
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      if (value.length <= CHUNK_SIZE) {
        await SecureStore.setItemAsync(key, value);
        await this.cleanUpChunks(key);
        return;
      }

      const totalChunks = Math.ceil(value.length / CHUNK_SIZE);
      const writes = Array.from({ length: totalChunks }, (_, i) =>
        SecureStore.setItemAsync(
          `${key}_chunk_${i}`,
          value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        )
      );
      await Promise.all(writes);
      await SecureStore.setItemAsync(`${key}_chunk_count`, totalChunks.toString());
      await SecureStore.deleteItemAsync(key);
    } catch {
      throw new Error('Failed to securely persist session storage');
    }
  },

  async removeItem(key: string): Promise<void> {
    await this.cleanUpChunks(key);
    await SecureStore.deleteItemAsync(key);
  },

  async cleanUpChunks(key: string): Promise<void> {
    const chunkCountStr = await SecureStore.getItemAsync(`${key}_chunk_count`);
    if (chunkCountStr === null) return;
    if (!/^\d+$/.test(chunkCountStr)) throw invalidChunkMetadataError();
    const count = Number(chunkCountStr);
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
      throw invalidChunkMetadataError();
    }

    const deletions = Array.from({ length: count }, (_, i) =>
      SecureStore.deleteItemAsync(`${key}_chunk_${i}`)
    );
    deletions.push(SecureStore.deleteItemAsync(`${key}_chunk_count`));
    await Promise.all(deletions);
  },
};
