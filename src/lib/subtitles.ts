import * as FileSystem from 'expo-file-system/legacy';

export type SubtitleCue = {
  endMs: number;
  startMs: number;
  text: string;
};

function parseTimestamp(input: string): number | null {
  const match = input.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);

  if (!match) {
    return null;
  }

  const [, hours, minutes, seconds, milliseconds] = match;
  return (((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000) + Number(milliseconds);
}

export function parseSrt(input: string): SubtitleCue[] {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\n\s*\n/g)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean))
    .map((lines) => {
      const timingLineIndex = lines.findIndex((line) => line.includes('-->'));

      if (timingLineIndex === -1) {
        return null;
      }

      const [startRaw, endRaw] = lines[timingLineIndex].split('-->').map((value) => value.trim());
      const startMs = parseTimestamp(startRaw);
      const endMs = parseTimestamp(endRaw);

      if (startMs === null || endMs === null || endMs <= startMs) {
        return null;
      }

      const text = lines.slice(timingLineIndex + 1).join('\n').trim();

      if (!text) {
        return null;
      }

      return {
        startMs,
        endMs,
        text,
      } satisfies SubtitleCue;
    })
    .filter((cue): cue is SubtitleCue => cue !== null)
    .sort((left, right) => left.startMs - right.startMs);
}

export async function loadSrtFile(uri: string): Promise<SubtitleCue[]> {
  const contents = await FileSystem.readAsStringAsync(uri);
  return parseSrt(contents);
}

export function getActiveSubtitleText(cues: SubtitleCue[], currentTimeSeconds: number): string | null {
  const currentTimeMs = Math.max(0, Math.floor(currentTimeSeconds * 1000));
  const cue = cues.find((entry) => currentTimeMs >= entry.startMs && currentTimeMs <= entry.endMs);

  return cue?.text ?? null;
}
