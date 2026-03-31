import * as FileSystem from 'expo-file-system/legacy';

import type { LibraryItem, VideoItem } from './types';

export const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
export const ALLOWED_SUBTITLE_EXTENSIONS = ['.srt'];
export const ALLOWED_UPLOAD_EXTENSIONS = [...ALLOWED_VIDEO_EXTENSIONS, ...ALLOWED_SUBTITLE_EXTENSIONS];

function getDocumentRoot(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('This device does not expose an app document directory.');
  }

  return FileSystem.documentDirectory;
}

export function getVideoDirectory(): string {
  return `${getDocumentRoot()}videos/`;
}

export function getTempUploadDirectory(): string {
  return `${getDocumentRoot()}uploads-tmp/`;
}

export function getFileExtension(fileName: string): string {
  const parts = fileName.toLowerCase().match(/\.[^.]+$/);
  return parts?.[0] ?? '';
}

export function getFileBaseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

export function isAllowedVideoFileName(fileName: string): boolean {
  return ALLOWED_VIDEO_EXTENSIONS.includes(getFileExtension(fileName));
}

export function isAllowedSubtitleFileName(fileName: string): boolean {
  return ALLOWED_SUBTITLE_EXTENSIONS.includes(getFileExtension(fileName));
}

export function isAllowedLibraryFileName(fileName: string): boolean {
  return isAllowedVideoFileName(fileName) || isAllowedSubtitleFileName(fileName);
}

export async function ensureAppDirectories(): Promise<void> {
  await FileSystem.makeDirectoryAsync(getVideoDirectory(), { intermediates: true });
  await FileSystem.makeDirectoryAsync(getTempUploadDirectory(), { intermediates: true });
}

export async function clearTempUploads(): Promise<void> {
  await ensureAppDirectories();

  const entries = await FileSystem.readDirectoryAsync(getTempUploadDirectory());

  await Promise.all(
    entries.map((entry) =>
      FileSystem.deleteAsync(`${getTempUploadDirectory()}${entry}`, { idempotent: true }).catch(() => undefined),
    ),
  );
}

export function sanitizeFileName(input: string): string {
  const leafName = input.split(/[\\/]/).pop()?.trim() || 'video.mp4';
  const cleaned = leafName.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ');
  const extension = getFileExtension(cleaned) || '.mp4';
  const baseName = cleaned.slice(0, cleaned.length - extension.length).replace(/\.+$/g, '').trim() || 'video';

  return `${baseName}${extension.toLowerCase()}`;
}

export async function createUploadTarget(fileName: string): Promise<{
  fileName: string;
  finalUri: string;
  tempUri: string;
}> {
  await ensureAppDirectories();

  const sanitized = sanitizeFileName(fileName);

  if (!isAllowedLibraryFileName(sanitized)) {
    throw new Error(`Unsupported file type. Use ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`);
  }

  const extension = getFileExtension(sanitized);
  const rawBaseName = sanitized.slice(0, sanitized.length - extension.length);
  let counter = 0;

  while (true) {
    const suffix = counter === 0 ? '' : `-${counter}`;
    const candidateName = `${rawBaseName}${suffix}${extension}`;
    const candidateUri = `${getVideoDirectory()}${candidateName}`;
    const info = await FileSystem.getInfoAsync(candidateUri);

    if (!info.exists) {
      const uploadKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      return {
        fileName: candidateName,
        finalUri: candidateUri,
        tempUri: `${getTempUploadDirectory()}${uploadKey}.upload`,
      };
    }

    counter += 1;
  }
}

export async function listLibraryItems(): Promise<LibraryItem[]> {
  await ensureAppDirectories();

  const entries = await FileSystem.readDirectoryAsync(getVideoDirectory());
  const items = await Promise.all(
    entries.filter(isAllowedLibraryFileName).map(async (entry) => {
      const uri = `${getVideoDirectory()}${entry}`;
      const info = await FileSystem.getInfoAsync(uri);

      if (!info.exists || info.isDirectory) {
        return null;
      }

      return {
        id: uri,
        kind: isAllowedSubtitleFileName(entry) ? 'subtitle' : 'video',
        name: entry,
        uri,
        size: info.size ?? 0,
        modified: info.modificationTime ? info.modificationTime * 1000 : Date.now(),
        extension: getFileExtension(entry),
      } satisfies LibraryItem;
    }),
  );

  return items
    .filter((item): item is LibraryItem => item !== null)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
}

export function getVideoItems(items: LibraryItem[]): VideoItem[] {
  return items.filter((item): item is VideoItem => item.kind === 'video');
}

export async function findMatchingSubtitleUri(video: VideoItem): Promise<string | null> {
  await ensureAppDirectories();

  const baseName = getFileBaseName(video.name).toLocaleLowerCase();
  const entries = await FileSystem.readDirectoryAsync(getVideoDirectory());
  const matchingEntry = entries.find(
    (entry) => isAllowedSubtitleFileName(entry) && getFileBaseName(entry).toLocaleLowerCase() === baseName,
  );

  return matchingEntry ? `${getVideoDirectory()}${matchingEntry}` : null;
}

export async function deleteLibraryItem(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true });
}
