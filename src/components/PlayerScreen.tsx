import { useEffect, useRef, useState } from 'react';
import { useEventListener } from 'expo';
import { Image, type ImageProps } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { createVideoPlayer, VideoView } from 'expo-video';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
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

const SUBTITLE_OUTLINE_OFFSETS = [
  [-2, 0],
  [2, 0],
  [0, -2],
  [0, 2],
  [-2, -2],
  [2, -2],
  [-2, 2],
  [2, 2],
] as const;

const BACKGROUND_DOUBLE_TAP_DELAY_MS = 250;
const SCRUB_PREVIEW_DEDUPE_THRESHOLD_SECONDS = 0.05;
const SCRUB_PREVIEW_POPUP_WIDTH = 160;
const SCRUB_PREVIEW_POPUP_HEIGHT = 90;

export function PlayerScreen({ currentIndex, exitOrientationLock, onClose, onSelectIndex, videos }: PlayerScreenProps) {
  const insets = useSafeAreaInsets();
  const video = videos[currentIndex];
  const hasNextVideo = currentIndex < videos.length - 1;
  const [player] = useState(() => createVideoPlayer(video.uri));
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubPreviewSource, setScrubPreviewSource] = useState<ImageProps['source'] | null>(null);
  const [scrubTime, setScrubTime] = useState(0);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [activeSubtitleText, setActiveSubtitleText] = useState<string | null>(null);
  const lastLoadedUriRef = useRef(video.uri);
  const activeVideoUriRef = useRef(video.uri);
  const currentDurationRef = useRef<number>(0);
  const autoHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRequestInFlightRef = useRef(false);
  const previewThumbnailRequestIdRef = useRef(0);
  const lastBackgroundTapTimestampRef = useRef(0);
  const lastPersistedPositionRef = useRef(0);
  const queuedPreviewTimeRef = useRef<number | null>(null);
  const lastPreviewedTimeRef = useRef<number | null>(null);
  const seekBarWidthRef = useRef(1);
  const scrubTimeRef = useRef(0);

  useEffect(() => {
    activeVideoUriRef.current = video.uri;
    lastPersistedPositionRef.current = 0;
    previewRequestInFlightRef.current = false;
    queuedPreviewTimeRef.current = null;
    previewThumbnailRequestIdRef.current += 1;
    lastPreviewedTimeRef.current = null;
    setScrubPreviewSource(null);
  }, [video.uri]);

  useEffect(() => {
    scrubTimeRef.current = scrubTime;
  }, [scrubTime]);

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

  useEffect(() => {
    return () => {
      if (backgroundTapTimeoutRef.current) {
        clearTimeout(backgroundTapTimeoutRef.current);
        backgroundTapTimeoutRef.current = null;
      }

      previewRequestInFlightRef.current = false;
      queuedPreviewTimeRef.current = null;
      previewThumbnailRequestIdRef.current += 1;
    };
  }, []);

  useEventListener(player, 'playToEnd', () => {
    persistPosition(video.uri, player.currentTime, true);
    setControlsVisible(false);

    if (hasNextVideo) {
      onSelectIndex(currentIndex + 1);
    }
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    setCurrentTime(currentTime);
    if (!isScrubbing) {
      persistPosition(activeVideoUriRef.current, currentTime);
    }
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

  function handleTogglePlaybackWithoutControls() {
    if (player.playing) {
      player.pause();
      return;
    }

    player.play();
  }

  function clearPendingBackgroundTap() {
    if (backgroundTapTimeoutRef.current) {
      clearTimeout(backgroundTapTimeoutRef.current);
      backgroundTapTimeoutRef.current = null;
    }
  }

  function handleBackgroundTap(singleTapAction: () => void) {
    if (isScrubbing) {
      return;
    }

    const now = Date.now();
    const isDoubleTap =
      backgroundTapTimeoutRef.current !== null &&
      now - lastBackgroundTapTimestampRef.current <= BACKGROUND_DOUBLE_TAP_DELAY_MS;

    if (isDoubleTap) {
      clearPendingBackgroundTap();
      lastBackgroundTapTimestampRef.current = 0;
      handleTogglePlaybackWithoutControls();
      return;
    }

    lastBackgroundTapTimestampRef.current = now;
    clearPendingBackgroundTap();
    backgroundTapTimeoutRef.current = setTimeout(() => {
      backgroundTapTimeoutRef.current = null;
      singleTapAction();
    }, BACKGROUND_DOUBLE_TAP_DELAY_MS);
  }

  function clearScrubPreview() {
    previewRequestInFlightRef.current = false;
    queuedPreviewTimeRef.current = null;
    previewThumbnailRequestIdRef.current += 1;
    lastPreviewedTimeRef.current = null;
    setScrubPreviewSource(null);
  }

  async function generateScrubPreview(time: number, requestId: number) {
    try {
      const [thumbnail] = await player.generateThumbnailsAsync([time]);

      if (previewThumbnailRequestIdRef.current !== requestId || !thumbnail) {
        return;
      }

      lastPreviewedTimeRef.current = time;
      setScrubPreviewSource(thumbnail as ImageProps['source']);
    } catch {
      if (previewThumbnailRequestIdRef.current === requestId) {
        setScrubPreviewSource(null);
      }
    } finally {
      if (previewThumbnailRequestIdRef.current !== requestId) {
        return;
      }

      previewRequestInFlightRef.current = false;

      const queuedPreviewTime = queuedPreviewTimeRef.current;
      queuedPreviewTimeRef.current = null;

      if (
        queuedPreviewTime !== null &&
        (lastPreviewedTimeRef.current === null ||
          Math.abs(lastPreviewedTimeRef.current - queuedPreviewTime) > SCRUB_PREVIEW_DEDUPE_THRESHOLD_SECONDS)
      ) {
        requestScrubPreview(queuedPreviewTime);
      }
    }
  }

  function requestScrubPreview(time: number) {
    if (
      lastPreviewedTimeRef.current !== null &&
      Math.abs(lastPreviewedTimeRef.current - time) <= SCRUB_PREVIEW_DEDUPE_THRESHOLD_SECONDS
    ) {
      return;
    }

    if (previewRequestInFlightRef.current) {
      queuedPreviewTimeRef.current = time;
      return;
    }

    previewRequestInFlightRef.current = true;
    queuedPreviewTimeRef.current = null;

    const requestId = previewThumbnailRequestIdRef.current + 1;
    previewThumbnailRequestIdRef.current = requestId;
    void generateScrubPreview(time, requestId);
  }

  function handleToggleControls() {
    setControlsVisible((visible) => !visible);
  }

  function handleHideControls() {
    setControlsVisible(false);
  }

  function handleVisibleBackgroundTap() {
    handleBackgroundTap(handleHideControls);
  }

  function handleHiddenBackgroundTap() {
    handleBackgroundTap(handleToggleControls);
  }

  function handleSeekBarLayout(event: LayoutChangeEvent) {
    seekBarWidthRef.current = Math.max(event.nativeEvent.layout.width, 1);
  }

  function getSeekTimeFromPosition(positionX: number): number {
    const width = Math.max(seekBarWidthRef.current, 1);
    const clampedX = Math.max(0, Math.min(positionX, width));
    const safeDuration = Math.max(currentDurationRef.current, 0);

    if (safeDuration <= 0) {
      return 0;
    }

    return (clampedX / width) * safeDuration;
  }

  function updateScrubFromEvent(event: GestureResponderEvent) {
    const nextTime = getSeekTimeFromPosition(event.nativeEvent.locationX);
    setScrubTime(nextTime);
    setControlsVisible(true);
    return nextTime;
  }

  function handleSeekBarGrant(event: GestureResponderEvent) {
    clearScrubPreview();
    setIsScrubbing(true);
    requestScrubPreview(updateScrubFromEvent(event));
  }

  function handleSeekBarMove(event: GestureResponderEvent) {
    requestScrubPreview(updateScrubFromEvent(event));
  }

  function handleSeekBarRelease(event: GestureResponderEvent) {
    handleSlidingComplete(updateScrubFromEvent(event));
  }

  function handleSeekBarTerminate() {
    handleSlidingComplete(scrubTimeRef.current);
  }

  function handleSlidingComplete(value: number) {
    clearScrubPreview();
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
  const remainingTime = Math.max(duration - displayedTime, 0);
  const progressPercent = duration > 0 ? Math.max(0, Math.min(displayedTime / duration, 1)) : 0;
  const scrubPreviewLeft = Math.max(
    0,
    Math.min(
      progressPercent * seekBarWidthRef.current - SCRUB_PREVIEW_POPUP_WIDTH / 2,
      Math.max(seekBarWidthRef.current - SCRUB_PREVIEW_POPUP_WIDTH, 0)
    )
  );

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
          <View style={styles.subtitleStack}>
            {SUBTITLE_OUTLINE_OFFSETS.map(([translateX, translateY], index) => (
              <Text
                key={`${translateX},${translateY},${index}`}
                style={[
                  styles.subtitleText,
                  styles.subtitleOutline,
                  { transform: [{ translateX }, { translateY }] },
                ]}
              >
                {activeSubtitleText}
              </Text>
            ))}
            <Text style={styles.subtitleText}>{activeSubtitleText}</Text>
          </View>
        </View>
      ) : null}

      {controlsVisible ? (
        <>
          <Pressable onPress={handleVisibleBackgroundTap} style={styles.dismissTapArea} />

          <View style={[styles.topOverlay, { paddingTop: insets.top + 10 }]}> 
            <View style={styles.topActionSlot}>
              <Pressable onPress={handleClose} style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}>
                <Text style={styles.closeButtonText}>Back</Text>
              </Pressable>
            </View>

            <View style={styles.titleWrap}>
              <Text numberOfLines={1} style={styles.fileName}>
                {video.name}
              </Text>
              <Text style={styles.playlistMeta}>
                {currentIndex + 1} / {videos.length}
                {hasNextVideo ? ' - next plays automatically' : ' - last video in queue'}
              </Text>
            </View>

            <View style={[styles.topActionSlot, styles.topActionSlotRight]}>
              {hasNextVideo ? (
                <Pressable onPress={handleNext} style={({ pressed }) => [styles.nextButton, pressed && styles.closeButtonPressed]}>
                  <Text style={styles.closeButtonText}>Next</Text>
                </Pressable>
              ) : null}
            </View>
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

          <View style={[styles.bottomOverlay, { paddingBottom: insets.bottom + 12 }]}> 
            <View
              style={[
                styles.seekBarShell,
                {
                  marginLeft: insets.left,
                  marginRight: insets.right,
                },
              ]}
            >
              {isScrubbing && scrubPreviewSource ? (
                <View pointerEvents="none" style={[styles.scrubPreviewPopup, { left: scrubPreviewLeft }]}> 
                  <Image contentFit="cover" source={scrubPreviewSource} style={styles.scrubPreviewImage} transition={0} />
                </View>
              ) : null}

              <View
                onLayout={handleSeekBarLayout}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={handleSeekBarGrant}
                onResponderMove={handleSeekBarMove}
                onResponderRelease={handleSeekBarRelease}
                onResponderTerminate={handleSeekBarTerminate}
                onStartShouldSetResponder={() => true}
                style={styles.seekBarTouchArea}
              >
                <View style={styles.seekBarTrack}>
                  <View style={[styles.seekBarProgress, { width: `${progressPercent * 100}%` }]} />
                </View>
                <View pointerEvents="none" style={styles.seekBarLabelRow}>
                  <Text style={styles.seekBarTimeText}>{formatDuration(displayedTime)}</Text>
                  <Text style={styles.seekBarTimeText}>-{formatDuration(remainingTime)}</Text>
                </View>
              </View>
            </View>
          </View>
        </>
      ) : (
        <Pressable onPress={handleHiddenBackgroundTap} style={styles.showTapArea} />
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
  scrubPreviewPopup: {
    position: 'absolute',
    bottom: 56,
    width: SCRUB_PREVIEW_POPUP_WIDTH,
    height: SCRUB_PREVIEW_POPUP_HEIGHT,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(8, 12, 16, 0.96)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  scrubPreviewImage: {
    flex: 1,
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
  subtitleStack: {
    position: 'relative',
    maxWidth: '92%',
    alignItems: 'center',
  },
  subtitleText: {
    color: '#F2F2F2',
    fontSize: 36,
    lineHeight: 44,
    fontWeight: '800',
    textAlign: 'center',
  },
  subtitleOutline: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    color: '#000',
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
  topActionSlot: {
    width: 78,
    alignItems: 'flex-start',
  },
  topActionSlotRight: {
    alignItems: 'flex-end',
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
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
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
    alignItems: 'center',
  },
  fileName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  playlistMeta: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
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
  seekBarShell: {
    width: '100%',
    position: 'relative',
  },
  seekBarTouchArea: {
    width: '100%',
    height: 44,
    justifyContent: 'center',
  },
  seekBarTrack: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: 'rgba(10,18,26,0.72)',
  },
  seekBarProgress: {
    height: '100%',
    backgroundColor: '#1f6f68',
  },
  seekBarLabelRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  seekBarTimeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});
