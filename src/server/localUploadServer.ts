import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';

import type { LibraryItem, UploadActivity } from '../lib/types';
import { clearPlaybackProgressForUris } from '../lib/playbackState';
import {
  clearTempUploads,
  createLibraryFolder,
  createUploadTarget,
  deleteLibraryItem,
  ensureAppDirectories,
  getLibraryItem,
  listAllVideoItems,
  listLibraryItems,
  normalizeLibraryDirectoryPath,
} from '../lib/videoLibrary';
import { deleteThumbnailForVideo } from '../lib/videoThumbnails';
import { buildUploadPage } from './uploadPage';

export const DEFAULT_SERVER_PORT = 8080;

type UploadSession = {
  uploadId: string;
  fileName: string;
  finalUri: string;
  relativePath: string;
  tempUri: string;
  totalSize: number;
  receivedBytes: number;
  expectedChunkIndex: number;
};

type StartServerOptions = {
  port: number;
  onActivity?: (activity: UploadActivity) => void;
  onLibraryChanged?: () => Promise<void> | void;
};

type NitroRequestLike = {
  body?: string;
  headers: Record<string, string>;
  method: string;
  path: string;
};

type NitroResponseLike = {
  body?: ArrayBuffer | string;
  headers?: Record<string, string>;
  statusCode: number;
};

type ConfigServerLike = {
  port: number;
  start: (
    port: number,
    handler: (request: NitroRequestLike) => Promise<NitroResponseLike> | NitroResponseLike,
    config: unknown,
    host?: string,
  ) => Promise<number>;
  stop: () => Promise<void>;
};

const CHUNK_SIZE = 1024 * 1024;

function getUploadPluginTempDir(): string {
  const baseDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;

  if (!baseDir) {
    throw new Error('This device does not expose an app storage directory.');
  }

  return `${baseDir}nitro-upload-temp/`.replace(/^file:\/\//, '').replace(/\/$/, '');
}

function normalizeFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function parseJsonBody(input?: string): Record<string, unknown> {
  if (!input) {
    return {};
  }

  return JSON.parse(input) as Record<string, unknown>;
}

function readString(input: unknown, fieldName: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`Missing ${fieldName}.`);
  }

  return input.trim();
}

function readNumber(input: unknown, fieldName: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`Missing ${fieldName}.`);
  }

  return input;
}

function readOptionalString(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function readHeader(headers: Record<string, string>, key: string): string {
  const value = headers[key.toLowerCase()];

  if (!value?.trim()) {
    throw new Error(`Missing ${key}.`);
  }

  return value.trim();
}

function readHeaderNumber(headers: Record<string, string>, key: string): number {
  const parsed = Number.parseInt(readHeader(headers, key), 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${key}.`);
  }

  return parsed;
}

function htmlResponse(body: string): NitroResponseLike {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body,
  };
}

function jsonResponse(body: object, statusCode = 200): NitroResponseLike {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown server error.';
}

function serializeLibraryItem(item: LibraryItem) {
  return {
    kind: item.kind,
    name: item.name,
    modified: item.modified,
    parentPath: item.parentPath,
    relativePath: item.relativePath,
    ...(item.kind === 'folder' ? {} : { extension: item.extension, size: item.size }),
  };
}

class LocalUploadServer {
  private onActivity?: (activity: UploadActivity) => void;

  private onLibraryChanged?: () => Promise<void> | void;

  private port: number | null = null;

  private server: ConfigServerLike | null = null;

  private uploads = new Map<string, UploadSession>();

  isRunning(): boolean {
    return this.server !== null;
  }

  getPort(): number | null {
    return this.port;
  }

  async start({ port, onActivity, onLibraryChanged }: StartServerOptions): Promise<void> {
    if (this.server && this.port === port) {
      this.onActivity = onActivity;
      this.onLibraryChanged = onLibraryChanged;
      this.emit({ status: 'idle', message: `Server ready on port ${port}.` });
      return;
    }

    await this.stop();
    await ensureAppDirectories();
    await clearTempUploads();

    this.onActivity = onActivity;
    this.onLibraryChanged = onLibraryChanged;

    const { ConfigServer } = require('react-native-nitro-http-server') as typeof import('react-native-nitro-http-server');
    const nextServer = new ConfigServer() as ConfigServerLike;
    const actualPort = await nextServer.start(
      port,
      (request: NitroRequestLike) => this.handleRequest(request),
      {
        mounts: [{ type: 'upload', path: '/upload/chunk', temp_dir: getUploadPluginTempDir() }],
        verbose: 'error',
      },
      '0.0.0.0',
    );

    if (!actualPort) {
      throw new Error('Unable to start the upload server.');
    }

    const resolvedPort = Number.isFinite(actualPort) && actualPort >= 1025 && actualPort <= 65535 ? actualPort : port;

    this.server = nextServer;
    this.port = resolvedPort;
    this.emit({ status: 'idle', message: `Server ready on port ${resolvedPort}.` });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }

    const activeUploads = Array.from(this.uploads.values());
    this.uploads.clear();
    this.port = null;

    await Promise.all(
      activeUploads.map((upload) => FileSystem.deleteAsync(upload.tempUri, { idempotent: true }).catch(() => undefined)),
    );

    this.emit({ status: 'stopped', message: 'Server stopped.' });
  }

  private emit(activity: Omit<UploadActivity, 'updatedAt'>): void {
    this.onActivity?.({ ...activity, updatedAt: Date.now() });
  }

  private async handleRequest(request: NitroRequestLike): Promise<NitroResponseLike> {
    try {
      if (request.method === 'GET' && request.path === '/') {
        return htmlResponse(
          buildUploadPage({
            chunkSize: CHUNK_SIZE,
          }),
        );
      }

      if (request.method === 'GET' && request.path === '/health') {
        return jsonResponse({
          ok: true,
          port: this.port,
          activeUploads: this.uploads.size,
        });
      }

      if (request.method === 'POST' && request.path === '/upload/init') {
        return await this.handleInit(request);
      }

      if (request.method === 'POST' && request.path === '/library/list') {
        return await this.handleList(request);
      }

      if (request.method === 'POST' && request.path === '/library/folder') {
        return await this.handleCreateFolder(request);
      }

      if (request.method === 'POST' && request.path === '/library/delete') {
        return await this.handleDelete(request);
      }

      if (request.method === 'POST' && request.path === '/upload/chunk') {
        return await this.handleChunk(request);
      }

      if (request.method === 'POST' && request.path === '/upload/complete') {
        return await this.handleComplete(request);
      }

      if (request.method === 'POST' && request.path === '/upload/cancel') {
        return await this.handleCancel(request);
      }

      return jsonResponse({ message: 'Route not found.' }, 404);
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 500);
    }
  }

  private async handleInit(request: NitroRequestLike): Promise<NitroResponseLike> {
    try {
      const body = parseJsonBody(request.body);
      const relativePath = readOptionalString(body.relativePath) ?? readString(body.fileName, 'fileName');
      const totalSize = readNumber(body.totalSize, 'totalSize');

      if (totalSize <= 0) {
        throw new Error('Upload must contain at least one byte.');
      }

      const target = await createUploadTarget(relativePath);
      const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      this.uploads.set(uploadId, {
        uploadId,
        fileName: target.fileName,
        finalUri: target.finalUri,
        relativePath: target.relativePath,
        tempUri: target.tempUri,
        totalSize,
        receivedBytes: 0,
        expectedChunkIndex: 0,
      });

      this.emit({
        status: 'receiving',
        message: `Preparing ${target.fileName}`,
        fileName: target.fileName,
        receivedBytes: 0,
        totalBytes: totalSize,
      });

      return jsonResponse({
        uploadId,
        fileName: target.fileName,
        relativePath: target.relativePath,
        chunkSize: CHUNK_SIZE,
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleList(request: NitroRequestLike): Promise<NitroResponseLike> {
    try {
      const body = parseJsonBody(request.body);
      const path = normalizeLibraryDirectoryPath(readOptionalString(body.path));
      const items = await listLibraryItems(path || null);

      return jsonResponse({
        path,
        items: items.map((item) => serializeLibraryItem(item)),
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleCreateFolder(request: NitroRequestLike): Promise<NitroResponseLike> {
    try {
      const body = parseJsonBody(request.body);
      const parentPath = normalizeLibraryDirectoryPath(readOptionalString(body.parentPath));
      const name = readString(body.name, 'name');
      const folder = await createLibraryFolder(parentPath || null, name);

      this.emit({ status: 'idle', message: `Created folder ${folder.name}` });
      await this.onLibraryChanged?.();

      return jsonResponse({ ok: true, folder: serializeLibraryItem(folder) });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleDelete(request: NitroRequestLike): Promise<NitroResponseLike> {
    try {
      const body = parseJsonBody(request.body);
      const relativePath = readString(body.relativePath, 'relativePath');
      const entryType = readString(body.entryType, 'entryType');

      if (entryType !== 'file' && entryType !== 'folder') {
        throw new Error('Invalid entryType.');
      }

      const target = await getLibraryItem(relativePath, entryType);

      if (!target) {
        throw new Error('Library item not found.');
      }

      const videosToCleanup = target.kind === 'folder' ? await listAllVideoItems(target.relativePath) : target.kind === 'video' ? [target] : [];

      if (videosToCleanup.length > 0) {
        await clearPlaybackProgressForUris(videosToCleanup.map((video) => video.uri));
        await Promise.all(videosToCleanup.map((video) => deleteThumbnailForVideo(video).catch(() => undefined)));
      }

      await deleteLibraryItem(target.uri);
      this.emit({ status: 'idle', message: `Deleted ${target.name}` });
      await this.onLibraryChanged?.();

      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleChunk(request: NitroRequestLike): Promise<NitroResponseLike> {
    try {
      const headers = normalizeHeaders(request.headers);
      const uploadId = readHeader(headers, 'x-upload-id');
      const chunkIndex = readHeaderNumber(headers, 'x-chunk-index');
      const totalChunks = readHeaderNumber(headers, 'x-total-chunks');
      const totalSize = readHeaderNumber(headers, 'x-total-size');
      const session = this.uploads.get(uploadId);

      if (!session) {
        throw new Error('Upload session not found.');
      }

      if (session.totalSize !== totalSize) {
        throw new Error('Upload size mismatch.');
      }

      if (chunkIndex < 0 || chunkIndex >= totalChunks) {
        throw new Error('Chunk index out of range.');
      }

      if (chunkIndex !== session.expectedChunkIndex) {
        throw new Error(`Unexpected chunk order. Expected chunk ${session.expectedChunkIndex}.`);
      }

      const uploadedFilePath = readHeader(headers, 'x-uploaded-file-path');
      const uploadedChunkFile = new File(normalizeFileUri(uploadedFilePath));

      if (!uploadedChunkFile.exists) {
        throw new Error('Uploaded chunk file missing.');
      }

      const chunkBytes = await uploadedChunkFile.bytes();
      const tempFile = new File(session.tempUri);

      if (session.receivedBytes + chunkBytes.byteLength > session.totalSize) {
        throw new Error('Chunk exceeds declared upload size.');
      }

      if (!tempFile.exists) {
        tempFile.create({ overwrite: true });
      }

      tempFile.write(chunkBytes, { append: session.receivedBytes > 0 });
      session.receivedBytes += chunkBytes.byteLength;
      session.expectedChunkIndex += 1;
      uploadedChunkFile.delete();

      this.emit({
        status: 'receiving',
        message: `Uploading ${session.fileName}`,
        fileName: session.fileName,
        receivedBytes: Math.min(session.receivedBytes, session.totalSize),
        totalBytes: session.totalSize,
      });

      return jsonResponse({
        ok: true,
        receivedBytes: session.receivedBytes,
        totalBytes: session.totalSize,
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleComplete(request: NitroRequestLike): Promise<NitroResponseLike> {
    try {
      const body = parseJsonBody(request.body);
      const uploadId = readString(body.uploadId, 'uploadId');
      const session = this.uploads.get(uploadId);

      if (!session) {
        throw new Error('Upload session not found.');
      }

      if (session.receivedBytes !== session.totalSize) {
        throw new Error('Upload is incomplete.');
      }

      await FileSystem.moveAsync({
        from: session.tempUri,
        to: session.finalUri,
      });

      this.uploads.delete(uploadId);
      this.emit({
        status: 'complete',
        message: `Saved ${session.relativePath}`,
        fileName: session.relativePath,
        receivedBytes: session.receivedBytes,
        totalBytes: session.totalSize,
      });

      await this.onLibraryChanged?.();
      return jsonResponse({ ok: true, fileName: session.fileName });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleCancel(request: NitroRequestLike): Promise<NitroResponseLike> {
    try {
      const body = parseJsonBody(request.body);
      const uploadId = readString(body.uploadId, 'uploadId');
      const session = this.uploads.get(uploadId);

      if (session) {
        this.uploads.delete(uploadId);
        await FileSystem.deleteAsync(session.tempUri, { idempotent: true });
        this.emit({
          status: 'error',
          message: `Cancelled ${session.fileName}`,
          fileName: session.fileName,
          receivedBytes: session.receivedBytes,
          totalBytes: session.totalSize,
        });
      }

      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }
}

export const localUploadServer = new LocalUploadServer();
