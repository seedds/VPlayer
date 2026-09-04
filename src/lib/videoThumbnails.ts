import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { VideoPlayer, VideoThumbnail } from 'expo-video';

import type { VideoItem } from './types';
import { getDocumentRoot } from './videoLibrary';

const THUMBNAIL_TIME_SECONDS = 10;
const THUMBNAIL_MAX_WIDTH = 240;
const THUMBNAIL_MAX_HEIGHT = 240;

function getThumbnailCandidateTimes(durationSeconds?: number): number[] {
  const preferredTime =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.min(THUMBNAIL_TIME_SECONDS, Math.max(0, durationSeconds - 1))
      : THUMBNAIL_TIME_SECONDS;

  return preferredTime > 0 ? [preferredTime, 0] : [0];
}

export function getThumbnailDirectory(): string {
  return `${getDocumentRoot()}thumbnails/`;
}

function hashString(input: string): string {
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function getThumbnailTargetUri(video: VideoItem): string {
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
  const targetUri = getThumbnailTargetUri(video);
  const info = await FileSystem.getInfoAsync(targetUri);

  return info.exists ? targetUri : null;
}

async function persistThumbnail(video: VideoItem, thumbnail: VideoThumbnail): Promise<string> {
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

// Captures a thumbnail from an already-created (and loaded) player. The caller
// owns the player's lifecycle, so this can share one player with duration
// probing instead of opening a second one per video.
export async function generateThumbnailWithPlayer(
  player: VideoPlayer,
  video: VideoItem,
  durationSeconds?: number,
): Promise<string> {
  let lastError: unknown = null;

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

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('Thumbnail generation returned no image.');
}

// Renames a cached thumbnail so it survives a video's URI change. The cache key
// includes the URI, so the target file name differs; on any failure the caller
// should fall back to clearing (the thumbnail will simply be regenerated).
export async function moveThumbnail(oldVideo: VideoItem, newVideo: VideoItem): Promise<boolean> {
  const fromUri = getThumbnailTargetUri(oldVideo);
  const toUri = getThumbnailTargetUri(newVideo);

  if (fromUri === toUri) {
    return true;
  }

  const info = await FileSystem.getInfoAsync(fromUri);

  if (!info.exists) {
    return false;
  }

  try {
    await FileSystem.deleteAsync(toUri, { idempotent: true }).catch(() => undefined);
    await FileSystem.moveAsync({ from: fromUri, to: toUri });
    return true;
  } catch {
    return false;
  }
}

export async function deleteThumbnailForVideo(video: VideoItem): Promise<void> {
  await FileSystem.deleteAsync(getThumbnailTargetUri(video), { idempotent: true }).catch(() => undefined);
}

export async function pruneThumbnailCache(videos: VideoItem[]): Promise<void> {
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
