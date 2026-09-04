import { createVideoPlayer } from 'expo-video';

import { savePlaybackDuration } from './playbackState';
import type { VideoItem } from './types';
import { generateThumbnailWithPlayer, getCachedThumbnailUri } from './videoThumbnails';

const SOURCE_LOAD_TIMEOUT_MS = 4000;
const HYDRATION_CONCURRENCY = 3;

type ProbeResult = {
  thumbnailUri: string | null;
  durationSeconds: number | null;
};

export type HydrateHandle = {
  cancel: () => void;
  done: Promise<void>;
};

// The probe cache is keyed on file identity (uri + size + modified), not the bare
// URI: if a file is overwritten in place (same name, new contents) its size/mtime
// change, so it re-probes and regenerates its thumbnail instead of showing a stale
// (and since-pruned) one.
function getProbeKey(video: VideoItem): string {
  return `${video.uri}|${video.size}|${video.modified}`;
}

// Opens one player for a video, waits for its source to load (capped), persists
// the duration, and generates a thumbnail if one is not already cached. A single
// player serves both jobs, replacing the two separate per-video players the app
// used to spawn.
async function probeVideo(video: VideoItem): Promise<ProbeResult> {
  const player = createVideoPlayer(video.uri);
  let subscription: { remove(): void } | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const durationSeconds = await new Promise<number | null>((resolve) => {
      let settled = false;

      const finish = (value: number | null) => {
        if (settled) {
          return;
        }

        settled = true;
        subscription?.remove();

        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        resolve(value);
      };

      subscription = player.addListener('sourceLoad', ({ duration }) => finish(duration));

      if (Number.isFinite(player.duration) && player.duration > 0) {
        finish(player.duration);
        return;
      }

      timeoutId = setTimeout(() => {
        finish(Number.isFinite(player.duration) && player.duration > 0 ? player.duration : null);
      }, SOURCE_LOAD_TIMEOUT_MS);
    });

    if (durationSeconds !== null && durationSeconds >= 0) {
      await savePlaybackDuration(video.uri, durationSeconds);
    }

    const effectiveDuration = durationSeconds !== null && durationSeconds >= 0 ? durationSeconds : undefined;

    let thumbnailUri = await getCachedThumbnailUri(video);

    if (!thumbnailUri) {
      try {
        thumbnailUri = await generateThumbnailWithPlayer(player, video, effectiveDuration);
      } catch {
        thumbnailUri = null;
      }
    }

    return { thumbnailUri, durationSeconds };
  } finally {
    player.release();
  }
}

// Probes a batch of videos with bounded concurrency, reporting each result as it
// lands. Skips any file already probed in this process, so repeated library
// refreshes do not re-open players for videos already seen this session. The
// returned handle can cancel in-flight work.
export function hydrateVideos(
  videos: VideoItem[],
  onResult: (video: VideoItem, result: ProbeResult) => void,
): HydrateHandle {
  let cancelled = false;

  const done = (async () => {
    const queue = videos.filter((video) => !probedKeys.has(getProbeKey(video)));

    if (queue.length === 0) {
      return;
    }

    const runWorker = async () => {
      while (!cancelled) {
        const video = queue.shift();

        if (!video) {
          return;
        }

        // Marked when a worker dequeues it (not up front), so a cancelled batch
        // leaves its untouched remainder unmarked for the next hydration to pick up.
        probedKeys.add(getProbeKey(video));

        try {
          const result = await probeVideo(video);

          if (!cancelled) {
            onResult(video, result);
          }
        } catch {
          // A failed probe is dropped; the key stays marked so it is not retried
          // in a tight loop. It is re-probed after the session ends (app restart).
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(HYDRATION_CONCURRENCY, queue.length) }, () => runWorker()));
  })();

  return {
    cancel: () => {
      cancelled = true;
    },
    done,
  };
}

// Per-process record of which files have been probed, so a video costs one player
// per session even across many library refreshes. Unreadable videos are included,
// so a broken file is not re-attempted every refresh.
const probedKeys = new Set<string>();
