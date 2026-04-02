import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createVideoPlayer } from 'expo-video';
import { StatusBar } from 'expo-status-bar';
import type { ImageProps } from 'expo-image';
import { useKeepAwake } from 'expo-keep-awake';
import * as Network from 'expo-network';
import * as ScreenOrientation from 'expo-screen-orientation';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { PlayerScreen } from './src/components/PlayerScreen';
import { VideoCard } from './src/components/VideoCard';
import { isAndroidTabletLayout } from './src/lib/device';
import { formatBytes, formatDate, getUploadProgress, normalizePort } from './src/lib/format';
import {
  clearAllPlaybackProgress,
  clearPlaybackProgressForUris,
  getAllPlaybackState,
  savePlaybackDuration,
  type PlaybackStateMap,
} from './src/lib/playbackState';
import {
  deleteThumbnailForVideo,
  generateThumbnailForVideo,
  getCachedThumbnailUri,
  pruneThumbnailCache,
} from './src/lib/videoThumbnails';
import type { LibraryItem, UploadActivity, VideoItem } from './src/lib/types';
import {
  deleteLibraryItem,
  ensureAppDirectories,
  getLibraryItem,
  getVideoItems,
  listAllVideoItems,
  listLibraryItems,
} from './src/lib/videoLibrary';
import { DEFAULT_SERVER_PORT, localUploadServer } from './src/server/localUploadServer';

type ActiveTab = 'library' | 'upload';
type ButtonTone = 'primary' | 'danger';
type ThumbnailSource = ImageProps['source'];

const INITIAL_ACTIVITY: UploadActivity = {
  status: 'idle',
  message: 'Starting local server...',
  updatedAt: Date.now(),
};

const THUMBNAIL_HYDRATION_CONCURRENCY = 3;
const THUMBNAIL_HYDRATION_MAX_ATTEMPTS = 3;

function getParentPath(path: string | null): string | null {
  if (!path) {
    return null;
  }

  const segments = path.split('/').filter(Boolean);

  if (segments.length <= 1) {
    return null;
  }

  return segments.slice(0, -1).join('/');
}

export default function App() {
  const { width, height } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<ActiveTab>('library');
  const [videos, setVideos] = useState<LibraryItem[]>([]);
  const [playbackStateByUri, setPlaybackStateByUri] = useState<PlaybackStateMap>({});
  const [thumbnailSourceByUri, setThumbnailSourceByUri] = useState<Record<string, ThumbnailSource | null | undefined>>({});
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedVideoUris, setSelectedVideoUris] = useState<Set<string>>(() => new Set());
  const [currentFolderPath, setCurrentFolderPath] = useState<string | null>(null);
  const [activity, setActivity] = useState<UploadActivity>(INITIAL_ACTIVITY);
  const [ipAddress, setIpAddress] = useState<string | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [activePort, setActivePort] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [portInput, setPortInput] = useState(String(DEFAULT_SERVER_PORT));
  const playbackStateByUriRef = useRef<PlaybackStateMap>({});
  const thumbnailSourceByUriRef = useRef<Record<string, ThumbnailSource | null | undefined>>({});
  const thumbnailJobUrisRef = useRef<Set<string>>(new Set());
  const currentFolderPathRef = useRef<string | null>(null);

  const isAndroidTablet = useMemo(() => isAndroidTabletLayout(width, height), [height, width]);
  const progress = getUploadProgress(activity);
  const serverUrl = serverRunning && ipAddress && activePort ? `http://${ipAddress}:${activePort}` : null;
  const videoItems = useMemo(() => getVideoItems(videos), [videos]);
  const selectedVideo = selectedIndex !== null ? videoItems[selectedIndex] ?? null : null;
  const selectedCount = selectedVideoUris.size;
  const shouldKeepAwakeForUpload = activity.status === 'receiving';

  useEffect(() => {
    playbackStateByUriRef.current = playbackStateByUri;
  }, [playbackStateByUri]);

  useEffect(() => {
    thumbnailSourceByUriRef.current = thumbnailSourceByUri;
  }, [thumbnailSourceByUri]);

  useEffect(() => {
    currentFolderPathRef.current = currentFolderPath;
  }, [currentFolderPath]);

  const refreshLibrary = useCallback(async (path: string | null = currentFolderPathRef.current) => {
    async function loadPath(targetPath: string | null): Promise<void> {
      if (targetPath) {
        const folder = await getLibraryItem(targetPath, 'folder');

        if (!folder || folder.kind !== 'folder') {
          await loadPath(getParentPath(targetPath));
          return;
        }
      }

      const [items, playbackState] = await Promise.all([listLibraryItems(targetPath), getAllPlaybackState()]);
      currentFolderPathRef.current = targetPath;
      setCurrentFolderPath(targetPath);
      setVideos(items);
      setPlaybackStateByUri(playbackState);
    }

    await loadPath(path || null);
  }, []);

  const hydrateMissingDurations = useCallback(async (items: VideoItem[], playbackState: PlaybackStateMap) => {
    let didUpdate = false;

    for (const item of items) {
      const existingDuration = playbackState[item.uri]?.durationSeconds;

      if (typeof existingDuration === 'number' && Number.isFinite(existingDuration) && existingDuration > 0) {
        continue;
      }

      const player = createVideoPlayer(item.uri);
      let subscription: { remove(): void } | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const duration = await new Promise<number | null>((resolve) => {
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

          player.release();
          resolve(value);
        };

        subscription = player.addListener('sourceLoad', ({ duration: loadedDuration }) => {
          finish(loadedDuration);
        });

        if (Number.isFinite(player.duration) && player.duration > 0) {
          finish(player.duration);
          return;
        }

        timeoutId = setTimeout(() => {
          finish(Number.isFinite(player.duration) && player.duration > 0 ? player.duration : null);
        }, 4000);
      });

      if (duration !== null && duration >= 0) {
        await savePlaybackDuration(item.uri, duration);
        didUpdate = true;
      }
    }

    if (didUpdate) {
      setPlaybackStateByUri(await getAllPlaybackState());
    }
  }, []);

  const refreshNetwork = useCallback(async () => {
    try {
      const [networkState, address] = await Promise.all([
        Network.getNetworkStateAsync(),
        Network.getIpAddressAsync().catch(() => null),
      ]);

      setIpAddress(address && address !== '0.0.0.0' ? address : null);

      if (!networkState.isConnected) {
        return;
      }

      if (networkState.type !== Network.NetworkStateType.WIFI && networkState.type !== Network.NetworkStateType.ETHERNET) {
        return;
      }

      if (!address || address === '0.0.0.0') {
        return;
      }
    } catch { }
  }, []);

  const getCleanupVideos = useCallback(async (item: LibraryItem): Promise<VideoItem[]> => {
    if (item.kind === 'folder') {
      return await listAllVideoItems(item.relativePath);
    }

    return item.kind === 'video' ? [item] : [];
  }, []);

  const probeExistingServer = useCallback(async (port: number): Promise<{ ok: boolean; reportedPort: number | null }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        return { ok: false, reportedPort: null };
      }

      const payload = (await response.json().catch(() => null)) as { ok?: boolean; port?: number } | null;
      return {
        ok: payload?.ok === true,
        reportedPort: typeof payload?.port === 'number' && Number.isFinite(payload.port) ? payload.port : null,
      };
    } catch {
      return { ok: false, reportedPort: null };
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  const adoptRunningServer = useCallback(
    async (port: number) => {
      setPortInput(String(port));
      setActivePort(port);
      setServerRunning(true);
      setActivity({
        status: 'idle',
        message: `Server ready on port ${port}.`,
        updatedAt: Date.now(),
      });
      await refreshNetwork();
    },
    [refreshNetwork],
  );

  const startServer = useCallback(
    async (port: number) => {
      try {
        setActivity({
          status: 'idle',
          message: `Starting server on port ${port}...`,
          updatedAt: Date.now(),
        });

        const existingServer = await probeExistingServer(port);

        if (existingServer.ok) {
          await adoptRunningServer(existingServer.reportedPort ?? port);
          return;
        }

        await localUploadServer.start({
          port,
          onActivity: setActivity,
          onLibraryChanged: refreshLibrary,
        });

        const reportedPort = localUploadServer.getPort();
        const resolvedPort = reportedPort && reportedPort >= 1025 && reportedPort <= 65535 ? reportedPort : port;

        await adoptRunningServer(resolvedPort);
      } catch (error) {
        const existingAfterFailure = await probeExistingServer(port);

        if (existingAfterFailure.ok) {
          await adoptRunningServer(existingAfterFailure.reportedPort ?? port);
          return;
        }

        setActivePort(null);
        setServerRunning(false);
        setActivity({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to start the server.',
          updatedAt: Date.now(),
        });
      }
    },
    [adoptRunningServer, probeExistingServer, refreshLibrary],
  );

  const stopServer = useCallback(async () => {
    await localUploadServer.stop();
    setActivePort(null);
    setServerRunning(false);
  }, []);

  useEffect(() => {
    if (selectedIndex !== null && selectedIndex >= videoItems.length) {
      setSelectedIndex(videoItems.length > 0 ? videoItems.length - 1 : null);
    }
  }, [selectedIndex, videoItems.length]);

  useEffect(() => {
    setSelectedVideoUris((current) => {
      if (current.size === 0) {
        return current;
      }

      const next = new Set(videos.map((video) => video.uri));
      const filtered = new Set(Array.from(current).filter((uri) => next.has(uri)));

      return filtered.size === current.size ? current : filtered;
    });
  }, [videos]);

  useEffect(() => {
    setThumbnailSourceByUri((current) => {
      const validUris = new Set(videos.map((video) => video.uri));
      const nextEntries = Object.entries(current).filter(([uri]) => validUris.has(uri));

      thumbnailJobUrisRef.current.forEach((uri) => {
        if (!validUris.has(uri)) {
          thumbnailJobUrisRef.current.delete(uri);
        }
      });

      return nextEntries.length === Object.keys(current).length ? current : Object.fromEntries(nextEntries);
    });
  }, [videos]);

  useEffect(() => {
    if (selectionMode && selectedCount === 0) {
      setSelectionMode(false);
    }
  }, [selectedCount, selectionMode]);

  useEffect(() => {
    if (!selectedVideo) {
      void ScreenOrientation.lockAsync(
        isAndroidTablet ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
      );
    }
  }, [isAndroidTablet, selectedVideo]);

  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      try {
        await ensureAppDirectories();
        await refreshLibrary();
        void refreshNetwork();

        if (!isMounted) {
          return;
        }

        await startServer(DEFAULT_SERVER_PORT);
      } catch (error) {
        if (isMounted) {
          setActivity({
            status: 'error',
            message: error instanceof Error ? error.message : 'App startup failed.',
            updatedAt: Date.now(),
          });
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void bootstrap();

    return () => {
      isMounted = false;
      void localUploadServer.stop();
    };
  }, [refreshLibrary, refreshNetwork, startServer]);

  const handleDeleteVideo = useCallback(
    (video: LibraryItem) => {
      Alert.alert(video.kind === 'folder' ? 'Delete folder?' : 'Delete file?', video.name, [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                const cleanupVideos = Array.from(
                  new Map((await getCleanupVideos(video)).map((item) => [item.uri, item])).values(),
                );

                if (cleanupVideos.length > 0) {
                  await clearPlaybackProgressForUris(cleanupVideos.map((item) => item.uri));
                  await Promise.all(cleanupVideos.map((item) => deleteThumbnailForVideo(item)));
                  setThumbnailSourceByUri((current) => {
                    const next = { ...current };

                    for (const item of cleanupVideos) {
                      delete next[item.uri];
                    }

                    return next;
                  });
                }

                await deleteLibraryItem(video.uri);
                await refreshLibrary();
              } catch (error) {
                Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete the file.');
              }
            })();
          },
        },
      ]);
    },
    [getCleanupVideos, refreshLibrary],
  );

  const handlePlayVideo = useCallback(
    (uri: string) => {
      const index = videoItems.findIndex((video) => video.uri === uri);

      if (index >= 0) {
        setSelectedIndex(index);
      }
    },
    [videoItems],
  );

  const handleCancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedVideoUris(new Set());
  }, []);

  const handleDeleteSelected = useCallback(() => {
    if (selectedCount === 0) {
      return;
    }

    Alert.alert('Delete selected items?', `${selectedCount} item${selectedCount === 1 ? '' : 's'} will be removed.`, [
      {
        text: 'Cancel',
        style: 'cancel',
      },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                const targets = videos.filter((video) => selectedVideoUris.has(video.uri));
                const cleanupVideos = Array.from(
                  new Map((await Promise.all(targets.map((video) => getCleanupVideos(video)))).flat().map((video) => [video.uri, video])).values(),
                );

                if (cleanupVideos.length > 0) {
                  await clearPlaybackProgressForUris(cleanupVideos.map((video) => video.uri));
                  await Promise.all(cleanupVideos.map((video) => deleteThumbnailForVideo(video)));
                }

                await Promise.all(
                  targets.map(async (video) => {
                    await deleteLibraryItem(video.uri);
                  }),
                );

                setThumbnailSourceByUri((current) => {
                  const next = { ...current };

                  for (const video of cleanupVideos) {
                    delete next[video.uri];
                  }

                  return next;
              });

              handleCancelSelection();
              await refreshLibrary();
            } catch (error) {
              Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete the selected files.');
            }
            })();
          },
        },
      ]);
  }, [getCleanupVideos, handleCancelSelection, refreshLibrary, selectedCount, selectedVideoUris, videos]);

  const handleClearSelectedPlayback = useCallback(() => {
    if (selectedCount === 0) {
      return;
    }

    Alert.alert(
      'Clear playback history?',
      'Saved playback positions will be reset for videos inside the selected items.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                const targets = videos.filter((video) => selectedVideoUris.has(video.uri));
                const selectedVideos = Array.from(
                  new Map((await Promise.all(targets.map((video) => getCleanupVideos(video)))).flat().map((video) => [video.uri, video])).values(),
                );

                await clearPlaybackProgressForUris(selectedVideos.map((video) => video.uri));
                handleCancelSelection();
                await refreshLibrary();
              } catch (error) {
                Alert.alert('Clear failed', error instanceof Error ? error.message : 'Could not clear playback history for the selected files.');
              }
            })();
          },
        },
      ],
    );
  }, [getCleanupVideos, handleCancelSelection, refreshLibrary, selectedVideoUris, videos]);

  useEffect(() => {
    if (!loading && activeTab === 'library') {
      void refreshLibrary();
    }
  }, [activeTab, loading, refreshLibrary]);

  useEffect(() => {
    if (loading) {
      return;
    }

    void hydrateMissingDurations(videoItems, playbackStateByUri);
  }, [hydrateMissingDurations, loading, playbackStateByUri, videoItems]);

  useEffect(() => {
    if (loading) {
      return;
    }

    let cancelled = false;
    let runThumbnailUris: Set<string> | null = null;

    async function hydrateMissingThumbnails() {
      await pruneThumbnailCache(await listAllVideoItems());

      const queuedVideos = videoItems.filter((video) => {
        if (thumbnailSourceByUriRef.current[video.uri] !== undefined || thumbnailJobUrisRef.current.has(video.uri)) {
          return false;
        }

        thumbnailJobUrisRef.current.add(video.uri);
        return true;
      });

      if (queuedVideos.length === 0) {
        return;
      }

      runThumbnailUris = new Set(queuedVideos.map((video) => video.uri));

      const retryCountsByUri = new Map<string, number>();
      const queue = [...queuedVideos];

      const runWorker = async () => {
        while (!cancelled) {
          const video = queue.shift();

          if (!video) {
            return;
          }

          let shouldReleaseJob = true;

          try {
            const cachedThumbnailUri = await getCachedThumbnailUri(video);

            if (cachedThumbnailUri) {
              if (!cancelled) {
                setThumbnailSourceByUri((current) => ({
                  ...current,
                  [video.uri]: { uri: cachedThumbnailUri },
                }));
              }

              retryCountsByUri.delete(video.uri);

              continue;
            }

            const thumbnailUri = await generateThumbnailForVideo(
              video,
              playbackStateByUriRef.current[video.uri]?.durationSeconds,
            );

            if (!cancelled) {
              setThumbnailSourceByUri((current) => ({
                ...current,
                [video.uri]: { uri: thumbnailUri },
              }));
            }

            retryCountsByUri.delete(video.uri);
          } catch {
            const nextAttempt = (retryCountsByUri.get(video.uri) ?? 0) + 1;

            if (!cancelled && nextAttempt < THUMBNAIL_HYDRATION_MAX_ATTEMPTS) {
              retryCountsByUri.set(video.uri, nextAttempt);
              queue.push(video);
              shouldReleaseJob = false;
              continue;
            }

            retryCountsByUri.delete(video.uri);

            if (!cancelled) {
              setThumbnailSourceByUri((current) => {
                if (current[video.uri] === undefined) {
                  return current;
                }

                const next = { ...current };
                delete next[video.uri];
                return next;
              });
            }
          } finally {
            if (shouldReleaseJob) {
              thumbnailJobUrisRef.current.delete(video.uri);
            }
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(THUMBNAIL_HYDRATION_CONCURRENCY, queuedVideos.length) }, () => runWorker()),
      );
    }

    void hydrateMissingThumbnails();

    return () => {
      cancelled = true;

      runThumbnailUris?.forEach((uri) => {
        thumbnailJobUrisRef.current.delete(uri);
      });
    };
  }, [loading, playbackStateByUri, videoItems]);

  useEffect(() => {
    if (!loading && activeTab === 'upload') {
      if (selectionMode) {
        setSelectionMode(false);
        setSelectedVideoUris(new Set());
      }

      void refreshNetwork();
    }
  }, [activeTab, loading, refreshNetwork, selectionMode]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        return;
      }

      void refreshLibrary();

      if (activeTab === 'upload') {
        void refreshNetwork();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [activeTab, refreshLibrary, refreshNetwork]);

  useEffect(() => {
    if (!serverRunning || ipAddress || loading) {
      return;
    }

    const interval = setInterval(() => {
      void refreshNetwork();
    }, 2000);

    return () => {
      clearInterval(interval);
    };
  }, [ipAddress, loading, refreshNetwork, serverRunning]);

  if (selectedVideo && selectedIndex !== null) {
    return (
      <SafeAreaProvider>
        <PlayerScreen
          currentIndex={selectedIndex}
          exitOrientationLock={
            isAndroidTablet ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP
          }
          videos={videoItems}
          onClose={() => {
            setSelectedIndex(null);
            void refreshLibrary();
          }}
          onSelectIndex={setSelectedIndex}
        />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
        {shouldKeepAwakeForUpload ? <UploadWakeLock /> : null}
        <StatusBar style="dark" />
        <View style={styles.screen}>
          <View style={styles.contentArea}>
            {loading ? (
              <View style={styles.loadingCard}>
                <ActivityIndicator size="large" color="#1f6f68" />
                <Text style={styles.loadingText}>Preparing storage, network, and local upload server...</Text>
              </View>
            ) : activeTab === 'library' ? (
              <LibraryView
                currentFolderPath={currentFolderPath}
                onClearPlayback={() => {
                  Alert.alert('Clear playback history?', 'This resets all saved playback positions and marks every video as new.', [
                    {
                      text: 'Cancel',
                      style: 'cancel',
                    },
                    {
                      text: 'Clear',
                      style: 'destructive',
                      onPress: () => {
                        void (async () => {
                          try {
                            await clearAllPlaybackProgress();
                            await refreshLibrary();
                          } catch (error) {
                            Alert.alert('Clear failed', error instanceof Error ? error.message : 'Could not clear playback history.');
                          }
                        })();
                      },
                    },
                  ]);
                }}
                playbackStateByUri={playbackStateByUri}
                selectedCount={selectedCount}
                selectedVideoUris={selectedVideoUris}
                selectionMode={selectionMode}
                thumbnailSourceByUri={thumbnailSourceByUri}
                onCancelSelection={handleCancelSelection}
                onClearSelectedPlayback={handleClearSelectedPlayback}
                onDeleteSelected={handleDeleteSelected}
                onNavigateUp={() => {
                  handleCancelSelection();
                  void refreshLibrary(getParentPath(currentFolderPath));
                }}
                onOpenFolder={(path) => {
                  handleCancelSelection();
                  void refreshLibrary(path);
                }}
                videos={videos}
                onDeleteVideo={handleDeleteVideo}
                onLongPressVideo={(video) => {
                  setSelectionMode(true);
                  setSelectedVideoUris(new Set([video.uri]));
                }}
                onPlayVideo={handlePlayVideo}
                onToggleVideoSelection={(video) => {
                  setSelectedVideoUris((current) => {
                    const next = new Set(current);

                    if (next.has(video.uri)) {
                      next.delete(video.uri);
                    } else {
                      next.add(video.uri);
                    }

                    return next;
                  });
                }}
              />
            ) : (
              <UploadView
                activity={activity}
                onRestartServer={() => void startServer(normalizePort(portInput, DEFAULT_SERVER_PORT))}
                onStopServer={() => void stopServer()}
                portInput={portInput}
                progress={progress}
                serverRunning={serverRunning}
                serverUrl={serverUrl}
                setPortInput={setPortInput}
              />
            )}
          </View>

          <View style={styles.bottomTabBar}>
            <BottomTabButton active={activeTab === 'library'} label="Library" onPress={() => setActiveTab('library')} />
            <BottomTabButton
              active={activeTab === 'upload'}
              label="Upload"
              onPress={() => {
                setSelectionMode(false);
                setSelectedVideoUris(new Set());
                setActiveTab('upload');
              }}
            />
          </View>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function UploadWakeLock() {
  useKeepAwake();

  return null;
}

type LibraryViewProps = {
  currentFolderPath: string | null;
  onCancelSelection: () => void;
  onClearPlayback: () => void;
  onClearSelectedPlayback: () => void;
  onDeleteSelected: () => void;
  onNavigateUp: () => void;
  onOpenFolder: (path: string) => void;
  playbackStateByUri: PlaybackStateMap;
  selectedCount: number;
  selectedVideoUris: Set<string>;
  selectionMode: boolean;
  thumbnailSourceByUri: Record<string, ThumbnailSource | null | undefined>;
  videos: LibraryItem[];
  onDeleteVideo: (video: LibraryItem) => void;
  onLongPressVideo: (video: LibraryItem) => void;
  onPlayVideo: (uri: string) => void;
  onToggleVideoSelection: (video: LibraryItem) => void;
};

function LibraryView({
  currentFolderPath,
  onCancelSelection,
  onClearPlayback,
  onClearSelectedPlayback,
  onDeleteSelected,
  onNavigateUp,
  onOpenFolder,
  playbackStateByUri,
  selectedCount,
  selectedVideoUris,
  selectionMode,
  thumbnailSourceByUri,
  videos,
  onDeleteVideo,
  onLongPressVideo,
  onPlayVideo,
  onToggleVideoSelection,
}: LibraryViewProps) {
  const pathSegments = currentFolderPath ? currentFolderPath.split('/').filter(Boolean) : [];

  return (
    <View style={styles.libraryWrap}>
      {pathSegments.length > 0 ? (
        <ScrollView contentContainerStyle={styles.libraryBreadcrumbs} horizontal showsHorizontalScrollIndicator={false}>
          {pathSegments.map((segment, index) => {
            const path = pathSegments.slice(0, index + 1).join('/');

            return (
              <View key={path} style={styles.libraryPathSegment}>
                {index > 0 ? <Text style={styles.libraryPathDivider}>/</Text> : null}
                <Pressable onPress={() => onOpenFolder(path)} style={({ pressed }) => [styles.libraryPathButton, pressed && styles.libraryPathButtonPressed]}>
                  <Text style={styles.libraryPathButtonText}>{segment}</Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      ) : null}

      <View style={styles.libraryToolbar}>
        {selectionMode ? (
          <Text style={styles.selectionCount}>{selectedCount} selected</Text>
        ) : currentFolderPath ? (
          <Pressable onPress={onNavigateUp} style={({ pressed }) => [styles.libraryBackButton, pressed && styles.libraryBackButtonPressed]}>
            <Text style={styles.libraryBackButtonText}>{'\u2190'}</Text>
          </Pressable>
        ) : (
          <View />
        )}
        {selectionMode ? (
          <View style={styles.selectionActions}>
            <Pressable onPress={onCancelSelection} style={({ pressed }) => [styles.selectionButton, styles.selectionButtonSecondary, pressed && styles.selectionButtonPressed]}>
              <Text style={styles.selectionButtonSecondaryText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={onClearSelectedPlayback} style={({ pressed }) => [styles.selectionButton, styles.selectionButtonSecondary, pressed && styles.selectionButtonPressed]}>
              <Text style={styles.selectionButtonSecondaryText}>Clear History</Text>
            </Pressable>
            <Pressable onPress={onDeleteSelected} style={({ pressed }) => [styles.selectionButton, styles.selectionButtonDanger, pressed && styles.selectionButtonPressed]}>
              <Text style={styles.selectionButtonDangerText}>Delete</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.libraryToolbarActions}>
            <Pressable onPress={onClearPlayback} style={({ pressed }) => [styles.clearPlaybackButton, pressed && styles.clearPlaybackButtonPressed]}>
              <Text style={styles.clearPlaybackButtonText}>Clear All History</Text>
            </Pressable>
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.libraryList} showsVerticalScrollIndicator={false}>
        {videos.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateTitle}>{currentFolderPath ? 'This folder is empty' : 'No media yet'}</Text>
            <Text style={styles.emptyStateText}>
              {currentFolderPath
                ? 'Use the Upload tab to add files here, or go up to another folder.'
                : 'Use the Upload tab at the bottom, open the device URL on your computer, and send a file here.'}
            </Text>
          </View>
        ) : null}
        {videos.map((video) => (
          <VideoCard
            key={video.id}
            durationSeconds={video.kind === 'video' ? playbackStateByUri[video.uri]?.durationSeconds : undefined}
            isNew={video.kind === 'video' ? playbackStateByUri[video.uri]?.hasStartedPlayback !== true : false}
            selected={selectedVideoUris.has(video.uri)}
            selectionMode={selectionMode}
            savedPositionSeconds={video.kind === 'video' ? playbackStateByUri[video.uri]?.positionSeconds ?? 0 : undefined}
            thumbnailSource={video.kind === 'video' ? thumbnailSourceByUri[video.uri] : undefined}
            video={video}
            onLongPress={() => {
              if (selectionMode) {
                onToggleVideoSelection(video);
                return;
              }

              onLongPressVideo(video);
            }}
            onDelete={() => onDeleteVideo(video)}
            onPlay={() => {
              if (selectionMode) {
                onToggleVideoSelection(video);
                return;
              }

              if (video.kind !== 'video') {
                if (video.kind === 'folder') {
                  onOpenFolder(video.relativePath);
                }

                return;
              }

              onPlayVideo(video.uri);
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}

type UploadViewProps = {
  activity: UploadActivity;
  onRestartServer: () => void;
  onStopServer: () => void;
  portInput: string;
  progress: number;
  serverRunning: boolean;
  serverUrl: string | null;
  setPortInput: (value: string) => void;
};

function UploadView({
  activity,
  onRestartServer,
  onStopServer,
  portInput,
  progress,
  serverRunning,
  serverUrl,
  setPortInput,
}: UploadViewProps) {
  const serverDisplayUrl = serverUrl ?? (serverRunning ? 'Server is running. Discovering device IP...' : 'Server is stopped');

  return (
    <ScrollView contentContainerStyle={styles.uploadContent} showsVerticalScrollIndicator={false}>
      <Panel title="HTTP upload server" subtitle="Keep this tab open while sending files from your computer.">
        <Text style={styles.serverStatusLabel}>{serverRunning ? 'Server is running' : 'Server is stopped'}</Text>
        <Text style={styles.serverUrl}>{serverDisplayUrl}</Text>

        <View style={styles.portRow}>
          <View style={styles.portInputWrap}>
            <Text style={styles.inputLabel}>Port</Text>
            <TextInput
              keyboardType="number-pad"
              onChangeText={setPortInput}
              placeholder="8080"
              placeholderTextColor="#8f857b"
              style={styles.portInput}
              value={portInput}
            />
          </View>
          <View style={styles.portActions}>
            <ActionButton label={serverRunning ? 'Restart server' : 'Start server'} onPress={onRestartServer} tone="primary" />
            <ActionButton disabled={!serverRunning} label="Stop" onPress={onStopServer} tone="danger" />
          </View>
        </View>
      </Panel>

      <Panel title="Upload activity" subtitle="Each finished upload appears automatically in Library.">
        <View style={styles.activityHeader}>
          <Text style={styles.activityMessage}>{activity.message}</Text>
          <Text style={styles.activityTime}>{formatDate(activity.updatedAt)}</Text>
        </View>

        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>

        <View style={styles.activityMetaRow}>
          <Text style={styles.supportText}>{activity.fileName ?? 'No active file'}</Text>
          <Text style={styles.supportText}>
            {activity.totalBytes
              ? `${formatBytes(activity.receivedBytes ?? 0)} / ${formatBytes(activity.totalBytes)}`
              : activity.status === 'complete'
                ? 'Upload finished'
                : 'Waiting for browser upload'}
          </Text>
        </View>
      </Panel>
    </ScrollView>
  );
}

type PanelProps = {
  children: ReactNode;
  subtitle: string;
  title: string;
};

function Panel({ children, subtitle, title }: PanelProps) {
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>{title}</Text>
      <Text style={styles.panelSubtitle}>{subtitle}</Text>
      <View style={styles.panelBody}>{children}</View>
    </View>
  );
}

type BottomTabButtonProps = {
  active: boolean;
  label: string;
  onPress: () => void;
};

function BottomTabButton({ active, label, onPress }: BottomTabButtonProps) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.bottomTabButton, active && styles.bottomTabButtonActive, pressed && styles.bottomTabButtonPressed]}>
      <Text style={[styles.bottomTabText, active && styles.bottomTabTextActive]}>{label}</Text>
    </Pressable>
  );
}

type ActionButtonProps = {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  tone: ButtonTone;
};

function ActionButton({ disabled = false, label, onPress, tone }: ActionButtonProps) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        tone === 'primary' && styles.actionButtonPrimary,
        tone === 'danger' && styles.actionButtonDanger,
        (pressed || disabled) && styles.actionButtonPressed,
      ]}
    >
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#efe7db',
  },
  screen: {
    flex: 1,
    backgroundColor: '#efe7db',
  },
  contentArea: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  loadingCard: {
    flex: 1,
    borderRadius: 24,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff8f1',
    gap: 16,
  },
  loadingText: {
    color: '#62574e',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  libraryWrap: {
    flex: 1,
  },
  libraryBreadcrumbs: {
    gap: 8,
    alignItems: 'center',
    paddingBottom: 10,
  },
  libraryPathSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  libraryPathDivider: {
    color: '#7b7067',
    fontSize: 14,
    fontWeight: '700',
  },
  libraryPathButton: {
    borderRadius: 14,
    backgroundColor: '#e3d7ca',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  libraryPathButtonPressed: {
    opacity: 0.78,
  },
  libraryPathButtonText: {
    color: '#4f463f',
    fontSize: 13,
    fontWeight: '700',
  },
  libraryToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
    gap: 10,
  },
  libraryToolbarActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'flex-end',
  },
  libraryBackButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: '#e3d7ca',
    alignItems: 'center',
    justifyContent: 'center',
  },
  libraryBackButtonPressed: {
    opacity: 0.78,
  },
  libraryBackButtonText: {
    color: '#4f463f',
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  libraryList: {
    gap: 0,
    paddingBottom: 12,
  },
  clearPlaybackButton: {
    borderRadius: 14,
    backgroundColor: '#e3d7ca',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  clearPlaybackButtonPressed: {
    opacity: 0.78,
  },
  clearPlaybackButtonText: {
    color: '#4f463f',
    fontSize: 13,
    fontWeight: '700',
  },
  selectionCount: {
    color: '#1d1917',
    fontSize: 14,
    fontWeight: '700',
  },
  selectionActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'flex-end',
  },
  selectionButton: {
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  selectionButtonSecondary: {
    backgroundColor: '#e3d7ca',
  },
  selectionButtonDanger: {
    backgroundColor: '#9e3e28',
  },
  selectionButtonPressed: {
    opacity: 0.78,
  },
  selectionButtonSecondaryText: {
    color: '#4f463f',
    fontSize: 13,
    fontWeight: '700',
  },
  selectionButtonDangerText: {
    color: '#fff7f2',
    fontSize: 13,
    fontWeight: '700',
  },
  emptyState: {
    flex: 1,
    borderRadius: 24,
    backgroundColor: '#fff8f1',
    borderWidth: 1,
    borderColor: '#ead8c4',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 10,
  },
  emptyStateTitle: {
    color: '#1d1917',
    fontSize: 24,
    fontWeight: '800',
  },
  emptyStateText: {
    color: '#645a51',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  uploadContent: {
    gap: 14,
    paddingBottom: 16,
  },
  panel: {
    borderRadius: 24,
    padding: 18,
    backgroundColor: '#fff8f1',
    borderWidth: 1,
    borderColor: '#ead8c4',
  },
  panelTitle: {
    color: '#1d1917',
    fontSize: 21,
    fontWeight: '800',
  },
  panelSubtitle: {
    color: '#70665d',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  panelBody: {
    marginTop: 16,
    gap: 14,
  },
  serverStatusLabel: {
    color: '#1d1917',
    fontSize: 16,
    fontWeight: '700',
  },
  serverUrl: {
    color: '#b35a36',
    fontSize: 18,
    fontWeight: '800',
  },
  supportText: {
    color: '#6f655c',
    fontSize: 14,
    lineHeight: 20,
  },
  portRow: {
    gap: 12,
  },
  portInputWrap: {
    gap: 8,
  },
  inputLabel: {
    color: '#5d544c',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  portInput: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#dfcfbd',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fffdf9',
    color: '#1d1917',
    fontSize: 16,
    fontWeight: '600',
  },
  portActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  actionButton: {
    minWidth: 120,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 16,
    alignItems: 'center',
  },
  actionButtonPrimary: {
    backgroundColor: '#c6673d',
  },
  actionButtonDanger: {
    backgroundColor: '#9e3e28',
  },
  actionButtonPressed: {
    opacity: 0.76,
  },
  actionButtonText: {
    color: '#fff7f2',
    fontSize: 14,
    fontWeight: '700',
  },
  activityHeader: {
    gap: 6,
  },
  activityMessage: {
    color: '#1d1917',
    fontSize: 16,
    fontWeight: '700',
  },
  activityTime: {
    color: '#756a61',
    fontSize: 13,
  },
  progressTrack: {
    height: 12,
    borderRadius: 999,
    backgroundColor: '#e7d8c9',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#1f6f68',
  },
  activityMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  bottomTabBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: '#efe7db',
    borderTopWidth: 1,
    borderTopColor: '#ded1c2',
  },
  bottomTabButton: {
    flex: 1,
    borderRadius: 18,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#e3d7ca',
  },
  bottomTabButtonActive: {
    backgroundColor: '#1f6f68',
  },
  bottomTabButtonPressed: {
    opacity: 0.82,
  },
  bottomTabText: {
    color: '#4f463f',
    fontSize: 14,
    fontWeight: '700',
  },
  bottomTabTextActive: {
    color: '#f8f3ee',
  },
});
