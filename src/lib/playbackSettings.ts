import * as FileSystem from 'expo-file-system/legacy';

// The hold-to-speed-up rate is stored in tenths (e.g. 30 == 3.0x) so the value
// persisted on disk is a whole number, matching the Flutter build.
export const MIN_LONG_PRESS_SPEED_TENTHS = 10;
export const MAX_LONG_PRESS_SPEED_TENTHS = 30;
export const DEFAULT_LONG_PRESS_SPEED_TENTHS = 30;
export const LONG_PRESS_SPEED_TENTHS_OPTIONS = [10, 15, 20, 25, 30] as const;

export type PlaybackSettings = {
  longPressSpeedTenths: number;
};

let playbackSettingsCache: PlaybackSettings | null = null;
let playbackSettingsMutationQueue: Promise<void> = Promise.resolve();

function getPlaybackSettingsFileUri(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('This device does not expose an app document directory.');
  }

  return `${FileSystem.documentDirectory}playback-settings.json`;
}

function createDefaultPlaybackSettings(): PlaybackSettings {
  return {
    longPressSpeedTenths: DEFAULT_LONG_PRESS_SPEED_TENTHS,
  };
}

export function clampLongPressSpeedTenths(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return DEFAULT_LONG_PRESS_SPEED_TENTHS;
  }

  return Math.min(MAX_LONG_PRESS_SPEED_TENTHS, Math.max(MIN_LONG_PRESS_SPEED_TENTHS, Math.round(input)));
}

async function loadPlaybackSettings(): Promise<PlaybackSettings> {
  if (playbackSettingsCache) {
    return playbackSettingsCache;
  }

  const fileUri = getPlaybackSettingsFileUri();
  const info = await FileSystem.getInfoAsync(fileUri);

  if (!info.exists) {
    playbackSettingsCache = createDefaultPlaybackSettings();
    return playbackSettingsCache;
  }

  try {
    const raw = await FileSystem.readAsStringAsync(fileUri);
    const parsed = JSON.parse(raw) as Partial<PlaybackSettings>;
    playbackSettingsCache = {
      longPressSpeedTenths: clampLongPressSpeedTenths(parsed.longPressSpeedTenths),
    };
  } catch {
    playbackSettingsCache = createDefaultPlaybackSettings();
  }

  return playbackSettingsCache;
}

async function writePlaybackSettings(nextSettings: PlaybackSettings): Promise<void> {
  playbackSettingsCache = nextSettings;
  await FileSystem.writeAsStringAsync(getPlaybackSettingsFileUri(), JSON.stringify(nextSettings));
}

export async function getPlaybackSettings(): Promise<PlaybackSettings> {
  return await loadPlaybackSettings();
}

export async function savePlaybackSettings(nextSettings: Partial<PlaybackSettings>): Promise<PlaybackSettings> {
  let resolvedSettings = createDefaultPlaybackSettings();

  playbackSettingsMutationQueue = playbackSettingsMutationQueue
    .catch(() => undefined)
    .then(async () => {
      const currentSettings = await loadPlaybackSettings();
      resolvedSettings = {
        ...currentSettings,
        ...nextSettings,
        longPressSpeedTenths: clampLongPressSpeedTenths(
          nextSettings.longPressSpeedTenths ?? currentSettings.longPressSpeedTenths,
        ),
      };

      await writePlaybackSettings(resolvedSettings);
    });

  await playbackSettingsMutationQueue;
  return resolvedSettings;
}
