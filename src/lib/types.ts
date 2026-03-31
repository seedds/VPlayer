export type VideoItem = {
  id: string;
  kind: 'video';
  name: string;
  uri: string;
  size: number;
  modified: number;
  extension: string;
};

export type SubtitleItem = {
  id: string;
  kind: 'subtitle';
  name: string;
  uri: string;
  size: number;
  modified: number;
  extension: string;
};

export type LibraryItem = VideoItem | SubtitleItem;

export type UploadStatus = 'idle' | 'receiving' | 'complete' | 'error' | 'stopped';

export type UploadActivity = {
  status: UploadStatus;
  message: string;
  updatedAt: number;
  fileName?: string;
  receivedBytes?: number;
  totalBytes?: number;
};
