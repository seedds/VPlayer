import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { createVideoPlayer } from 'expo-video';

import type { VideoThumbnail } from 'expo-video';

import type { VideoItem } from './types';

export const THUMBNAIL_TIME_SECONDS = 10;
export const THUMBNAIL_MAX_WIDTH = 240;
export const THUMBNAIL_MAX_HEIGHT = 240;

function getThumbnailCandidateTimes(durationSeconds?: number): number[] {
  const preferredTime =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.min(THUMBNAIL_TIME_SECONDS, Math.max(0, durationSeconds - 1))
      : THUMBNAIL_TIME_SECONDS;

  return preferredTime > 0 ? [preferredTime, 0] : [0];
}

function getDocumentRoot(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('This device does not expose an app document directory.');
  }

  return FileSystem.documentDirectory;
}

export function getThumbnailDirectory(): string {
  return `${getDocumentRoot()}thumbnails/`;
}

export async function ensureThumbnailDirectory(): Promise<void> {
  await FileSystem.makeDirectoryAsync(getThumbnailDirectory(), { intermediates: true });
}

function hashString(input: string): string {
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

export function getThumbnailTargetUri(video: VideoItem): string {
  const cacheKey = hashString(
    [
      video.uri,
      video.size,
      video.modified,
      THUMBNAIL_TIME_SECONDS,
      THUMBNAIL_MAX_WIDTH,
      THUMBNAIL_MAX_HEIGHT,
    ].join('|'),
  );

  return `${getThumbnailDirectory()}${cacheKey}.jpg`;
}

export async function getCachedThumbnailUri(video: VideoItem): Promise<string | null> {
  await ensureThumbnailDirectory();

  const targetUri = getThumbnailTargetUri(video);
  const info = await FileSystem.getInfoAsync(targetUri);

  return info.exists ? targetUri : null;
}

export async function persistThumbnail(video: VideoItem, thumbnail: VideoThumbnail): Promise<string> {
  await ensureThumbnailDirectory();

  const renderedImage = await ImageManipulator.manipulate(thumbnail).renderAsync();
  const savedImage = await renderedImage.saveAsync({
    compress: 0.9,
    format: SaveFormat.JPEG,
  });

  const targetUri = getThumbnailTargetUri(video);

  await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => undefined);
  await FileSystem.moveAsync({ from: savedImage.uri, to: targetUri });

  return targetUri;
}

export async function generateThumbnailForVideo(video: VideoItem, durationSeconds?: number): Promise<string> {
  const player = createVideoPlayer(video.uri);
  let lastError: unknown = null;

  try {
    for (const time of getThumbnailCandidateTimes(durationSeconds)) {
      try {
        const thumbnails = await player.generateThumbnailsAsync([time], {
          maxHeight: THUMBNAIL_MAX_HEIGHT,
          maxWidth: THUMBNAIL_MAX_WIDTH,
        });
        const thumbnail = thumbnails[0] ?? null;

        if (thumbnail) {
          return await persistThumbnail(video, thumbnail);
        }
      } catch (error) {
        lastError = error;
      }
    }
  } finally {
    player.release();
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('Thumbnail generation returned no image.');
}

export async function deleteThumbnailForVideo(video: VideoItem): Promise<void> {
  await ensureThumbnailDirectory();
  await FileSystem.deleteAsync(getThumbnailTargetUri(video), { idempotent: true }).catch(() => undefined);
}

export async function pruneThumbnailCache(videos: VideoItem[]): Promise<void> {
  await ensureThumbnailDirectory();

  const validPaths = new Set(videos.map((video) => getThumbnailTargetUri(video)));
  const entries = await FileSystem.readDirectoryAsync(getThumbnailDirectory());

  await Promise.all(
    entries.map(async (entry) => {
      const uri = `${getThumbnailDirectory()}${entry}`;

      if (!validPaths.has(uri)) {
        await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
      }
    }),
  );
}
