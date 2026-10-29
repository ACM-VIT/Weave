export const PROFILE_PHOTO_MAX_BYTES = 5_242_880;
export type PickedProfilePhoto = { uri: string; file?: File; fileSize?: number };
export type SavedPhoto = { avatar_url: string; profile_version: string };
export type PhotoState = { status: 'idle'|'picking'|'ready'|'uploading'|'saved'|'error'; uri?: string; message?: string; uncertain?: boolean };
/** Mutation outcomes outlive the editor, but never their authentication generation. */
export class ProfilePhotoRecovery {
    private states = new Map<string, 'pending'|'uncertain'>();
    private generation: number | undefined;
    useSession(generation: number) {
        if (this.generation !== generation) { this.states.clear(); this.generation = generation; }
    }
    status(scope: string) { return this.states.get(scope); }
    begin(scope: string) {
        if (this.states.has(scope)) return false;
        this.states.set(scope, 'pending'); return true;
    }
    unknown(scope: string) { this.states.set(scope, 'uncertain'); }
    clear(scope: string) { this.states.delete(scope); }
}
export const profilePhotoRecovery = new ProfilePhotoRecovery();
const uncertainMessage = 'The upload could not be confirmed. Check your saved profile photo before trying again.';
export function createProfilePhotoFlow(ports: {
    isCurrent(): boolean;
    isSessionCurrent?(): boolean;
    recovery?: ProfilePhotoRecovery;
    scope?: string;
    pick(): Promise<PickedProfilePhoto|null>;
    read(photo: PickedProfilePhoto): Promise<ArrayBuffer>;
    release?(photo: PickedProfilePhoto): void;
    upload(bytes: ArrayBuffer, signal: AbortSignal): Promise<SavedPhoto>;
    reconcile?(): Promise<void>;
    apply(saved: SavedPhoto): void;
    state(value: PhotoState): void;
}) {
    const recovery = ports.recovery ?? new ProfilePhotoRecovery(), scope = ports.scope ?? 'local';
    let operation = 0, bytes: ArrayBuffer|undefined, uri: string|undefined, busy = false, disposed = false;
    let controller: AbortController|undefined, selected: PickedProfilePhoto|undefined;
    const current = () => !disposed && ports.isCurrent();
    const valid = (id: number) => id === operation && current();
    const sessionCurrent = () => (ports.isSessionCurrent ?? ports.isCurrent)();
    function release(photo = selected) {
        if (photo) { try { ports.release?.(photo); } catch { /* Cleanup never changes a mutation outcome. */ } }
        if (photo === selected) selected = undefined;
    }
    function cancel(notify = true) {
        operation++; controller?.abort(); controller = undefined; bytes = undefined; uri = undefined; busy = false; release();
        if (notify && current()) ports.state(recovery.status(scope)
            ? { status: 'error', uncertain: true, message: uncertainMessage } : { status: 'idle' });
    }
    if (recovery.status(scope) && current()) ports.state({ status: 'error', uncertain: true, message: uncertainMessage });
    return {
        cancel,
        dispose() { disposed = true; cancel(false); },
        retire() { recovery.clear(scope); disposed = true; cancel(false); },
        isCurrent: current,
        async reconcile(): Promise<boolean> {
            if (!current() || busy || !ports.reconcile) return false;
            if (recovery.status(scope) === 'pending') {
                ports.state({ status: 'error', uncertain: true, message: 'The previous upload is still finishing. Check again shortly.' }); return false;
            }
            const id = operation; busy = true;
            try {
                await ports.reconcile();
                if (!valid(id) || recovery.status(scope) === 'pending') return false;
                recovery.clear(scope); ports.state({ status: 'idle' }); return true;
            } catch {
                if (valid(id)) ports.state({ status: 'error', uncertain: true, message: 'Unable to check your saved photo. Try checking again when connected.' });
                return false;
            } finally { if (valid(id)) busy = false; }
        },
        async select() {
            if (busy || !current() || recovery.status(scope)) return;
            cancel(false); const id = operation; busy = true; ports.state({ status: 'picking' });
            let chosen: PickedProfilePhoto | undefined;
            try {
                const picked = await ports.pick();
                if (!valid(id)) { if (picked) release(picked); return; }
                if (!picked) { ports.state({ status: 'idle' }); return; }
                selected = picked; chosen = picked;
                if (picked.fileSize !== undefined && picked.fileSize > PROFILE_PHOTO_MAX_BYTES) throw new Error('Choose a photo of 5 MiB or smaller.');
                const data = await ports.read(picked);
                if (!valid(id)) return;
                if (!data.byteLength || data.byteLength > PROFILE_PHOTO_MAX_BYTES) throw new Error('Choose a photo of 5 MiB or smaller.');
                const b = new Uint8Array(data), ascii = (start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
                const allowed = (b[0] === 255 && b[1] === 216 && b[2] === 255) || (b[0] === 137 && ascii(1, 4) === 'PNG') || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP');
                if (!allowed) throw new Error('Choose a JPEG, PNG, or still WebP image.');
                bytes = data; uri = picked.uri; ports.state({ status: 'ready', uri });
            } catch (error) {
                if (chosen) release(chosen);
                if (valid(id)) ports.state({ status: 'error', message: error instanceof Error ? error.message : 'Unable to read this photo.' });
            } finally { if (valid(id)) busy = false; }
        },
        async save() {
            if (busy || !bytes || !current() || !recovery.begin(scope)) return;
            const id = operation; busy = true; controller = new AbortController(); ports.state({ status: 'uploading', uri });
            try {
                const saved = await ports.upload(bytes, controller.signal);
                recovery.clear(scope);
                if (!valid(id)) return;
                ports.apply(saved); bytes = undefined; ports.state({ status: 'saved', uri });
            } catch (error) {
                const status = (error as { status?: number })?.status;
                const needsCheck = status === 409 || status === 428;
                const definite = typeof status === 'number' && [400,401,403,404,409,413,415,428,429].includes(status);
                if ((!needsCheck && definite) || !sessionCurrent()) recovery.clear(scope); else recovery.unknown(scope);
                if (valid(id)) {
                    bytes = undefined;
                    ports.state({ status: 'error', uri, uncertain: needsCheck || !definite, message: definite && error instanceof Error ? error.message : uncertainMessage });
                }
            } finally { if (valid(id)) busy = false; }
        },
    };
}
export function validateSavedPhoto(value:unknown,owner:string):SavedPhoto {
 if(!value||typeof value!=='object')throw new Error('The saved photo could not be confirmed.');
 const data=value as Record<string,unknown>;
 if(data.user_id!==owner||typeof data.avatar_url!=='string'||typeof data.profile_version!=='string'||!/^[1-9][0-9]{0,18}$/.test(data.profile_version))throw new Error('The saved photo could not be confirmed.');
 const url=new URL(data.avatar_url);
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('The saved photo could not be confirmed.');
 return{avatar_url:data.avatar_url,profile_version:data.profile_version};
}

export function photoVersionHeader(value: unknown): string {
    const version = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
    if (!/^[1-9][0-9]{0,18}$/.test(version)) throw Object.assign(new Error('Check your current profile before uploading a photo.'), { status: 428 });
    return `"${version}"`;
}
