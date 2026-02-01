import * as crypto from 'crypto';

interface CacheEntry {
  hash: string;
  translation: string;
  timestamp: number;
}

interface BlockCacheEntry {
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
    this.blockCache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; entries: number; blockEntries: number } {
    return {
      size: this.cache.size,
      entries: this.cache.size,
      blockEntries: this.blockCache.size,
    };
  }

  // =====================================================
  // Block-based caching
  // =====================================================

  /**
   * Block cache: sourceHash -> (targetLanguage -> translation)
   */
  private blockCache: Map<string, Map<string, BlockCacheEntry>> = new Map();

  /**
   * Get cached block translation by source hash and target language
   */
  getBlock(sourceHash: string, targetLanguage: string): string | undefined {
    const langMap = this.blockCache.get(sourceHash);
    if (!langMap) {
      return undefined;
    }

    const entry = langMap.get(targetLanguage);
    if (!entry) {
      return undefined;
    }

    // Check if cache entry is expired
    if (Date.now() - entry.timestamp > this.maxAge) {
      langMap.delete(targetLanguage);
      if (langMap.size === 0) {
        this.blockCache.delete(sourceHash);
      }
      return undefined;
    }

    return entry.translation;
  }

  /**
   * Store block translation in cache
   */
  setBlock(sourceHash: string, targetLanguage: string, translation: string): void {
    let langMap = this.blockCache.get(sourceHash);
    if (!langMap) {
      langMap = new Map();
      this.blockCache.set(sourceHash, langMap);
    }

    langMap.set(targetLanguage, {
      translation,
      timestamp: Date.now(),
    });
  }

  /**
   * Get translations for multiple blocks at once
   */
  getBlocks(sourceHashes: string[], targetLanguage: string): Map<string, string> {
    const result = new Map<string, string>();

    for (const hash of sourceHashes) {
      const translation = this.getBlock(hash, targetLanguage);
      if (translation !== undefined) {
        result.set(hash, translation);
      }
    }

    return result;
  }

  /**
   * Store multiple block translations at once
   */
  setBlocks(translations: Map<string, string>, targetLanguage: string): void {
    for (const [hash, translation] of translations) {
      this.setBlock(hash, targetLanguage, translation);
    }
  }

  /**
   * Check if a block is cached
   */
  hasBlock(sourceHash: string, targetLanguage: string): boolean {
    return this.getBlock(sourceHash, targetLanguage) !== undefined;
  }

  /**
   * Clear only block cache
   */
  clearBlockCache(): void {
    this.blockCache.clear();
  }
}

// Singleton instance
export const translationCache = new TranslationCache();
