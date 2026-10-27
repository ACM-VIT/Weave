export interface ReadmeMediaImage {
  alt: string;
  url: string;
}

export interface ReadmeMediaManifest {
  schema_version: 1;
  content_version: number;
  content_hash: string;
  readme_available: boolean;
  poster: ReadmeMediaImage | null;
  images: ReadmeMediaImage[];
  videos: string[];
}
