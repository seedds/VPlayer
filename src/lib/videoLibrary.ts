import * as FileSystem from 'expo-file-system/legacy';

import type { FolderItem, LibraryItem, VideoItem } from './types';
import { getThumbnailDirectory } from './videoThumbnails';

const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const ALLOWED_SUBTITLE_EXTENSIONS = ['.srt'];

export function getDocumentRoot(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('This device does not expose an app document directory.');
  }

  return FileSystem.documentDirectory;
}

// The parent of an absolute library URI (or relative path). Shared by the app UI
// and the folder picker so there is one definition of "go up a level".
export function getParentPath(path: string | null): string | null {
  if (!path) {
    return null;
  }

  const segments = path.split('/').filter(Boolean);

  if (segments.length <= 1) {
    return null;
  }

  return segments.slice(0, -1).join('/');
}

function getVideoDirectory(): string {
  return `${getDocumentRoot()}videos/`;
}

function getTempUploadDirectory(): string {
  return `${getDocumentRoot()}uploads-tmp/`;
}

export function getFileExtension(fileName: string): string {
  const parts = fileName.toLowerCase().match(/\.[^.]+$/);
  return parts?.[0] ?? '';
}

function getFileBaseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function isAllowedVideoFileName(fileName: string): boolean {
  return ALLOWED_VIDEO_EXTENSIONS.includes(getFileExtension(fileName));
}

function isAllowedSubtitleFileName(fileName: string): boolean {
  return ALLOWED_SUBTITLE_EXTENSIONS.includes(getFileExtension(fileName));
}

// A rename must not strip the extension a video or subtitle needs: sanitizeFileName
// preserves whatever it is given, so `ep1.mp4` -> `ep1` would silently produce a
// non-playable `file`. Changing between two allowed video extensions is fine.
function renamePreservesKind(originalName: string, nextName: string): boolean {
  const wasVideo = isAllowedVideoFileName(originalName);
  const wasSubtitle = isAllowedSubtitleFileName(originalName);

  if (wasVideo) {
    return isAllowedVideoFileName(nextName);
  }

  if (wasSubtitle) {
    return isAllowedSubtitleFileName(nextName);
  }

  return true;
}

function sanitizeFolderName(input: string): string {
  const cleaned = input.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}._ -]/gu, '_').replace(/\s+/g, ' ').trim();
  const normalized = cleaned.replace(/^\.+$/g, '').replace(/\.+$/g, '').trim();

  return normalized || 'folder';
}

function splitRelativePath(input?: string | null): string[] {
  return (input ?? '')
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function joinRelativePath(parentPath: string | null, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

function getRelativeName(relativePath: string): string {
  const segments = splitRelativePath(relativePath);
  return segments[segments.length - 1] ?? '';
}

function getDirectoryUri(relativePath?: string | null): string {
  const normalizedPath = normalizeLibraryDirectoryPath(relativePath);
  return normalizedPath ? `${getVideoDirectory()}${normalizedPath}/` : getVideoDirectory();
}

function getItemUri(relativePath: string): string {
  return `${getVideoDirectory()}${relativePath}`;
}

function compareLibraryItems(left: LibraryItem, right: LibraryItem): number {
  if (left.kind === 'folder' && right.kind !== 'folder') {
    return -1;
  }

  if (left.kind !== 'folder' && right.kind === 'folder') {
    return 1;
  }

  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}

async function buildLibraryItem(relativePath: string): Promise<LibraryItem | null> {
  const uri = getItemUri(relativePath);
  const info = await FileSystem.getInfoAsync(uri);

  if (!info.exists) {
    return null;
  }

  const name = getRelativeName(relativePath);
  const parentPath = getParentPath(relativePath);
  const modified = info.modificationTime ? info.modificationTime * 1000 : Date.now();

  if (info.isDirectory) {
    return {
      kind: 'folder',
      name,
      uri,
      modified,
      parentPath,
      relativePath,
    } satisfies FolderItem;
  }

  return {
    kind: isAllowedSubtitleFileName(name) ? 'subtitle' : isAllowedVideoFileName(name) ? 'video' : 'file',
    name,
    uri,
    size: info.size ?? 0,
    modified,
    extension: getFileExtension(name),
    parentPath,
    relativePath,
  } satisfies LibraryItem;
}

export function normalizeLibraryDirectoryPath(input?: string | null): string {
  return splitRelativePath(input)
    .map((segment) => sanitizeFolderName(segment))
    .join('/');
}

function sanitizeFileName(input: string): string {
  const leafName = input.split(/[\\/]/).pop()?.trim() || 'upload';
  const cleaned = leafName.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}._ -]/gu, '_').replace(/\s+/g, ' ');
  const extension = getFileExtension(cleaned);
  const rawBaseName = extension ? cleaned.slice(0, cleaned.length - extension.length) : cleaned;
  const baseName = rawBaseName.replace(/^\.+$/g, '').replace(/\.+$/g, '').trim() || 'upload';

  return `${baseName}${extension.toLowerCase()}`;
}

function normalizeLibraryFilePath(input: string): string {
  const segments = splitRelativePath(input);

  if (segments.length === 0) {
    return sanitizeFileName('upload');
  }

  return [
    ...segments.slice(0, -1).map((segment) => sanitizeFolderName(segment)),
    sanitizeFileName(segments[segments.length - 1] ?? 'upload'),
  ].join('/');
}

// Creates every app-owned directory once. Called at bootstrap and server start,
// so the per-call mkdirs the thumbnail/library helpers used to run are unnecessary.
export async function ensureAppDirectories(): Promise<void> {
  await FileSystem.makeDirectoryAsync(getVideoDirectory(), { intermediates: true });
  await FileSystem.makeDirectoryAsync(getTempUploadDirectory(), { intermediates: true });
  await FileSystem.makeDirectoryAsync(getThumbnailDirectory(), { intermediates: true });
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

export async function createUploadTarget(relativePath: string): Promise<{
  fileName: string;
  finalUri: string;
  parentPath: string | null;
  relativePath: string;
  tempUri: string;
}> {
  await ensureAppDirectories();

  const normalizedPath = normalizeLibraryFilePath(relativePath);
  const parentPath = getParentPath(normalizedPath);
  const sanitizedName = getRelativeName(normalizedPath);

  if (parentPath) {
    await FileSystem.makeDirectoryAsync(getDirectoryUri(parentPath), { intermediates: true });
  }

  const uploadKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    fileName: sanitizedName,
    finalUri: getItemUri(normalizedPath),
    parentPath,
    relativePath: normalizedPath,
    tempUri: `${getTempUploadDirectory()}${uploadKey}.upload`,
  };
}

async function listLibraryItemsInDirectory(parentPath: string | null): Promise<LibraryItem[]> {
  const normalizedParent = normalizeLibraryDirectoryPath(parentPath);
  const directoryUri = getDirectoryUri(normalizedParent);
  const directoryInfo = await FileSystem.getInfoAsync(directoryUri);

  if (!directoryInfo.exists || !directoryInfo.isDirectory) {
    return [];
  }

  const entries = await FileSystem.readDirectoryAsync(directoryUri);
  const items = await Promise.all(
    entries.map((entry) => buildLibraryItem(joinRelativePath(normalizedParent || null, entry))),
  );

  return items.filter((item): item is LibraryItem => item !== null).sort(compareLibraryItems);
}

export async function listLibraryItems(parentPath: string | null = null): Promise<LibraryItem[]> {
  await ensureAppDirectories();
  return listLibraryItemsInDirectory(parentPath);
}

export async function listAllVideoItems(parentPath: string | null = null): Promise<VideoItem[]> {
  await ensureAppDirectories();

  const pendingPaths: Array<string | null> = [normalizeLibraryDirectoryPath(parentPath) || null];
  const videos: VideoItem[] = [];

  while (pendingPaths.length > 0) {
    const nextPath = pendingPaths.pop() ?? null;
    const items = await listLibraryItemsInDirectory(nextPath);

    for (const item of items) {
      if (item.kind === 'folder') {
        pendingPaths.push(item.relativePath);
        continue;
      }

      if (item.kind === 'video') {
        videos.push(item);
      }
    }
  }

  return videos.sort((left, right) => left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true, sensitivity: 'base' }));
}

// Every video reachable under a library item: the item itself if it is a video,
// or a recursive walk if it is a folder. Used to collect the videos whose
// playback progress and thumbnails need re-keying or clearing after a mutation.
export async function collectVideos(item: LibraryItem): Promise<VideoItem[]> {
  if (item.kind === 'folder') {
    return listAllVideoItems(item.relativePath);
  }

  return item.kind === 'video' ? [item] : [];
}

// Validates a lookup path instead of rewriting it: an existing item's stored
// relativePath already reflects on-disk names, so re-sanitizing it (the old
// entryType-driven behavior) could point at the wrong file. Rejects traversal
// (`.`/`..`) and empty segments; the kind is then read from disk.
function toLookupPath(relativePath: string): string | null {
  const segments = splitRelativePath(relativePath);

  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  return segments.join('/');
}

export async function getLibraryItem(relativePath: string): Promise<LibraryItem | null> {
  const lookupPath = toLookupPath(relativePath);

  if (!lookupPath) {
    return null;
  }

  return buildLibraryItem(lookupPath);
}

export async function createLibraryFolder(parentPath: string | null, name: string): Promise<FolderItem> {
  await ensureAppDirectories();

  const normalizedParent = normalizeLibraryDirectoryPath(parentPath);
  const folderName = sanitizeFolderName(name);
  const relativePath = joinRelativePath(normalizedParent || null, folderName);
  const uri = getDirectoryUri(relativePath);
  const info = await FileSystem.getInfoAsync(uri);

  if (info.exists) {
    throw new Error('A file or folder with that name already exists.');
  }

  await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  const folder = await buildLibraryItem(relativePath);

  if (!folder || folder.kind !== 'folder') {
    throw new Error('Could not create the folder.');
  }

  return folder;
}

export async function renameLibraryItem(relativePath: string, newName: string): Promise<LibraryItem> {
  await ensureAppDirectories();

  const target = await getLibraryItem(relativePath);

  if (!target) {
    throw new Error('Library item not found.');
  }

  const isFolder = target.kind === 'folder';
  const sanitizedName = isFolder ? sanitizeFolderName(newName) : sanitizeFileName(newName);

  if (!isFolder && !renamePreservesKind(target.name, sanitizedName)) {
    const extension = getFileExtension(target.name);
    throw new Error(`Keep the ${extension} extension so the file stays playable.`);
  }

  const nextRelativePath = joinRelativePath(target.parentPath, sanitizedName);

  if (nextRelativePath === target.relativePath) {
    return target;
  }

  const nextUri = getItemUri(nextRelativePath);
  const nextInfo = await FileSystem.getInfoAsync(nextUri);

  if (nextInfo.exists) {
    throw new Error('A file or folder with that name already exists.');
  }

  await FileSystem.moveAsync({
    from: target.uri,
    to: nextUri,
  });

  const renamed = await buildLibraryItem(nextRelativePath);

  if (!renamed) {
    throw new Error('Could not rename the item.');
  }

  return renamed;
}

export async function moveLibraryItem(
  relativePath: string,
  destinationParentPath: string | null,
): Promise<LibraryItem> {
  await ensureAppDirectories();

  const target = await getLibraryItem(relativePath);

  if (!target) {
    throw new Error('Library item not found.');
  }

  const destinationParent = normalizeLibraryDirectoryPath(destinationParentPath);

  if (target.parentPath === (destinationParent || null)) {
    return target;
  }

  if (target.kind === 'folder') {
    if (destinationParent === target.relativePath || destinationParent.startsWith(`${target.relativePath}/`)) {
      throw new Error('A folder cannot be moved into itself.');
    }
  }

  const destinationDirectory = getDirectoryUri(destinationParent || null);
  const destinationInfo = await FileSystem.getInfoAsync(destinationDirectory);

  if (!destinationInfo.exists || !destinationInfo.isDirectory) {
    throw new Error('Destination folder not found.');
  }

  const nextRelativePath = joinRelativePath(destinationParent || null, target.name);
  const nextUri = getItemUri(nextRelativePath);
  const nextInfo = await FileSystem.getInfoAsync(nextUri);

  if (nextInfo.exists) {
    throw new Error('A file or folder with that name already exists in the destination.');
  }

  await FileSystem.moveAsync({
    from: target.uri,
    to: nextUri,
  });

  const moved = await buildLibraryItem(nextRelativePath);

  if (!moved) {
    throw new Error('Could not move the item.');
  }

  return moved;
}

export async function findMatchingSubtitleUri(video: VideoItem): Promise<string | null> {
  await ensureAppDirectories();

  const baseName = getFileBaseName(video.name).toLocaleLowerCase();
  const siblings = await listLibraryItems(video.parentPath);
  const matchingSubtitle = siblings.find(
    (item) => item.kind === 'subtitle' && getFileBaseName(item.name).toLocaleLowerCase() === baseName,
  );

  return matchingSubtitle?.uri ?? null;
}

export async function deleteLibraryItem(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true });
}
