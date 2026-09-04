import * as FileSystem from 'expo-file-system/legacy';

import { createJsonFileStore } from './jsonStore';
import { getDocumentRoot } from './videoLibrary';

export type Settings = {
  maxParallelUploads: number;
  subtitleFontSize: number;
  longPressSpeedTenths: number;
};

export type SettingKey = keyof Settings;

type SettingMeta = {
  default: number;
  options: readonly number[];
  // Header title of the picker screen.
  navTitle: string;
  // Panel/section title shown next to this setting.
  title: string;
  subtitle: string;
  // Label on the row that opens the picker.
  rowLabel: string;
  // Optional note shown under the row.
  footnote?: string;
  // Formats a stored value for display (e.g. tenths -> "3.0x").
  formatLabel?: (value: number) => string;
};

// One source of truth for every numeric setting: its choices, default, and all
// the copy the picker/settings screens render. `longPressSpeedTenths` is stored
// in tenths (30 == 3.0x) so the persisted value stays a whole number. `min`/`max`
// are the first/last option, so a setting's bounds cannot drift from its choices.
export const SETTING_META: { readonly [K in SettingKey]: SettingMeta } = {
  maxParallelUploads: {
    default: 3,
    options: [1, 2, 3, 4, 5],
    navTitle: 'Concurrent Uploads',
    title: 'Concurrent uploads',
    subtitle: 'Choose how many files the browser uploader can send in parallel.',
    rowLabel: 'Select upload count',
    footnote: 'Refresh the browser upload page to apply changes.',
  },
  subtitleFontSize: {
    default: 36,
    options: [24, 28, 32, 36, 40, 44, 48],
    navTitle: 'Subtitle Size',
    title: 'Subtitle size',
    subtitle: 'Choose how large subtitles appear during playback.',
    rowLabel: 'Select subtitle size',
  },
  longPressSpeedTenths: {
    default: 30,
    options: [10, 15, 20, 25, 30],
    navTitle: 'Hold-to-Speed-Up',
    title: 'Hold-to-speed-up rate',
    subtitle: 'Press and hold the video to temporarily play at this speed.',
    rowLabel: 'Select speed',
    formatLabel: (value) => `${(value / 10).toFixed(1)}\u00d7`,
  },
};

export const DEFAULT_SETTINGS: Settings = {
  maxParallelUploads: SETTING_META.maxParallelUploads.default,
  subtitleFontSize: SETTING_META.subtitleFontSize.default,
  longPressSpeedTenths: SETTING_META.longPressSpeedTenths.default,
};

// The legacy per-setting files, migrated once into app-settings.json. Each maps
// its old JSON field onto a unified setting key.
const LEGACY_SETTINGS_FILES: ReadonlyArray<{ fileName: string; key: SettingKey; field: string }> = [
  { fileName: 'upload-settings.json', key: 'maxParallelUploads', field: 'maxParallelUploads' },
  { fileName: 'subtitle-settings.json', key: 'subtitleFontSize', field: 'subtitleFontSize' },
  { fileName: 'playback-settings.json', key: 'longPressSpeedTenths', field: 'longPressSpeedTenths' },
];

export function clampSetting(key: SettingKey, input: unknown): number {
  const { options, default: defaultValue } = SETTING_META[key];
  const min = options[0];
  const max = options[options.length - 1];

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, Math.round(input)));
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

const store = createJsonFileStore<Settings>('app-settings.json', async ({ exists, parsed }) => {
  if (!exists) {
    // First launch on this build: adopt any values from the three legacy files,
    // write the unified file, then remove the old ones.
    const legacy = await readLegacySettings();
    const value = clampAll(legacy);
    await deleteLegacySettings();
    return { value, persist: true };
  }

  return {
    value: clampAll((parsed as Partial<Record<SettingKey, unknown>>) ?? {}),
    persist: false,
  };
});

export async function getSettings(): Promise<Settings> {
  return store.read();
}

export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  return store.update((current) => clampAll({ ...current, ...partial }));
}
