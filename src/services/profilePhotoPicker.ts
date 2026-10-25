import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File as NativeFile } from 'expo-file-system';
import { PROFILE_PHOTO_MAX_BYTES, type PickedProfilePhoto } from './profilePhotoFlow';
export async function pickProfilePhoto(): Promise<PickedProfilePhoto | null> {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false,
        allowsEditing: false, quality: 1, exif: false, base64: false,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    });
    if (result.canceled)
        return null;
    const asset = result.assets[0];
    if (!asset)
        throw new Error('No photo was selected.');
    return { uri: asset.uri, file: asset.file, fileSize: asset.fileSize };
}
export async function readProfilePhoto(photo: PickedProfilePhoto): Promise<ArrayBuffer> {
    if (Platform.OS === 'web') {
        if (!photo.file)
            throw new Error('This photo cannot be read. Please choose it again.');
        if (photo.file.size > PROFILE_PHOTO_MAX_BYTES)
            throw new Error('Choose a photo of 5 MiB or smaller.');
        return photo.file.arrayBuffer();
    }
    const file = new NativeFile(photo.uri);
    if (file.size > PROFILE_PHOTO_MAX_BYTES)
        throw new Error('Choose a photo of 5 MiB or smaller.');
    return file.arrayBuffer();
}

/** Web blob URLs are picker-owned. Leave native cache/source file ownership to the OS. */
export function releaseProfilePhoto(photo: PickedProfilePhoto): void {
    if (Platform.OS === 'web' && photo.uri.startsWith('blob:')) URL.revokeObjectURL(photo.uri);
}
