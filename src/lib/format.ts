import type { UploadActivity } from './types';

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  const digits = scaled >= 10 || index === 0 ? 0 : 1;

  return `${scaled.toFixed(digits)} ${units[index]}`;
}

export function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

export function formatDuration(value?: number | null): string {
  if (!Number.isFinite(value) || value === null || value === undefined || value < 0) {
    return '--:--';
  }

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function normalizePort(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1025 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

export function getUploadProgress(activity: UploadActivity): number {
  if (!activity.totalBytes || !activity.receivedBytes) {
    return activity.status === 'complete' ? 1 : 0;
  }

  return Math.max(0, Math.min(1, activity.receivedBytes / activity.totalBytes));
}
