import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

type PromptModalProps = {
  confirmLabel?: string;
  initialValue?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  // Character range to auto-select when the modal opens, so a rename can present
  // the full name with the base (not the extension) highlighted.
  selection?: { start: number; end: number };
  title: string;
  visible: boolean;
};

export function PromptModal({
  confirmLabel = 'Save',
  initialValue = '',
  onCancel,
  onSubmit,
  placeholder,
  selection,
  title,
  visible,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue);
  // Applied once when the modal opens, then cleared on the first edit. Keeping a
  // fixed `selection` prop makes RN re-select the base name after every
  // keystroke, so renaming would only ever replace one character at a time.
  const [activeSelection, setActiveSelection] = useState<{ start: number; end: number } | undefined>(selection);

  // Keyed on the `visible` rising edge only. The parent passes a fresh
  // `selection` object every render, so depending on it (or `initialValue`) would
  // reset the field on any App re-render while the dialog is open — every arriving
  // thumbnail, upload chunk, or IP poll would wipe what the user has typed.
  useEffect(() => {
    if (visible) {
      setValue(initialValue);
      setActiveSelection(selection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const trimmed = value.trim();

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            autoFocus
            onChangeText={(nextValue) => {
              setActiveSelection(undefined);
              setValue(nextValue);
            }}
            onSelectionChange={() => setActiveSelection(undefined)}
            onSubmitEditing={() => {
              if (trimmed) {
                onSubmit(trimmed);
              }
            }}
            placeholder={placeholder}
            placeholderTextColor="#8f857b"
            returnKeyType="done"
            selection={activeSelection}
            style={styles.input}
            value={value}
          />
          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && styles.buttonPressed]}
            >
              <Text style={styles.buttonSecondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={!trimmed}
              onPress={() => onSubmit(trimmed)}
              style={({ pressed }) => [
                styles.button,
                styles.buttonPrimary,
                !trimmed && styles.buttonDisabled,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.buttonPrimaryText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,16,12,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 24,
    backgroundColor: '#fff8f1',
    borderWidth: 1,
    borderColor: '#ead8c4',
    padding: 20,
    gap: 14,
  },
  title: {
    color: '#1d1917',
    fontSize: 19,
    fontWeight: '800',
  },
  input: {
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
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  button: {
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  buttonSecondary: {
    backgroundColor: '#e3d7ca',
  },
  buttonPrimary: {
    backgroundColor: '#c6673d',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.78,
  },
  buttonSecondaryText: {
    color: '#4f463f',
    fontSize: 14,
    fontWeight: '700',
  },
  buttonPrimaryText: {
    color: '#fff7f2',
    fontSize: 14,
    fontWeight: '700',
  },
});
