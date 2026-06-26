import React, { useEffect, useMemo, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Check, Plus, X } from 'lucide-react-native';
import { getResponsiveContainerStyle } from '@/components/responsive-layout';

interface SavePopupProps {
  isVisible: boolean;
  onClose: () => void;
}

const INITIAL_COLLECTIONS = ['AI Projects', 'Web Development', 'Open Source', 'Inspiration'];

export function SavePopup({ isVisible, onClose }: SavePopupProps) {
  const { width } = useWindowDimensions();
  const responsiveSheetStyle = getResponsiveContainerStyle(width);
  const [selected, setSelected] = useState('AI Projects');
  const [collections, setCollections] = useState(INITIAL_COLLECTIONS);
  const [isCreating, setIsCreating] = useState(false);
  const [newCollection, setNewCollection] = useState('');
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');
  const translateY = useMemo(() => new Animated.Value(340), []);
  const opacity = useMemo(() => new Animated.Value(0), []);
  const [touchStartX, setTouchStartX] = useState(0);

  const handleTouchStart = (e: any) => {
    setTouchStartX(e.nativeEvent.pageX);
  };

  const handleTouchEnd = (e: any) => {
    const touchEndX = e.nativeEvent.pageX;
    const deltaX = touchEndX - touchStartX;
    if (deltaX < -50) {
      closeAnimated();
    }
  };

  useEffect(() => {
    if (isVisible) {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 0,
          duration: 280,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isVisible, opacity, translateY]);

  const closeAnimated = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 340,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) return;
      setStatus('idle');
      setIsCreating(false);
      setNewCollection('');
      onClose();
    });
  };

  const createCollection = () => {
    const name = newCollection.trim();
    if (!name) return;
    if (!collections.includes(name)) {
      setCollections((current) => [...current, name]);
    }
    setSelected(name);
    setIsCreating(false);
    setNewCollection('');
  };

  const saveRepository = () => {
    setStatus('saved');
    setTimeout(closeAnimated, 450);
  };

  if (!isVisible) return null;

  return (
    <View style={styles.root}>
      <Pressable style={StyleSheet.absoluteFill} onPress={closeAnimated}>
        <Animated.View style={[styles.overlay, { opacity }]} />
      </Pressable>
      <Animated.View
        style={[styles.sheet, responsiveSheetStyle, { transform: [{ translateY }] }]}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Save Repository</Text>
            <Text style={styles.subtitle}>Choose a collection</Text>
          </View>
          <Pressable onPress={closeAnimated} style={styles.closeButton}>
            <X size={28} color="#A49898" strokeWidth={1.4} />
          </Pressable>
        </View>

        <View style={styles.list}>
          {collections.map((name) => {
            const active = selected === name;
            return (
              <Pressable
                key={name}
                onPress={() => setSelected(name)}
                style={({ pressed }) => [
                  styles.collectionRow,
                  active && styles.collectionRowActive,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={styles.thumbnail}>
                  <View style={styles.thumbGlow} />
                  <View style={styles.thumbCore} />
                </View>
                <Text style={styles.collectionName}>{name}</Text>
                <View style={[styles.radio, active && styles.radioActive]}>
                  {active ? <View style={styles.radioDot} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>

        {isCreating ? (
          <View style={styles.createInputRow}>
            <TextInput
              autoFocus
              value={newCollection}
              onChangeText={setNewCollection}
              onSubmitEditing={createCollection}
              placeholder="Collection name"
              placeholderTextColor="#757575"
              style={styles.createInput}
            />
            <Pressable onPress={createCollection} style={styles.createSubmit}>
              <Check size={18} color="#FFFFFF" />
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setIsCreating(true)}
            style={({ pressed }) => [styles.createButton, pressed && styles.rowPressed]}
          >
            <Plus size={16} color="#D9D9D9" strokeWidth={2.5} />
            <Text style={styles.createText}>Create new collection</Text>
          </Pressable>
        )}

        <Pressable
          onPress={saveRepository}
          style={({ pressed }) => [styles.saveButton, pressed && styles.savePressed]}
        >
          <Text style={styles.saveText}>
            {status === 'saved' ? 'Saved!' : `Save to ${selected}`}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    zIndex: 50,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: '#131513',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: '#6DA963',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 27,
    minHeight: 462,
    width: '100%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 21,
  },
  title: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Bold',
    fontSize: 21,
    lineHeight: 27,
  },
  subtitle: {
    color: '#D9D9D9',
    fontFamily: 'NataSans-Regular',
    fontSize: 16,
    lineHeight: 21,
  },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    gap: 10,
  },
  collectionRow: {
    height: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#6DA963',
    backgroundColor: '#151714',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  collectionRowActive: {
    backgroundColor: '#273126',
  },
  rowPressed: {
    opacity: 0.75,
  },
  thumbnail: {
    width: 38,
    height: 38,
    borderRadius: 6,
    backgroundColor: '#10150F',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  thumbGlow: {
    position: 'absolute',
    width: 35,
    height: 35,
    borderRadius: 18,
    backgroundColor: '#F5C54D',
    opacity: 0.28,
  },
  thumbCore: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: '#F5C54D',
  },
  collectionName: {
    flex: 1,
    color: '#FFFFFF',
    fontFamily: 'NataSans-Regular',
    fontSize: 19,
    lineHeight: 24,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#757575',
    backgroundColor: 'rgba(28,28,28,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  radioActive: {
    borderColor: '#6DA963',
  },
  radioDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#6DA963',
  },
  createButton: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  createText: {
    color: '#D9D9D9',
    fontFamily: 'NataSans-Bold',
    fontSize: 18,
    lineHeight: 23,
  },
  createInputRow: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  createInput: {
    flex: 1,
    height: 42,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#6DA963',
    color: '#FFFFFF',
    fontFamily: 'NataSans-Regular',
    fontSize: 16,
    paddingHorizontal: 12,
  },
  createSubmit: {
    width: 42,
    height: 42,
    borderRadius: 8,
    backgroundColor: '#6DA963',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButton: {
    height: 49,
    borderRadius: 8,
    backgroundColor: '#6DA963',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 3,
  },
  savePressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  saveText: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Bold',
    fontSize: 18,
    lineHeight: 24,
  },
});
