import { useEffect, useRef, useState } from 'react';
import Slider from '@react-native-community/slider';
import { useEventListener } from 'expo';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { createVideoPlayer, VideoView } from 'expo-video';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';

import { formatDuration } from '../lib/format';
import { getSavedPlaybackPosition, savePlaybackDuration, savePlaybackPosition } from '../lib/playbackState';
import { getActiveSubtitleText, loadSrtFile, type SubtitleCue } from '../lib/subtitles';
import { findMatchingSubtitleUri } from '../lib/videoLibrary';
import type { VideoItem } from '../lib/types';

type PlayerScreenProps = {
  currentIndex: number;
  exitOrientationLock: ScreenOrientation.OrientationLock;
  onClose: () => void;
  onSelectIndex: (index: number) => void;
  videos: VideoItem[];
};

export function PlayerScreen({ currentIndex, exitOrientationLock, onClose, onSelectIndex, videos }: PlayerScreenProps) {
  const insets = useSafeAreaInsets();
  const video = videos[currentIndex];
  const hasNextVideo = currentIndex < videos.length - 1;
  const [player] = useState(() => createVideoPlayer(video.uri));
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [activeSubtitleText, setActiveSubtitleText] = useState<string | null>(null);
  const lastLoadedUriRef = useRef(video.uri);
  const activeVideoUriRef = useRef(video.uri);
  const currentDurationRef = useRef<number>(0);
  const autoHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPersistedPositionRef = useRef(0);

  useEffect(() => {
    activeVideoUriRef.current = video.uri;
    lastPersistedPositionRef.current = 0;
  }, [video.uri]);

  const persistPosition = (uri: string, positionSeconds: number, force = false) => {
    if (!force && Math.abs(positionSeconds - lastPersistedPositionRef.current) < 2) {
      return;
    }

    lastPersistedPositionRef.current = positionSeconds;
    void savePlaybackPosition(uri, positionSeconds, currentDurationRef.current);
  };

  useEffect(() => {
    player.keepScreenOnWhilePlaying = true;
    player.timeUpdateEventInterval = 0.5;
  }, [player]);

  useEffect(() => {
    if (autoHideTimeoutRef.current) {
      clearTimeout(autoHideTimeoutRef.current);
    }

    if (controlsVisible && isPlaying && !isScrubbing) {
      autoHideTimeoutRef.current = setTimeout(() => {
        setControlsVisible(false);
      }, 2500);
    }

    return () => {
      if (autoHideTimeoutRef.current) {
        clearTimeout(autoHideTimeoutRef.current);
        autoHideTimeoutRef.current = null;
      }
    };
  }, [controlsVisible, isPlaying, isScrubbing]);

  useEventListener(player, 'playToEnd', () => {
    persistPosition(video.uri, player.currentTime, true);
    setControlsVisible(false);

    if (hasNextVideo) {
      onSelectIndex(currentIndex + 1);
    }
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    setCurrentTime(currentTime);
    persistPosition(activeVideoUriRef.current, currentTime);
    setActiveSubtitleText(getActiveSubtitleText(subtitleCues, currentTime));
  });

  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    setIsPlaying(isPlaying);
  });

  useEventListener(player, 'sourceLoad', ({ duration }) => {
    currentDurationRef.current = duration;
    void savePlaybackDuration(activeVideoUriRef.current, duration);
    setCurrentTime(player.currentTime);
    setScrubTime(player.currentTime);
  });

  useEffect(() => {
    let cancelled = false;

    async function loadSubtitles() {
      try {
        const subtitleUri = await findMatchingSubtitleUri(video);

        if (!subtitleUri || cancelled) {
          setSubtitleCues([]);
          setActiveSubtitleText(null);
          return;
        }

        const cues = await loadSrtFile(subtitleUri);

        if (cancelled) {
          return;
        }

        setSubtitleCues(cues);
        setActiveSubtitleText(getActiveSubtitleText(cues, player.currentTime));
      } catch {
        if (!cancelled) {
          setSubtitleCues([]);
          setActiveSubtitleText(null);
        }
      }
    }

    void loadSubtitles();

    return () => {
      cancelled = true;
    };
  }, [player, video]);

  useEffect(() => {
    if (lastLoadedUriRef.current === video.uri) {
      let cancelled = false;

      async function resumeCurrentVideo() {
        const savedPosition = await getSavedPlaybackPosition(video.uri);

        if (cancelled) {
          return;
        }

        currentDurationRef.current = player.duration;
        player.currentTime = savedPosition;
        setCurrentTime(savedPosition);
        setScrubTime(savedPosition);
        setActiveSubtitleText(getActiveSubtitleText(subtitleCues, savedPosition));
        player.play();
      }

      void resumeCurrentVideo();

      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;

    async function replaceSource() {
      const savedPosition = await getSavedPlaybackPosition(video.uri);

      if (cancelled) {
        return;
      }

      try {
        await player.replaceAsync(video.uri);
      } catch {
        player.replace(video.uri);
      }

      if (!cancelled) {
        lastLoadedUriRef.current = video.uri;
        currentDurationRef.current = player.duration;
        player.currentTime = savedPosition;
        setCurrentTime(savedPosition);
        setScrubTime(savedPosition);
        setActiveSubtitleText(getActiveSubtitleText(subtitleCues, savedPosition));
        player.play();
      }
    }

    void replaceSource();

    return () => {
      cancelled = true;
    };
  }, [player, subtitleCues, video.uri]);

  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);

    return () => {
      persistPosition(activeVideoUriRef.current, player.currentTime, true);
      void ScreenOrientation.lockAsync(exitOrientationLock);
      player.release();
    };
  }, [exitOrientationLock, player]);

  function handleClose() {
    persistPosition(video.uri, player.currentTime, true);
    onClose();
  }

  function handleNext() {
    persistPosition(video.uri, player.currentTime, true);
    setControlsVisible(false);
    onSelectIndex(currentIndex + 1);
  }

  function handleSeek(seconds: number) {
    player.seekBy(seconds);
    setCurrentTime(player.currentTime);
    setScrubTime(player.currentTime);
    setControlsVisible(true);
  }

  function handleTogglePlayback() {
    if (player.playing) {
      player.pause();
      setControlsVisible(true);
      return;
    }

    player.play();
    setControlsVisible(true);
  }

  function handleToggleControls() {
    setControlsVisible((visible) => !visible);
  }

  function handleHideControls() {
    setControlsVisible(false);
  }

  function handleSlidingStart() {
    setIsScrubbing(true);
    setScrubTime(currentTime);
    setControlsVisible(true);
  }

  function handleSlidingComplete(value: number) {
    player.currentTime = value;
    setCurrentTime(value);
    setScrubTime(value);
    setIsScrubbing(false);
    setActiveSubtitleText(getActiveSubtitleText(subtitleCues, value));
    persistPosition(video.uri, value, true);
    setControlsVisible(true);
  }

  const displayedTime = isScrubbing ? scrubTime : currentTime;
  const duration = currentDurationRef.current;

  return (
    <View style={styles.container}>
      <StatusBar hidden style="light" />
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="contain"
        style={styles.video}
      />

      {activeSubtitleText ? (
        <View
          pointerEvents="none"
          style={[
            styles.subtitleOverlay,
            {
              bottom: controlsVisible ? insets.bottom + 54 : insets.bottom + 14,
            },
          ]}
        >
          <View style={styles.subtitleBubble}>
            <Text style={styles.subtitleText}>{activeSubtitleText}</Text>
          </View>
        </View>
      ) : null}

      {controlsVisible ? (
        <>
          <Pressable onPress={handleHideControls} style={styles.dismissTapArea} />

          <View style={[styles.topOverlay, { paddingTop: insets.top + 10 }]}> 
            <Pressable onPress={handleClose} style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}>
              <Text style={styles.closeButtonText}>Back</Text>
            </Pressable>

            <View style={styles.titleWrap}>
              <Text numberOfLines={1} style={styles.fileName}>
                {video.name}
              </Text>
              <Text style={styles.playlistMeta}>
                {currentIndex + 1} / {videos.length}
                {hasNextVideo ? ' - next plays automatically' : ' - last video in queue'}
              </Text>
            </View>

            {hasNextVideo ? (
              <Pressable onPress={handleNext} style={({ pressed }) => [styles.nextButton, pressed && styles.closeButtonPressed]}>
                <Text style={styles.closeButtonText}>Next</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.centerOverlay}>
            <View style={styles.transportRow}>
              <Pressable onPress={() => handleSeek(-10)} style={({ pressed }) => [styles.transportButton, pressed && styles.closeButtonPressed]}>
                <Text style={styles.transportButtonText}>-10</Text>
              </Pressable>
              <Pressable onPress={handleTogglePlayback} style={({ pressed }) => [styles.playPauseButton, pressed && styles.closeButtonPressed]}>
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </Pressable>
              <Pressable onPress={() => handleSeek(10)} style={({ pressed }) => [styles.transportButton, pressed && styles.closeButtonPressed]}>
                <Text style={styles.transportButtonText}>+10</Text>
              </Pressable>
            </View>
          </View>

          <View style={[styles.bottomOverlay, { paddingBottom: insets.bottom + 14 }]}> 
            <View style={styles.timeRow}>
              <Text style={styles.timeText}>{formatDuration(displayedTime)}</Text>
              <View style={styles.sliderColumn}>
                <Slider
                  maximumTrackTintColor="rgba(255,255,255,0.2)"
                  maximumValue={Math.max(duration, 0.1)}
                  minimumTrackTintColor="#1f6f68"
                  minimumValue={0}
                  onSlidingComplete={handleSlidingComplete}
                  onSlidingStart={handleSlidingStart}
                  onValueChange={setScrubTime}
                  step={1}
                  style={styles.slider}
                  thumbTintColor="#fff"
                  value={Math.min(displayedTime, Math.max(duration, 0.1))}
                />
              </View>
              <Text style={styles.timeText}>{formatDuration(duration)}</Text>
            </View>
          </View>
        </>
      ) : (
        <Pressable onPress={handleToggleControls} style={styles.showTapArea} />
      )}
    </View>
  );
}

function PlayIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path d="M6 4.5L15 10L6 15.5V4.5Z" fill="#FFFFFF" />
    </Svg>
  );
}

function PauseIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Rect x="5" y="4" width="3.5" height="12" rx="1" fill="#FFFFFF" />
      <Rect x="11.5" y="4" width="3.5" height="12" rx="1" fill="#FFFFFF" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050505',
  },
  video: {
    flex: 1,
    backgroundColor: '#050505',
  },
  showTapArea: {
    ...StyleSheet.absoluteFillObject,
  },
  subtitleOverlay: {
    position: 'absolute',
    left: 18,
    right: 18,
    alignItems: 'center',
  },
  subtitleBubble: {
    maxWidth: '92%',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  subtitleText: {
    color: '#fff',
    fontSize: 18,
    lineHeight: 25,
    fontWeight: '700',
    textAlign: 'center',
  },
  dismissTapArea: {
    ...StyleSheet.absoluteFillObject,
  },
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
  },
  centerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  bottomOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 18,
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  closeButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(31,111,104,0.9)',
  },
  nextButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(31,111,104,0.9)',
  },
  closeButtonPressed: {
    opacity: 0.78,
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  titleWrap: {
    flex: 1,
    gap: 3,
  },
  fileName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  playlistMeta: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '500',
  },
  transportRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
    alignItems: 'center',
  },
  transportButton: {
    minWidth: 64,
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(31,111,104,0.9)',
  },
  playPauseButton: {
    minWidth: 92,
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 12,
    backgroundColor: 'rgba(31,111,104,0.9)',
  },
  transportButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  timeText: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 12,
    fontWeight: '600',
    minWidth: 44,
  },
  slider: {
    width: '100%',
    flex: 1,
    height: 28,
  },
  sliderColumn: {
    flex: 1,
    justifyContent: 'flex-end',
    minHeight: 28,
  },
});
