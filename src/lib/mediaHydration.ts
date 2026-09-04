import { createVideoPlayer } from 'expo-video';

import { savePlaybackDuration } from './playbackState';
import type { VideoItem } from './types';
import { generateThumbnailWithPlayer, getCachedThumbnailUri } from './videoThumbnails';

const SOURCE_LOAD_TIMEOUT_MS = 4000;

export type ProbeResult = {
  thumbnailUri: string | null;
  durationSeconds: number | null;
};

export type HydrateCallbacks = {
  // Called once per video with whatever this session could resolve. `thumbnailUri`
  // is null when generation failed; `durationSeconds` is null when the source
  // never reported a duration.
  onResult: (video: VideoItem, result: ProbeResult) => void;
};

export type HydrateOptions = {
  concurrency?: number;
};

export type HydrateHandle = {
  cancel: () => void;
  promise: Promise<void>;
};

// Opens one player for a video, waits for its source to load (capped), persists
// the duration, and generates a thumbnail if one is not already cached. A single
// player serves both jobs, replacing the two separate per-video players the app
// used to spawn.
export async function probeVideo(video: VideoItem, knownDurationSeconds?: number): Promise<ProbeResult> {
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

    const effectiveDuration =
      durationSeconds !== null && durationSeconds >= 0 ? durationSeconds : knownDurationSeconds;

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
// lands. Skips any URI already probed in this process, so repeated library
// refreshes do not re-open players for videos already seen this session. The
// returned handle can cancel in-flight work.
export function hydrateVideos(videos: VideoItem[], options: HydrateOptions, callbacks: HydrateCallbacks): HydrateHandle {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  let cancelled = false;

  const promise = (async () => {
    const queue = videos.filter((video) => {
      if (probedUris.has(video.uri)) {
        return false;
      }

      probedUris.add(video.uri);
      return true;
    });

    if (queue.length === 0) {
      return;
    }

    const runWorker = async () => {
      while (!cancelled) {
        const video = queue.shift();

        if (!video) {
          return;
        }

        try {
          const result = await probeVideo(video);

          if (!cancelled) {
            callbacks.onResult(video, result);
          }
        } catch {
          // A failed probe is dropped; the URI stays marked so it is not retried
          // in a tight loop. It is re-probed after the session ends (app restart).
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => runWorker()));
  })();

  return {
    cancel: () => {
      cancelled = true;
    },
    promise,
  };
}

// Per-process record of which URIs have been probed, so a video costs one player
// per session even across many library refreshes. Unreadable videos are included,
// so a broken file is not re-attempted every refresh.
const probedUris = new Set<string>();

export function forgetProbedUris(uris: Iterable<string>): void {
  for (const uri of uris) {
    probedUris.delete(uri);
  }
}
