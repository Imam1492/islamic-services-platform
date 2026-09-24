import * as SecureStore from 'expo-secure-store';

/**
 * SecureStore chunking storage adapter.
 * iOS Keychain enforces a 2048-byte limit per item.
 * To safely persist Supabase sessions of arbitrary size without data truncation or corruption,
 * this adapter splits values larger than 1800 characters across deterministic chunk keys.
 */
const CHUNK_SIZE = 1800;

export const LargeSecureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    try {
      const chunkCountStr = await SecureStore.getItemAsync(`${key}_chunk_count`);
      if (chunkCountStr) {
        const count = parseInt(chunkCountStr, 10);
        if (!isNaN(count) && count > 0) {
          const chunkPromises: Promise<string | null>[] = [];
          for (let i = 0; i < count; i++) {
            chunkPromises.push(SecureStore.getItemAsync(`${key}_chunk_${i}`));
          }
          const chunks = await Promise.all(chunkPromises);
          if (chunks.some((c) => c === null)) {
            return null;
          }
          return chunks.join('');
        }
      }
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      if (value.length <= CHUNK_SIZE) {
        await SecureStore.setItemAsync(key, value);
        await this.cleanUpChunks(key);
        return;
      }

      const totalChunks = Math.ceil(value.length / CHUNK_SIZE);
      const writePromises: Promise<void>[] = [];

      for (let i = 0; i < totalChunks; i++) {
        const chunk = value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        writePromises.push(SecureStore.setItemAsync(`${key}_chunk_${i}`, chunk));
      }

      await Promise.all(writePromises);
      await SecureStore.setItemAsync(`${key}_chunk_count`, totalChunks.toString());

      // Remove any existing non-chunked key
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Ignore if base key did not exist
      }
    } catch {
      throw new Error(`Failed to securely persist session storage`);
    }
  },

  async removeItem(key: string): Promise<void> {
    try {
      await this.cleanUpChunks(key);
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Ignore if base key did not exist
      }
    } catch {
      // Ignore removal failures during cleanup
    }
  },

  async cleanUpChunks(key: string): Promise<void> {
    try {
      const chunkCountStr = await SecureStore.getItemAsync(`${key}_chunk_count`);
      if (chunkCountStr) {
        const count = parseInt(chunkCountStr, 10);
        if (!isNaN(count) && count > 0) {
          const deletePromises: Promise<void>[] = [];
          for (let i = 0; i < count; i++) {
            deletePromises.push(SecureStore.deleteItemAsync(`${key}_chunk_${i}`));
          }
          deletePromises.push(SecureStore.deleteItemAsync(`${key}_chunk_count`));
          await Promise.allSettled(deletePromises);
        }
      }
    } catch {
      // Ignore chunk cleanup errors
    }
  },
};
