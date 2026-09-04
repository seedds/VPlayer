import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getParentPath, listLibraryItems } from '../lib/videoLibrary';
import type { FolderItem, LibraryItem } from '../lib/types';

type FolderPickerModalProps = {
  // The items being moved: used to disable their current parent (a no-op) and to
  // stop a folder being moved into itself or its own subtree.
  movingItems: LibraryItem[];
  onCancel: () => void;
  onPick: (destinationPath: string | null) => void;
  visible: boolean;
};

export function FolderPickerModal({ movingItems, onCancel, onPick, visible }: FolderPickerModalProps) {
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Ignores results from a superseded load: tapping into a subfolder then up
  // quickly could otherwise land the slower response last and show the wrong
  // folder's contents under the right title.
  const loadRequestIdRef = useRef(0);

  // A move's items always share one parent (selection is within a single folder),
  // which is a no-op destination.
  const sourceParentPath = movingItems[0]?.parentPath ?? null;

  const movingFolderPaths = movingItems
    .filter((item): item is FolderItem => item.kind === 'folder')
    .map((item) => item.relativePath);

  const loadFolders = useCallback(async (path: string | null) => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    setLoading(true);

    try {
      const items = await listLibraryItems(path);

      if (loadRequestIdRef.current !== requestId) {
        return;
      }

      setFolders(items.filter((item): item is FolderItem => item.kind === 'folder'));
    } catch {
      if (loadRequestIdRef.current === requestId) {
        setFolders([]);
      }
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }

    setBrowsePath(null);
    void loadFolders(null);
  }, [loadFolders, visible]);

  function isInsideMovedSubtree(path: string | null): boolean {
    if (!path) {
      return false;
    }

    return movingFolderPaths.some((folderPath) => path === folderPath || path.startsWith(`${folderPath}/`));
  }

  const currentIsSource = (browsePath ?? null) === sourceParentPath;
  const currentIsInsideMovedSubtree = isInsideMovedSubtree(browsePath);
  const canMoveHere = !currentIsSource && !currentIsInsideMovedSubtree;
  const browseFolderName = browsePath ? (browsePath.split('/').pop() ?? 'Library') : 'Library';

  function openFolder(folder: FolderItem) {
    setBrowsePath(folder.relativePath);
    void loadFolders(folder.relativePath);
  }

  function goUp() {
    const parent = getParentPath(browsePath);
    setBrowsePath(parent);
    void loadFolders(parent);
  }

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Pressable onPress={onCancel} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
              <Text style={styles.headerButtonText}>Cancel</Text>
            </Pressable>
            <Text numberOfLines={1} style={styles.headerTitle}>
              {browseFolderName}
            </Text>
            <Pressable
              disabled={!canMoveHere}
              onPress={() => onPick(browsePath ?? null)}
              style={({ pressed }) => [
                styles.headerButton,
                styles.headerButtonPrimary,
                !canMoveHere && styles.headerButtonDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.headerButtonText, styles.headerButtonPrimaryText]}>Move Here</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
            {browsePath ? (
              <Pressable onPress={goUp} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <Text style={styles.rowIcon}>{'\u2190'}</Text>
                <Text style={styles.rowText}>..</Text>
              </Pressable>
            ) : null}

            {loading ? (
              <View style={styles.loading}>
                <ActivityIndicator color="#1f6f68" size="large" />
              </View>
            ) : folders.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>No folders here.</Text>
              </View>
            ) : (
              folders.map((folder) => {
                const disabled = isInsideMovedSubtree(folder.relativePath);

                return (
                  <Pressable
                    disabled={disabled}
                    key={folder.uri}
                    onPress={() => openFolder(folder)}
                    style={({ pressed }) => [styles.row, disabled && styles.rowDisabled, pressed && styles.rowPressed]}
                  >
                    <Text style={styles.rowIcon}>{'\uD83D\uDCC1'}</Text>
                    <Text numberOfLines={1} style={styles.rowText}>
                      {folder.name}
                    </Text>
                    <Text style={styles.rowChevron}>{'\u203A'}</Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>

          <Text style={styles.footerHint}>
            {currentIsSource
              ? 'Items are already in this folder.'
              : currentIsInsideMovedSubtree
                ? 'A folder cannot be moved into itself.'
                : `Move here into "${browseFolderName}".`}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,16,12,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '82%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: '#efe7db',
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#ded1c2',
  },
  headerButton: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#e3d7ca',
  },
  headerButtonPrimary: {
    backgroundColor: '#1f6f68',
  },
  headerButtonDisabled: {
    opacity: 0.4,
  },
  headerButtonText: {
    color: '#4f463f',
    fontSize: 14,
    fontWeight: '700',
  },
  headerButtonPrimaryText: {
    color: '#fff',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: '#1d1917',
    fontSize: 16,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.78,
  },
  list: {
    paddingVertical: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e0d3c4',
  },
  rowPressed: {
    backgroundColor: '#e6ddd2',
  },
  rowDisabled: {
    opacity: 0.4,
  },
  rowIcon: {
    fontSize: 18,
  },
  rowText: {
    flex: 1,
    color: '#1d1917',
    fontSize: 16,
    fontWeight: '600',
  },
  rowChevron: {
    color: '#8f857b',
    fontSize: 20,
  },
  loading: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  emptyState: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  emptyStateText: {
    color: '#70665d',
    fontSize: 15,
  },
  footerHint: {
    paddingHorizontal: 20,
    paddingTop: 12,
    color: '#70665d',
    fontSize: 13,
    textAlign: 'center',
  },
});
