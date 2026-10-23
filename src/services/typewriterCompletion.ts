/** Bounded session-local completion markers, never persisted to disk. */
export class TypewriterCompletionCache {
  private completed = new Map<string, string>();
  private characters = 0;

  constructor(private readonly maxEntries = 128, private readonly maxCharacters = 64_000) {}

  has(key: string, source: string): boolean {
    if (this.completed.get(key) !== source) return false;
    // Refresh LRU order without retaining additional source versions.
    this.completed.delete(key);
    this.completed.set(key, source);
    return true;
  }

  complete(key: string, source: string): void {
    const previous = this.completed.get(key);
    if (previous !== undefined) this.characters -= key.length + previous.length;
    this.completed.delete(key);
    if (key.length + source.length > this.maxCharacters) return;
    this.completed.set(key, source);
    this.characters += key.length + source.length;
    while (this.completed.size > this.maxEntries || this.characters > this.maxCharacters) {
      const oldest = this.completed.keys().next().value!;
      this.characters -= oldest.length + this.completed.get(oldest)!.length;
      this.completed.delete(oldest);
    }
  }

  clear(): void {
    this.completed.clear();
    this.characters = 0;
  }
}
