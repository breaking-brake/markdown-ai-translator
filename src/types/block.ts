/**
 * Block-based Markdown parsing and diffing types
 */

/**
 * Types of Markdown blocks
 */
export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'code_block'
  | 'blockquote'
  | 'list'
  | 'table'
  | 'thematic_break'
  | 'blank_lines'
  | 'html_block'
  | 'front_matter';

/**
 * A single Markdown block
 */
export interface MarkdownBlock {
  /** Block index in the document */
  index: number;
  /** Type of the block */
  type: BlockType;
  /** Raw content of the block including any formatting */
  content: string;
  /** SHA-256 hash of the content for change detection */
  hash: string;
  /** Starting line number (0-indexed) */
  startLine: number;
  /** Ending line number (0-indexed, inclusive) */
  endLine: number;
}

/**
 * A parsed Markdown document
 */
export interface ParsedDocument {
  /** All blocks in document order */
  blocks: MarkdownBlock[];
  /** Lookup map from hash to block for fast matching */
  blocksByHash: Map<string, MarkdownBlock[]>;
  /** Overall document hash for quick equality check */
  documentHash: string;
}

/**
 * Describes a change to a single block
 */
export interface BlockChange {
  /** Type of change */
  type: 'added' | 'removed' | 'modified';
  /** Index in old document (for removed/modified) */
  oldIndex?: number;
  /** Index in new document (for added/modified) */
  newIndex?: number;
  /** The old block (for removed/modified) */
  oldBlock?: MarkdownBlock;
  /** The new block (for added/modified) */
  newBlock?: MarkdownBlock;
}

/**
 * Result of diffing two parsed documents
 */
export interface BlockDiff {
  /** Whether any changes were detected */
  hasChanges: boolean;
  /** List of all changes */
  changes: BlockChange[];
  /** Blocks that are unchanged (with their index mapping) */
  unchangedBlocks: Array<{
    oldIndex: number;
    newIndex: number;
    block: MarkdownBlock;
  }>;
  /** Human-readable summary of changes */
  summary: string;
}

/**
 * Translation context for a block
 */
export interface BlockTranslationContext {
  /** The block to translate */
  block: MarkdownBlock;
  /** Translation of the previous block (if available) */
  previousTranslation?: string;
  /** Content of the next block (if available) */
  nextBlockContent?: string;
}
