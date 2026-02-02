import * as vscode from 'vscode';
import { ParsedDocument, BlockDiff, BlockChange, MarkdownBlock } from './types/block';
import { parseMarkdownToBlocks } from './parser';

export interface SessionState {
  originalContent: string;
  translatedContent: string;
  messages: vscode.LanguageModelChatMessage[];
  model: vscode.LanguageModelChat | null;
  /** Parsed document for block-based diffing */
  parsedDocument?: ParsedDocument;
  /** Block translations cache (hash -> translation) */
  blockTranslations?: Map<string, string>;
  /** Index of last translated block (0-indexed, inclusive) */
  translatedUpToBlockIndex?: number;
}

/**
 * Manages a translation session with conversation history
 */
export class TranslationSession {
  private state: SessionState | null = null;

  /**
   * Check if session exists
   */
  hasSession(): boolean {
    return this.state !== null;
  }

  /**
   * Get current session state
   */
  getState(): SessionState | null {
    return this.state;
  }

  /**
   * Initialize a new translation session
   */
  initSession(
    originalContent: string,
    translatedContent: string,
    messages: vscode.LanguageModelChatMessage[],
    model: vscode.LanguageModelChat,
    parsedDocument?: ParsedDocument,
    blockTranslations?: Map<string, string>,
    translatedUpToBlockIndex?: number
  ): void {
    this.state = {
      originalContent,
      translatedContent,
      messages,
      model,
      parsedDocument,
      blockTranslations,
      translatedUpToBlockIndex,
    };
  }

  /**
   * Update session with new translation
   */
  updateSession(
    originalContent: string,
    translatedContent: string,
    newMessages: vscode.LanguageModelChatMessage[],
    parsedDocument?: ParsedDocument,
    blockTranslations?: Map<string, string>,
    translatedUpToBlockIndex?: number
  ): void {
    if (!this.state) return;
    this.state.originalContent = originalContent;
    this.state.translatedContent = translatedContent;
    this.state.messages = [...this.state.messages, ...newMessages];
    if (parsedDocument) {
      this.state.parsedDocument = parsedDocument;
    }
    if (blockTranslations) {
      // Merge new block translations with existing
      if (this.state.blockTranslations) {
        for (const [hash, translation] of blockTranslations) {
          this.state.blockTranslations.set(hash, translation);
        }
      } else {
        this.state.blockTranslations = blockTranslations;
      }
    }
    if (translatedUpToBlockIndex !== undefined) {
      this.state.translatedUpToBlockIndex = translatedUpToBlockIndex;
    }
  }

  /**
   * Update the model used in the session
   */
  updateModel(model: vscode.LanguageModelChat): void {
    if (this.state) {
      this.state.model = model;
    }
  }

  /**
   * Get translated block index from session
   */
  getTranslatedUpToBlockIndex(): number | undefined {
    return this.state?.translatedUpToBlockIndex;
  }

  /**
   * Get block translations from session
   */
  getBlockTranslations(): Map<string, string> | undefined {
    return this.state?.blockTranslations;
  }

  /**
   * Get parsed document from session
   */
  getParsedDocument(): ParsedDocument | undefined {
    return this.state?.parsedDocument;
  }

  /**
   * Clear the session
   */
  clearSession(): void {
    this.state = null;
  }

  /**
   * Detect block-level changes between old and new content
   * Returns a BlockDiff with changed, added, removed blocks
   */
  detectBlockChanges(newContent: string): BlockDiff | null {
    if (!this.state) return null;

    const oldDocument = this.state.parsedDocument;
    if (!oldDocument) {
      // No parsed document - parse now
      const parsed = parseMarkdownToBlocks(this.state.originalContent);
      this.state.parsedDocument = parsed;
      return this.detectBlockChangesInternal(parsed, newContent);
    }

    return this.detectBlockChangesInternal(oldDocument, newContent);
  }

  /**
   * Internal implementation of block change detection
   */
  private detectBlockChangesInternal(oldDocument: ParsedDocument, newContent: string): BlockDiff | null {
    const newDocument = parseMarkdownToBlocks(newContent);

    // Quick check: if document hashes match, no changes
    if (oldDocument.documentHash === newDocument.documentHash) {
      return null;
    }

    const changes: BlockChange[] = [];
    const unchangedBlocks: Array<{ oldIndex: number; newIndex: number; block: MarkdownBlock }> = [];

    // Track which blocks have been matched
    const matchedOldIndices = new Set<number>();
    const matchedNewIndices = new Set<number>();

    // Phase 1: Hash matching - find blocks with identical content
    for (const newBlock of newDocument.blocks) {
      const oldBlocksWithSameHash = oldDocument.blocksByHash.get(newBlock.hash);
      if (oldBlocksWithSameHash) {
        // Find the best match (closest position)
        let bestMatch: MarkdownBlock | null = null;
        let bestDistance = Infinity;

        for (const oldBlock of oldBlocksWithSameHash) {
          if (!matchedOldIndices.has(oldBlock.index)) {
            const distance = Math.abs(oldBlock.index - newBlock.index);
            if (distance < bestDistance) {
              bestDistance = distance;
              bestMatch = oldBlock;
            }
          }
        }

        if (bestMatch) {
          matchedOldIndices.add(bestMatch.index);
          matchedNewIndices.add(newBlock.index);
          unchangedBlocks.push({
            oldIndex: bestMatch.index,
            newIndex: newBlock.index,
            block: newBlock,
          });
        }
      }
    }

    // Phase 2: Position-based matching for unmatched blocks
    // Collect unmatched blocks
    const unmatchedOld: MarkdownBlock[] = [];
    const unmatchedNew: MarkdownBlock[] = [];

    for (const oldBlock of oldDocument.blocks) {
      if (!matchedOldIndices.has(oldBlock.index)) {
        unmatchedOld.push(oldBlock);
      }
    }

    for (const newBlock of newDocument.blocks) {
      if (!matchedNewIndices.has(newBlock.index)) {
        unmatchedNew.push(newBlock);
      }
    }

    // Try to match unmatched blocks by position and type
    for (const newBlock of unmatchedNew) {
      // Find the closest unmatched old block of the same type
      let bestMatch: MarkdownBlock | null = null;
      let bestDistance = Infinity;

      for (const oldBlock of unmatchedOld) {
        if (!matchedOldIndices.has(oldBlock.index) && oldBlock.type === newBlock.type) {
          const distance = Math.abs(oldBlock.index - newBlock.index);
          if (distance < bestDistance && distance <= 3) {
            // Only match if within 3 positions
            bestDistance = distance;
            bestMatch = oldBlock;
          }
        }
      }

      if (bestMatch) {
        // Found a match - this is a modified block
        matchedOldIndices.add(bestMatch.index);
        matchedNewIndices.add(newBlock.index);
        changes.push({
          type: 'modified',
          oldIndex: bestMatch.index,
          newIndex: newBlock.index,
          oldBlock: bestMatch,
          newBlock: newBlock,
        });
      }
    }

    // Remaining unmatched old blocks are removed
    for (const oldBlock of oldDocument.blocks) {
      if (!matchedOldIndices.has(oldBlock.index)) {
        changes.push({
          type: 'removed',
          oldIndex: oldBlock.index,
          oldBlock: oldBlock,
        });
      }
    }

    // Remaining unmatched new blocks are added
    for (const newBlock of newDocument.blocks) {
      if (!matchedNewIndices.has(newBlock.index)) {
        changes.push({
          type: 'added',
          newIndex: newBlock.index,
          newBlock: newBlock,
        });
      }
    }

    // Sort changes by new index (or old index for removed)
    changes.sort((a, b) => {
      const aIndex = a.newIndex ?? a.oldIndex ?? 0;
      const bIndex = b.newIndex ?? b.oldIndex ?? 0;
      return aIndex - bIndex;
    });

    if (changes.length === 0) {
      return null;
    }

    return {
      hasChanges: true,
      changes,
      unchangedBlocks,
      summary: this.summarizeBlockChanges(changes),
    };
  }

  /**
   * Create a human-readable summary of block changes
   */
  private summarizeBlockChanges(changes: BlockChange[]): string {
    const added = changes.filter((c) => c.type === 'added').length;
    const removed = changes.filter((c) => c.type === 'removed').length;
    const modified = changes.filter((c) => c.type === 'modified').length;

    const parts: string[] = [];
    if (added > 0) parts.push(`${added} block${added > 1 ? 's' : ''} added`);
    if (removed > 0) parts.push(`${removed} block${removed > 1 ? 's' : ''} removed`);
    if (modified > 0) parts.push(`${modified} block${modified > 1 ? 's' : ''} modified`);

    return parts.join(', ');
  }

  /**
   * Detect changes between old and new content (line-based)
   * Returns a structured diff
   * @deprecated Use detectBlockChanges for block-based diffing
   */
  detectChanges(newContent: string): ContentDiff | null {
    if (!this.state) return null;

    const oldLines = this.state.originalContent.split('\n');
    const newLines = newContent.split('\n');

    const changes: Change[] = [];
    let oldIndex = 0;
    let newIndex = 0;

    // Simple line-by-line diff algorithm
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      if (oldIndex >= oldLines.length) {
        // Lines added at the end
        changes.push({
          type: 'added',
          lineNumber: newIndex + 1,
          content: newLines[newIndex],
        });
        newIndex++;
      } else if (newIndex >= newLines.length) {
        // Lines removed from the end
        changes.push({
          type: 'removed',
          lineNumber: oldIndex + 1,
          content: oldLines[oldIndex],
        });
        oldIndex++;
      } else if (oldLines[oldIndex] === newLines[newIndex]) {
        // Lines match
        oldIndex++;
        newIndex++;
      } else {
        // Lines differ - try to find if it's a modification or add/remove
        const oldInNew = newLines.indexOf(oldLines[oldIndex], newIndex);
        const newInOld = oldLines.indexOf(newLines[newIndex], oldIndex);

        if (oldInNew === -1 && newInOld === -1) {
          // Line was modified
          changes.push({
            type: 'modified',
            lineNumber: newIndex + 1,
            oldContent: oldLines[oldIndex],
            content: newLines[newIndex],
          });
          oldIndex++;
          newIndex++;
        } else if (oldInNew !== -1 && (newInOld === -1 || oldInNew - newIndex <= newInOld - oldIndex)) {
          // Lines were added
          changes.push({
            type: 'added',
            lineNumber: newIndex + 1,
            content: newLines[newIndex],
          });
          newIndex++;
        } else {
          // Lines were removed
          changes.push({
            type: 'removed',
            lineNumber: oldIndex + 1,
            content: oldLines[oldIndex],
          });
          oldIndex++;
        }
      }
    }

    if (changes.length === 0) {
      return null; // No changes
    }

    return {
      hasChanges: true,
      changes,
      summary: this.summarizeChanges(changes),
    };
  }

  /**
   * Create a human-readable summary of changes
   */
  private summarizeChanges(changes: Change[]): string {
    const added = changes.filter(c => c.type === 'added');
    const removed = changes.filter(c => c.type === 'removed');
    const modified = changes.filter(c => c.type === 'modified');

    const parts: string[] = [];
    if (added.length > 0) parts.push(`${added.length} lines added`);
    if (removed.length > 0) parts.push(`${removed.length} lines removed`);
    if (modified.length > 0) parts.push(`${modified.length} lines modified`);

    return parts.join(', ');
  }

  /**
   * Format diff for the prompt
   */
  formatDiffForPrompt(diff: ContentDiff, newContent: string): string {
    const lines: string[] = [];

    lines.push('The original document has been updated. Here are the changes:');
    lines.push('');

    for (const change of diff.changes) {
      switch (change.type) {
        case 'added':
          lines.push(`[LINE ${change.lineNumber} ADDED]: ${change.content}`);
          break;
        case 'removed':
          lines.push(`[LINE ${change.lineNumber} REMOVED]: ${change.content}`);
          break;
        case 'modified':
          lines.push(`[LINE ${change.lineNumber} CHANGED]:`);
          lines.push(`  Old: ${change.oldContent}`);
          lines.push(`  New: ${change.content}`);
          break;
      }
    }

    lines.push('');
    lines.push('Please update the translation to reflect these changes.');
    lines.push('Output the complete updated translation in Markdown format.');
    lines.push('');
    lines.push('Here is the complete updated original document for reference:');
    lines.push('---');
    lines.push(newContent);

    return lines.join('\n');
  }
}

export interface Change {
  type: 'added' | 'removed' | 'modified';
  lineNumber: number;
  content: string;
  oldContent?: string;
}

export interface ContentDiff {
  hasChanges: boolean;
  changes: Change[];
  summary: string;
}

// Singleton instance
export const translationSession = new TranslationSession();

// Re-export block types for convenience
export type { BlockDiff, BlockChange, ParsedDocument, MarkdownBlock } from './types/block';
