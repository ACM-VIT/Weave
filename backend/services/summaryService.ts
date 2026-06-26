export function summarizeReadme(readmeText: string | null | undefined): string {
  if (!readmeText) {
    return "No README available.";
  }

  const cleanText = readmeText
    .replace(/[#>*`~-]/g, "")
    .replace(/\r/g, "")
    .trim();

  const paragraphs = cleanText
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return paragraphs.slice(0, 2).join("\n\n").substring(0, 1000);
}
