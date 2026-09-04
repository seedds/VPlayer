import * as FileSystem from 'expo-file-system/legacy';

export const MIN_SUBTITLE_FONT_SIZE = 24;
export const MAX_SUBTITLE_FONT_SIZE = 48;
export const DEFAULT_SUBTITLE_FONT_SIZE = 36;
export const SUBTITLE_FONT_SIZE_OPTIONS = [24, 28, 32, 36, 40, 44, 48] as const;

export type SubtitleSettings = {
  subtitleFontSize: number;
};

let subtitleSettingsCache: SubtitleSettings | null = null;
let subtitleSettingsMutationQueue: Promise<void> = Promise.resolve();

function getSubtitleSettingsFileUri(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('This device does not expose an app document directory.');
  }

  return `${FileSystem.documentDirectory}subtitle-settings.json`;
}

function createDefaultSubtitleSettings(): SubtitleSettings {
  return {
    subtitleFontSize: DEFAULT_SUBTITLE_FONT_SIZE,
  };
}

export function clampSubtitleFontSize(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return DEFAULT_SUBTITLE_FONT_SIZE;
  }

  return Math.min(MAX_SUBTITLE_FONT_SIZE, Math.max(MIN_SUBTITLE_FONT_SIZE, Math.round(input)));
}

async function loadSubtitleSettings(): Promise<SubtitleSettings> {
  if (subtitleSettingsCache) {
    return subtitleSettingsCache;
  }

  const fileUri = getSubtitleSettingsFileUri();
  const info = await FileSystem.getInfoAsync(fileUri);

  if (!info.exists) {
    subtitleSettingsCache = createDefaultSubtitleSettings();
    return subtitleSettingsCache;
  }

  try {
    const raw = await FileSystem.readAsStringAsync(fileUri);
    const parsed = JSON.parse(raw) as Partial<SubtitleSettings>;
    subtitleSettingsCache = {
      subtitleFontSize: clampSubtitleFontSize(parsed.subtitleFontSize),
    };
  } catch {
    subtitleSettingsCache = createDefaultSubtitleSettings();
  }

  return subtitleSettingsCache;
}

async function writeSubtitleSettings(nextSettings: SubtitleSettings): Promise<void> {
  subtitleSettingsCache = nextSettings;
  await FileSystem.writeAsStringAsync(getSubtitleSettingsFileUri(), JSON.stringify(nextSettings));
}

export async function getSubtitleSettings(): Promise<SubtitleSettings> {
  return await loadSubtitleSettings();
}

export async function saveSubtitleSettings(nextSettings: Partial<SubtitleSettings>): Promise<SubtitleSettings> {
  let resolvedSettings = createDefaultSubtitleSettings();

  subtitleSettingsMutationQueue = subtitleSettingsMutationQueue
    .catch(() => undefined)
    .then(async () => {
      const currentSettings = await loadSubtitleSettings();
      resolvedSettings = {
        ...currentSettings,
        ...nextSettings,
        subtitleFontSize: clampSubtitleFontSize(nextSettings.subtitleFontSize ?? currentSettings.subtitleFontSize),
      };

      await writeSubtitleSettings(resolvedSettings);
    });

  await subtitleSettingsMutationQueue;
  return resolvedSettings;
}
