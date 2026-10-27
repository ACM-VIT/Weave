export const README_MEDIA_SCHEMA_VERSION = 2 as const;
export const README_MEDIA_ITEM_LIMIT = 3;
export const README_MEDIA_URL_LIMIT = 2_048;
export const README_MEDIA_ALT_LIMIT = 10_000;
export const README_MEDIA_HASH_LIMIT = 256;
export const README_MEDIA_MANIFEST_BYTE_LIMIT = 1_000_000;

export interface ReadmeMediaImage {
  alt: string;
  url: string;
}

export interface ReadmeMediaManifest {
  schema_version: typeof README_MEDIA_SCHEMA_VERSION;
  content_version: number;
  content_hash: string;
  readme_available: boolean;
  representation: 'deferred' | 'inline_only';
  poster: ReadmeMediaImage | null;
  images: ReadmeMediaImage[];
  videos: string[];
}
