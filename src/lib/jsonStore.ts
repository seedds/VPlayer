import * as FileSystem from 'expo-file-system/legacy';

import { getDocumentRoot } from './videoLibrary';

// What a normalizer produces on first load: the value to serve, and whether the
// store should write it back immediately (used only for settings' one-time legacy
// migration; a corrupt or valid file is served without a rewrite).
export type NormalizeResult<T> = {
  value: T;
  persist: boolean;
};

// Given the file's parsed contents (or `undefined` when it is missing or corrupt,
// disambiguated by `exists`), produce the initial in-memory value.
export type Normalize<T> = (context: { exists: boolean; parsed: unknown }) => Promise<NormalizeResult<T>> | NormalizeResult<T>;

export type JsonFileStore<T> = {
  read(): Promise<T>;
  // Applies `updater` under a serialized mutation queue. Returning `null` skips
  // the write (no-op update).
  update(updater: (current: T) => T | null): Promise<T>;
};

// A cached, serialized JSON file backing store. Collapses the identical
// cache + mutation-queue + read/write machinery that `playbackState` and
// `settings` each carried.
export function createJsonFileStore<T>(fileName: string, normalize: Normalize<T>): JsonFileStore<T> {
  let cache: T | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();

  function getFileUri(): string {
    return `${getDocumentRoot()}${fileName}`;
  }

  async function write(nextValue: T): Promise<void> {
    cache = nextValue;
    await FileSystem.writeAsStringAsync(getFileUri(), JSON.stringify(nextValue));
  }

  async function load(): Promise<T> {
    if (cache) {
      return cache;
    }

    const fileUri = getFileUri();
    const info = await FileSystem.getInfoAsync(fileUri);

    let context: { exists: boolean; parsed: unknown } = { exists: false, parsed: undefined };

    if (info.exists) {
      try {
        context = { exists: true, parsed: JSON.parse(await FileSystem.readAsStringAsync(fileUri)) };
      } catch {
        context = { exists: true, parsed: undefined };
      }
    }

    const { value, persist } = await normalize(context);
    cache = value;

    if (persist) {
      await write(value);
    }

    return value;
  }

  async function update(updater: (current: T) => T | null): Promise<T> {
    let resolved: T | null = null;

    mutationQueue = mutationQueue
      .catch(() => undefined)
      .then(async () => {
        const current = await load();
        const next = updater(current);

        if (next === null) {
          resolved = current;
          return;
        }

        await write(next);
        resolved = next;
      });

    await mutationQueue;
    return resolved ?? (await load());
  }

  return { read: load, update };
}
