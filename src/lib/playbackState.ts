import * as FileSystem from 'expo-file-system/legacy';

export type PlaybackStateEntry = {
  durationSeconds?: number;
  hasStartedPlayback?: boolean;
  positionSeconds: number;
  updatedAt: number;
};

export type PlaybackStateMap = Record<string, PlaybackStateEntry>;

let playbackStateCache: PlaybackStateMap | null = null;
let playbackStateMutationQueue: Promise<void> = Promise.resolve();

function getPlaybackStateFileUri(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('This device does not expose an app document directory.');
  }

  return `${FileSystem.documentDirectory}playback-state.json`;
}

async function loadPlaybackState(): Promise<PlaybackStateMap> {
  if (playbackStateCache) {
    return playbackStateCache;
  }

  const fileUri = getPlaybackStateFileUri();
  const info = await FileSystem.getInfoAsync(fileUri);

  if (!info.exists) {
    playbackStateCache = {};
    return playbackStateCache;
  }

  try {
    const raw = await FileSystem.readAsStringAsync(fileUri);
    const parsed = JSON.parse(raw) as PlaybackStateMap;
    playbackStateCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    playbackStateCache = {};
  }

  return playbackStateCache;
}

function clonePlaybackState(state: PlaybackStateMap): PlaybackStateMap {
  return Object.fromEntries(Object.entries(state).map(([uri, entry]) => [uri, { ...entry }]));
}

async function writePlaybackState(nextState: PlaybackStateMap): Promise<void> {
  playbackStateCache = nextState;
  await FileSystem.writeAsStringAsync(getPlaybackStateFileUri(), JSON.stringify(nextState));
}

async function updatePlaybackState(updater: (state: PlaybackStateMap) => PlaybackStateMap | null): Promise<void> {
  playbackStateMutationQueue = playbackStateMutationQueue
    .catch(() => undefined)
    .then(async () => {
      const state = await loadPlaybackState();
      const nextState = updater(state);

      if (!nextState) {
        return;
      }

      await writePlaybackState(nextState);
    });

  await playbackStateMutationQueue;
}

export async function getSavedPlaybackPosition(uri: string): Promise<number> {
  const state = await loadPlaybackState();
  return state[uri]?.positionSeconds ?? 0;
}

export async function getAllPlaybackState(): Promise<PlaybackStateMap> {
  return clonePlaybackState(await loadPlaybackState());
}

export async function savePlaybackPosition(uri: string, positionSeconds: number, durationSeconds?: number): Promise<void> {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    return;
  }

  await updatePlaybackState((state) => {
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

  await updatePlaybackState((state) => {
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

export async function clearPlaybackPosition(uri: string): Promise<void> {
  await updatePlaybackState((state) => {
    if (!(uri in state)) {
      return null;
    }

    const nextState = { ...state };
    delete nextState[uri];
    return nextState;
  });
}

export async function clearAllPlaybackProgress(): Promise<void> {
  await updatePlaybackState((state) =>
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

export async function clearPlaybackProgressForUris(uris: Iterable<string>): Promise<void> {
  const targetUris = new Set(uris);

  if (targetUris.size === 0) {
    return;
  }

  await updatePlaybackState((state) => {
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
