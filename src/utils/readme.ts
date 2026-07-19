export const README_MAX_CHARACTERS = 50_000;

export function prepareReadmeForDisplay(readmeText?: string | null): string {
  const content = readmeText?.trim() || 'No README content is available for this repository.';
  if (content.length <= README_MAX_CHARACTERS) return content;
  return `${content.slice(0, README_MAX_CHARACTERS)}\n\n[README truncated for safe display]`;
}
