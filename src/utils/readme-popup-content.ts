export type ReadmePopupBlock = { kind: 'html'; content: string } | { kind: 'video'; url: string } | { kind: 'image'; url: string; alt: string };

/** Preserve the complete digest; source demos sit between sections, not inside AI prose. */
export function readmePopupBlocks(html: string, videos: readonly string[], summary: boolean, images: readonly {url:string;alt:string}[] = []): ReadmePopupBlock[] {
  const sections = summary ? html.split(/(?=<h[1-3]\b)/i).filter(Boolean) : [html];
  const clips = [...new Set(videos)].slice(0, 3);
  const pictures = summary ? images.filter((item,index)=>images.findIndex(other=>other.url===item.url)===index).slice(0,3) : [];
  const media: ReadmePopupBlock[]=[];
  for(let i=0;i<Math.max(clips.length,pictures.length);i++){
    if(pictures[i])media.push({kind:'image',...pictures[i]});
    if(clips[i])media.push({kind:'video',url:clips[i]});
  }
  const blocks: ReadmePopupBlock[] = [];
  sections.forEach((content, index) => {
    blocks.push({ kind: 'html', content });
    if (summary && media[index]) blocks.push(media[index]);
  });
  for (const item of media.slice(summary ? sections.length : 0)) blocks.push(item);
  return blocks;
}
