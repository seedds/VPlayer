import { movePlaybackState } from './playbackState';
import type { VideoItem } from './types';
import { deleteThumbnailForVideo, moveThumbnail } from './videoThumbnails';

export type ArtifactMove = { oldUri: string; newUri: string };

// Maps a video's old URI onto its new one after its containing item was renamed
// or moved. For a single video oldRootUri === the video's URI (so the suffix is
// empty); for a folder each contained video shares the old folder URI as a
// prefix, which is swapped for the new one.
function remapUri(uri: string, oldRootUri: string, newRootUri: string): string {
  return `${newRootUri}${uri.slice(oldRootUri.length)}`;
}

// Re-keys playback progress and cached thumbnails from old URIs to new ones when
// a rename/move changes a video's URI, so a half-watched video keeps its
// position and thumbnail instead of resetting to "new". A thumbnail whose rename
// fails is cleared (it regenerates on the next probe). Returns the applied moves
// so the caller can re-key its own in-memory state.
export async function relinkVideoArtifacts(
  oldVideos: VideoItem[],
  oldRootUri: string,
  newRootUri: string,
): Promise<ArtifactMove[]> {
  if (oldVideos.length === 0 || oldRootUri === newRootUri) {
    return [];
  }

  const moves: ArtifactMove[] = oldVideos.map((video) => ({
    oldUri: video.uri,
    newUri: remapUri(video.uri, oldRootUri, newRootUri),
  }));

  await movePlaybackState(moves.map((move) => [move.oldUri, move.newUri] as const));

  await Promise.all(
    oldVideos.map(async (video, index) => {
      const newVideo: VideoItem = { ...video, uri: moves[index].newUri };
      const moved = await moveThumbnail(video, newVideo);

      if (!moved) {
        await deleteThumbnailForVideo(video).catch(() => undefined);
      }
    }),
  );

  return moves;
}
