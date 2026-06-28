import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Flame } from "lucide-react-native";
import { fonts } from "@/constants/colors";

interface SavePopupProps {
  isVisible: boolean;
  onClose: () => void;
}

const palette = {
  sheet: "#0B130B",
  sheetBorder: "#84FF70",
  row: "#252E24",
  rowDark: "#131513",
  text: "#FFF7FF",
  muted: "#757575",
  accent: "#84FF70",
  button: "#70AB63",
  buttonText: "#0B130B",
  flameBg: "rgba(208, 176, 0, 0.2)",
  flame: "#F5C84D",
  overlay: "rgba(15, 23, 1, 0.6)",
} as const;

// ─── Session-persistent state (survives popup open/close) ────────────────────
// Collections the user has created are kept here so they don't vanish on
// every reopen. The selected collection also persists.
let _sessionCollections = ["AI Projects", "Web Development", "Open Source", "Inspiration"];
let _sessionSelected = _sessionCollections[0];

export function SavePopup({ isVisible, onClose }: SavePopupProps) {
  // Mirror session state into component state so React re-renders properly
  const [collections, setCollections] = useState<string[]>(_sessionCollections);
  const [selected, setSelectedState] = useState<string>(_sessionSelected);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [saved, setSaved] = useState(false);

  const slide = useRef(new Animated.Value(1)).current;
  const fade = useRef(new Animated.Value(0)).current;

  // Helper that also keeps the module-level ref in sync
  const setSelected = (name: string) => {
    _sessionSelected = name;
    setSelectedState(name);
  };

  // Reset transient UI state every time the popup opens
  useEffect(() => {
    if (isVisible) {
      // Sync from session (in case collections were added while closed)
      setCollections([..._sessionCollections]);
      setSelectedState(_sessionSelected);
      setIsCreating(false);
      setNewName("");
      setSaved(false);

      slide.setValue(1);
      fade.setValue(0);

      Animated.parallel([
        Animated.timing(slide, {
          toValue: 0,
          duration: 280,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(fade, {
          toValue: 1,
          duration: 200,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  const translateY = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 480],
  });

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(slide, {
        toValue: 1,
        duration: 220,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 0,
        duration: 170,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) onClose();
    });
  };

  // ── Save (also creates the collection if the input is open) ─────────────
  const handleSave = () => {
    if (isCreating) {
      const name = newName.trim();
      if (name) {
        // Create & select the typed collection first
        if (!_sessionCollections.includes(name)) {
          _sessionCollections = [..._sessionCollections, name];
        }
        setCollections([..._sessionCollections]);
        setSelected(name);
      }
      setIsCreating(false);
      setNewName("");
    }
    setSaved(true);
    setTimeout(dismiss, 700);
  };

  if (!isVisible) return null;

  return (
    <View pointerEvents="box-none" style={styles.root}>
      {/* Dimmed backdrop */}
      <Pressable
        accessibilityLabel="Close save repository sheet"
        onPress={dismiss}
        style={StyleSheet.absoluteFill}
      >
        <Animated.View style={[styles.overlay, { opacity: fade }]} />
      </Pressable>

      {/* Bottom sheet */}
      <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
        {/* Header */}
        <View style={styles.titleRow}>
          <View>
            <Text style={styles.title}>Save Repository</Text>
            <Text style={styles.subtitle}>Choose a collection</Text>
          </View>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            hitSlop={14}
            onPress={dismiss}
            style={styles.closeButton}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        {/* Collection list */}
        <ScrollView
          style={styles.collectionsScroll}
          contentContainerStyle={styles.collections}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {collections.map((col) => {
            const isSelected = col === selected;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: isSelected }}
                key={col}
                onPress={() => setSelected(col)}
                style={({ pressed }) => [
                  styles.collectionRow,
                  pressed && styles.pressedRow,
                ]}
              >
                {/* Flame icon thumbnail */}
                <View style={styles.thumbnail}>
                  <Flame
                    color={palette.flame}
                    fill={palette.flame}
                    size={19}
                    strokeWidth={1.8}
                  />
                </View>

                <Text style={styles.collectionName} numberOfLines={1}>
                  {col}
                </Text>

                {/* Radio indicator */}
                <View style={[styles.radio, isSelected && styles.radioSelected]}>
                  {isSelected && <View style={styles.radioInner} />}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Create new collection */}
        {isCreating ? (
          <View style={styles.createInputWrap}>
            <TextInput
              autoFocus
              maxLength={40}
              onChangeText={setNewName}
              onSubmitEditing={handleSave}
              placeholder="Collection name…"
              placeholderTextColor={palette.muted}
              returnKeyType="done"
              style={styles.createInput}
              value={newName}
            />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setIsCreating(true)}
            style={({ pressed }) => [
              styles.createButton,
              pressed && styles.createPressed,
            ]}
          >
            <Text style={styles.createText}>+ Create new collection</Text>
          </Pressable>
        )}

        {/* Save button */}
        <Pressable
          accessibilityRole="button"
          disabled={saved}
          onPress={handleSave}
          style={({ pressed }) => [
            styles.saveButton,
            saved && styles.saveButtonSaved,
            pressed && !saved && styles.savePressed,
          ]}
        >
          <Text style={styles.saveText}>
            {saved ? "Saved ✓" : `Save to ${ isCreating && newName.trim() ? newName.trim() : selected } `}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "flex-end",
    zIndex: 100,
  },
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: palette.overlay,
    ...Platform.select({
      web: { backdropFilter: "blur(4px)" },
    }),
  },
  sheet: {
    backgroundColor: palette.sheet,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: palette.sheetBorder,
    paddingTop: 20,
    paddingBottom: 28,
    paddingHorizontal: 20,
    width: "100%",
    maxHeight: "85%",
  },

  // ── Header ──────────────────────────────────────────────────────────────
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  title: {
    color: palette.text,
    fontFamily: fonts.bold,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 26,
  },
  subtitle: {
    color: palette.muted,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 2,
  },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: {
    color: palette.muted,
    fontSize: 26,
    fontWeight: "300",
    lineHeight: 28,
  },

  // ── Collection list ──────────────────────────────────────────────────────
  collectionsScroll: {
    flexGrow: 0,
    maxHeight: 300,
  },
  collections: {
    gap: 10,
    marginTop: 14,
    paddingBottom: 4,
  },
  collectionRow: {
    alignItems: "center",
    backgroundColor: palette.rowDark,
    borderColor: palette.accent,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    height: 56,
    paddingLeft: 8,
    paddingRight: 16,
  },
  pressedRow: {
    opacity: 0.82,
  },
  thumbnail: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: palette.flameBg,
    alignItems: "center",
    justifyContent: "center",
  },
  collectionName: {
    flex: 1,
    color: palette.text,
    fontFamily: fonts.medium,
    fontSize: 16,
    fontWeight: "500",
    marginLeft: 14,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: palette.muted,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: {
    borderColor: palette.accent,
    backgroundColor: "rgba(132,255,112,0.15)",
  },
  radioInner: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: palette.accent,
  },

  // ── Create new collection ────────────────────────────────────────────────
  createButton: {
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    marginTop: 12,
  },
  createPressed: {
    opacity: 0.75,
  },
  createText: {
    color: palette.accent,
    fontFamily: fonts.medium,
    fontSize: 15,
    fontWeight: "600",
  },
  createInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: palette.row,
    borderColor: palette.accent,
    borderRadius: 10,
    borderWidth: 1,
    height: 50,
    marginTop: 12,
    paddingHorizontal: 12,
    gap: 8,
  },
  createInput: {
    flex: 1,
    color: palette.text,
    fontFamily: fonts.regular,
    fontSize: 15,
    paddingVertical: 0,
    height: "100%",
  },
  createConfirm: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: palette.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtn: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 16,
  },

  // ── Save button ──────────────────────────────────────────────────────────
  saveButton: {
    alignItems: "center",
    backgroundColor: palette.button,
    borderRadius: 30,
    height: 52,
    justifyContent: "center",
    marginTop: 20,
    width: "100%",
  },
  saveButtonSaved: {
    backgroundColor: "#3A6B35",
  },
  savePressed: {
    opacity: 0.88,
  },
  saveText: {
    color: palette.text,
    fontFamily: fonts.bold,
    fontSize: 16,
    fontWeight: "700",
  },
});
