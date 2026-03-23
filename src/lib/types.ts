export type VideoItem = {
  id: string;
  name: string;
  uri: string;
  size: number;
  modified: number;
  extension: string;
};

export type UploadStatus = 'idle' | 'receiving' | 'complete' | 'error' | 'stopped';

export type UploadActivity = {
  status: UploadStatus;
  message: string;
  updatedAt: number;
  fileName?: string;
  receivedBytes?: number;
  totalBytes?: number;
};

export type StorageSnapshot = {
  freeBytes: number;
  totalBytes: number;
};
