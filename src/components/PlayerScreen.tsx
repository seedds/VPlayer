import { useEffect, useRef, useState } from 'react';
import { useEventListener } from 'expo';
import { Image, type ImageProps } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { createVideoPlayer, VideoView } from 'expo-video';
import { AppState, Pressable, StyleSheet, Text, View, type AppStateStatus, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
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
  longPressSpeedTenths: number;
  onClose: () => void;
  onSelectIndex: (index: number) => void;
  subtitleFontSize: number;
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
const RESUME_NEAR_END_THRESHOLD_SECONDS = 10;
const PLAYBACK_RATE_STEP = 0.1;
const MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 2;
// A hold longer than the double-tap window engages the speed boost, so a hold can
// never swallow a double tap.
const LONG_PRESS_BOOST_DELAY_MS = 500;
const SUBTITLE_BASE_FONT_SIZE = 36;
const SUBTITLE_BASE_LINE_HEIGHT = 44;

function formatClockTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

type PendingResumeState = {
  savedPosition: number;
  shouldAutoplay: boolean;
  uri: string;
};

function clampPlaybackRate(rate: number): number {
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, Math.round(rate * 10) / 10));
}

function getResumePosition(savedPosition: number, duration: number): number {
  if (!Number.isFinite(savedPosition) || savedPosition <= 0) {
    return 0;
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    return savedPosition;
  }

  const clampedPosition = Math.max(0, Math.min(savedPosition, duration));
  const remainingTime = duration - clampedPosition;

  if (remainingTime >= RESUME_NEAR_END_THRESHOLD_SECONDS) {
    return clampedPosition;
  }

  return Math.max(duration - RESUME_NEAR_END_THRESHOLD_SECONDS, 0);
}

export function PlayerScreen({
  currentIndex,
  exitOrientationLock,
  longPressSpeedTenths,
  onClose,
  onSelectIndex,
  subtitleFontSize,
  videos,
}: PlayerScreenProps) {
  const insets = useSafeAreaInsets();
  const video = videos[currentIndex];
  const hasNextVideo = currentIndex < videos.length - 1;
  const [player] = useState(() => createVideoPlayer(video.uri));
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isControlsLocked, setIsControlsLocked] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [currentClockTime, setCurrentClockTime] = useState(() => formatClockTime(new Date()));
  const [scrubPreviewSource, setScrubPreviewSource] = useState<ImageProps['source'] | null>(null);
  const [scrubTime, setScrubTime] = useState(0);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [activeSubtitleText, setActiveSubtitleText] = useState<string | null>(null);
  // Hold-to-speed-up. The boosted rate is applied to the player directly and kept
  // out of `playbackRate`, so the manual +/- control keeps showing (and restoring
  // to) the user's chosen base rate.
  const [speedBoostActive, setSpeedBoostActive] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const longPressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedBoostActiveRef = useRef(false);
  const playbackRateRef = useRef(1);
  const activePointerCountRef = useRef(0);
  const suppressNextBackgroundTapRef = useRef(false);
  const boostedRate = longPressSpeedTenths / 10;
  const lastLoadedUriRef = useRef(video.uri);
  const activeVideoUriRef = useRef(video.uri);
  const subtitleCuesRef = useRef<SubtitleCue[]>([]);
  const currentDurationRef = useRef<number>(0);
  const autoHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRequestInFlightRef = useRef(false);
  const previewThumbnailRequestIdRef = useRef(0);
  const lastBackgroundTapTimestampRef = useRef(0);
  const lastBackgroundTapTouchCountRef = useRef(0);
  const backgroundGestureTouchCountRef = useRef(0);
  const lastPersistedPositionRef = useRef(0);
  const queuedPreviewTimeRef = useRef<number | null>(null);
  const lastPreviewedTimeRef = useRef<number | null>(null);
  const pendingResumeRef = useRef<PendingResumeState | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const appHasFocusRef = useRef(true);
  const playbackInterruptedRef = useRef(false);
  const seekBarWidthRef = useRef(1);
  const scrubTimeRef = useRef(0);

  useEffect(() => {
    activeVideoUriRef.current = video.uri;
    playbackInterruptedRef.current = false;
    lastPersistedPositionRef.current = 0;
    pendingResumeRef.current = null;
    clearScrubPreview();
    setSubtitleCues([]);
    setActiveSubtitleText(null);
    setLoadError(null);
    // Auto-advance can be triggered *by* fast-forwarding to the end, so drop any
    // live boost before it carries into the next video.
    releaseSpeedBoost();
  }, [video.uri]);

  useEffect(() => {
    scrubTimeRef.current = scrubTime;
  }, [scrubTime]);

  useEffect(() => {
    playbackRateRef.current = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    subtitleCuesRef.current = subtitleCues;
  }, [subtitleCues]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setCurrentClockTime(formatClockTime(new Date()));
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, []);

  const persistPosition = (uri: string, positionSeconds: number, force = false) => {
    if (!force && Math.abs(positionSeconds - lastPersistedPositionRef.current) < 2) {
      return;
    }

    lastPersistedPositionRef.current = positionSeconds;
    void savePlaybackPosition(uri, positionSeconds, currentDurationRef.current);
  };

  function applyResumePosition(savedPosition: number, duration: number, shouldAutoplay: boolean) {
    currentDurationRef.current = duration;
    const resumePosition = getResumePosition(savedPosition, duration);
    player.currentTime = resumePosition;
    setCurrentTime(resumePosition);
    setScrubTime(resumePosition);
    setActiveSubtitleText(getActiveSubtitleText(subtitleCuesRef.current, resumePosition));

    if (shouldAutoplay) {
      player.play();
    }
  }

  function clearAutoHideTimer() {
    if (autoHideTimeoutRef.current) {
      clearTimeout(autoHideTimeoutRef.current);
      autoHideTimeoutRef.current = null;
    }
  }

  function restartAutoHideTimer(shouldAutoHide: boolean) {
    clearAutoHideTimer();

    if (shouldAutoHide) {
      autoHideTimeoutRef.current = setTimeout(() => {
        setControlsVisible(false);
      }, 2500);
    }
  }

  function showControls() {
    setControlsVisible(true);
    restartAutoHideTimer(player.playing && !isScrubbing);
  }

  function resumeAutoHideAfterBackgroundGesture() {
    restartAutoHideTimer(controlsVisible && isPlaying && !isScrubbing);
  }

  useEffect(() => {
    player.keepScreenOnWhilePlaying = true;
    player.preservesPitch = true;
    player.timeUpdateEventInterval = 0.5;
  }, [player]);

  useEffect(() => {
    restartAutoHideTimer(controlsVisible && isPlaying && !isScrubbing);

    return () => {
      clearAutoHideTimer();
    };
  }, [controlsVisible, isControlsLocked, isPlaying, isScrubbing]);

  useEffect(() => {
    return () => {
      if (backgroundTapTimeoutRef.current) {
        clearTimeout(backgroundTapTimeoutRef.current);
        backgroundTapTimeoutRef.current = null;
      }

      lastBackgroundTapTouchCountRef.current = 0;
      backgroundGestureTouchCountRef.current = 0;
      clearScrubPreview();

      if (longPressTimeoutRef.current) {
        clearTimeout(longPressTimeoutRef.current);
        longPressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handlePlaybackInterruption = () => {
      playbackInterruptedRef.current = true;
      appHasFocusRef.current = false;
      cancelSpeedBoost();
      clearScrubPreview();
      setIsScrubbing(false);
      setIsControlsLocked(false);
      persistPosition(activeVideoUriRef.current, player.currentTime, true);
      player.pause();
      setControlsVisible(true);
    };

    const changeSubscription = AppState.addEventListener('change', (nextAppState) => {
      const previousAppState = appStateRef.current;
      appStateRef.current = nextAppState;

      const isLeavingActive = previousAppState === 'active' && nextAppState !== 'active';
      const isReturningActive = previousAppState !== 'active' && nextAppState === 'active';

      if (isLeavingActive) {
        handlePlaybackInterruption();
        return;
      }

      if (isReturningActive) {
        appHasFocusRef.current = true;
      }
    });

    const blurSubscription = AppState.addEventListener('blur', () => {
      handlePlaybackInterruption();
    });

    const focusSubscription = AppState.addEventListener('focus', () => {
      appHasFocusRef.current = true;
    });

    return () => {
      changeSubscription.remove();
      blurSubscription.remove();
      focusSubscription.remove();
    };
  }, [player]);

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

  useEventListener(player, 'statusChange', ({ status, error }) => {
    // A missing/corrupt file otherwise just sits on a black frame with no
    // message. Surface it and reveal the controls so Back is reachable.
    if (status === 'error') {
      setLoadError(error?.message ?? 'This video could not be played.');
      setControlsVisible(true);
      return;
    }

    if (status === 'readyToPlay') {
      setLoadError(null);
    }
  });

  useEventListener(player, 'sourceLoad', ({ duration }) => {
    currentDurationRef.current = duration;
    void savePlaybackDuration(activeVideoUriRef.current, duration);

    const pendingResume = pendingResumeRef.current;

    if (pendingResume && pendingResume.uri === activeVideoUriRef.current) {
      pendingResumeRef.current = null;
      applyResumePosition(pendingResume.savedPosition, duration, pendingResume.shouldAutoplay);
      return;
    }

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
    // Keyed on the video's URI, not the object reference: a library refresh
    // rebuilds an equal `video` object, and depending on it would reload and
    // re-parse the SRT on every refresh while playing. The parentPath/name are
    // implied by the URI, so they add nothing as deps.
  }, [player, video.uri]);

  useEffect(() => {
    const shouldAutoplay = () => appStateRef.current === 'active' && appHasFocusRef.current && !playbackInterruptedRef.current;

    if (lastLoadedUriRef.current === video.uri) {
      let cancelled = false;

      async function resumeCurrentVideo() {
        const savedPosition = await getSavedPlaybackPosition(video.uri);
        const shouldResumePlayback = shouldAutoplay();

        if (cancelled) {
          return;
        }

        if (Number.isFinite(player.duration) && player.duration > 0) {
          applyResumePosition(savedPosition, player.duration, shouldResumePlayback);
          return;
        }

        pendingResumeRef.current = {
          savedPosition,
          shouldAutoplay: shouldResumePlayback,
          uri: video.uri,
        };
      }

      void resumeCurrentVideo();

      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;

    async function replaceSource() {
      const savedPosition = await getSavedPlaybackPosition(video.uri);
      const shouldResumePlayback = shouldAutoplay();

      if (cancelled) {
        return;
      }

      pendingResumeRef.current = {
        savedPosition,
        shouldAutoplay: shouldResumePlayback,
        uri: video.uri,
      };

      try {
        await player.replaceAsync(video.uri);
      } catch {
        player.replace(video.uri);
      }

      if (!cancelled) {
        lastLoadedUriRef.current = video.uri;

        // Only apply here if the sourceLoad listener has not already consumed the
        // pending resume for this video. Otherwise the resume runs twice and seeks
        // back a visible ~0.5s after playback has already started.
        if (
          pendingResumeRef.current?.uri === video.uri &&
          Number.isFinite(player.duration) &&
          player.duration > 0
        ) {
          pendingResumeRef.current = null;
          applyResumePosition(savedPosition, player.duration, shouldResumePlayback);
        }
      }
    }

    void replaceSource();

    return () => {
      cancelled = true;
    };
  }, [player, video.uri]);

  // Persist and release exactly once, on unmount. Keying this on the player alone
  // (never the orientation prop) guarantees the player is not released while the
  // screen is still open.
  useEffect(() => {
    return () => {
      persistPosition(activeVideoUriRef.current, player.currentTime, true);
      player.release();
    };
  }, [player]);

  // Orientation is a separate concern: lock landscape on open, restore the
  // caller's lock on close, without touching the player lifecycle.
  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);

    return () => {
      void ScreenOrientation.lockAsync(exitOrientationLock);
    };
  }, [exitOrientationLock]);

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
    showControls();
  }

  function handleTogglePlayback() {
    if (player.playing) {
      player.pause();
      showControls();
      return;
    }

    playbackInterruptedRef.current = false;
    player.play();
    showControls();
  }

  function handleLockControls() {
    setIsControlsLocked(true);
    showControls();
  }

  function handleUnlockControls() {
    setIsControlsLocked(false);
    showControls();
  }

  function updatePlaybackRate(nextRate: number) {
    const normalizedRate = clampPlaybackRate(nextRate);
    // While boosting, the hold owns the player's rate; the new base rate is
    // applied on release.
    if (!speedBoostActiveRef.current) {
      player.playbackRate = normalizedRate;
    }
    setPlaybackRate(normalizedRate);
    showControls();
  }

  function handleIncreasePlaybackRate() {
    updatePlaybackRate(playbackRate + PLAYBACK_RATE_STEP);
  }

  function handleDecreasePlaybackRate() {
    updatePlaybackRate(playbackRate - PLAYBACK_RATE_STEP);
  }

  function handleTogglePlaybackWithoutControls() {
    if (player.playing) {
      player.pause();
      return;
    }

    playbackInterruptedRef.current = false;
    player.play();
  }

  // Applies the configured long-press rate as an absolute rate (not a multiplier
  // of playbackRate), bypassing clampPlaybackRate because the boost ceiling (up
  // to 3.0x) is above the manual control's 2.0x max.
  function engageSpeedBoost() {
    longPressTimeoutRef.current = null;

    if (!player.playing || isScrubbing) {
      return;
    }

    speedBoostActiveRef.current = true;
    // The release of a hold must not toggle controls or seed a double tap.
    suppressNextBackgroundTapRef.current = true;
    player.playbackRate = boostedRate;
    setSpeedBoostActive(true);
    setControlsVisible(false);
  }

  // Restores the base rate. Idempotent, so every teardown path can call it.
  function releaseSpeedBoost() {
    if (!speedBoostActiveRef.current) {
      return;
    }

    speedBoostActiveRef.current = false;
    player.playbackRate = playbackRateRef.current;
    setSpeedBoostActive(false);
  }

  function cancelSpeedBoost() {
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }

    releaseSpeedBoost();
  }

  function clearPendingBackgroundTap() {
    if (backgroundTapTimeoutRef.current) {
      clearTimeout(backgroundTapTimeoutRef.current);
      backgroundTapTimeoutRef.current = null;
    }
  }

  function updateBackgroundGestureTouchCount(event: GestureResponderEvent) {
    const touchCount = Math.max(event.nativeEvent.touches.length, event.nativeEvent.changedTouches.length);
    backgroundGestureTouchCountRef.current = Math.max(backgroundGestureTouchCountRef.current, touchCount);
  }

  function resetBackgroundGestureTouchCount() {
    backgroundGestureTouchCountRef.current = 0;
  }

  function toggleControlsLockFromGesture() {
    clearScrubPreview();
    setIsScrubbing(false);
    setIsControlsLocked((locked) => !locked);
    setControlsVisible(true);
  }

  function handleBackgroundTap(singleTapAction: () => void, touchCount: number) {
    if (isScrubbing) {
      return;
    }

    const normalizedTouchCount = touchCount >= 2 ? 2 : 1;

    const now = Date.now();
    const isDoubleTap =
      backgroundTapTimeoutRef.current !== null &&
      now - lastBackgroundTapTimestampRef.current <= BACKGROUND_DOUBLE_TAP_DELAY_MS &&
      lastBackgroundTapTouchCountRef.current === normalizedTouchCount;

    if (isDoubleTap) {
      clearPendingBackgroundTap();
      lastBackgroundTapTimestampRef.current = 0;
      lastBackgroundTapTouchCountRef.current = 0;

      if (normalizedTouchCount >= 2) {
        toggleControlsLockFromGesture();
        return;
      }

      handleTogglePlaybackWithoutControls();
      return;
    }

    lastBackgroundTapTimestampRef.current = now;
    lastBackgroundTapTouchCountRef.current = normalizedTouchCount;
    clearPendingBackgroundTap();
    backgroundTapTimeoutRef.current = setTimeout(() => {
      backgroundTapTimeoutRef.current = null;
      lastBackgroundTapTouchCountRef.current = 0;

      if (normalizedTouchCount === 1) {
        singleTapAction();
      }
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

  function cancelPendingLongPress() {
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  }

  function handleBackgroundResponderGrant(event: GestureResponderEvent) {
    updateBackgroundGestureTouchCount(event);
    clearAutoHideTimer();
    activePointerCountRef.current = Math.max(event.nativeEvent.touches.length, 1);

    // Only a single-finger hold on playing video boosts. Multi-finger gestures
    // (lock/unlock) never do.
    if (activePointerCountRef.current === 1 && player.playing && !isScrubbing) {
      cancelPendingLongPress();
      longPressTimeoutRef.current = setTimeout(engageSpeedBoost, LONG_PRESS_BOOST_DELAY_MS);
    }
  }

  function handleBackgroundResponderTouchStart(event: GestureResponderEvent) {
    updateBackgroundGestureTouchCount(event);
    activePointerCountRef.current = Math.max(event.nativeEvent.touches.length, activePointerCountRef.current);

    // A second finger arriving cancels the pending boost so a two-finger tap can
    // never boost.
    if (activePointerCountRef.current > 1) {
      cancelPendingLongPress();
    }
  }

  function finishBackgroundGesture(singleTapAction: () => void, event: GestureResponderEvent) {
    updateBackgroundGestureTouchCount(event);
    cancelPendingLongPress();
    activePointerCountRef.current = 0;

    const wasBoosting = speedBoostActiveRef.current;
    releaseSpeedBoost();

    const touchCount = backgroundGestureTouchCountRef.current || 1;
    resetBackgroundGestureTouchCount();

    // The release of a hold must not toggle controls or seed a phantom tap.
    if (wasBoosting || suppressNextBackgroundTapRef.current) {
      suppressNextBackgroundTapRef.current = false;
      resumeAutoHideAfterBackgroundGesture();
      return;
    }

    handleBackgroundTap(singleTapAction, touchCount);
    resumeAutoHideAfterBackgroundGesture();
  }

  function handleVisibleBackgroundResponderRelease(event: GestureResponderEvent) {
    finishBackgroundGesture(handleHideControls, event);
  }

  function handleHiddenBackgroundResponderRelease(event: GestureResponderEvent) {
    finishBackgroundGesture(handleToggleControls, event);
  }

  function handleBackgroundResponderTerminate() {
    cancelPendingLongPress();
    activePointerCountRef.current = 0;
    releaseSpeedBoost();
    suppressNextBackgroundTapRef.current = false;
    resetBackgroundGestureTouchCount();
    resumeAutoHideAfterBackgroundGesture();
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

  const subtitleTextSizeStyle = {
    fontSize: subtitleFontSize,
    lineHeight: (subtitleFontSize * SUBTITLE_BASE_LINE_HEIGHT) / SUBTITLE_BASE_FONT_SIZE,
  };
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
              bottom: controlsVisible && !isControlsLocked ? insets.bottom + 54 : insets.bottom + 14,
            },
          ]}
        >
          <View style={styles.subtitleStack}>
            {SUBTITLE_OUTLINE_OFFSETS.map(([translateX, translateY], index) => (
              <Text
                key={`${translateX},${translateY},${index}`}
                style={[
                  styles.subtitleText,
                  subtitleTextSizeStyle,
                  styles.subtitleOutline,
                  { transform: [{ translateX }, { translateY }] },
                ]}
              >
                {activeSubtitleText}
              </Text>
            ))}
            <Text style={[styles.subtitleText, subtitleTextSizeStyle]}>{activeSubtitleText}</Text>
          </View>
        </View>
      ) : null}

      {speedBoostActive ? (
        <View pointerEvents="none" style={[styles.speedBoostBadge, { top: insets.top + 56 }]}>
          <Text style={styles.speedBoostBadgeText}>{boostedRate.toFixed(1)}{'\u00d7'}</Text>
          <PlayIcon />
        </View>
      ) : null}

      {loadError ? (
        <View pointerEvents="none" style={styles.loadErrorOverlay}>
          <Text style={styles.loadErrorIcon}>{'\u26A0'}</Text>
          <Text style={styles.loadErrorText}>{loadError}</Text>
        </View>
      ) : null}

      {controlsVisible ? (
        <>
          <View
            onResponderGrant={handleBackgroundResponderGrant}
            onResponderRelease={handleVisibleBackgroundResponderRelease}
            onResponderTerminate={handleBackgroundResponderTerminate}
            onStartShouldSetResponder={() => !isScrubbing}
            onTouchStart={handleBackgroundResponderTouchStart}
            style={styles.dismissTapArea}
          />

          {!isControlsLocked ? (
            <View style={[styles.topOverlay, { paddingTop: insets.top + 10 }]}> 
              <View style={styles.topActionSlot}>
                <Pressable onPress={handleClose} style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}>
                  <Text style={styles.closeButtonText}>Back</Text>
                </Pressable>
              </View>

              <View style={styles.titleWrap}>
                <Text numberOfLines={1} style={styles.fileName}>
                  {currentClockTime}
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
          ) : null}

          <View style={styles.centerOverlay}>
            <View style={styles.centerControlStack}>
              <Pressable
                onPress={isControlsLocked ? handleUnlockControls : handleLockControls}
                style={({ pressed }) => [styles.lockButton, pressed && styles.closeButtonPressed]}
              >
                {isControlsLocked ? <UnlockIcon /> : <LockIcon />}
              </Pressable>

              <View pointerEvents={isControlsLocked ? 'none' : 'auto'} style={styles.transportRowSlot}>
                {!isControlsLocked ? (
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
                ) : null}
              </View>
            </View>
          </View>

          {!isControlsLocked ? (
            <View pointerEvents="box-none" style={[styles.speedControlOverlay, { right: insets.right + 12 }]}> 
              <View style={styles.speedControlStack}>
                <Pressable onPress={handleIncreasePlaybackRate} style={({ pressed }) => [styles.speedButton, pressed && styles.closeButtonPressed]}>
                  <Text style={styles.speedButtonText}>+</Text>
                </Pressable>
                <Text style={styles.speedValueText}>{playbackRate.toFixed(1)}</Text>
                <Pressable onPress={handleDecreasePlaybackRate} style={({ pressed }) => [styles.speedButton, pressed && styles.closeButtonPressed]}>
                  <Text style={styles.speedButtonText}>-</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {!isControlsLocked ? (
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
                    <View style={styles.seekBarFileNameWrap}>
                      <Text numberOfLines={1} style={styles.seekBarFileNameText}>
                        {video.name}
                      </Text>
                    </View>
                    <Text style={styles.seekBarTimeText}>-{formatDuration(remainingTime)}</Text>
                  </View>
                </View>
              </View>
            </View>
          ) : null}
        </>
      ) : (
        <View
          onResponderGrant={handleBackgroundResponderGrant}
          onResponderRelease={handleHiddenBackgroundResponderRelease}
          onResponderTerminate={handleBackgroundResponderTerminate}
          onStartShouldSetResponder={() => !isScrubbing}
          onTouchStart={handleBackgroundResponderTouchStart}
          style={styles.showTapArea}
        />
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

function LockIcon() {
  return (
    <Svg width={24} height={24} viewBox="0 0 16 16" fill="none">
      <Path
        fill="#FFFFFF"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4 6V4C4 1.79086 5.79086 0 8 0C10.2091 0 12 1.79086 12 4V6H14V16H2V6H4ZM6 4C6 2.89543 6.89543 2 8 2C9.10457 2 10 2.89543 10 4V6H6V4ZM7 13V9H9V13H7Z"
      />
    </Svg>
  );
}

function UnlockIcon() {
  return (
    <Svg width={24} height={24} viewBox="0 0 16 16" fill="none">
      <Path
        fill="#FFFFFF"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.5 2C10.6716 2 10 2.67157 10 3.5V6H13V16H1V6H8V3.5C8 1.567 9.567 0 11.5 0C13.433 0 15 1.567 15 3.5V4H13V3.5C13 2.67157 12.3284 2 11.5 2ZM9 10H5V12H9V10Z"
      />
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
  speedBoostBadge: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(8,12,16,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  speedBoostBadgeText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  loadErrorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 32,
  },
  loadErrorIcon: {
    color: '#fff',
    fontSize: 40,
  },
  loadErrorText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
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
  centerControlStack: {
    alignItems: 'center',
    gap: 16,
  },
  speedControlOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedControlStack: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  speedButton: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: 'rgba(31,111,104,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  speedButtonText: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 32,
    fontWeight: '700',
  },
  speedValueText: {
    minWidth: 52,
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  transportRowSlot: {
    minHeight: 48,
    justifyContent: 'center',
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
  transportRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
    alignItems: 'center',
  },
  lockButton: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    backgroundColor: 'rgba(8,12,16,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
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
  seekBarFileNameWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 78,
  },
  seekBarFileNameText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
});
