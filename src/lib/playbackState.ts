import * as FileSystem from 'expo-file-system/legacy';

export type PlaybackStateEntry = {
  durationSeconds?: number;
  hasStartedPlayback?: boolean;
  positionSeconds: number;
  updatedAt: number;
};

export type PlaybackStateMap = Record<string, PlaybackStateEntry>;

let playbackStateCache: PlaybackStateMap | null = null;

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

async function writePlaybackState(nextState: PlaybackStateMap): Promise<void> {
  playbackStateCache = nextState;
  await FileSystem.writeAsStringAsync(getPlaybackStateFileUri(), JSON.stringify(nextState));
}

export async function getSavedPlaybackPosition(uri: string): Promise<number> {
  const state = await loadPlaybackState();
  return state[uri]?.positionSeconds ?? 0;
}

export async function getAllPlaybackState(): Promise<PlaybackStateMap> {
  return loadPlaybackState();
}

export async function savePlaybackPosition(uri: string, positionSeconds: number, durationSeconds?: number): Promise<void> {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    return;
  }

  const state = await loadPlaybackState();
  const previousEntry = state[uri];
  const nextState: PlaybackStateMap = {
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

  await writePlaybackState(nextState);
}

export async function savePlaybackDuration(uri: string, durationSeconds: number): Promise<void> {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return;
  }

  const state = await loadPlaybackState();
  const previousEntry = state[uri];

  const nextState: PlaybackStateMap = {
    ...state,
    [uri]: {
      durationSeconds,
      hasStartedPlayback: previousEntry?.hasStartedPlayback ?? false,
      positionSeconds: previousEntry?.positionSeconds ?? 0,
      updatedAt: Date.now(),
    },
  };

  await writePlaybackState(nextState);
}

export async function clearPlaybackPosition(uri: string): Promise<void> {
  const state = await loadPlaybackState();

  if (!(uri in state)) {
    return;
  }

  const nextState = { ...state };
  delete nextState[uri];
  await writePlaybackState(nextState);
}

export async function clearAllPlaybackProgress(): Promise<void> {
  const state = await loadPlaybackState();

  const nextState: PlaybackStateMap = Object.fromEntries(
    Object.entries(state).map(([uri, entry]) => [
      uri,
      {
        durationSeconds: entry.durationSeconds,
        hasStartedPlayback: false,
        positionSeconds: 0,
        updatedAt: Date.now(),
      } satisfies PlaybackStateEntry,
    ]),
  );

  await writePlaybackState(nextState);
}
