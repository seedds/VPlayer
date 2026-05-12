type LibraryEntry = {
  id: string;
  name: string;
  uri: string;
  modified: number;
  parentPath: string | null;
  relativePath: string;
};

export type FolderItem = LibraryEntry & {
  kind: 'folder';
};

export type VideoItem = LibraryEntry & {
  kind: 'video';
  size: number;
  extension: string;
};

export type SubtitleItem = LibraryEntry & {
  kind: 'subtitle';
  size: number;
  extension: string;
};

export type FileItem = LibraryEntry & {
  kind: 'file';
  size: number;
  extension: string;
};

export type LibraryItem = FolderItem | VideoItem | SubtitleItem | FileItem;

export type UploadStatus = 'idle' | 'receiving' | 'complete' | 'error' | 'stopped';

export type ActiveUploadRow = {
  uploadId: string;
  fileName: string;
  message: string;
  updatedAt: number;
  receivedBytes: number;
  totalBytes: number;
};

export type UploadActivity = {
  status: UploadStatus;
  message: string;
  updatedAt: number;
  activeUploads: ActiveUploadRow[];
  fileName?: string;
  receivedBytes?: number;
  totalBytes?: number;
};
