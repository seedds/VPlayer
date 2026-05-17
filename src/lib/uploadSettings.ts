import * as FileSystem from 'expo-file-system/legacy';

export const MIN_MAX_PARALLEL_UPLOADS = 1;
export const MAX_MAX_PARALLEL_UPLOADS = 5;
export const DEFAULT_MAX_PARALLEL_UPLOADS = 1;

export type UploadSettings = {
  maxParallelUploads: number;
};

let uploadSettingsCache: UploadSettings | null = null;
let uploadSettingsMutationQueue: Promise<void> = Promise.resolve();

function getUploadSettingsFileUri(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('This device does not expose an app document directory.');
  }

  return `${FileSystem.documentDirectory}upload-settings.json`;
}

function createDefaultUploadSettings(): UploadSettings {
  return {
    maxParallelUploads: DEFAULT_MAX_PARALLEL_UPLOADS,
  };
}

export function clampMaxParallelUploads(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return DEFAULT_MAX_PARALLEL_UPLOADS;
  }

  return Math.min(MAX_MAX_PARALLEL_UPLOADS, Math.max(MIN_MAX_PARALLEL_UPLOADS, Math.round(input)));
}

async function loadUploadSettings(): Promise<UploadSettings> {
  if (uploadSettingsCache) {
    return uploadSettingsCache;
  }

  const fileUri = getUploadSettingsFileUri();
  const info = await FileSystem.getInfoAsync(fileUri);

  if (!info.exists) {
    uploadSettingsCache = createDefaultUploadSettings();
    return uploadSettingsCache;
  }

  try {
    const raw = await FileSystem.readAsStringAsync(fileUri);
    const parsed = JSON.parse(raw) as Partial<UploadSettings>;
    uploadSettingsCache = {
      maxParallelUploads: clampMaxParallelUploads(parsed.maxParallelUploads),
    };
  } catch {
    uploadSettingsCache = createDefaultUploadSettings();
  }

  return uploadSettingsCache;
}

async function writeUploadSettings(nextSettings: UploadSettings): Promise<void> {
  uploadSettingsCache = nextSettings;
  await FileSystem.writeAsStringAsync(getUploadSettingsFileUri(), JSON.stringify(nextSettings));
}

export async function getUploadSettings(): Promise<UploadSettings> {
  return await loadUploadSettings();
}

export async function saveUploadSettings(nextSettings: Partial<UploadSettings>): Promise<UploadSettings> {
  let resolvedSettings = createDefaultUploadSettings();

  uploadSettingsMutationQueue = uploadSettingsMutationQueue
    .catch(() => undefined)
    .then(async () => {
      const currentSettings = await loadUploadSettings();
      resolvedSettings = {
        ...currentSettings,
        ...nextSettings,
        maxParallelUploads: clampMaxParallelUploads(nextSettings.maxParallelUploads ?? currentSettings.maxParallelUploads),
      };

      await writeUploadSettings(resolvedSettings);
    });

  await uploadSettingsMutationQueue;
  return resolvedSettings;
}
