import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavigationContainer, DefaultTheme, useNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import * as Network from 'expo-network';
import * as ScreenOrientation from 'expo-screen-orientation';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { FolderPickerModal } from './src/components/FolderPickerModal';
import { PlayerScreen } from './src/components/PlayerScreen';
import { PromptModal } from './src/components/PromptModal';
import { VideoCard } from './src/components/VideoCard';
import { isAndroidTabletLayout } from './src/lib/device';
import { formatBytes, formatDate, getUploadProgress, normalizePort } from './src/lib/format';
import {
  clampSetting,
  getSettings,
  SETTING_LIMITS,
  type SettingKey,
  type Settings,
  updateSettings,
} from './src/lib/settings';
import {
  clearAllPlaybackProgress,
  clearPlaybackProgressForUris,
  getAllPlaybackState,
  type PlaybackStateMap,
} from './src/lib/playbackState';
import { forgetProbedUris, hydrateVideos } from './src/lib/mediaHydration';
import { relinkVideoArtifacts } from './src/lib/videoArtifacts';
import { deleteThumbnailForVideo, pruneThumbnailCache } from './src/lib/videoThumbnails';
import type { LibraryItem, UploadActivity, VideoItem } from './src/lib/types';
import {
  collectVideos,
  createLibraryFolder,
  deleteLibraryItem,
  ensureAppDirectories,
  getFileExtension,
  getLibraryItem,
  getParentPath,
  getVideoItems,
  listAllVideoItems,
  listLibraryItems,
  moveLibraryItem,
  renameLibraryItem,
} from './src/lib/videoLibrary';
import { DEFAULT_SERVER_PORT, localUploadServer } from './src/server/localUploadServer';

type ButtonTone = 'primary' | 'danger';

type RootStackParamList = {
  MainTabs: undefined;
  Player: undefined;
  UploadConcurrencySettings: undefined;
  SubtitleSizeSettings: undefined;
  LongPressSpeedSettings: undefined;
};

type MainTabParamList = {
  Library: undefined;
  Settings: undefined;
  Upload: undefined;
};

function createUploadActivity(status: UploadActivity['status'], message: string): UploadActivity {
  return {
    status,
    message,
    activeUploads: [],
    updatedAt: Date.now(),
  };
}

const INITIAL_ACTIVITY = createUploadActivity('idle', 'Starting local server...');

const THUMBNAIL_HYDRATION_CONCURRENCY = 3;

// Full name with the base selected (extension preserved but not highlighted),
// matching the Flutter rename prompt so the part that must be kept is visible.
function getRenameSelection(name: string): { start: number; end: number } {
  const extension = getFileExtension(name);
  return { start: 0, end: Math.max(name.length - extension.length, 0) };
}

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTab = createBottomTabNavigator<MainTabParamList>();

const navigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#efe7db',
    border: '#ded1c2',
    card: '#efe7db',
    primary: '#1f6f68',
    text: '#1d1917',
  },
};

export default function App() {
  const { width, height } = useWindowDimensions();
  const [videos, setVideos] = useState<LibraryItem[]>([]);
  const [playbackStateByUri, setPlaybackStateByUri] = useState<PlaybackStateMap>({});
  const [thumbnailUriByVideo, setThumbnailUriByVideo] = useState<Record<string, string>>({});
  const [selectedVideoUri, setSelectedVideoUri] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedVideoUris, setSelectedVideoUris] = useState<Set<string>>(() => new Set());
  const [currentFolderPath, setCurrentFolderPath] = useState<string | null>(null);
  const [activity, setActivity] = useState<UploadActivity>(INITIAL_ACTIVITY);
  const [ipAddress, setIpAddress] = useState<string | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [activePort, setActivePort] = useState<number | null>(null);
  // Bumped only when the upload server reports a library change, to trigger a
  // full-library thumbnail pass. Plain UI refreshes (tab focus, foreground) do
  // not bump it, so they never restat every thumbnail in the library.
  const [serverLibraryRevision, setServerLibraryRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [portInput, setPortInput] = useState(String(DEFAULT_SERVER_PORT));
  const [settings, setSettings] = useState<Settings>(() => ({
    maxParallelUploads: SETTING_LIMITS.maxParallelUploads.default,
    subtitleFontSize: SETTING_LIMITS.subtitleFontSize.default,
    longPressSpeedTenths: SETTING_LIMITS.longPressSpeedTenths.default,
  }));
  const { maxParallelUploads, subtitleFontSize, longPressSpeedTenths } = settings;
  // In-app library-management dialogs (Android has no Alert.prompt).
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<LibraryItem | null>(null);
  const [moveVisible, setMoveVisible] = useState(false);
  const currentFolderPathRef = useRef<string | null>(null);
  const maxParallelUploadsRef = useRef(SETTING_LIMITS.maxParallelUploads.default);
  const navigationRef = useNavigationContainerRef<RootStackParamList>();

  const isAndroidTablet = useMemo(() => isAndroidTabletLayout(width, height), [height, width]);
  const progress = getUploadProgress(activity);
  const serverUrl = serverRunning && ipAddress && activePort ? `http://${ipAddress}:${activePort}` : null;
  const videoItems = useMemo(() => getVideoItems(videos), [videos]);
  const selectedIndex = useMemo(() => {
    if (!selectedVideoUri) {
      return null;
    }

    const index = videoItems.findIndex((video) => video.uri === selectedVideoUri);
    return index >= 0 ? index : null;
  }, [selectedVideoUri, videoItems]);
  const selectedVideo = selectedIndex !== null ? videoItems[selectedIndex] ?? null : null;
  const selectedCount = selectedVideoUris.size;
  const selectedItems = useMemo(() => videos.filter((video) => selectedVideoUris.has(video.uri)), [selectedVideoUris, videos]);
  const allSelected = videos.length > 0 && selectedCount === videos.length;
  const shouldKeepAwakeForUpload = activity.activeUploads.length > 0;

  useEffect(() => {
    currentFolderPathRef.current = currentFolderPath;
  }, [currentFolderPath]);

  useEffect(() => {
    maxParallelUploadsRef.current = maxParallelUploads;
    localUploadServer.setMaxParallelUploads(maxParallelUploads);
  }, [maxParallelUploads]);

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

  // Probes the current folder's videos (thumbnail + duration) as the user
  // navigates. Cheap: mediaHydration skips URIs already probed this session, so
  // re-entering a folder does no work.
  const hydrateCurrentFolder = useCallback((items: VideoItem[]): (() => void) => {
    const handle = hydrateVideos(items, { concurrency: THUMBNAIL_HYDRATION_CONCURRENCY }, {
      onResult: (video, result) => {
        if (result.thumbnailUri) {
          setThumbnailUriByVideo((current) => ({ ...current, [video.uri]: result.thumbnailUri as string }));
        }

        if (result.durationSeconds !== null) {
          setPlaybackStateByUri((current) => {
            const entry = current[video.uri];
            const nextDuration = result.durationSeconds as number;

            if (entry?.durationSeconds === nextDuration) {
              return current;
            }

            return {
              ...current,
              [video.uri]: {
                durationSeconds: nextDuration,
                hasStartedPlayback: entry?.hasStartedPlayback ?? false,
                positionSeconds: entry?.positionSeconds ?? 0,
                updatedAt: entry?.updatedAt ?? Date.now(),
              },
            };
          });
        }
      },
    });

    return handle.cancel;
  }, []);

  const refreshNetwork = useCallback(async () => {
    try {
      const [networkState, address] = await Promise.all([
        Network.getNetworkStateAsync(),
        Network.getIpAddressAsync().catch(() => null),
      ]);

      // Only publish the IP when it can actually reach the upload server: a LAN
      // connection over Wi-Fi or Ethernet. On cellular the address is unreachable
      // from a computer, so showing it as the server URL would be misleading.
      const isLanConnection =
        networkState.isConnected &&
        (networkState.type === Network.NetworkStateType.WIFI ||
          networkState.type === Network.NetworkStateType.ETHERNET);

      setIpAddress(isLanConnection && address && address !== '0.0.0.0' ? address : null);
    } catch {
      setIpAddress(null);
    }
  }, []);

  const startServer = useCallback(
    async (port: number, configuredMaxParallelUploads = maxParallelUploadsRef.current) => {
      try {
        setActivity(createUploadActivity('idle', `Starting server on port ${port}...`));

        await localUploadServer.start({
          maxParallelUploads: configuredMaxParallelUploads,
          port,
          onActivity: setActivity,
          onLibraryChanged: async () => {
            await refreshLibrary();
            // Only a server-driven change (upload, browser delete/rename/move)
            // triggers the full-library thumbnail pass.
            setServerLibraryRevision((current) => current + 1);
          },
        });

        const reportedPort = localUploadServer.getPort();
        const resolvedPort = reportedPort && reportedPort >= 1025 && reportedPort <= 65535 ? reportedPort : port;

        setPortInput(String(resolvedPort));
        setActivePort(resolvedPort);
        setServerRunning(true);
        setActivity(createUploadActivity('idle', `Server ready on port ${resolvedPort}.`));
        await refreshNetwork();
      } catch (error) {
        setActivePort(null);
        setServerRunning(false);
        setActivity(createUploadActivity('error', error instanceof Error ? error.message : 'Unable to start the server.'));
      }
    },
    [refreshLibrary, refreshNetwork],
  );

  const stopServer = useCallback(async () => {
    await localUploadServer.stop();
    setActivePort(null);
    setServerRunning(false);
  }, []);

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
    if (selectionMode && selectedCount === 0) {
      setSelectionMode(false);
    }
  }, [selectedCount, selectionMode]);

  useEffect(() => {
    void ScreenOrientation.lockAsync(
      isAndroidTablet ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
  }, [isAndroidTablet]);

  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      try {
        const loadedSettings = await getSettings();
        maxParallelUploadsRef.current = loadedSettings.maxParallelUploads;
        localUploadServer.setMaxParallelUploads(loadedSettings.maxParallelUploads);

        if (isMounted) {
          setSettings(loadedSettings);
        }

        await ensureAppDirectories();
        await refreshLibrary();
        void refreshNetwork();

        if (!isMounted) {
          return;
        }

        setLoading(false);

        await startServer(DEFAULT_SERVER_PORT, loadedSettings.maxParallelUploads);
      } catch (error) {
        if (isMounted) {
          setActivity(createUploadActivity('error', error instanceof Error ? error.message : 'App startup failed.'));
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

  // Deletes all artifacts (playback progress, cached thumbnail, in-memory
  // thumbnail entry, session probe record) for a set of videos. Used when the
  // videos themselves are being deleted.
  const forgetVideoArtifacts = useCallback(async (cleanupVideos: VideoItem[]) => {
    if (cleanupVideos.length === 0) {
      return;
    }

    const uris = cleanupVideos.map((video) => video.uri);
    await clearPlaybackProgressForUris(uris);
    await Promise.all(cleanupVideos.map((video) => deleteThumbnailForVideo(video).catch(() => undefined)));
    forgetProbedUris(uris);
    setThumbnailUriByVideo((current) => {
      const next = { ...current };

      for (const uri of uris) {
        delete next[uri];
      }

      return next;
    });
  }, []);

  // Re-keys artifacts (playback progress, thumbnails, session probe records, and
  // the in-memory thumbnail map) from old URIs to new ones after a rename/move,
  // so a half-watched video keeps its position and thumbnail.
  const relinkArtifacts = useCallback(async (oldVideos: VideoItem[], oldRootUri: string, newRootUri: string) => {
    const moves = await relinkVideoArtifacts(oldVideos, oldRootUri, newRootUri);

    if (moves.length === 0) {
      return;
    }

    forgetProbedUris(moves.map((move) => move.oldUri));
    setThumbnailUriByVideo((current) => {
      const next = { ...current };

      for (const { oldUri, newUri } of moves) {
        if (oldUri in next) {
          next[newUri] = next[oldUri];
          delete next[oldUri];
        }
      }

      return next;
    });
  }, []);

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
                  new Map((await collectVideos(video)).map((item) => [item.uri, item])).values(),
                );

                await forgetVideoArtifacts(cleanupVideos);
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
    [forgetVideoArtifacts, refreshLibrary],
  );

  const handlePlayVideo = useCallback(
    (uri: string) => {
      setSelectedVideoUri(uri);

      if (navigationRef.isReady()) {
        navigationRef.navigate('Player');
      }
    },
    [navigationRef],
  );

  const handleSelectVideoIndex = useCallback(
    (index: number) => {
      setSelectedVideoUri(videoItems[index]?.uri ?? null);
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
                  new Map((await Promise.all(targets.map((video) => collectVideos(video)))).flat().map((video) => [video.uri, video])).values(),
                );

                await forgetVideoArtifacts(cleanupVideos);

                await Promise.all(
                  targets.map(async (video) => {
                    await deleteLibraryItem(video.uri);
                  }),
                );

              handleCancelSelection();
              await refreshLibrary();
            } catch (error) {
              Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete the selected files.');
            }
            })();
          },
        },
      ]);
  }, [forgetVideoArtifacts, handleCancelSelection, refreshLibrary, selectedCount, selectedVideoUris, videos]);

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
                  new Map((await Promise.all(targets.map((video) => collectVideos(video)))).flat().map((video) => [video.uri, video])).values(),
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
  }, [handleCancelSelection, refreshLibrary, selectedCount, selectedVideoUris, videos]);

  const handleCreateFolder = useCallback(
    (name: string) => {
      setNewFolderVisible(false);

      void (async () => {
        try {
          await createLibraryFolder(currentFolderPathRef.current, name);
          await refreshLibrary();
        } catch (error) {
          Alert.alert('New folder failed', error instanceof Error ? error.message : 'Could not create the folder.');
        }
      })();
    },
    [refreshLibrary],
  );

  const handleRenameItem = useCallback(
    (name: string) => {
      const target = renameTarget;
      setRenameTarget(null);

      if (!target) {
        return;
      }

      void (async () => {
        try {
          const entryType = target.kind === 'folder' ? 'folder' : 'file';
          const cleanupVideos = Array.from(
            new Map((await collectVideos(target)).map((item) => [item.uri, item])).values(),
          );

          const renamed = await renameLibraryItem(target.relativePath, entryType, name);

          if (renamed.uri !== target.uri) {
            await relinkArtifacts(cleanupVideos, target.uri, renamed.uri);
          }

          await refreshLibrary();
        } catch (error) {
          Alert.alert('Rename failed', error instanceof Error ? error.message : 'Could not rename the item.');
        }
      })();
    },
    [refreshLibrary, relinkArtifacts, renameTarget],
  );

  const handleMoveSelected = useCallback(
    (destinationPath: string | null) => {
      setMoveVisible(false);
      const targets = selectedItems;

      if (targets.length === 0) {
        return;
      }

      void (async () => {
        const failures: string[] = [];

        // Diverges from the server's move (which stops on first failure): move
        // what we can and report the rest, so one collision doesn't abandon a batch.
        for (const target of targets) {
          try {
            const entryType = target.kind === 'folder' ? 'folder' : 'file';
            const cleanupVideos = Array.from(
              new Map((await collectVideos(target)).map((item) => [item.uri, item])).values(),
            );

            const moved = await moveLibraryItem(target.relativePath, entryType, destinationPath);

            if (moved.uri !== target.uri) {
              await relinkArtifacts(cleanupVideos, target.uri, moved.uri);
            }
          } catch (error) {
            failures.push(`${target.name}: ${error instanceof Error ? error.message : 'move failed'}`);
          }
        }

        handleCancelSelection();
        await refreshLibrary();

        if (failures.length > 0) {
          Alert.alert('Some items could not be moved', failures.join('\n'));
        }
      })();
    },
    [handleCancelSelection, refreshLibrary, relinkArtifacts, selectedItems],
  );

  const handleToggleSelectAll = useCallback(() => {
    if (allSelected) {
      handleCancelSelection();
      return;
    }

    setSelectedVideoUris(new Set(videos.map((video) => video.uri)));
  }, [allSelected, handleCancelSelection, videos]);

  const updateSetting = useCallback(
    async (key: SettingKey, value: number): Promise<boolean> => {
      const nextValue = clampSetting(key, value);

      if (nextValue === settings[key]) {
        return true;
      }

      try {
        const saved = await updateSettings({ [key]: nextValue });
        setSettings(saved);
        return true;
      } catch (error) {
        Alert.alert('Save failed', error instanceof Error ? error.message : 'Could not save settings.');
        return false;
      }
    },
    [settings],
  );

  // Effect A: probe the videos in the current folder as the user navigates.
  useEffect(() => {
    if (loading) {
      return;
    }

    return hydrateCurrentFolder(videoItems);
  }, [hydrateCurrentFolder, loading, videoItems]);

  // Effect B: at startup and whenever the server reports a library change, walk
  // the whole library once — probing anything not yet seen this session — then
  // prune thumbnails for videos that no longer exist.
  useEffect(() => {
    if (loading) {
      return;
    }

    let cancelled = false;
    let cancelHydration: (() => void) | null = null;

    async function hydrateLibraryInBackground() {
      const allVideos = await listAllVideoItems();

      if (cancelled) {
        return;
      }

      const handle = hydrateVideos(allVideos, { concurrency: THUMBNAIL_HYDRATION_CONCURRENCY }, {
        onResult: (video, result) => {
          if (result.thumbnailUri) {
            setThumbnailUriByVideo((current) => ({ ...current, [video.uri]: result.thumbnailUri as string }));
          }
        },
      });
      cancelHydration = handle.cancel;
      await handle.promise;

      if (!cancelled) {
        await pruneThumbnailCache(allVideos);
      }
    }

    void hydrateLibraryInBackground();

    return () => {
      cancelled = true;
      cancelHydration?.();
    };
  }, [loading, serverLibraryRevision]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        return;
      }

      void refreshLibrary();
      void refreshNetwork();
    });

    return () => {
      subscription.remove();
    };
  }, [refreshLibrary, refreshNetwork]);

  useEffect(() => {
    if (selectedVideoUri === null || selectedVideo || !navigationRef.isReady()) {
      return;
    }

    if (navigationRef.canGoBack()) {
      navigationRef.goBack();
    }
  }, [navigationRef, selectedVideo, selectedVideoUri]);

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

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        {shouldKeepAwakeForUpload ? <UploadWakeLock /> : null}
        <StatusBar style="dark" />
        <NavigationContainer ref={navigationRef} theme={navigationTheme}>
          <RootStack.Navigator screenOptions={{ headerShown: false }}>
            <RootStack.Screen name="MainTabs">
              {() => (
                <MainTab.Navigator
                  screenOptions={{
                    headerShown: false,
                    sceneStyle: styles.tabScene,
                    tabBarActiveTintColor: '#1f6f68',
                    tabBarInactiveTintColor: '#4f463f',
                    tabBarHideOnKeyboard: true,
                    tabBarStyle: styles.tabBar,
                    tabBarLabelStyle: styles.tabBarLabel,
                  }}
                >
                  <MainTab.Screen
                    name="Library"
                    listeners={{
                      focus: () => {
                        if (!loading) {
                          void refreshLibrary();
                        }
                      },
                    }}
                  >
                    {() => (
                      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
                        <View style={styles.screen}>
                          <View style={styles.libraryContentArea}>
                            {loading ? (
                              <View style={[styles.loadingCard, styles.libraryLoadingCard]}>
                                <ActivityIndicator size="large" color="#1f6f68" />
                                <Text style={styles.loadingText}>Preparing storage, network, and local upload server...</Text>
                              </View>
                            ) : (
                              <LibraryView
                                allSelected={allSelected}
                                currentFolderPath={currentFolderPath}
                                onNewFolder={() => setNewFolderVisible(true)}
                                onRenameVideo={(video) => setRenameTarget(video)}
                                onMoveSelected={() => setMoveVisible(true)}
                                onToggleSelectAll={handleToggleSelectAll}
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
                                thumbnailUriByVideo={thumbnailUriByVideo}
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
                            )}
                          </View>
                        </View>
                      </SafeAreaView>
                    )}
                  </MainTab.Screen>
                  <MainTab.Screen
                    name="Upload"
                    listeners={{
                      focus: () => {
                        handleCancelSelection();
                        void refreshNetwork();
                      },
                    }}
                  >
                    {() => (
                      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
                        <View style={styles.screen}>
                          <View style={styles.contentArea}>
                            {loading ? (
                              <View style={styles.loadingCard}>
                                <ActivityIndicator size="large" color="#1f6f68" />
                                <Text style={styles.loadingText}>Preparing storage, network, and local upload server...</Text>
                              </View>
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
                        </View>
                      </SafeAreaView>
                    )}
                  </MainTab.Screen>
                  <MainTab.Screen
                    name="Settings"
                    listeners={{
                      focus: () => {
                        handleCancelSelection();
                      },
                    }}
                  >
                    {() => (
                      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
                        <View style={styles.screen}>
                          <View style={styles.contentArea}>
                            {loading ? (
                              <View style={styles.loadingCard}>
                                <ActivityIndicator size="large" color="#1f6f68" />
                                <Text style={styles.loadingText}>Preparing storage, network, and local upload server...</Text>
                              </View>
                            ) : (
                              <SettingsView
                                longPressSpeedTenths={longPressSpeedTenths}
                                maxParallelUploads={maxParallelUploads}
                                onOpenLongPressSpeedSettings={() => navigationRef.navigate('LongPressSpeedSettings')}
                                onOpenSubtitleSizeSettings={() => navigationRef.navigate('SubtitleSizeSettings')}
                                onOpenUploadConcurrencySettings={() => navigationRef.navigate('UploadConcurrencySettings')}
                                subtitleFontSize={subtitleFontSize}
                              />
                            )}
                          </View>
                        </View>
                      </SafeAreaView>
                    )}
                  </MainTab.Screen>
                </MainTab.Navigator>
              )}
            </RootStack.Screen>
            <RootStack.Screen
              name="UploadConcurrencySettings"
              options={{
                headerShown: true,
                title: 'Concurrent Uploads',
                headerBackTitle: 'Settings',
                headerShadowVisible: false,
              }}
            >
              {({ navigation }) => (
                <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
                  <View style={styles.screen}>
                    <View style={styles.contentArea}>
                      <OptionPickerView
                        options={SETTING_LIMITS.maxParallelUploads.options}
                        selectedValue={maxParallelUploads}
                        subtitle="Choose how many files the browser uploader can send in parallel."
                        title="Concurrent uploads"
                        onSelect={async (value) => {
                          const didSave = await updateSetting('maxParallelUploads', value);

                          if (didSave) {
                            navigation.goBack();
                          }
                        }}
                      />
                    </View>
                  </View>
                </SafeAreaView>
              )}
            </RootStack.Screen>
            <RootStack.Screen
              name="SubtitleSizeSettings"
              options={{
                headerShown: true,
                title: 'Subtitle Size',
                headerBackTitle: 'Settings',
                headerShadowVisible: false,
              }}
            >
              {({ navigation }) => (
                <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
                  <View style={styles.screen}>
                    <View style={styles.contentArea}>
                      <OptionPickerView
                        options={SETTING_LIMITS.subtitleFontSize.options}
                        selectedValue={subtitleFontSize}
                        subtitle="Choose how large subtitles appear during playback."
                        title="Subtitle size"
                        onSelect={async (value) => {
                          const didSave = await updateSetting('subtitleFontSize', value);

                          if (didSave) {
                            navigation.goBack();
                          }
                        }}
                      />
                    </View>
                  </View>
                </SafeAreaView>
              )}
            </RootStack.Screen>
            <RootStack.Screen
              name="LongPressSpeedSettings"
              options={{
                headerShown: true,
                title: 'Hold-to-Speed-Up',
                headerBackTitle: 'Settings',
                headerShadowVisible: false,
              }}
            >
              {({ navigation }) => (
                <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
                  <View style={styles.screen}>
                    <View style={styles.contentArea}>
                      <OptionPickerView
                        formatLabel={(value) => `${(value / 10).toFixed(1)}\u00d7`}
                        options={SETTING_LIMITS.longPressSpeedTenths.options}
                        selectedValue={longPressSpeedTenths}
                        subtitle="Press and hold the video to temporarily play at this speed."
                        title="Hold-to-speed-up rate"
                        onSelect={async (value) => {
                          const didSave = await updateSetting('longPressSpeedTenths', value);

                          if (didSave) {
                            navigation.goBack();
                          }
                        }}
                      />
                    </View>
                  </View>
                </SafeAreaView>
              )}
            </RootStack.Screen>
            <RootStack.Screen
              name="Player"
              listeners={{
                beforeRemove: () => {
                  setSelectedVideoUri(null);
                  void refreshLibrary();
                },
              }}
            >
              {({ navigation }) =>
                selectedVideo && selectedIndex !== null ? (
                  <PlayerScreen
                    currentIndex={selectedIndex}
                    exitOrientationLock={
                      isAndroidTablet ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP
                    }
                    longPressSpeedTenths={longPressSpeedTenths}
                    subtitleFontSize={subtitleFontSize}
                    videos={videoItems}
                    onClose={() => {
                      navigation.goBack();
                    }}
                    onSelectIndex={handleSelectVideoIndex}
                  />
                ) : null
              }
            </RootStack.Screen>
          </RootStack.Navigator>
        </NavigationContainer>
        <PromptModal
          confirmLabel="Create"
          onCancel={() => setNewFolderVisible(false)}
          onSubmit={handleCreateFolder}
          placeholder="Folder name"
          title="New folder"
          visible={newFolderVisible}
        />
        <PromptModal
          confirmLabel="Rename"
          initialValue={renameTarget?.name ?? ''}
          onCancel={() => setRenameTarget(null)}
          onSubmit={handleRenameItem}
          selection={renameTarget ? getRenameSelection(renameTarget.name) : undefined}
          title="Rename"
          visible={renameTarget !== null}
        />
        <FolderPickerModal
          movingItems={selectedItems}
          onCancel={() => setMoveVisible(false)}
          onPick={handleMoveSelected}
          visible={moveVisible}
        />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

function UploadWakeLock() {
  useKeepAwake();

  return null;
}

type LibraryViewProps = {
  allSelected: boolean;
  currentFolderPath: string | null;
  onCancelSelection: () => void;
  onClearPlayback: () => void;
  onClearSelectedPlayback: () => void;
  onDeleteSelected: () => void;
  onMoveSelected: () => void;
  onNavigateUp: () => void;
  onNewFolder: () => void;
  onOpenFolder: (path: string) => void;
  onRenameVideo: (video: LibraryItem) => void;
  onToggleSelectAll: () => void;
  playbackStateByUri: PlaybackStateMap;
  selectedCount: number;
  selectedVideoUris: Set<string>;
  selectionMode: boolean;
  thumbnailUriByVideo: Record<string, string>;
  videos: LibraryItem[];
  onDeleteVideo: (video: LibraryItem) => void;
  onLongPressVideo: (video: LibraryItem) => void;
  onPlayVideo: (uri: string) => void;
  onToggleVideoSelection: (video: LibraryItem) => void;
};

function LibraryView({
  allSelected,
  currentFolderPath,
  onCancelSelection,
  onClearPlayback,
  onClearSelectedPlayback,
  onDeleteSelected,
  onMoveSelected,
  onNavigateUp,
  onNewFolder,
  onOpenFolder,
  onRenameVideo,
  onToggleSelectAll,
  playbackStateByUri,
  selectedCount,
  selectedVideoUris,
  selectionMode,
  thumbnailUriByVideo,
  videos,
  onDeleteVideo,
  onLongPressVideo,
  onPlayVideo,
  onToggleVideoSelection,
}: LibraryViewProps) {
  const openSwipeRowRef = useRef<{ close: () => void; uri: string } | null>(null);

  const closeOpenSwipeRow = useCallback(() => {
    openSwipeRowRef.current?.close();
    openSwipeRowRef.current = null;
  }, []);

  const handleSwipeableOpen = useCallback((uri: string, close: () => void) => {
    if (openSwipeRowRef.current?.uri && openSwipeRowRef.current.uri !== uri) {
      openSwipeRowRef.current.close();
    }

    openSwipeRowRef.current = { close, uri };
  }, []);

  const handleSwipeableClose = useCallback((uri: string) => {
    if (openSwipeRowRef.current?.uri === uri) {
      openSwipeRowRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (selectionMode) {
      closeOpenSwipeRow();
    }
  }, [closeOpenSwipeRow, selectionMode]);

  const renderItem = useCallback(
    ({ item: video }: { item: LibraryItem }) => (
      <VideoCard
        durationSeconds={video.kind === 'video' ? playbackStateByUri[video.uri]?.durationSeconds : undefined}
        isNew={video.kind === 'video' ? playbackStateByUri[video.uri]?.hasStartedPlayback !== true : false}
        selected={selectedVideoUris.has(video.uri)}
        selectionMode={selectionMode}
        savedPositionSeconds={video.kind === 'video' ? playbackStateByUri[video.uri]?.positionSeconds ?? 0 : undefined}
        thumbnailUri={video.kind === 'video' ? thumbnailUriByVideo[video.uri] : undefined}
        video={video}
        onLongPress={() => {
          if (selectionMode) {
            onToggleVideoSelection(video);
            return;
          }

          onLongPressVideo(video);
        }}
        onDelete={() => onDeleteVideo(video)}
        onRename={() => onRenameVideo(video)}
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
        onSwipeableClose={() => handleSwipeableClose(video.uri)}
        onSwipeableOpen={(close) => handleSwipeableOpen(video.uri, close)}
      />
    ),
    [
      handleSwipeableClose,
      handleSwipeableOpen,
      onDeleteVideo,
      onLongPressVideo,
      onOpenFolder,
      onPlayVideo,
      onRenameVideo,
      onToggleVideoSelection,
      playbackStateByUri,
      selectedVideoUris,
      selectionMode,
      thumbnailUriByVideo,
    ],
  );

  return (
    <View style={styles.libraryWrap}>
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
            <Pressable onPress={onToggleSelectAll} style={({ pressed }) => [styles.selectionButton, styles.selectionButtonSecondary, pressed && styles.selectionButtonPressed]}>
              <Text style={styles.selectionButtonSecondaryText}>{allSelected ? 'Deselect All' : 'Select All'}</Text>
            </Pressable>
            <Pressable onPress={onMoveSelected} style={({ pressed }) => [styles.selectionButton, styles.selectionButtonSecondary, pressed && styles.selectionButtonPressed]}>
              <Text style={styles.selectionButtonSecondaryText}>Move</Text>
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
            <Pressable onPress={onNewFolder} style={({ pressed }) => [styles.clearPlaybackButton, pressed && styles.clearPlaybackButtonPressed]}>
              <Text style={styles.clearPlaybackButtonText}>New Folder</Text>
            </Pressable>
            <Pressable onPress={onClearPlayback} style={({ pressed }) => [styles.clearPlaybackButton, pressed && styles.clearPlaybackButtonPressed]}>
              <Text style={styles.clearPlaybackButtonText}>Clear All History</Text>
            </Pressable>
          </View>
        )}
      </View>

      <FlatList
        onScrollBeginDrag={closeOpenSwipeRow}
        contentContainerStyle={[styles.libraryList, videos.length === 0 && styles.libraryListEmpty]}
        data={videos}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateTitle}>{currentFolderPath ? 'This folder is empty' : 'No media yet'}</Text>
            <Text style={styles.emptyStateText}>
              {currentFolderPath
                ? 'Use the Upload tab to add files here, or go up to another folder.'
                : 'Use the Upload tab at the bottom, open the device URL on your computer, and send a file here.'}
            </Text>
          </View>
        }
      />
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
  const activeUploadCount = activity.activeUploads.length;

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
              placeholder="8081"
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
          <Text style={styles.supportText}>
            {activeUploadCount > 0 ? `${activeUploadCount} active upload${activeUploadCount === 1 ? '' : 's'}` : 'No active uploads'}
          </Text>
          <Text style={styles.supportText}>
            {activity.totalBytes
              ? `${formatBytes(activity.receivedBytes ?? 0)} / ${formatBytes(activity.totalBytes)}`
              : activity.status === 'complete'
                ? 'Upload finished'
                : 'Waiting for browser upload'}
          </Text>
        </View>

        {activeUploadCount > 0 ? (
          <View style={styles.activityList}>
            {activity.activeUploads.map((upload) => {
              const uploadProgress = getUploadProgress(upload);

              return (
                <View key={upload.uploadId} style={styles.activityItem}>
                  <View style={styles.activityItemHeader}>
                    <Text numberOfLines={1} style={styles.activityItemTitle}>
                      {upload.fileName}
                    </Text>
                    <Text style={styles.activityItemTime}>{formatDate(upload.updatedAt)}</Text>
                  </View>
                  <Text style={styles.supportText}>{upload.message}</Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${uploadProgress * 100}%` }]} />
                  </View>
                  <View style={styles.activityMetaRow}>
                    <Text style={styles.supportText}>
                      {formatBytes(upload.receivedBytes)} / {formatBytes(upload.totalBytes)}
                    </Text>
                    <Text style={styles.supportText}>{`${Math.round(uploadProgress * 100)}%`}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.activityEmptyState}>
            <Text style={styles.supportText}>No active uploads</Text>
          </View>
        )}
      </Panel>
    </ScrollView>
  );
}

type SettingsViewProps = {
  longPressSpeedTenths: number;
  maxParallelUploads: number;
  onOpenLongPressSpeedSettings: () => void;
  onOpenSubtitleSizeSettings: () => void;
  onOpenUploadConcurrencySettings: () => void;
  subtitleFontSize: number;
};

function SettingsView({
  longPressSpeedTenths,
  maxParallelUploads,
  onOpenLongPressSpeedSettings,
  onOpenSubtitleSizeSettings,
  onOpenUploadConcurrencySettings,
  subtitleFontSize,
}: SettingsViewProps) {
  return (
    <ScrollView contentContainerStyle={styles.uploadContent} showsVerticalScrollIndicator={false}>
      <Panel title="Upload settings" subtitle="Control how many files the browser uploader sends at once.">
        <View style={styles.settingSection}>
          <Text style={styles.settingTitle}>Concurrent uploads</Text>
          <Text style={styles.supportText}>Choose how many files the browser uploader can send in parallel.</Text>
          <Pressable
            onPress={onOpenUploadConcurrencySettings}
            style={({ pressed }) => [styles.settingNavigationRow, pressed && styles.settingNavigationRowPressed]}
          >
            <Text style={styles.settingNavigationLabel}>Select upload count</Text>
            <View style={styles.settingNavigationAccessory}>
              <Text style={styles.settingNavigationValue}>{maxParallelUploads}</Text>
              <Text style={styles.settingNavigationChevron}>{'\u203A'}</Text>
            </View>
          </Pressable>
          <Text style={styles.supportText}>Refresh the browser upload page to apply changes.</Text>
        </View>
      </Panel>

      <Panel title="Player settings" subtitle="Tune subtitles and the hold-to-speed-up gesture.">
        <View style={styles.settingSection}>
          <Text style={styles.settingTitle}>Subtitle size</Text>
          <Text style={styles.supportText}>Choose how large subtitles appear during playback.</Text>
          <Pressable
            onPress={onOpenSubtitleSizeSettings}
            style={({ pressed }) => [styles.settingNavigationRow, pressed && styles.settingNavigationRowPressed]}
          >
            <Text style={styles.settingNavigationLabel}>Select subtitle size</Text>
            <View style={styles.settingNavigationAccessory}>
              <Text style={styles.settingNavigationValue}>{subtitleFontSize}</Text>
              <Text style={styles.settingNavigationChevron}>{'\u203A'}</Text>
            </View>
          </Pressable>
        </View>

        <View style={styles.settingSection}>
          <Text style={styles.settingTitle}>Hold-to-speed-up rate</Text>
          <Text style={styles.supportText}>Press and hold the video to temporarily play at this speed.</Text>
          <Pressable
            onPress={onOpenLongPressSpeedSettings}
            style={({ pressed }) => [styles.settingNavigationRow, pressed && styles.settingNavigationRowPressed]}
          >
            <Text style={styles.settingNavigationLabel}>Select speed</Text>
            <View style={styles.settingNavigationAccessory}>
              <Text style={styles.settingNavigationValue}>{(longPressSpeedTenths / 10).toFixed(1)}{'\u00d7'}</Text>
              <Text style={styles.settingNavigationChevron}>{'\u203A'}</Text>
            </View>
          </Pressable>
        </View>
      </Panel>
    </ScrollView>
  );
}

type OptionPickerViewProps = {
  formatLabel?: (value: number) => string;
  options: readonly number[];
  selectedValue: number;
  subtitle: string;
  title: string;
  onSelect: (value: number) => Promise<void> | void;
};

function OptionPickerView({ formatLabel, options, selectedValue, subtitle, title, onSelect }: OptionPickerViewProps) {
  return (
    <ScrollView contentContainerStyle={styles.uploadContent} showsVerticalScrollIndicator={false}>
      <Panel title={title} subtitle={subtitle}>
        <View style={styles.settingSection}>
          <View style={styles.settingOptionGrid}>
            {options.map((value) => {
              const selected = value === selectedValue;

              return (
                <Pressable
                  key={value}
                  onPress={() => onSelect(value)}
                  style={({ pressed }) => [
                    styles.settingOptionButton,
                    selected && styles.settingOptionButtonSelected,
                    pressed && styles.settingOptionButtonPressed,
                  ]}
                >
                  <Text style={[styles.settingOptionText, selected && styles.settingOptionTextSelected]}>
                    {formatLabel ? formatLabel(value) : value}
                  </Text>
                </Pressable>
              );
            })}
          </View>
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
  root: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: '#efe7db',
  },
  tabScene: {
    backgroundColor: '#efe7db',
  },
  tabBar: {
    backgroundColor: '#efe7db',
    borderTopColor: '#ded1c2',
  },
  tabBarLabel: {
    fontSize: 12,
    fontWeight: '700',
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
  libraryContentArea: {
    flex: 1,
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
  libraryLoadingCard: {
    marginHorizontal: 16,
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
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
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
  libraryListEmpty: {
    flexGrow: 1,
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
  settingSection: {
    gap: 14,
  },
  settingTitle: {
    color: '#1d1917',
    fontSize: 16,
    fontWeight: '700',
  },
  settingNavigationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ead8c4',
    backgroundColor: '#fffdf9',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  settingNavigationRowPressed: {
    opacity: 0.8,
  },
  settingNavigationAccessory: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  settingNavigationLabel: {
    color: '#4f463f',
    fontSize: 16,
    fontWeight: '700',
  },
  settingNavigationValue: {
    color: '#1f6f68',
    fontSize: 16,
    fontWeight: '700',
  },
  settingNavigationChevron: {
    color: '#8f857b',
    fontSize: 20,
    lineHeight: 20,
  },
  settingOptionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  settingOptionButton: {
    minWidth: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#dfcfbd',
    backgroundColor: '#fffdf9',
    paddingHorizontal: 18,
    paddingVertical: 14,
    alignItems: 'center',
  },
  settingOptionButtonSelected: {
    borderColor: '#1f6f68',
    backgroundColor: '#dceeea',
  },
  settingOptionButtonPressed: {
    opacity: 0.8,
  },
  settingOptionText: {
    color: '#4f463f',
    fontSize: 16,
    fontWeight: '700',
  },
  settingOptionTextSelected: {
    color: '#1f6f68',
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
  activityList: {
    gap: 12,
  },
  activityItem: {
    gap: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ead8c4',
    backgroundColor: '#fffdf9',
    padding: 14,
  },
  activityItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  activityItemTitle: {
    flex: 1,
    color: '#1d1917',
    fontSize: 15,
    fontWeight: '700',
  },
  activityItemTime: {
    color: '#756a61',
    fontSize: 12,
  },
  activityEmptyState: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ead8c4',
    backgroundColor: '#fffdf9',
    padding: 14,
  },
});
