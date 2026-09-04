import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { ConfigServer, type HttpRequest, type HttpResponse, type ServerConfig } from 'react-native-nitro-http-server';

import type { ActiveUploadRow, LibraryItem, UploadActivity, UploadStatus } from '../lib/types';
import { clampSetting, SETTING_META } from '../lib/settings';
import {
  clearTempUploads,
  collectVideos,
  createLibraryFolder,
  createUploadTarget,
  deleteLibraryItem,
  ensureAppDirectories,
  getLibraryItem,
  listLibraryItems,
  moveLibraryItem,
  normalizeLibraryDirectoryPath,
  renameLibraryItem,
} from '../lib/videoLibrary';
import { forgetVideoArtifacts, relinkVideoArtifacts } from '../lib/videoArtifacts';
import { buildUploadPage } from './uploadPage';

export const DEFAULT_SERVER_PORT = 8081;

type UploadSession = {
  uploadId: string;
  fileName: string;
  finalUri: string;
  relativePath: string;
  tempUri: string;
  totalSize: number;
  receivedBytes: number;
  expectedChunkIndex: number;
  lastActivityAt: number;
};

// A session with no chunk/complete activity for this long is swept: a browser tab
// killed mid-upload otherwise keeps a 'receiving' session (and the app's
// keep-awake and "Uploading" banner) alive until the server restarts.
const UPLOAD_SESSION_TTL_MS = 5 * 60 * 1000;

type StartServerOptions = {
  port: number;
  onActivity?: (activity: UploadActivity) => void;
  onLibraryChanged?: () => Promise<void> | void;
};

const CHUNK_SIZE = 1024 * 1024;

function getUploadPluginTempDirUri(): string {
  const baseDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;

  if (!baseDir) {
    throw new Error('This device does not expose an app storage directory.');
  }

  return `${baseDir}nitro-upload-temp/`;
}

function getUploadPluginTempDir(): string {
  return getUploadPluginTempDirUri().replace(/^file:\/\//, '').replace(/\/$/, '');
}

// The upload plugin writes each received chunk to this directory. Rejected chunks
// (bad session, wrong order, size mismatch) are deleted inline, but a crash can
// still orphan files here, so it is swept clean when the server starts.
async function clearNitroUploadTemp(): Promise<void> {
  const directoryUri = getUploadPluginTempDirUri();
  const info = await FileSystem.getInfoAsync(directoryUri);

  if (!info.exists || !info.isDirectory) {
    return;
  }

  const entries = await FileSystem.readDirectoryAsync(directoryUri);

  await Promise.all(
    entries.map((entry) => FileSystem.deleteAsync(`${directoryUri}${entry}`, { idempotent: true }).catch(() => undefined)),
  );
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

function htmlResponse(body: string): HttpResponse {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body,
  };
}

function jsonResponse(body: object, statusCode = 200): HttpResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown server error.';
}

function parseRequestUrl(path: string): URL {
  return new URL(path, 'http://local-upload-server');
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

async function serializeLibraryListing(path: string | null) {
  const normalizedPath = normalizeLibraryDirectoryPath(path);
  const items = await listLibraryItems(normalizedPath || null);

  return {
    path: normalizedPath,
    items: items.map((item) => serializeLibraryItem(item)),
  };
}

class LocalUploadServer {
  private onActivity?: (activity: UploadActivity) => void;

  private onLibraryChanged?: () => Promise<void> | void;

  private port: number | null = null;

  private server: ConfigServer | null = null;

  private maxParallelUploads = SETTING_META.maxParallelUploads.default;

  private uploads = new Map<string, UploadSession>();

  isRunning(): boolean {
    return this.server !== null;
  }

  getPort(): number | null {
    return this.port;
  }

  setMaxParallelUploads(maxParallelUploads: number): void {
    this.maxParallelUploads = clampSetting('maxParallelUploads', maxParallelUploads);
  }

  async start({ port, onActivity, onLibraryChanged }: StartServerOptions): Promise<void> {
    if (this.server && this.port === port) {
      this.onActivity = onActivity;
      this.onLibraryChanged = onLibraryChanged;
      this.emitActivity('idle', `Server ready on port ${port}.`);
      return;
    }

    await this.stop();
    await ensureAppDirectories();
    await clearTempUploads();
    await clearNitroUploadTemp();

    this.onActivity = onActivity;
    this.onLibraryChanged = onLibraryChanged;

    const nextServer = new ConfigServer();
    const serverConfig: ServerConfig = {
      mounts: [{ type: 'upload', path: '/upload/chunk', temp_dir: getUploadPluginTempDir() }],
      verbose: 'error',
    };
    const actualPort = await nextServer.start(
      port,
      (request: HttpRequest) => this.handleRequest(request),
      serverConfig,
      '0.0.0.0',
    );

    if (!actualPort) {
      throw new Error('Unable to start the upload server.');
    }

    const resolvedPort = Number.isFinite(actualPort) && actualPort >= 1025 && actualPort <= 65535 ? actualPort : port;

    this.server = nextServer;
    this.port = resolvedPort;
    this.emitActivity('idle', `Server ready on port ${resolvedPort}.`);
  }

  async stop(): Promise<void> {
    const wasRunning = this.server !== null;

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

    // start() calls stop() first; only report a stop when something was actually
    // running, so a normal start does not flash "Server stopped." at the user.
    if (wasRunning) {
      this.emitActivity('stopped', 'Server stopped.');
    }
  }

  private emit(activity: Omit<UploadActivity, 'updatedAt'>): void {
    this.onActivity?.({ ...activity, updatedAt: Date.now() });
  }

  private buildUploadRows(updatedAt: number): ActiveUploadRow[] {
    return Array.from(this.uploads.values()).map((session) => ({
      uploadId: session.uploadId,
      fileName: session.relativePath,
      message: session.receivedBytes > 0 ? `Uploading ${session.fileName}` : `Preparing ${session.fileName}`,
      updatedAt,
      receivedBytes: Math.min(session.receivedBytes, session.totalSize),
      totalBytes: session.totalSize,
    }));
  }

  private buildActivity(statusWhenIdle: UploadStatus, messageWhenIdle: string): Omit<UploadActivity, 'updatedAt'> {
    const updatedAt = Date.now();
    const activeUploads = this.buildUploadRows(updatedAt);

    if (activeUploads.length === 0) {
      return {
        status: statusWhenIdle,
        message: messageWhenIdle,
        activeUploads: [],
      };
    }

    const receivedBytes = activeUploads.reduce((sum, upload) => sum + upload.receivedBytes, 0);
    const totalBytes = activeUploads.reduce((sum, upload) => sum + upload.totalBytes, 0);
    const isPreparingOnly = activeUploads.every((upload) => upload.receivedBytes === 0);

    return {
      status: 'receiving',
      message: `${isPreparingOnly ? 'Preparing' : 'Uploading'} ${activeUploads.length} file${activeUploads.length === 1 ? '' : 's'}`,
      activeUploads,
      receivedBytes,
      totalBytes,
    };
  }

  private emitActivity(statusWhenIdle: UploadStatus, messageWhenIdle: string): void {
    this.emit(this.buildActivity(statusWhenIdle, messageWhenIdle));
  }

  // Drops sessions with no activity for UPLOAD_SESSION_TTL_MS and deletes their
  // temp files. Runs on every request, so no timer is needed.
  private sweepStaleSessions(): void {
    const now = Date.now();
    const staleSessions = Array.from(this.uploads.values()).filter(
      (session) => now - session.lastActivityAt > UPLOAD_SESSION_TTL_MS,
    );

    if (staleSessions.length === 0) {
      return;
    }

    for (const session of staleSessions) {
      this.uploads.delete(session.uploadId);
      void FileSystem.deleteAsync(session.tempUri, { idempotent: true }).catch(() => undefined);
    }

    this.emitActivity('idle', 'Cleaned up an inactive upload.');
  }

  private async handleRequest(request: HttpRequest): Promise<HttpResponse> {
    try {
      this.sweepStaleSessions();

      const requestUrl = parseRequestUrl(request.path);
      const pathname = requestUrl.pathname;

      if (request.method === 'GET' && pathname === '/') {
        return htmlResponse(
          buildUploadPage({
            chunkSize: CHUNK_SIZE,
            maxParallelUploads: this.maxParallelUploads,
          }),
        );
      }

      if (request.method === 'POST' && pathname === '/upload/init') {
        return await this.handleInit(request);
      }

      if (request.method === 'GET' && pathname === '/library/list') {
        return await this.handleList(requestUrl);
      }

      if (request.method === 'POST' && pathname === '/library/folder') {
        return await this.handleCreateFolder(request);
      }

      if (request.method === 'POST' && pathname === '/library/delete') {
        return await this.handleDelete(request);
      }

      if (request.method === 'POST' && pathname === '/library/rename') {
        return await this.handleRename(request);
      }

      if (request.method === 'POST' && pathname === '/library/move') {
        return await this.handleMove(request);
      }

      if (request.method === 'POST' && pathname === '/upload/chunk') {
        return await this.handleChunk(request);
      }

      if (request.method === 'POST' && pathname === '/upload/complete') {
        return await this.handleComplete(request);
      }

      if (request.method === 'POST' && pathname === '/upload/cancel') {
        return await this.handleCancel(request);
      }

      return jsonResponse({ message: 'Route not found.' }, 404);
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 500);
    }
  }

  private async handleInit(request: HttpRequest): Promise<HttpResponse> {
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
        lastActivityAt: Date.now(),
      });

      this.emitActivity('receiving', `Preparing ${target.fileName}`);

      return jsonResponse({
        uploadId,
        relativePath: target.relativePath,
        chunkSize: CHUNK_SIZE,
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleList(requestUrl: URL): Promise<HttpResponse> {
    try {
      const listing = await serializeLibraryListing(readOptionalString(requestUrl.searchParams.get('path')));

      return jsonResponse(listing);
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleCreateFolder(request: HttpRequest): Promise<HttpResponse> {
    try {
      const body = parseJsonBody(request.body);
      const parentPath = normalizeLibraryDirectoryPath(readOptionalString(body.parentPath));
      const name = readString(body.name, 'name');
      const folder = await createLibraryFolder(parentPath || null, name);

      this.emitActivity('idle', `Created folder ${folder.name}`);
      await this.onLibraryChanged?.();

      return jsonResponse({
        ok: true,
        ...(await serializeLibraryListing(parentPath || null)),
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleDelete(request: HttpRequest): Promise<HttpResponse> {
    try {
      const body = parseJsonBody(request.body);
      const relativePath = readString(body.relativePath, 'relativePath');
      const currentPath = normalizeLibraryDirectoryPath(readOptionalString(body.currentPath));

      const target = await getLibraryItem(relativePath);

      if (!target) {
        throw new Error('Library item not found.');
      }

      await forgetVideoArtifacts(await collectVideos(target));
      await deleteLibraryItem(target.uri);
      this.emitActivity('idle', `Deleted ${target.name}`);
      await this.onLibraryChanged?.();

      return jsonResponse({
        ok: true,
        ...(await serializeLibraryListing(currentPath || null)),
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleRename(request: HttpRequest): Promise<HttpResponse> {
    try {
      const body = parseJsonBody(request.body);
      const relativePath = readString(body.relativePath, 'relativePath');
      const currentPath = normalizeLibraryDirectoryPath(readOptionalString(body.currentPath));
      const name = readString(body.name, 'name');
      const target = await getLibraryItem(relativePath);

      if (!target) {
        throw new Error('Library item not found.');
      }

      const videosToRelink = await collectVideos(target);
      const renamed = await renameLibraryItem(target.relativePath, name);

      if (renamed.uri !== target.uri) {
        await relinkVideoArtifacts(videosToRelink, target.uri, renamed.uri);
      }

      this.emitActivity('idle', `Renamed ${target.name} to ${renamed.name}`);
      await this.onLibraryChanged?.();

      return jsonResponse({
        ok: true,
        item: serializeLibraryItem(renamed),
        ...(await serializeLibraryListing(currentPath || null)),
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleMove(request: HttpRequest): Promise<HttpResponse> {
    try {
      const body = parseJsonBody(request.body);
      const currentPath = normalizeLibraryDirectoryPath(readOptionalString(body.currentPath));
      const destinationPath = normalizeLibraryDirectoryPath(readOptionalString(body.destinationPath));
      const rawItems = Array.isArray(body.items) ? body.items : [];

      if (rawItems.length === 0) {
        throw new Error('Select at least one item to move.');
      }

      let movedCount = 0;
      const failures: string[] = [];

      // Move what we can and report the rest, matching the in-app move: one
      // collision must not abandon the remaining items with no listing returned.
      for (const rawItem of rawItems) {
        if (!rawItem || typeof rawItem !== 'object') {
          failures.push('Invalid item to move.');
          continue;
        }

        try {
          const itemBody = rawItem as Record<string, unknown>;
          const relativePath = readString(itemBody.relativePath, 'relativePath');
          const target = await getLibraryItem(relativePath);

          if (!target) {
            throw new Error('Library item not found.');
          }

          const videosToRelink = await collectVideos(target);
          const moved = await moveLibraryItem(target.relativePath, destinationPath || null);

          if (moved.uri !== target.uri) {
            await relinkVideoArtifacts(videosToRelink, target.uri, moved.uri);
            movedCount += 1;
          }
        } catch (itemError) {
          failures.push(getErrorMessage(itemError));
        }
      }

      this.emitActivity('idle', `Moved ${movedCount} item${movedCount === 1 ? '' : 's'}`);
      await this.onLibraryChanged?.();

      return jsonResponse({
        ok: true,
        movedCount,
        failures,
        ...(await serializeLibraryListing(currentPath || null)),
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleChunk(request: HttpRequest): Promise<HttpResponse> {
    const headers = normalizeHeaders(request.headers);
    // Read the plugin-written chunk path up front so it can be deleted on every
    // exit path, not just success: a rejected chunk would otherwise leak the file.
    const uploadedChunkFile = (() => {
      try {
        const headerPath = readHeader(headers, 'x-uploaded-file-path').replace(/^file:\/\//, '');

        // The plugin writes chunks into its own temp dir. Reject any other path so
        // a LAN client cannot name an arbitrary file for us to read/append/delete.
        if (headerPath !== getUploadPluginTempDir() && !headerPath.startsWith(`${getUploadPluginTempDir()}/`)) {
          return null;
        }

        return new File(normalizeFileUri(headerPath));
      } catch {
        return null;
      }
    })();

    try {
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

      if (!uploadedChunkFile?.exists) {
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
      session.lastActivityAt = Date.now();

      this.emitActivity('receiving', `Uploading ${session.fileName}`);

      return jsonResponse({
        ok: true,
        receivedBytes: session.receivedBytes,
        totalBytes: session.totalSize,
      });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    } finally {
      try {
        if (uploadedChunkFile?.exists) {
          uploadedChunkFile.delete();
        }
      } catch {
        // The plugin temp dir is swept on the next start(); ignore delete races.
      }
    }
  }

  private async handleComplete(request: HttpRequest): Promise<HttpResponse> {
    try {
      const body = parseJsonBody(request.body);
      const uploadId = readString(body.uploadId, 'uploadId');
      const session = this.uploads.get(uploadId);

      if (!session) {
        throw new Error('Upload session not found.');
      }

      try {
        if (session.receivedBytes !== session.totalSize) {
          throw new Error('Upload is incomplete.');
        }

        const existingTargetInfo = await FileSystem.getInfoAsync(session.finalUri);

        if (existingTargetInfo.exists) {
          if (existingTargetInfo.isDirectory) {
            throw new Error('A folder with that name already exists.');
          }

          await FileSystem.deleteAsync(session.finalUri, { idempotent: true });
        }

        await FileSystem.moveAsync({
          from: session.tempUri,
          to: session.finalUri,
        });
      } catch (completionError) {
        // A failed finalize otherwise leaves the session 'receiving' forever and
        // its temp file on disk. Drop both, then surface the error.
        this.uploads.delete(uploadId);
        await FileSystem.deleteAsync(session.tempUri, { idempotent: true }).catch(() => undefined);
        this.emitActivity('error', `Failed to save ${session.fileName}`);
        throw completionError;
      }

      this.uploads.delete(uploadId);
      this.emitActivity('complete', `Saved ${session.relativePath}`);

      await this.onLibraryChanged?.();
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }

  private async handleCancel(request: HttpRequest): Promise<HttpResponse> {
    try {
      const body = parseJsonBody(request.body);
      const uploadId = readString(body.uploadId, 'uploadId');
      const session = this.uploads.get(uploadId);

      if (session) {
        this.uploads.delete(uploadId);
        await FileSystem.deleteAsync(session.tempUri, { idempotent: true });
        this.emitActivity('error', `Cancelled ${session.fileName}`);
      }

      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ message: getErrorMessage(error) }, 400);
    }
  }
}

export const localUploadServer = new LocalUploadServer();
