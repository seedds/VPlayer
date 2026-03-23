import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
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
import { clearAllPlaybackProgress, clearPlaybackPosition, getAllPlaybackState, savePlaybackDuration, type PlaybackStateMap } from './src/lib/playbackState';
import {
  deleteThumbnailForVideo,
  getCachedThumbnailUri,
  persistThumbnail,
  pruneThumbnailCache,
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_TIME_SECONDS,
} from './src/lib/videoThumbnails';
import type { StorageSnapshot, UploadActivity, VideoItem } from './src/lib/types';
import { deleteVideo, ensureAppDirectories, getStorageSnapshot, listVideos } from './src/lib/videoLibrary';
import { DEFAULT_SERVER_PORT, localUploadServer } from './src/server/localUploadServer';

type ActiveTab = 'library' | 'upload';
type ButtonTone = 'primary' | 'danger';
type ThumbnailSource = ImageProps['source'];

const INITIAL_ACTIVITY: UploadActivity = {
  status: 'idle',
  message: 'Starting local server...',
  updatedAt: Date.now(),
};

export default function App() {
  const { width, height } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<ActiveTab>('library');
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [playbackStateByUri, setPlaybackStateByUri] = useState<PlaybackStateMap>({});
  const [thumbnailSourceByUri, setThumbnailSourceByUri] = useState<Record<string, ThumbnailSource | null | undefined>>({});
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedVideoUris, setSelectedVideoUris] = useState<Set<string>>(() => new Set());
  const [activity, setActivity] = useState<UploadActivity>(INITIAL_ACTIVITY);
  const [ipAddress, setIpAddress] = useState<string | null>(null);
  const [networkHint, setNetworkHint] = useState('Checking network...');
  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [activePort, setActivePort] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [portInput, setPortInput] = useState(String(DEFAULT_SERVER_PORT));

  const isAndroidTablet = useMemo(() => isAndroidTabletLayout(width, height), [height, width]);
  const progress = getUploadProgress(activity);
  const currentPort = useMemo(() => normalizePort(portInput, DEFAULT_SERVER_PORT), [portInput]);
  const serverUrl = serverRunning && ipAddress && activePort ? `http://${ipAddress}:${activePort}` : null;
  const selectedVideo = selectedIndex !== null ? videos[selectedIndex] ?? null : null;
  const selectedCount = selectedVideoUris.size;
  const shouldKeepAwakeForUpload = activity.status === 'receiving';

  const refreshLibrary = useCallback(async () => {
    const [items, snapshot, playbackState] = await Promise.all([listVideos(), getStorageSnapshot(), getAllPlaybackState()]);
    setVideos(items);
    setStorage(snapshot);
    setPlaybackStateByUri(playbackState);
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
        setNetworkHint('Connect your device and computer to the same Wi-Fi network.');
        return;
      }

      if (networkState.type !== Network.NetworkStateType.WIFI && networkState.type !== Network.NetworkStateType.ETHERNET) {
        setNetworkHint('Wi-Fi is recommended. Mobile data may not expose a local upload address.');
        return;
      }

      if (!address || address === '0.0.0.0') {
        setNetworkHint('Server is running. Discovering device IP...');
        return;
      }

      setNetworkHint('Open the upload address from a browser on the same network.');
    } catch {
      setNetworkHint('Could not detect the device IP automatically yet.');
    }
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
    if (selectedIndex !== null && selectedIndex >= videos.length) {
      setSelectedIndex(videos.length > 0 ? videos.length - 1 : null);
    }
  }, [selectedIndex, videos.length]);

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
    (video: VideoItem) => {
      Alert.alert('Delete video?', video.name, [
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
                await clearPlaybackPosition(video.uri);
                await deleteThumbnailForVideo(video);
                await deleteVideo(video.uri);
                setThumbnailSourceByUri((current) => {
                  const next = { ...current };
                  delete next[video.uri];
                  return next;
                });
                await refreshLibrary();
              } catch (error) {
                Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete the video.');
              }
            })();
          },
        },
      ]);
    },
    [refreshLibrary],
  );

  const handlePlayVideo = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  useEffect(() => {
    if (!loading && activeTab === 'library') {
      void refreshLibrary();
    }
  }, [activeTab, loading, refreshLibrary]);

  useEffect(() => {
    if (loading || activeTab !== 'library') {
      return;
    }

    void hydrateMissingDurations(videos, playbackStateByUri);
  }, [activeTab, hydrateMissingDurations, loading, playbackStateByUri, videos]);

  useEffect(() => {
    if (loading || activeTab !== 'library' || videos.length === 0) {
      return;
    }

    let cancelled = false;

    async function hydrateMissingThumbnails() {
      await pruneThumbnailCache(videos);

      for (const video of videos) {
        if (cancelled || thumbnailSourceByUri[video.uri] !== undefined) {
          continue;
        }

        const cachedThumbnailUri = await getCachedThumbnailUri(video);

        if (cachedThumbnailUri) {
          if (!cancelled) {
            setThumbnailSourceByUri((current) => ({
              ...current,
              [video.uri]: { uri: cachedThumbnailUri },
            }));
          }

          continue;
        }

        const player = createVideoPlayer(video.uri);

        try {
          const knownDuration = playbackStateByUri[video.uri]?.durationSeconds;
          const thumbnailTime = knownDuration && knownDuration > 0
            ? Math.min(THUMBNAIL_TIME_SECONDS, Math.max(0, knownDuration - 1))
            : THUMBNAIL_TIME_SECONDS;
          const thumbnails = await player.generateThumbnailsAsync([thumbnailTime], {
            maxHeight: THUMBNAIL_MAX_HEIGHT,
            maxWidth: THUMBNAIL_MAX_WIDTH,
          });
          const thumbnail = thumbnails[0] ?? null;

          if (!thumbnail) {
            throw new Error('Thumbnail generation returned no image.');
          }

          const thumbnailUri = await persistThumbnail(video, thumbnail);

          if (!cancelled) {
            setThumbnailSourceByUri((current) => ({
              ...current,
              [video.uri]: { uri: thumbnailUri },
            }));
          }
        } catch {
          if (!cancelled) {
            setThumbnailSourceByUri((current) => ({
              ...current,
              [video.uri]: null,
            }));
          }
        } finally {
          player.release();
        }
      }
    }

    void hydrateMissingThumbnails();

    return () => {
      cancelled = true;
    };
  }, [activeTab, loading, playbackStateByUri, thumbnailSourceByUri, videos]);

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
          videos={videos}
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
                selectedVideoUris={selectedVideoUris}
                selectionMode={selectionMode}
                thumbnailSourceByUri={thumbnailSourceByUri}
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
                currentPort={currentPort}
                isAndroidTablet={isAndroidTablet}
                networkHint={networkHint}
                onRestartServer={() => void startServer(normalizePort(portInput, DEFAULT_SERVER_PORT))}
                onStopServer={() => void stopServer()}
                portInput={portInput}
                progress={progress}
                serverRunning={serverRunning}
                serverUrl={serverUrl}
                setPortInput={setPortInput}
                storage={storage}
                videoCount={videos.length}
              />
            )}
          </View>

          {selectionMode ? (
            <View style={styles.selectionBar}>
              <Text style={styles.selectionCount}>{selectedCount} selected</Text>
              <View style={styles.selectionActions}>
                <Pressable
                  onPress={() => {
                    setSelectionMode(false);
                    setSelectedVideoUris(new Set());
                  }}
                  style={({ pressed }) => [styles.selectionButton, styles.selectionButtonSecondary, pressed && styles.selectionButtonPressed]}
                >
                  <Text style={styles.selectionButtonSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (selectedCount === 0) {
                      return;
                    }

                    Alert.alert('Delete selected videos?', `${selectedCount} file${selectedCount === 1 ? '' : 's'} will be removed.`, [
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

                              await Promise.all(
                                targets.map(async (video) => {
                                  await clearPlaybackPosition(video.uri);
                                  await deleteThumbnailForVideo(video);
                                  await deleteVideo(video.uri);
                                }),
                              );

                              setThumbnailSourceByUri((current) => {
                                const next = { ...current };

                                for (const video of targets) {
                                  delete next[video.uri];
                                }

                                return next;
                              });

                              setSelectionMode(false);
                              setSelectedVideoUris(new Set());
                              await refreshLibrary();
                            } catch (error) {
                              Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete the selected videos.');
                            }
                          })();
                        },
                      },
                    ]);
                  }}
                  style={({ pressed }) => [styles.selectionButton, styles.selectionButtonDanger, pressed && styles.selectionButtonPressed]}
                >
                  <Text style={styles.selectionButtonDangerText}>Delete</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

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
  onClearPlayback: () => void;
  playbackStateByUri: PlaybackStateMap;
  selectedVideoUris: Set<string>;
  selectionMode: boolean;
  thumbnailSourceByUri: Record<string, ThumbnailSource | null | undefined>;
  videos: VideoItem[];
  onDeleteVideo: (video: VideoItem) => void;
  onLongPressVideo: (video: VideoItem) => void;
  onPlayVideo: (index: number) => void;
  onToggleVideoSelection: (video: VideoItem) => void;
};

function LibraryView({
  onClearPlayback,
  playbackStateByUri,
  selectedVideoUris,
  selectionMode,
  thumbnailSourceByUri,
  videos,
  onDeleteVideo,
  onLongPressVideo,
  onPlayVideo,
  onToggleVideoSelection,
}: LibraryViewProps) {
  if (videos.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyStateTitle}>No videos yet</Text>
        <Text style={styles.emptyStateText}>Use the Upload tab at the bottom, open the device URL on your computer, and send a file here.</Text>
      </View>
    );
  }

  return (
    <View style={styles.libraryWrap}>
      {!selectionMode ? (
        <View style={styles.libraryToolbar}>
          <Pressable onPress={onClearPlayback} style={({ pressed }) => [styles.clearPlaybackButton, pressed && styles.clearPlaybackButtonPressed]}>
            <Text style={styles.clearPlaybackButtonText}>Clear playback</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.libraryList} showsVerticalScrollIndicator={false}>
        {videos.map((video, index) => (
          <VideoCard
            key={video.id}
            durationSeconds={playbackStateByUri[video.uri]?.durationSeconds}
            isNew={playbackStateByUri[video.uri]?.hasStartedPlayback !== true}
            selected={selectedVideoUris.has(video.uri)}
            selectionMode={selectionMode}
            savedPositionSeconds={playbackStateByUri[video.uri]?.positionSeconds ?? 0}
            thumbnailSource={thumbnailSourceByUri[video.uri]}
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

              onPlayVideo(index);
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}

type UploadViewProps = {
  activity: UploadActivity;
  currentPort: number;
  isAndroidTablet: boolean;
  networkHint: string;
  onRestartServer: () => void;
  onStopServer: () => void;
  portInput: string;
  progress: number;
  serverRunning: boolean;
  serverUrl: string | null;
  setPortInput: (value: string) => void;
  storage: StorageSnapshot | null;
  videoCount: number;
};

function UploadView({
  activity,
  currentPort,
  isAndroidTablet,
  networkHint,
  onRestartServer,
  onStopServer,
  portInput,
  progress,
  serverRunning,
  serverUrl,
  setPortInput,
  storage,
  videoCount,
}: UploadViewProps) {
  const serverDisplayUrl = serverUrl ?? (serverRunning ? 'Server is running. Discovering device IP...' : 'Server is stopped');
  const networkStatusText = serverRunning && !serverUrl ? 'The upload server is already running. The app is retrying local IP detection now.' : networkHint;

  return (
    <ScrollView contentContainerStyle={styles.uploadContent} showsVerticalScrollIndicator={false}>
      {isAndroidTablet && (
        <View style={styles.inlineHintWrap}>
          {isAndroidTablet ? <Text style={styles.inlineHint}>Android tablet detected: the app remains in landscape.</Text> : null}
        </View>
      )}

      <View style={styles.quickStatsRow}>
        <QuickStat label="Videos" value={String(videoCount)} />
        <QuickStat label="Free" value={storage ? formatBytes(storage.freeBytes) : '--'} />
        <QuickStat label="Port" value={String(currentPort)} />
      </View>

      <Panel title="HTTP upload server" subtitle="Keep this tab open while sending files from your computer.">
        <Text style={styles.serverStatusLabel}>{serverRunning ? 'Server is running' : 'Server is stopped'}</Text>
        <Text style={styles.serverUrl}>{serverDisplayUrl}</Text>
        <Text style={styles.supportText}>{networkStatusText}</Text>

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

        <View style={styles.uploadUrlCard}>
          <Text style={styles.uploadUrlLabel}>Desktop address</Text>
          <Text style={styles.uploadUrlValue}>{`http://<device-ip>:${currentPort}`}</Text>
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

      <Panel title="Desktop steps" subtitle="Quick flow for sending videos from your Mac or PC.">
        <View style={styles.stepsList}>
          <StepRow number="1" text="Join the same Wi-Fi network on the phone and computer." />
          <StepRow number="2" text="Open the shown address in a browser on the computer." />
          <StepRow number="3" text="Choose one or more videos and wait for the save confirmation." />
          <StepRow number="4" text="Switch back to Library and tap a video. The player continues into the next file automatically." />
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

type QuickStatProps = {
  label: string;
  value: string;
};

function QuickStat({ label, value }: QuickStatProps) {
  return (
    <View style={styles.quickStat}>
      <Text style={styles.quickStatLabel}>{label}</Text>
      <Text style={styles.quickStatValue}>{value}</Text>
    </View>
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

type StepRowProps = {
  number: string;
  text: string;
};

function StepRow({ number, text }: StepRowProps) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepBubble}>
        <Text style={styles.stepBubbleText}>{number}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
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
  quickStatsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  quickStat: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: '#e2d5c9',
    minWidth: 92,
  },
  quickStatLabel: {
    color: '#695f57',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  quickStatValue: {
    color: '#1d1917',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 3,
  },
  inlineHintWrap: {
    gap: 6,
  },
  inlineHint: {
    color: '#6c6259',
    fontSize: 12,
    lineHeight: 17,
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
  libraryToolbar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingBottom: 8,
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
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
    backgroundColor: '#efe7db',
    borderTopWidth: 1,
    borderTopColor: '#ded1c2',
  },
  selectionCount: {
    color: '#1d1917',
    fontSize: 14,
    fontWeight: '700',
  },
  selectionActions: {
    flexDirection: 'row',
    gap: 10,
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
  uploadUrlCard: {
    borderRadius: 18,
    padding: 14,
    backgroundColor: '#f7ede1',
  },
  uploadUrlLabel: {
    color: '#6f655c',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  uploadUrlValue: {
    color: '#1d1917',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 4,
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
  stepsList: {
    gap: 12,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  stepBubble: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f4e0d2',
  },
  stepBubbleText: {
    color: '#9d4a2a',
    fontSize: 13,
    fontWeight: '800',
  },
  stepText: {
    flex: 1,
    color: '#5c534b',
    fontSize: 15,
    lineHeight: 22,
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
