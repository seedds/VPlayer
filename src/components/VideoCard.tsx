import { Image, type ImageProps } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { formatDuration } from '../lib/format';
import type { LibraryItem } from '../lib/types';

type VideoCardProps = {
  durationSeconds?: number;
  isNew: boolean;
  onDelete: () => void;
  onLongPress: () => void;
  onPlay: () => void;
  savedPositionSeconds?: number;
  selected: boolean;
  selectionMode: boolean;
  thumbnailSource?: ImageProps['source'];
  video: LibraryItem;
};

export function VideoCard({
  durationSeconds,
  isNew,
  onDelete,
  onLongPress,
  onPlay,
  savedPositionSeconds,
  selected,
  selectionMode,
  thumbnailSource,
  video,
}: VideoCardProps) {
  const isVideo = video.kind === 'video';
  const playbackProgress =
    isVideo && typeof durationSeconds === 'number' && durationSeconds > 0 && typeof savedPositionSeconds === 'number'
      ? Math.max(0, Math.min(1, savedPositionSeconds / durationSeconds))
      : 0;

  function getPlaceholderLabel(): string {
    if (video.kind === 'folder') {
      return 'Folder';
    }

    if (video.kind === 'subtitle') {
      return 'SRT';
    }

    if (video.kind === 'file') {
      return 'File';
    }

    return 'Video';
  }

  function getMetaText(): string {
    if (video.kind === 'folder') {
      return 'Folder';
    }

    if (video.kind === 'video') {
      return `${formatDuration(savedPositionSeconds)} / ${formatDuration(durationSeconds)}`;
    }

    if (video.kind === 'subtitle') {
      return 'Subtitle file';
    }

    return 'File cannot be played';
  }

  return (
    <Pressable onLongPress={onLongPress} onPress={onPlay} style={({ pressed }) => [styles.card, selected && styles.cardSelected, pressed && styles.cardPressed]}>
      <View style={styles.primaryAction}>
        <View style={styles.thumbnailWrap}>
          {isVideo && thumbnailSource ? (
            <Image contentFit="cover" source={thumbnailSource} style={styles.thumbnail} />
          ) : (
            <View style={styles.thumbnailPlaceholder}>
              <Text style={styles.thumbnailPlaceholderText}>{getPlaceholderLabel()}</Text>
            </View>
          )}
        </View>

        <View style={styles.content}>
          <Text numberOfLines={1} style={styles.title}>
            {video.name}
          </Text>
          <Text numberOfLines={1} style={styles.meta}>
            {getMetaText()}
          </Text>
        </View>
      </View>

      {selectionMode ? (
        <View style={styles.rowActions}>
          <View style={styles.badgeSlot}>
            {isVideo ? (isNew ? <Text style={styles.newLabel}>[new]</Text> : <PlaybackProgressBadge progress={playbackProgress} />) : null}
          </View>
          <View style={styles.actionSlot}>
            <View style={[styles.selectionIndicator, selected && styles.selectionIndicatorActive]}>
              <Text style={[styles.selectionIndicatorText, selected && styles.selectionIndicatorTextActive]}>{selected ? '✓' : ''}</Text>
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.rowActions}>
          <View style={styles.badgeSlot}>
            {isVideo ? (isNew ? <Text style={styles.newLabel}>[new]</Text> : <PlaybackProgressBadge progress={playbackProgress} />) : null}
          </View>
          <View style={styles.actionSlot}>
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              style={({ pressed }) => [styles.deleteButton, pressed && styles.deleteButtonPressed]}
            >
              <Text style={styles.deleteLabel}>Delete</Text>
            </Pressable>
          </View>
        </View>
      )}
    </Pressable>
  );
}

type PlaybackProgressBadgeProps = {
  progress: number;
};

function PlaybackProgressBadge({ progress }: PlaybackProgressBadgeProps) {
  const size = 18;
  const center = size / 2;
  const radius = 8;
  const clampedProgress = Math.max(0, Math.min(1, progress));

  return (
    <View style={styles.progressBadgeWrap}>
      <Svg height={size} width={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={center} cy={center} fill="#f4e7da" r={radius} />
        {clampedProgress >= 1 ? (
          <Circle cx={center} cy={center} fill="#1f6f68" r={radius} />
        ) : clampedProgress > 0 ? (
          <Path d={describePieSlice(center, center, radius, clampedProgress)} fill="#1f6f68" />
        ) : null}
        <Circle cx={center} cy={center} fill="none" r={radius} stroke="#c7b4a5" strokeWidth={1.25} />
      </Svg>
    </View>
  );
}

function describePieSlice(cx: number, cy: number, radius: number, progress: number): string {
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + Math.PI * 2 * progress;
  const startX = cx;
  const startY = cy - radius;
  const endX = cx + radius * Math.cos(endAngle);
  const endY = cy + radius * Math.sin(endAngle);
  const largeArcFlag = progress > 0.5 ? 1 : 0;

  return [`M ${cx} ${cy}`, `L ${startX} ${startY}`, `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY}`, 'Z'].join(' ');
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 20,
    backgroundColor: '#fff9f2',
    borderWidth: 1,
    borderColor: '#ead8c4',
    padding: 6,
  },
  cardPressed: {
    backgroundColor: '#f4e7da',
  },
  cardSelected: {
    borderColor: '#1f6f68',
    backgroundColor: '#eef7f5',
  },
  primaryAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  thumbnailWrap: {
    width: 54,
    height: 46,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#d7ccc1',
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  thumbnailPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1f6f68',
  },
  thumbnailPlaceholderText: {
    color: '#f6f1eb',
    fontSize: 11,
    fontWeight: '700',
  },
  content: {
    flex: 1,
    gap: 4,
  },
  title: {
    color: '#1d1917',
    fontSize: 16,
    fontWeight: '700',
  },
  meta: {
    color: '#6b6158',
    fontSize: 12,
  },
  deleteButton: {
    borderRadius: 14,
    backgroundColor: '#faede7',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badgeSlot: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionSlot: {
    width: 78,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  deleteButtonPressed: {
    opacity: 0.76,
  },
  deleteLabel: {
    color: '#9e3e28',
    fontSize: 13,
    fontWeight: '700',
  },
  newLabel: {
    color: '#1f6f68',
    fontSize: 12,
    fontWeight: '700',
  },
  progressBadgeWrap: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectionIndicator: {
    width: 34,
    height: 30,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: '#d8c7b6',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff8f1',
  },
  selectionIndicatorActive: {
    borderColor: '#1f6f68',
    backgroundColor: '#1f6f68',
  },
  selectionIndicatorText: {
    color: 'transparent',
    fontSize: 16,
    fontWeight: '800',
  },
  selectionIndicatorTextActive: {
    color: '#fff',
  },
});
