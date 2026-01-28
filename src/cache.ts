import * as crypto from 'crypto';

interface CacheEntry {
  hash: string;
  translation: string;
  timestamp: number;
}

export class TranslationCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxAge: number = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Generate a hash for the given content
   */
  private generateHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get cached translation if available and not expired
   */
  get(content: string): string | undefined {
    const hash = this.generateHash(content);
    const entry = this.cache.get(hash);

    if (!entry) {
      return undefined;
    }

    // Check if cache entry is expired
    if (Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(hash);
      return undefined;
    }

    return entry.translation;
  }

  /**
   * Store translation in cache
   */
  set(content: string, translation: string): void {
    const hash = this.generateHash(content);
    this.cache.set(hash, {
      hash,
      translation,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if content is cached
   */
  has(content: string): boolean {
    return this.get(content) !== undefined;
  }

  /**
   * Clear all cached translations
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; entries: number } {
    return {
      size: this.cache.size,
      entries: this.cache.size,
    };
  }
}

// Singleton instance
export const translationCache = new TranslationCache();
