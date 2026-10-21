/** A structured README digest, independent from short card summaries and raw Markdown. */
export interface ReadmeSummaryContent {
  overview: string;
  capabilities: string[];
  use_cases: string[];
  considerations: string[];
}

export interface ReadmeSummaryArtifact extends ReadmeSummaryContent {
  summary_id: string;
  content_version: number;
  content_hash: string;
  prompt_version: string;
  format_version: string;
  model_version: string;
  source: 'generated';
  generated_at: string;
}

export const README_SUMMARY_PROMPT_VERSION = 'readme-digest-v1';
export const README_SUMMARY_FORMAT_VERSION = 'readme-digest-json-v1';
