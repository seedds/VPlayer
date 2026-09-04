import { createJsonFileStore } from './jsonStore';

type PlaybackStateEntry = {
  durationSeconds?: number;
  hasStartedPlayback?: boolean;
  positionSeconds: number;
  updatedAt: number;
};

export type PlaybackStateMap = Record<string, PlaybackStateEntry>;

const store = createJsonFileStore<PlaybackStateMap>('playback-state.json', ({ parsed }) => ({
  value: parsed && typeof parsed === 'object' ? (parsed as PlaybackStateMap) : {},
  persist: false,
}));

export async function getSavedPlaybackPosition(uri: string): Promise<number> {
  const state = await store.read();
  return state[uri]?.positionSeconds ?? 0;
}

export async function getAllPlaybackState(): Promise<PlaybackStateMap> {
  return store.read();
}

export async function savePlaybackPosition(uri: string, positionSeconds: number, durationSeconds?: number): Promise<void> {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    return;
  }

  await store.update((state) => {
    const previousEntry = state[uri];

    return {
      ...state,
      [uri]: {
        durationSeconds:
          typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0
            ? durationSeconds
            : previousEntry?.durationSeconds,
        hasStartedPlayback: true,
        positionSeconds,
        updatedAt: Date.now(),
      },
    };
  });
}

export async function savePlaybackDuration(uri: string, durationSeconds: number): Promise<void> {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return;
  }

  await store.update((state) => {
    const previousEntry = state[uri];

    return {
      ...state,
      [uri]: {
        durationSeconds,
        hasStartedPlayback: previousEntry?.hasStartedPlayback ?? false,
        positionSeconds: previousEntry?.positionSeconds ?? 0,
        updatedAt: Date.now(),
      },
    };
  });
}

export async function clearAllPlaybackProgress(): Promise<void> {
  await store.update((state) =>
    Object.fromEntries(
      Object.entries(state).map(([uri, entry]) => [
        uri,
        {
          durationSeconds: entry.durationSeconds,
          hasStartedPlayback: false,
          positionSeconds: 0,
          updatedAt: Date.now(),
        } satisfies PlaybackStateEntry,
      ]),
    ),
  );
}

// Re-keys playback entries from old URIs to new ones, preserving position and
// duration. Used when a rename/move changes a video's URI so a half-watched
// video keeps its progress instead of being reset to "new".
export async function movePlaybackState(pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const moves = pairs.filter(([oldUri, newUri]) => oldUri !== newUri);

  if (moves.length === 0) {
    return;
  }

  await store.update((state) => {
    let didUpdate = false;
    const nextState = { ...state };

    for (const [oldUri, newUri] of moves) {
      const entry = state[oldUri];

      if (!entry) {
        continue;
      }

      delete nextState[oldUri];
      nextState[newUri] = entry;
      didUpdate = true;
    }

    return didUpdate ? nextState : null;
  });
}

// Resets progress (marks "new") for the given URIs without removing the entries.
// Used by "Clear history", where the videos still exist.
export async function clearPlaybackProgressForUris(uris: Iterable<string>): Promise<void> {
  const targetUris = new Set(uris);

  if (targetUris.size === 0) {
    return;
  }

  await store.update((state) => {
    let didUpdate = false;
    const nextState = { ...state };

    for (const uri of targetUris) {
      const entry = state[uri];

      if (!entry) {
        continue;
      }

      nextState[uri] = {
        durationSeconds: entry.durationSeconds,
        hasStartedPlayback: false,
        positionSeconds: 0,
        updatedAt: Date.now(),
      } satisfies PlaybackStateEntry;
      didUpdate = true;
    }

    return didUpdate ? nextState : null;
  });
}

// Removes playback entries entirely. Used when the videos themselves are being
// deleted, so `playback-state.json` does not accumulate dead URIs forever.
export async function removePlaybackEntries(uris: Iterable<string>): Promise<void> {
  const targetUris = new Set(uris);

  if (targetUris.size === 0) {
    return;
  }

  await store.update((state) => {
    let didUpdate = false;
    const nextState = { ...state };

    for (const uri of targetUris) {
      if (uri in nextState) {
        delete nextState[uri];
        didUpdate = true;
      }
    }

    return didUpdate ? nextState : null;
  });
}
