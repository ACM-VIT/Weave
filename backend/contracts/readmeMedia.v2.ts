export interface ReadmeMediaImage {
  alt: string;
  url: string;
}

export interface ReadmeMediaManifest {
  schema_version: 2;
  content_version: number;
  content_hash: string;
  readme_available: boolean;
  representation: 'deferred' | 'inline_only';
  poster: ReadmeMediaImage | null;
  images: ReadmeMediaImage[];
  videos: string[];
}
