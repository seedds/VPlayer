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
  type StyleProp,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { Platform } from 'react-native';

import { FolderPickerModal } from './src/components/FolderPickerModal';
import { PlayerScreen } from './src/components/PlayerScreen';
import { PromptModal } from './src/components/PromptModal';
import { VideoCard } from './src/components/VideoCard';
import { formatBytes, formatDate, getUploadProgress, normalizePort } from './src/lib/format';
import {
  clampSetting,
  DEFAULT_SETTINGS,
  getSettings,
  SETTING_META,
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
import { hydrateVideos } from './src/lib/mediaHydration';
import { forgetVideoArtifacts, relinkVideoArtifacts } from './src/lib/videoArtifacts';
import { pruneThumbnailCache } from './src/lib/videoThumbnails';
import type { LibraryItem, UploadActivity, VideoItem } from './src/lib/types';
import {
  collectVideos,
  createLibraryFolder,
  deleteLibraryItem,
  ensureAppDirectories,
  getFileExtension,
  getLibraryItem,
  getParentPath,
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
  SettingPicker: { key: SettingKey };
};

function isAndroidTabletLayout(width: number, height: number): boolean {
  return Platform.OS === 'android' && Math.min(width, height) >= 600;
}

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

type ConfirmDestructiveOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  failureTitle: string;
  failureMessage: string;
  action: () => Promise<void>;
};

// One confirm-then-run-with-failure-alert flow for the destructive library
// actions (delete video, delete/clear selection, clear all history), which were
// five near-identical Alert.alert blocks.
function confirmDestructive({ title, message, confirmLabel, failureTitle, failureMessage, action }: ConfirmDestructiveOptions) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: confirmLabel,
      style: 'destructive',
      onPress: () => {
        void (async () => {
          try {
            await action();
          } catch (error) {
            Alert.alert(failureTitle, error instanceof Error ? error.message : failureMessage);
          }
        })();
      },
    },
  ]);
}

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
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const { maxParallelUploads, subtitleFontSize, longPressSpeedTenths } = settings;
  // In-app library-management dialogs (Android has no Alert.prompt).
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<LibraryItem | null>(null);
  const [moveVisible, setMoveVisible] = useState(false);
  const currentFolderPathRef = useRef<string | null>(null);
  const navigationRef = useNavigationContainerRef<RootStackParamList>();

  const isAndroidTablet = useMemo(() => isAndroidTabletLayout(width, height), [height, width]);
  const progress = getUploadProgress(activity);
  const serverUrl = serverRunning && ipAddress && activePort ? `http://${ipAddress}:${activePort}` : null;
  const videoItems = useMemo(
    () => videos.filter((item): item is VideoItem => item.kind === 'video'),
    [videos],
  );
  const selectedIndex = useMemo(() => {
    if (!selectedVideoUri) {
      return null;
    }

    const index = videoItems.findIndex((video) => video.uri === selectedVideoUri);
    return index >= 0 ? index : null;
  }, [selectedVideoUri, videoItems]);
  const selectedVideo = selectedIndex !== null ? videoItems[selectedIndex] ?? null : null;
  const selectedCount = selectedVideoUris.size;
  const selectionMode = selectedCount > 0;
  const selectedItems = useMemo(() => videos.filter((video) => selectedVideoUris.has(video.uri)), [selectedVideoUris, videos]);
  const allSelected = videos.length > 0 && selectedCount === videos.length;
  const shouldKeepAwakeForUpload = activity.activeUploads.length > 0;

  // The server reads this only when rendering the upload page, so keeping it in
  // sync via this one effect is sufficient — no ref or start() parameter needed.
  useEffect(() => {
    localUploadServer.setMaxParallelUploads(maxParallelUploads);
  }, [maxParallelUploads]);

  const refreshLibraryRequestIdRef = useRef(0);

  const refreshLibrary = useCallback(async (path: string | null = currentFolderPathRef.current) => {
    // Ignore a slow load whose folder the user has since navigated away from:
    // focus/AppState/onLibraryChanged/beforeRemove can all overlap, and a stale
    // result landing last would otherwise revert the visible folder.
    const requestId = refreshLibraryRequestIdRef.current + 1;
    refreshLibraryRequestIdRef.current = requestId;

    async function loadPath(targetPath: string | null): Promise<void> {
      if (targetPath) {
        const folder = await getLibraryItem(targetPath);

        if (!folder || folder.kind !== 'folder') {
          await loadPath(getParentPath(targetPath));
          return;
        }
      }

      const [items, playbackState] = await Promise.all([listLibraryItems(targetPath), getAllPlaybackState()]);

      if (refreshLibraryRequestIdRef.current !== requestId) {
        return;
      }

      currentFolderPathRef.current = targetPath;
      setCurrentFolderPath(targetPath);
      setVideos(items);
      setPlaybackStateByUri(playbackState);
    }

    await loadPath(path || null);
  }, []);

  // Applies one probe result to in-memory state: caches the thumbnail and, if the
  // probe found a duration, records it. Shared by both hydration passes.
  const applyProbeResult = useCallback(
    (video: VideoItem, result: { thumbnailUri: string | null; durationSeconds: number | null }) => {
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
    [],
  );

  // Probes the current folder's videos (thumbnail + duration) as the user
  // navigates. Cheap: mediaHydration skips files already probed this session, so
  // re-entering a folder does no work.
  const hydrateCurrentFolder = useCallback(
    (items: VideoItem[]): (() => void) => hydrateVideos(items, applyProbeResult).cancel,
    [applyProbeResult],
  );

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
    async (port: number) => {
      try {
        setActivity(createUploadActivity('idle', `Starting server on port ${port}...`));

        await localUploadServer.start({
          port,
          onActivity: setActivity,
          onLibraryChanged: async () => {
            await refreshLibrary();
            // Only a server-driven change (upload, browser delete/rename/move)
            // triggers the full-library thumbnail pass.
            setServerLibraryRevision((current) => current + 1);
          },
        });

        // The server already validated the port and emitted "Server ready"; trust
        // its reported port rather than re-checking and re-announcing here.
        const resolvedPort = localUploadServer.getPort() ?? port;

        setPortInput(String(resolvedPort));
        setActivePort(resolvedPort);
        setServerRunning(true);
        await refreshNetwork();
      } catch (error) {
        setActivePort(null);
        setServerRunning(false);
        setActivity(createUploadActivity('error', error instanceof Error ? error.message : 'Unable to start the server.'));
      }
    },
    [refreshLibrary, refreshNetwork],
  );

  const stopServer = async () => {
    await localUploadServer.stop();
    setActivePort(null);
    setServerRunning(false);
  };

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
    void ScreenOrientation.lockAsync(
      isAndroidTablet ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
  }, [isAndroidTablet]);

  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      try {
        const loadedSettings = await getSettings();
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

        await startServer(DEFAULT_SERVER_PORT);
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

  // Deletes on-disk artifacts (playback progress, cached thumbnail) for a set of
  // videos being deleted, then drops their in-memory thumbnail entries. The probe
  // cache needs no eviction: it is keyed on file identity, so a re-uploaded file
  // (new size/mtime) re-probes on its own.
  const forgetArtifacts = async (cleanupVideos: VideoItem[]) => {
    if (cleanupVideos.length === 0) {
      return;
    }

    await forgetVideoArtifacts(cleanupVideos);
    setThumbnailUriByVideo((current) => {
      const next = { ...current };

      for (const video of cleanupVideos) {
        delete next[video.uri];
      }

      return next;
    });
  };

  // Re-keys artifacts (playback progress, thumbnails, and the in-memory thumbnail
  // map) from old URIs to new ones after a rename/move, so a half-watched video
  // keeps its position and thumbnail.
  const relinkArtifacts = async (oldVideos: VideoItem[], oldRootUri: string, newRootUri: string) => {
    const moves = await relinkVideoArtifacts(oldVideos, oldRootUri, newRootUri);

    if (moves.length === 0) {
      return;
    }

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
  };

  const handleDeleteVideo = (video: LibraryItem) => {
    confirmDestructive({
      title: video.kind === 'folder' ? 'Delete folder?' : 'Delete file?',
      message: video.name,
      confirmLabel: 'Delete',
      failureTitle: 'Delete failed',
      failureMessage: 'Could not delete the file.',
      action: async () => {
        const cleanupVideos = await collectVideos(video);
        await forgetArtifacts(cleanupVideos);
        await deleteLibraryItem(video.uri);
        await refreshLibrary();
      },
    });
  };

  const handlePlayVideo = (uri: string) => {
    setSelectedVideoUri(uri);

    if (navigationRef.isReady()) {
      navigationRef.navigate('Player');
    }
  };

  const handleSelectVideoIndex = (index: number) => {
    setSelectedVideoUri(videoItems[index]?.uri ?? null);
  };

  const handleCancelSelection = () => {
    setSelectedVideoUris(new Set());
  };

  const handleDeleteSelected = () => {
    if (selectedItems.length === 0) {
      return;
    }

    confirmDestructive({
      title: 'Delete selected items?',
      message: `${selectedItems.length} item${selectedItems.length === 1 ? '' : 's'} will be removed.`,
      confirmLabel: 'Delete',
      failureTitle: 'Delete failed',
      failureMessage: 'Could not delete the selected files.',
      action: async () => {
        const cleanupVideos = (await Promise.all(selectedItems.map((video) => collectVideos(video)))).flat();

        await forgetArtifacts(cleanupVideos);
        await Promise.all(selectedItems.map((video) => deleteLibraryItem(video.uri)));
        handleCancelSelection();
        await refreshLibrary();
      },
    });
  };

  const handleClearSelectedPlayback = () => {
    if (selectedItems.length === 0) {
      return;
    }

    confirmDestructive({
      title: 'Clear playback history?',
      message: 'Saved playback positions will be reset for videos inside the selected items.',
      confirmLabel: 'Clear',
      failureTitle: 'Clear failed',
      failureMessage: 'Could not clear playback history for the selected files.',
      action: async () => {
        const selectedVideos = (await Promise.all(selectedItems.map((video) => collectVideos(video)))).flat();

        await clearPlaybackProgressForUris(selectedVideos.map((video) => video.uri));
        handleCancelSelection();
        await refreshLibrary();
      },
    });
  };

  const handleCreateFolder = (name: string) => {
    setNewFolderVisible(false);

    void (async () => {
      try {
        await createLibraryFolder(currentFolderPathRef.current, name);
        await refreshLibrary();
      } catch (error) {
        Alert.alert('New folder failed', error instanceof Error ? error.message : 'Could not create the folder.');
      }
    })();
  };

  const handleRenameItem = (name: string) => {
    const target = renameTarget;
    setRenameTarget(null);

    if (!target) {
      return;
    }

    void (async () => {
      try {
        const cleanupVideos = await collectVideos(target);
        const renamed = await renameLibraryItem(target.relativePath, name);

        if (renamed.uri !== target.uri) {
          await relinkArtifacts(cleanupVideos, target.uri, renamed.uri);
        }

        await refreshLibrary();
      } catch (error) {
        Alert.alert('Rename failed', error instanceof Error ? error.message : 'Could not rename the item.');
      }
    })();
  };

  const handleMoveSelected = (destinationPath: string | null) => {
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
          const cleanupVideos = await collectVideos(target);
          const moved = await moveLibraryItem(target.relativePath, destinationPath);

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
  };

  const handleToggleSelectAll = () => {
    if (allSelected) {
      handleCancelSelection();
      return;
    }

    setSelectedVideoUris(new Set(videos.map((video) => video.uri)));
  };

  const updateSetting = async (key: SettingKey, value: number): Promise<boolean> => {
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
  };

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

      const handle = hydrateVideos(allVideos, applyProbeResult);
      cancelHydration = handle.cancel;
      await handle.done;

      if (!cancelled) {
        await pruneThumbnailCache(allVideos);
      }
    }

    void hydrateLibraryInBackground();

    return () => {
      cancelled = true;
      cancelHydration?.();
    };
  }, [applyProbeResult, loading, serverLibraryRevision]);

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
                              <LoadingCard style={styles.libraryLoadingCard} />
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
                              <LoadingCard />
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
                              <LoadingCard />
                            ) : (
                              <SettingsView
                                settings={settings}
                                onOpenSetting={(key) => navigationRef.navigate('SettingPicker', { key })}
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
              name="SettingPicker"
              options={({ route }) => ({
                headerShown: true,
                title: SETTING_META[route.params.key].navTitle,
                headerBackTitle: 'Settings',
                headerShadowVisible: false,
              })}
            >
              {({ navigation, route }) => {
                const key = route.params.key;
                const meta = SETTING_META[key];

                return (
                  <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
                    <View style={styles.screen}>
                      <View style={styles.contentArea}>
                        <OptionPickerView
                          formatLabel={meta.formatLabel}
                          options={meta.options}
                          selectedValue={settings[key]}
                          subtitle={meta.subtitle}
                          title={meta.title}
                          onSelect={async (value) => {
                            const didSave = await updateSetting(key, value);

                            if (didSave) {
                              navigation.goBack();
                            }
                          }}
                        />
                      </View>
                    </View>
                  </SafeAreaView>
                );
              }}
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

function LoadingCard({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.loadingCard, style]}>
      <ActivityIndicator size="large" color="#1f6f68" />
      <Text style={styles.loadingText}>Preparing storage, network, and local upload server...</Text>
    </View>
  );
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
        keyExtractor={(item) => item.uri}
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
  settings: Settings;
  onOpenSetting: (key: SettingKey) => void;
};

// Groups the setting rows into their two panels; each row's copy comes from
// SETTING_META, so adding a setting is a table edit rather than new JSX.
const SETTING_PANELS: ReadonlyArray<{ title: string; subtitle: string; keys: readonly SettingKey[] }> = [
  {
    title: 'Upload settings',
    subtitle: 'Control how many files the browser uploader sends at once.',
    keys: ['maxParallelUploads'],
  },
  {
    title: 'Player settings',
    subtitle: 'Tune subtitles and the hold-to-speed-up gesture.',
    keys: ['subtitleFontSize', 'longPressSpeedTenths'],
  },
];

function SettingsView({ settings, onOpenSetting }: SettingsViewProps) {
  return (
    <ScrollView contentContainerStyle={styles.uploadContent} showsVerticalScrollIndicator={false}>
      {SETTING_PANELS.map((panel) => (
        <Panel key={panel.title} title={panel.title} subtitle={panel.subtitle}>
          {panel.keys.map((key) => {
            const meta = SETTING_META[key];
            const value = settings[key];

            return (
              <View key={key} style={styles.settingSection}>
                <Text style={styles.settingTitle}>{meta.title}</Text>
                <Text style={styles.supportText}>{meta.subtitle}</Text>
                <Pressable
                  onPress={() => onOpenSetting(key)}
                  style={({ pressed }) => [styles.settingNavigationRow, pressed && styles.settingNavigationRowPressed]}
                >
                  <Text style={styles.settingNavigationLabel}>{meta.rowLabel}</Text>
                  <View style={styles.settingNavigationAccessory}>
                    <Text style={styles.settingNavigationValue}>
                      {meta.formatLabel ? meta.formatLabel(value) : value}
                    </Text>
                    <Text style={styles.settingNavigationChevron}>{'\u203A'}</Text>
                  </View>
                </Pressable>
                {meta.footnote ? <Text style={styles.supportText}>{meta.footnote}</Text> : null}
              </View>
            );
          })}
        </Panel>
      ))}
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
