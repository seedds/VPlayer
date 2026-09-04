import * as FileSystem from 'expo-file-system/legacy';

import { getDocumentRoot } from './videoLibrary';

export type Settings = {
  maxParallelUploads: number;
  subtitleFontSize: number;
  longPressSpeedTenths: number;
};

export type SettingKey = keyof Settings;

type SettingLimit = {
  min: number;
  max: number;
  default: number;
  options: readonly number[];
};

// One source of truth for every numeric setting: its bounds, default, and the
// choices shown in the picker screens. `longPressSpeedTenths` is stored in
// tenths (30 == 3.0x) so the persisted value stays a whole number.
export const SETTING_LIMITS: { readonly [K in SettingKey]: SettingLimit } = {
  maxParallelUploads: { min: 1, max: 5, default: 3, options: [1, 2, 3, 4, 5] },
  subtitleFontSize: { min: 24, max: 48, default: 36, options: [24, 28, 32, 36, 40, 44, 48] },
  longPressSpeedTenths: { min: 10, max: 30, default: 30, options: [10, 15, 20, 25, 30] },
};

// The legacy per-setting files, migrated once into app-settings.json. Each maps
// its old JSON field onto a unified setting key.
const LEGACY_SETTINGS_FILES: ReadonlyArray<{ fileName: string; key: SettingKey; field: string }> = [
  { fileName: 'upload-settings.json', key: 'maxParallelUploads', field: 'maxParallelUploads' },
  { fileName: 'subtitle-settings.json', key: 'subtitleFontSize', field: 'subtitleFontSize' },
  { fileName: 'playback-settings.json', key: 'longPressSpeedTenths', field: 'longPressSpeedTenths' },
];

let settingsCache: Settings | null = null;
let settingsMutationQueue: Promise<void> = Promise.resolve();

function getSettingsFileUri(): string {
  return `${getDocumentRoot()}app-settings.json`;
}

export function clampSetting(key: SettingKey, input: unknown): number {
  const limit = SETTING_LIMITS[key];

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return limit.default;
  }

  return Math.min(limit.max, Math.max(limit.min, Math.round(input)));
}

function createDefaultSettings(): Settings {
  return {
    maxParallelUploads: SETTING_LIMITS.maxParallelUploads.default,
    subtitleFontSize: SETTING_LIMITS.subtitleFontSize.default,
    longPressSpeedTenths: SETTING_LIMITS.longPressSpeedTenths.default,
  };
}

function clampAll(partial: Partial<Record<SettingKey, unknown>>): Settings {
  return {
    maxParallelUploads: clampSetting('maxParallelUploads', partial.maxParallelUploads),
    subtitleFontSize: clampSetting('subtitleFontSize', partial.subtitleFontSize),
    longPressSpeedTenths: clampSetting('longPressSpeedTenths', partial.longPressSpeedTenths),
  };
}

async function readLegacySettings(): Promise<Partial<Record<SettingKey, unknown>>> {
  const migrated: Partial<Record<SettingKey, unknown>> = {};

  await Promise.all(
    LEGACY_SETTINGS_FILES.map(async ({ fileName, key, field }) => {
      try {
        const fileUri = `${getDocumentRoot()}${fileName}`;
        const info = await FileSystem.getInfoAsync(fileUri);

        if (!info.exists) {
          return;
        }

        const parsed = JSON.parse(await FileSystem.readAsStringAsync(fileUri)) as Record<string, unknown>;
        migrated[key] = parsed[field];
      } catch {
        // A missing or corrupt legacy file just falls back to the default.
      }
    }),
  );

  return migrated;
}

async function deleteLegacySettings(): Promise<void> {
  await Promise.all(
    LEGACY_SETTINGS_FILES.map(({ fileName }) =>
      FileSystem.deleteAsync(`${getDocumentRoot()}${fileName}`, { idempotent: true }).catch(() => undefined),
    ),
  );
}

async function loadSettings(): Promise<Settings> {
  if (settingsCache) {
    return settingsCache;
  }

  const fileUri = getSettingsFileUri();
  const info = await FileSystem.getInfoAsync(fileUri);

  if (!info.exists) {
    // First launch on this build: adopt any values from the three legacy files,
    // write the unified file, then remove the old ones.
    const legacy = await readLegacySettings();
    settingsCache = clampAll(legacy);
    await writeSettings(settingsCache);
    await deleteLegacySettings();
    return settingsCache;
  }

  try {
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(fileUri)) as Partial<Record<SettingKey, unknown>>;
    settingsCache = clampAll(parsed);
  } catch {
    settingsCache = createDefaultSettings();
  }

  return settingsCache;
}

async function writeSettings(nextSettings: Settings): Promise<void> {
  settingsCache = nextSettings;
  await FileSystem.writeAsStringAsync(getSettingsFileUri(), JSON.stringify(nextSettings));
}

export async function getSettings(): Promise<Settings> {
  return loadSettings();
}

export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  let resolvedSettings = createDefaultSettings();

  settingsMutationQueue = settingsMutationQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await loadSettings();
      resolvedSettings = clampAll({ ...current, ...partial });
      await writeSettings(resolvedSettings);
    });

  await settingsMutationQueue;
  return resolvedSettings;
}
