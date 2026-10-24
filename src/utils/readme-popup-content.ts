export type ReadmePopupBlock = { kind: 'html'; content: string } | { kind: 'video'; url: string };

/** Preserve the complete digest; source demos sit between sections, not inside AI prose. */
export function readmePopupBlocks(html: string, videos: readonly string[], summary: boolean): ReadmePopupBlock[] {
  const sections = summary ? html.split(/(?=<h[1-3]\b)/i).filter(Boolean) : [html];
  const media = [...new Set(videos)].slice(0, 3);
  const blocks: ReadmePopupBlock[] = [];
  sections.forEach((content, index) => {
    blocks.push({ kind: 'html', content });
    if (summary && media[index]) blocks.push({ kind: 'video', url: media[index] });
  });
  for (const url of media.slice(summary ? sections.length : 0)) blocks.push({ kind: 'video', url });
  return blocks;
}
