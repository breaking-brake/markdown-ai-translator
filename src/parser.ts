/**
 * Markdown block parser
 * Parses Markdown content into discrete blocks for incremental translation
 */

import * as crypto from 'crypto';
import { MarkdownBlock, BlockType, ParsedDocument } from './types/block';

/**
 * Generate SHA-256 hash for content
 */
function generateHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * State machine states for parsing
 */
type ParserState =
  | 'normal'
  | 'code_block'
  | 'front_matter'
  | 'html_block';

interface ParserContext {
  state: ParserState;
  /** Fence character for code blocks (` or ~) */
  codeFence?: string;
  /** Fence length for code blocks */
  codeFenceLength?: number;
  /** Current block being accumulated */
  currentBlock: string[];
  /** Starting line of current block */
  blockStartLine: number;
  /** Type of current block being accumulated */
  currentType?: BlockType;
}

/**
 * Check if a line starts a heading
 */
function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

/**
 * Check if a line is a thematic break (---, ***, ___)
 */
function isThematicBreak(line: string): boolean {
  return /^(\s{0,3})([-*_])\s*\2\s*\2(\s*\2)*\s*$/.test(line);
}

/**
 * Check if a line starts a code fence
 */
function isCodeFenceStart(line: string): { fence: string; length: number } | null {
  const match = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
  if (match) {
    return { fence: match[2][0], length: match[2].length };
  }
  return null;
}

/**
 * Check if a line ends a code fence
 */
function isCodeFenceEnd(line: string, fence: string, minLength: number): boolean {
  const pattern = new RegExp(`^\\s{0,3}${fence}{${minLength},}\\s*$`);
  return pattern.test(line);
}

/**
 * Check if a line starts a list item (unordered or ordered)
 */
function isListItem(line: string): boolean {
  // Unordered: - * +
  // Ordered: 1. 2. etc
  return /^(\s*)[-*+]\s/.test(line) || /^(\s*)\d+[.)]\s/.test(line);
}

/**
 * Check if a line is part of a list (has appropriate indentation)
 */
function isListContinuation(line: string): boolean {
  // Empty line or indented content can continue a list
  return line.trim() === '' || /^\s{2,}/.test(line);
}

/**
 * Check if a line starts a blockquote
 */
function isBlockquote(line: string): boolean {
  return /^\s{0,3}>/.test(line);
}

/**
 * Check if a line starts a table (pipe at start or with content)
 */
function isTableLine(line: string): boolean {
  // Table lines contain pipes and have content
  return /^\s*\|/.test(line) || /\|.*\|/.test(line);
}

/**
 * Check if a line is a table separator (|---|---|)
 */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
}

/**
 * Check if a line is blank
 */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * Check if a line starts front matter (--- at document start)
 */
function isFrontMatterStart(line: string, lineIndex: number): boolean {
  return lineIndex === 0 && line.trim() === '---';
}

/**
 * Check if a line ends front matter
 */
function isFrontMatterEnd(line: string): boolean {
  return line.trim() === '---' || line.trim() === '...';
}

/**
 * Check if a line starts an HTML block
 */
function isHtmlBlockStart(line: string): boolean {
  // Common HTML block patterns
  return /^\s*<(script|pre|style|textarea|!--|!DOCTYPE|\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)[\s>\/])/i.test(line);
}

/**
 * Determine the block type for a line
 */
function determineBlockType(line: string, prevType?: BlockType): BlockType | null {
  if (isHeading(line)) return 'heading';
  if (isThematicBreak(line)) return 'thematic_break';
  if (isCodeFenceStart(line)) return 'code_block';
  if (isBlockquote(line)) return 'blockquote';
  if (isListItem(line)) return 'list';
  if (isTableLine(line)) return 'table';
  if (isHtmlBlockStart(line)) return 'html_block';
  if (isBlank(line)) return 'blank_lines';
  return 'paragraph';
}

/**
 * Parse Markdown content into blocks
 */
export function parseMarkdownToBlocks(content: string): ParsedDocument {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];

  const ctx: ParserContext = {
    state: 'normal',
    currentBlock: [],
    blockStartLine: 0,
  };

  /**
   * Finalize the current block and add it to blocks array
   */
  function finalizeBlock(endLine: number): void {
    if (ctx.currentBlock.length === 0) return;

    const blockContent = ctx.currentBlock.join('\n');
    const blockType = ctx.currentType || 'paragraph';

    blocks.push({
      index: blocks.length,
      type: blockType,
      content: blockContent,
      hash: generateHash(blockContent),
      startLine: ctx.blockStartLine,
      endLine: endLine,
    });

    ctx.currentBlock = [];
    ctx.currentType = undefined;
  }

  /**
   * Start a new block
   */
  function startBlock(line: string, lineIndex: number, type: BlockType): void {
    ctx.currentBlock = [line];
    ctx.blockStartLine = lineIndex;
    ctx.currentType = type;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle special states
    if (ctx.state === 'front_matter') {
      ctx.currentBlock.push(line);
      if (isFrontMatterEnd(line) && ctx.currentBlock.length > 1) {
        ctx.state = 'normal';
        finalizeBlock(i);
      }
      continue;
    }

    if (ctx.state === 'code_block') {
      ctx.currentBlock.push(line);
      if (isCodeFenceEnd(line, ctx.codeFence!, ctx.codeFenceLength!)) {
        ctx.state = 'normal';
        finalizeBlock(i);
      }
      continue;
    }

    // Check for front matter at document start
    if (i === 0 && isFrontMatterStart(line, i)) {
      ctx.state = 'front_matter';
      ctx.currentType = 'front_matter';
      ctx.currentBlock = [line];
      ctx.blockStartLine = i;
      continue;
    }

    // Check for code fence start
    const codeFence = isCodeFenceStart(line);
    if (codeFence) {
      finalizeBlock(i - 1);
      ctx.state = 'code_block';
      ctx.codeFence = codeFence.fence;
      ctx.codeFenceLength = codeFence.length;
      startBlock(line, i, 'code_block');
      continue;
    }

    // Normal state processing
    const lineType = determineBlockType(line, ctx.currentType);

    // Handle blank lines
    if (lineType === 'blank_lines') {
      if (ctx.currentType === 'blank_lines') {
        // Continue accumulating blank lines
        ctx.currentBlock.push(line);
      } else if (ctx.currentType === 'list') {
        // Blank line might continue a list or end it
        // Look ahead to see if list continues
        const nextNonBlank = lines.slice(i + 1).find(l => l.trim() !== '');
        if (nextNonBlank && (isListItem(nextNonBlank) || /^\s{2,}/.test(nextNonBlank))) {
          ctx.currentBlock.push(line);
        } else {
          finalizeBlock(i - 1);
          startBlock(line, i, 'blank_lines');
        }
      } else {
        // End current block, start blank lines block
        finalizeBlock(i - 1);
        startBlock(line, i, 'blank_lines');
      }
      continue;
    }

    // Handle heading (always its own block)
    if (lineType === 'heading') {
      finalizeBlock(i - 1);
      startBlock(line, i, 'heading');
      finalizeBlock(i);
      continue;
    }

    // Handle thematic break (always its own block)
    if (lineType === 'thematic_break') {
      finalizeBlock(i - 1);
      startBlock(line, i, 'thematic_break');
      finalizeBlock(i);
      continue;
    }

    // Handle blockquote
    if (lineType === 'blockquote') {
      if (ctx.currentType === 'blockquote') {
        ctx.currentBlock.push(line);
      } else {
        finalizeBlock(i - 1);
        startBlock(line, i, 'blockquote');
      }
      continue;
    }

    // Handle list
    if (lineType === 'list' || (ctx.currentType === 'list' && isListContinuation(line))) {
      if (ctx.currentType === 'list') {
        ctx.currentBlock.push(line);
      } else {
        finalizeBlock(i - 1);
        startBlock(line, i, 'list');
      }
      continue;
    }

    // Handle table
    if (lineType === 'table' || (ctx.currentType === 'table' && (isTableLine(line) || isTableSeparator(line)))) {
      if (ctx.currentType === 'table') {
        ctx.currentBlock.push(line);
      } else {
        finalizeBlock(i - 1);
        startBlock(line, i, 'table');
      }
      continue;
    }

    // Handle paragraph (default)
    if (ctx.currentType === 'paragraph') {
      ctx.currentBlock.push(line);
    } else {
      finalizeBlock(i - 1);
      startBlock(line, i, 'paragraph');
    }
  }

  // Finalize any remaining block
  finalizeBlock(lines.length - 1);

  // Build hash lookup map
  const blocksByHash = new Map<string, MarkdownBlock[]>();
  for (const block of blocks) {
    const existing = blocksByHash.get(block.hash);
    if (existing) {
      existing.push(block);
    } else {
      blocksByHash.set(block.hash, [block]);
    }
  }

  // Calculate document hash
  const documentHash = generateHash(content);

  return {
    blocks,
    blocksByHash,
    documentHash,
  };
}

/**
 * Reconstruct content from blocks
 */
export function blocksToContent(blocks: MarkdownBlock[]): string {
  return blocks.map(b => b.content).join('\n');
}
