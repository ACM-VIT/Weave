import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { authSessionLifecycle } from '@/api/session-lifecycle';
import { uploadProfileAvatar } from '@/api/profile-avatar';
import { createProfilePhotoFlow, profilePhotoRecovery, type PhotoState } from '@/services/profilePhotoFlow';
import { pickProfilePhoto, readProfilePhoto, releaseProfilePhoto } from '@/services/profilePhotoPicker';
import { useAuth } from '@/store/AuthContext';
export function ProfilePhotoEditor({ owner, onClose }: {
    owner: string;
    onClose: () => void;
}) {
    const auth = useAuth(), authRef = useRef(auth), closeRef = useRef(onClose), mounted = useRef(true);
    useEffect(() => { authRef.current = auth; closeRef.current = onClose; }, [auth, onClose]);
    const [state, setState] = useState<PhotoState>({ status: 'idle' }), [checking, setChecking] = useState(false);
    const flowRef = useRef<ReturnType<typeof createProfilePhotoFlow> | null>(null);
    useEffect(() => {
        mounted.current = true;
        const generation = authSessionLifecycle.currentGeneration();
        profilePhotoRecovery.useSession(generation);
        const flow = createProfilePhotoFlow({
            recovery: profilePhotoRecovery, scope: `${owner}:${generation}`,
            isSessionCurrent: () => authSessionLifecycle.isCurrent(generation),
            release: releaseProfilePhoto,
            reconcile: () => authRef.current.checkOnboardingStatus({ owner, generation }),
            isCurrent: () => mounted.current && authSessionLifecycle.isCurrent(generation), pick: pickProfilePhoto, read: readProfilePhoto,
            upload: (bytes, signal) => uploadProfileAvatar(owner, bytes, authRef.current.user?.profile_version, signal),
            apply: saved => authRef.current.applySavedAvatar(owner, generation, saved),
            state: next => { if (mounted.current) {
                setState(next);
                if (next.status === 'saved')
                    closeRef.current();
            } },
        });
        flowRef.current = flow;
        const unsubscribe = authSessionLifecycle.subscribe(() => { if (!authSessionLifecycle.isCurrent(generation)) {
            flow.retire();
            closeRef.current();
        } });
        return () => { mounted.current = false; unsubscribe(); flow.dispose(); flowRef.current = null; };
    }, [owner]);
    const close = () => { if (!mounted.current || !flowRef.current?.isCurrent()) return; flowRef.current.cancel(); closeRef.current(); };
    const busy = state.status === 'picking' || state.status === 'uploading' || checking;
    const checkSaved = async () => {
        if (!flowRef.current?.isCurrent())
            return;
        const generation = authSessionLifecycle.currentGeneration();
        setChecking(true);
        try {
            const checked = await flowRef.current.reconcile();
            if (checked && mounted.current && authSessionLifecycle.isCurrent(generation))
                closeRef.current();
        }
        catch {
            if (mounted.current && authSessionLifecycle.isCurrent(generation))
                setState(current => ({ ...current, message: 'Unable to check your saved photo. Try checking again when connected.' }));
        }
        finally {
            if (mounted.current && authSessionLifecycle.isCurrent(generation))
                setChecking(false);
        }
    };
    return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
  <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
   <Text accessibilityRole="header" className="font-nataBold" style={styles.heading}>Profile photo</Text>
   <Text className="font-nata" style={styles.copy}>JPEG, PNG or still WebP · up to 5 MiB. No animated images.</Text>
   <Text className="font-nata" style={styles.copy}>Anyone with the image link can view your uploaded profile photo.</Text>
   {state.uri ? <Image accessibilityLabel="Selected profile photo preview" source={{ uri: state.uri }} style={styles.preview}/> : null}
   {state.message ? <Text accessibilityRole="alert" style={styles.error}>{state.message}</Text> : null}
   {busy ? <View accessibilityRole="progressbar" accessibilityLabel={checking ? 'Checking saved photo' : state.status === 'picking' ? 'Reading photo' : 'Saving photo'} style={styles.progress}><ActivityIndicator color="#63E08A"/><Text style={styles.copy}>{checking ? 'Checking saved photo…' : state.status === 'picking' ? 'Choose a photo…' : 'Saving photo… Closing does not undo an upload already sent.'}</Text></View> : null}
   <Pressable disabled={busy || state.uncertain} accessibilityRole="button" accessibilityLabel="Choose profile photo" accessibilityState={{ disabled: busy || Boolean(state.uncertain) }} onPress={() => void flowRef.current?.select()} style={[styles.button, (busy || state.uncertain) && styles.disabled]}><Text style={styles.buttonText}>{state.uri ? 'Choose another photo' : 'Choose photo'}</Text></Pressable>
   {state.status === 'ready' ? <Pressable accessibilityRole="button" accessibilityLabel="Save profile photo" onPress={() => void flowRef.current?.save()} style={[styles.button, styles.primary]}><Text style={styles.primaryText}>Save photo</Text></Pressable> : null}
   {state.uncertain ? <Pressable disabled={checking} accessibilityRole="button" accessibilityLabel="Check saved profile photo" onPress={() => void checkSaved()} style={styles.button}><Text style={styles.buttonText}>Check saved photo</Text></Pressable> : null}
   <Pressable accessibilityRole="button" accessibilityLabel="Cancel photo change" onPress={close} style={styles.button}><Text style={styles.buttonText}>{state.status === 'uploading' ? 'Close' : 'Cancel'}</Text></Pressable>
  </ScrollView>
 </Modal>;
}
const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: '#080808' }, content: { padding: 24, paddingTop: 48, paddingBottom: 48, gap: 18, maxWidth: 600, width: '100%', alignSelf: 'center' },
    heading: { color: '#fff', fontSize: 27 }, copy: { color: '#b8b8c0', fontSize: 15, lineHeight: 23 }, error: { color: '#ff6878', fontSize: 15, lineHeight: 23 },
    preview: { width: 180, height: 180, borderRadius: 90, alignSelf: 'center' }, progress: { gap: 10, alignItems: 'center' },
    button: { minHeight: 48, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: '#34343a', alignItems: 'center', justifyContent: 'center' },
    buttonText: { color: '#fff', fontSize: 16 }, primary: { backgroundColor: '#63e08a' }, primaryText: { color: '#071009', fontSize: 16, fontWeight: '700' }, disabled: { opacity: 0.5 },
});
