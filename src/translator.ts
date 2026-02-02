import * as vscode from 'vscode';
import { translationCache } from './cache';
import { translationSession, ContentDiff, BlockDiff, ParsedDocument, MarkdownBlock } from './session';
import { parseMarkdownToBlocks, blocksToContent } from './parser';
import { BlockTranslationContext } from './types/block';

/**
 * Internal maximum chunk size to avoid "Response too long" errors.
 * User-selected chunk sizes larger than this will be auto-split into multiple requests.
 */
const INTERNAL_MAX_CHUNK_SIZE = 10000;

export interface TranslationResult {
  success: boolean;
  translation?: string;
  error?: string;
  fromCache?: boolean;
  incremental?: boolean;
  /** Block translations map (hash -> translation) for caching */
  blockTranslations?: Map<string, string>;
  /** Parsed document for session state */
  parsedDocument?: ParsedDocument;
  /** Index of last translated block (0-indexed, inclusive) */
  translatedUpToBlockIndex?: number;
  /** Whether there are more blocks to translate */
  hasMoreBlocks?: boolean;
}

export interface TranslationProgress {
  current: number;
  total: number;
  message: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  maxInputTokens: number;
}

/**
 * Get available language models
 */
export async function getAvailableModels(): Promise<ModelInfo[]> {
  try {
    const models = await vscode.lm.selectChatModels({});
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      family: model.family,
      maxInputTokens: model.maxInputTokens,
    }));
  } catch {
    return [];
  }
}

/**
 * Get model by ID or return first available
 */
async function getModel(modelId?: string): Promise<vscode.LanguageModelChat | null> {
  const allModels = await vscode.lm.selectChatModels({});

  if (allModels.length === 0) {
    return null;
  }

  // If modelId is specified, try to find it
  if (modelId) {
    const selectedModel = allModels.find((m) => m.id === modelId);
    if (selectedModel) {
      return selectedModel;
    }
  }

  // Fall back to first copilot model or any available model
  const copilotModel = allModels.find((m) => m.vendor === 'copilot');
  return copilotModel || allModels[0];
}

/**
 * Translate content using VSCode LanguageModel API
 * Supports both initial translation and incremental updates
 */
export async function translateContent(
  content: string,
  targetLanguage: string,
  token: vscode.CancellationToken,
  onProgress?: (progress: TranslationProgress) => void,
  modelId?: string
): Promise<TranslationResult> {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  const enableCache = config.get<boolean>('enableCache', true);

  // Check cache first
  if (enableCache) {
    const cached = translationCache.get(content);
    if (cached) {
      return { success: true, translation: cached, fromCache: true };
    }
  }

  try {
    // Get model
    const effectiveModelId = modelId || config.get<string>('modelId', '');
    const model = await getModel(effectiveModelId);

    if (!model) {
      return {
        success: false,
        error: 'No language models available. Please ensure GitHub Copilot is installed and signed in.',
      };
    }

    onProgress?.({ current: 0, total: 1, message: 'Translating...' });

    // Perform translation
    const result = await performInitialTranslation(content, targetLanguage, model, token);

    onProgress?.({ current: 1, total: 1, message: 'Translation complete' });

    if (enableCache && result.translation) {
      translationCache.set(content, result.translation);
    }

    return result;
  } catch (error) {
    return handleTranslationError(error);
  }
}

export interface StreamingOptions {
  modelId?: string;
  bypassCache?: boolean;
}

/**
 * Translate content with streaming support
 * Calls onChunk for each fragment received
 */
export async function translateContentStreaming(
  content: string,
  targetLanguage: string,
  token: vscode.CancellationToken,
  onChunk: (chunk: string) => void,
  options?: StreamingOptions
): Promise<TranslationResult> {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  const enableCache = config.get<boolean>('enableCache', true);
  const bypassCache = options?.bypassCache ?? false;

  // Check cache first (unless bypassing)
  if (enableCache && !bypassCache) {
    const cached = translationCache.get(content);
    if (cached) {
      // Even for cached content, send as one chunk for consistency
      onChunk(cached);
      return { success: true, translation: cached, fromCache: true };
    }
  }

  try {
    // Get model
    const effectiveModelId = options?.modelId || config.get<string>('modelId', '');
    const model = await getModel(effectiveModelId);

    if (!model) {
      return {
        success: false,
        error: 'No language models available. Please ensure GitHub Copilot is installed and signed in.',
      };
    }

    // Perform streaming translation
    const result = await performStreamingTranslation(content, targetLanguage, model, token, onChunk);

    // Check cancellation AFTER translation completes - don't cache or use cancelled translations
    if (token.isCancellationRequested) {
      // Clear session since translation was cancelled
      translationSession.clearSession();
      return { success: false, error: 'Translation cancelled' };
    }

    if (enableCache && result.translation) {
      translationCache.set(content, result.translation);
    }

    return result;
  } catch (error) {
    // Clear session on error
    translationSession.clearSession();
    return handleTranslationError(error);
  }
}

/**
 * Perform streaming translation
 */
async function performStreamingTranslation(
  content: string,
  targetLanguage: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  onChunk: (chunk: string) => void
): Promise<TranslationResult> {
  const prompt = `You are a professional translator. Translate the following Markdown content to ${targetLanguage}.
Preserve all Markdown formatting, code blocks, links, and structure exactly as they are.
Only translate the text content, not code or URLs.
Do not add any explanations or notes - output only the translated Markdown.

[Content to translate]

${content}`;

  const userMessage = vscode.LanguageModelChatMessage.User(prompt);
  const messages = [userMessage];

  const response = await model.sendRequest(messages, {}, token);

  let translation = '';
  for await (const fragment of response.text) {
    if (token.isCancellationRequested) {
      throw new Error('Translation cancelled');
    }
    translation += fragment;
    onChunk(fragment);
  }

  // Store in session for future incremental updates
  const assistantMessage = vscode.LanguageModelChatMessage.Assistant(translation);
  translationSession.initSession(content, translation, [userMessage, assistantMessage], model);

  return { success: true, translation };
}

/**
 * Perform incremental translation based on detected changes
 */
export async function translateIncremental(
  newContent: string,
  targetLanguage: string,
  token: vscode.CancellationToken,
  onProgress?: (progress: TranslationProgress) => void
): Promise<TranslationResult> {
  const session = translationSession.getState();

  if (!session || !session.model) {
    return {
      success: false,
      error: 'No active translation session. Please translate the full document first.',
    };
  }

  // Detect changes
  const diff = translationSession.detectChanges(newContent);

  if (!diff) {
    // No changes detected
    return {
      success: true,
      translation: session.translatedContent,
      fromCache: true,
    };
  }

  onProgress?.({
    current: 0,
    total: 1,
    message: `Updating translation (${diff.summary})...`,
  });

  try {
    const result = await performIncrementalTranslation(
      newContent,
      targetLanguage,
      diff,
      { messages: session.messages, model: session.model, translatedContent: session.translatedContent },
      token
    );

    // Check cancellation AFTER translation completes
    if (token.isCancellationRequested) {
      return { success: false, error: 'Translation cancelled' };
    }

    onProgress?.({ current: 1, total: 1, message: 'Translation updated' });

    return result;
  } catch (error) {
    return handleTranslationError(error);
  }
}

/**
 * Perform initial full translation
 */
async function performInitialTranslation(
  content: string,
  targetLanguage: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken
): Promise<TranslationResult> {
  const prompt = `You are a professional translator. Translate the following Markdown content to ${targetLanguage}.
Preserve all Markdown formatting, code blocks, links, and structure exactly as they are.
Only translate the text content, not code or URLs.
Do not add any explanations or notes - output only the translated Markdown.

[Content to translate]

${content}`;

  const userMessage = vscode.LanguageModelChatMessage.User(prompt);
  const messages = [userMessage];

  const response = await model.sendRequest(messages, {}, token);

  let translation = '';
  for await (const fragment of response.text) {
    if (token.isCancellationRequested) {
      throw new Error('Translation cancelled');
    }
    translation += fragment;
  }

  // Store in session for future incremental updates
  const assistantMessage = vscode.LanguageModelChatMessage.Assistant(translation);
  translationSession.initSession(content, translation, [userMessage, assistantMessage], model);

  return { success: true, translation };
}

/**
 * Perform incremental translation using conversation history
 */
async function performIncrementalTranslation(
  newContent: string,
  targetLanguage: string,
  diff: ContentDiff,
  session: { messages: vscode.LanguageModelChatMessage[]; model: vscode.LanguageModelChat; translatedContent: string },
  token: vscode.CancellationToken
): Promise<TranslationResult> {
  const updatePrompt = translationSession.formatDiffForPrompt(diff, newContent);
  const userMessage = vscode.LanguageModelChatMessage.User(updatePrompt);

  // Build messages with conversation history
  const messages = [...session.messages, userMessage];

  const response = await session.model.sendRequest(messages, {}, token);

  let translation = '';
  for await (const fragment of response.text) {
    if (token.isCancellationRequested) {
      throw new Error('Translation cancelled');
    }
    translation += fragment;
  }

  // Update session with new content
  const assistantMessage = vscode.LanguageModelChatMessage.Assistant(translation);
  translationSession.updateSession(newContent, translation, [userMessage, assistantMessage]);

  // Update cache
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  if (config.get<boolean>('enableCache', true)) {
    translationCache.set(newContent, translation);
  }

  return { success: true, translation, incremental: true };
}

/**
 * Handle translation errors
 */
function handleTranslationError(error: unknown): TranslationResult {
  if (error instanceof vscode.LanguageModelError) {
    switch (error.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return {
          success: false,
          error: 'Permission denied. Please sign in to GitHub Copilot and try again.',
        };
      case vscode.LanguageModelError.NotFound.name:
        return {
          success: false,
          error: 'Language model not found. Please ensure GitHub Copilot is installed.',
        };
      case vscode.LanguageModelError.Blocked.name:
        return {
          success: false,
          error: 'Request was blocked. Please try again later.',
        };
      default:
        return {
          success: false,
          error: `Language model error: ${error.message}`,
        };
    }
  }

  if (error instanceof Error) {
    return { success: false, error: error.message };
  }

  return { success: false, error: 'An unknown error occurred' };
}

/**
 * Clear the current translation session
 */
export function clearTranslationSession(): void {
  translationSession.clearSession();
}

/**
 * Check if there's an active translation session
 */
export function hasTranslationSession(): boolean {
  return translationSession.hasSession();
}

// =====================================================
// Block-based translation functions
// =====================================================

export interface BlockTranslationOptions {
  modelId?: string;
  bypassCache?: boolean;
  /** Chunk size in characters for block-based chunking */
  chunkSize?: number;
}

/**
 * Translate content using block-based approach with streaming
 * Respects chunk size by only translating blocks up to the limit
 */
export async function translateContentBlockBased(
  content: string,
  targetLanguage: string,
  token: vscode.CancellationToken,
  onChunk: (chunk: string) => void,
  options?: BlockTranslationOptions
): Promise<TranslationResult> {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  const enableCache = config.get<boolean>('enableCache', true);
  const bypassCache = options?.bypassCache ?? false;
  const chunkSize = options?.chunkSize ?? config.get<number>('chunkSize', 5000);

  // Parse content into blocks
  const parsedDocument = parseMarkdownToBlocks(content);

  // Check document-level cache first (unless bypassing)
  if (enableCache && !bypassCache) {
    const cached = translationCache.get(content);
    if (cached) {
      onChunk(cached);
      const parsedTranslation = parseMarkdownToBlocks(cached);
      const blockTranslations = buildBlockTranslationMap(parsedDocument, parsedTranslation);
      return {
        success: true,
        translation: cached,
        fromCache: true,
        blockTranslations,
        parsedDocument,
        translatedUpToBlockIndex: parsedDocument.blocks.length - 1,
        hasMoreBlocks: false,
      };
    }
  }

  try {
    const effectiveModelId = options?.modelId || config.get<string>('modelId', '');
    const model = await getModel(effectiveModelId);

    if (!model) {
      return {
        success: false,
        error: 'No language models available. Please ensure GitHub Copilot is installed and signed in.',
      };
    }

    // Determine which blocks to translate based on user's chunk size
    const { blocksToTranslate, lastBlockIndex } = selectBlocksForChunk(
      parsedDocument.blocks,
      0, // Start from beginning
      chunkSize
    );

    const hasMoreBlocks = lastBlockIndex < parsedDocument.blocks.length - 1;

    // Split blocks into internal chunks to avoid "Response too long" errors
    const internalChunks = splitIntoInternalChunks(blocksToTranslate);

    let fullTranslation = '';
    const allBlockTranslations = new Map<string, string>();
    const allMessages: vscode.LanguageModelChatMessage[] = [];
    let cancelledDuringStream = false;
    let lastTranslatedBlockIndex = -1;

    // Process each internal chunk
    for (let chunkIndex = 0; chunkIndex < internalChunks.length; chunkIndex++) {
      if (token.isCancellationRequested) {
        cancelledDuringStream = true;
        break;
      }

      const internalBlocks = internalChunks[chunkIndex];
      const contentToTranslate = internalBlocks.map((b) => b.content).join('\n');

      // Add newline separator between internal chunks
      if (chunkIndex > 0 && fullTranslation.length > 0) {
        fullTranslation += '\n';
        onChunk('\n');
      }

      // Translate the internal chunk
      const prompt = `You are a professional translator. Translate the following Markdown content to ${targetLanguage}.
Preserve all Markdown formatting, code blocks, links, and structure exactly as they are.
Only translate the text content, not code or URLs.
Do not add any explanations or notes - output only the translated Markdown.

[Content to translate]

${contentToTranslate}`;

      const userMessage = vscode.LanguageModelChatMessage.User(prompt);
      const response = await model.sendRequest([userMessage], {}, token);

      let chunkTranslation = '';
      for await (const fragment of response.text) {
        if (token.isCancellationRequested) {
          cancelledDuringStream = true;
          break;
        }
        chunkTranslation += fragment;
        fullTranslation += fragment;
        onChunk(fragment);
      }

      // Parse and map translations for this internal chunk
      const parsedChunkTranslation = parseMarkdownToBlocks(chunkTranslation);
      const chunkBlockTranslations = buildBlockTranslationMapForRange(
        internalBlocks,
        parsedChunkTranslation
      );

      // Merge into all block translations
      for (const [hash, translation] of chunkBlockTranslations) {
        allBlockTranslations.set(hash, translation);
      }

      // Track messages for session
      const assistantMessage = vscode.LanguageModelChatMessage.Assistant(chunkTranslation);
      allMessages.push(userMessage, assistantMessage);

      // Calculate last translated block index (relative to full document)
      const blocksBeforeThisChunk = internalChunks.slice(0, chunkIndex).reduce((sum, c) => sum + c.length, 0);
      lastTranslatedBlockIndex = blocksBeforeThisChunk + Math.min(parsedChunkTranslation.blocks.length, internalBlocks.length) - 1;

      if (cancelledDuringStream) {
        break;
      }
    }

    // If cancelled, save partial session state
    if (cancelledDuringStream) {
      translationSession.initSession(
        content,
        fullTranslation,
        allMessages,
        model,
        parsedDocument,
        allBlockTranslations,
        lastTranslatedBlockIndex >= 0 ? lastTranslatedBlockIndex : undefined
      );

      return {
        success: false,
        error: 'Translation cancelled',
        blockTranslations: allBlockTranslations,
        parsedDocument,
        translatedUpToBlockIndex: lastTranslatedBlockIndex >= 0 ? lastTranslatedBlockIndex : undefined,
        hasMoreBlocks: true,
      };
    }

    // Cache block translations
    if (enableCache) {
      translationCache.setBlocks(allBlockTranslations, targetLanguage);
      // Only cache full document if all blocks were translated
      if (!hasMoreBlocks) {
        translationCache.set(content, fullTranslation);
      }
    }

    // Initialize session with block data
    translationSession.initSession(
      content,
      fullTranslation,
      allMessages,
      model,
      parsedDocument,
      allBlockTranslations,
      lastBlockIndex
    );

    return {
      success: true,
      translation: fullTranslation,
      blockTranslations: allBlockTranslations,
      parsedDocument,
      translatedUpToBlockIndex: lastBlockIndex,
      hasMoreBlocks,
    };
  } catch (error) {
    translationSession.clearSession();
    return handleTranslationError(error);
  }
}

/**
 * Select blocks to translate within chunk size limit
 */
function selectBlocksForChunk(
  blocks: MarkdownBlock[],
  startIndex: number,
  chunkSize: number
): { blocksToTranslate: MarkdownBlock[]; lastBlockIndex: number } {
  const blocksToTranslate: MarkdownBlock[] = [];
  let totalSize = 0;
  let lastBlockIndex = startIndex - 1;

  for (let i = startIndex; i < blocks.length; i++) {
    const block = blocks[i];
    const blockSize = block.content.length;

    // Always include at least one block
    if (blocksToTranslate.length === 0 || totalSize + blockSize <= chunkSize) {
      blocksToTranslate.push(block);
      totalSize += blockSize + 1; // +1 for newline
      lastBlockIndex = i;
    } else {
      break;
    }
  }

  return { blocksToTranslate, lastBlockIndex };
}

/**
 * Split blocks into internal chunks to avoid "Response too long" errors.
 * Each internal chunk will be at most INTERNAL_MAX_CHUNK_SIZE characters.
 */
function splitIntoInternalChunks(blocks: MarkdownBlock[]): MarkdownBlock[][] {
  const chunks: MarkdownBlock[][] = [];
  let currentChunk: MarkdownBlock[] = [];
  let currentSize = 0;

  for (const block of blocks) {
    const blockSize = block.content.length;

    // Always include at least one block in a chunk
    if (currentChunk.length === 0 || currentSize + blockSize <= INTERNAL_MAX_CHUNK_SIZE) {
      currentChunk.push(block);
      currentSize += blockSize + 1; // +1 for newline
    } else {
      // Start a new chunk
      chunks.push(currentChunk);
      currentChunk = [block];
      currentSize = blockSize + 1;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Build block translation map for a specific range of source blocks
 */
function buildBlockTranslationMapForRange(
  sourceBlocks: MarkdownBlock[],
  translation: ParsedDocument
): Map<string, string> {
  const map = new Map<string, string>();

  if (sourceBlocks.length === translation.blocks.length) {
    // Position-based mapping
    for (let i = 0; i < sourceBlocks.length; i++) {
      map.set(sourceBlocks[i].hash, translation.blocks[i].content);
    }
  } else {
    // Type-based matching
    let translationIndex = 0;
    for (const sourceBlock of sourceBlocks) {
      while (
        translationIndex < translation.blocks.length &&
        translation.blocks[translationIndex].type !== sourceBlock.type
      ) {
        translationIndex++;
      }

      if (translationIndex < translation.blocks.length) {
        map.set(sourceBlock.hash, translation.blocks[translationIndex].content);
        translationIndex++;
      } else {
        map.set(sourceBlock.hash, sourceBlock.content);
      }
    }
  }

  return map;
}

/**
 * Translate the next chunk of blocks
 * Continues from where the previous translation left off
 */
export async function translateNextBlockChunk(
  targetLanguage: string,
  chunkSize: number,
  token: vscode.CancellationToken,
  onChunk: (chunk: string) => void,
  options?: BlockTranslationOptions
): Promise<TranslationResult> {
  const session = translationSession.getState();

  if (!session || !session.model || !session.parsedDocument) {
    return {
      success: false,
      error: 'No active translation session. Please translate the document first.',
    };
  }

  // Use the specified model if provided, otherwise use session model
  let model = session.model;
  if (options?.modelId && options.modelId !== session.model.id) {
    const newModel = await getModel(options.modelId);
    if (newModel) {
      model = newModel;
      // Update session with new model
      translationSession.updateModel(newModel);
    }
  }

  const config = vscode.workspace.getConfiguration('markdownTranslate');
  const enableCache = config.get<boolean>('enableCache', true);

  const { parsedDocument, blockTranslations, translatedUpToBlockIndex } = session;
  const startIndex = (translatedUpToBlockIndex ?? -1) + 1;

  // Check if there are more blocks to translate
  if (startIndex >= parsedDocument.blocks.length) {
    // All blocks already translated
    const fullTranslation = mergeTranslatedBlocks(parsedDocument, blockTranslations || new Map());
    onChunk(fullTranslation);
    return {
      success: true,
      translation: fullTranslation,
      fromCache: true,
      translatedUpToBlockIndex: parsedDocument.blocks.length - 1,
      hasMoreBlocks: false,
    };
  }

  try {
    // Check if there are already translated blocks (for newline separator logic)
    const existingTranslations = blockTranslations || new Map<string, string>();
    const hasExistingTranslation = startIndex > 0 && existingTranslations.size > 0;
    // Note: existing translation is now passed via StreamingData.existingTranslation
    // and initialized in the webview, so we don't send it via onChunk anymore

    // Select next chunk of blocks based on user's chunk size
    const { blocksToTranslate, lastBlockIndex } = selectBlocksForChunk(
      parsedDocument.blocks,
      startIndex,
      chunkSize
    );

    const hasMoreBlocks = lastBlockIndex < parsedDocument.blocks.length - 1;

    // Split blocks into internal chunks to avoid "Response too long" errors
    const internalChunks = splitIntoInternalChunks(blocksToTranslate);

    let newTranslation = '';
    const newBlockTranslations = new Map<string, string>();
    const allMessages: vscode.LanguageModelChatMessage[] = [];

    // Add initial newline if there was existing content
    if (hasExistingTranslation) {
      onChunk('\n');
    }

    // Process each internal chunk
    for (let chunkIndex = 0; chunkIndex < internalChunks.length; chunkIndex++) {
      if (token.isCancellationRequested) {
        return { success: false, error: 'Translation cancelled' };
      }

      const internalBlocks = internalChunks[chunkIndex];
      const contentToTranslate = internalBlocks.map((b) => b.content).join('\n');

      // Add newline separator between internal chunks
      if (chunkIndex > 0 && newTranslation.length > 0) {
        newTranslation += '\n';
        onChunk('\n');
      }

      // Translate
      const prompt = `You are a professional translator. Translate the following Markdown content to ${targetLanguage}.
Preserve all Markdown formatting, code blocks, links, and structure exactly as they are.
Only translate the text content, not code or URLs.
Do not add any explanations or notes - output only the translated Markdown.

[Content to translate]

${contentToTranslate}`;

      const userMessage = vscode.LanguageModelChatMessage.User(prompt);
      const response = await model.sendRequest([userMessage], {}, token);

      let chunkTranslation = '';
      for await (const fragment of response.text) {
        if (token.isCancellationRequested) {
          return { success: false, error: 'Translation cancelled' };
        }
        chunkTranslation += fragment;
        newTranslation += fragment;
        onChunk(fragment);
      }

      // Parse and map translations for this internal chunk
      const parsedChunkTranslation = parseMarkdownToBlocks(chunkTranslation);
      const chunkBlockTranslations = buildBlockTranslationMapForRange(
        internalBlocks,
        parsedChunkTranslation
      );

      // Merge into new block translations
      for (const [hash, translation] of chunkBlockTranslations) {
        newBlockTranslations.set(hash, translation);
      }

      // Track messages for session
      const assistantMessage = vscode.LanguageModelChatMessage.Assistant(chunkTranslation);
      allMessages.push(userMessage, assistantMessage);
    }

    // Merge with existing translations
    const allBlockTranslations = new Map([...existingTranslations, ...newBlockTranslations]);

    // Build full translation (only up to lastBlockIndex)
    const fullTranslation = mergeTranslatedBlocks(parsedDocument, allBlockTranslations, lastBlockIndex);

    // Cache
    if (enableCache) {
      translationCache.setBlocks(newBlockTranslations, targetLanguage);
      if (!hasMoreBlocks) {
        translationCache.set(session.originalContent, fullTranslation);
      }
    }

    // Update session
    translationSession.updateSession(
      session.originalContent,
      fullTranslation,
      allMessages,
      parsedDocument,
      newBlockTranslations,
      lastBlockIndex
    );

    return {
      success: true,
      translation: fullTranslation,
      blockTranslations: allBlockTranslations,
      parsedDocument,
      translatedUpToBlockIndex: lastBlockIndex,
      hasMoreBlocks,
    };
  } catch (error) {
    return handleTranslationError(error);
  }
}

/**
 * Translate all remaining blocks at once
 */
export async function translateAllRemainingBlocks(
  targetLanguage: string,
  token: vscode.CancellationToken,
  onChunk: (chunk: string) => void,
  options?: BlockTranslationOptions
): Promise<TranslationResult> {
  const session = translationSession.getState();

  if (!session || !session.model || !session.parsedDocument) {
    return {
      success: false,
      error: 'No active translation session. Please translate the document first.',
    };
  }

  // Use the specified model if provided, otherwise use session model
  let model = session.model;
  if (options?.modelId && options.modelId !== session.model.id) {
    const newModel = await getModel(options.modelId);
    if (newModel) {
      model = newModel;
      // Update session with new model
      translationSession.updateModel(newModel);
    }
  }

  const config = vscode.workspace.getConfiguration('markdownTranslate');
  const enableCache = config.get<boolean>('enableCache', true);

  const { parsedDocument, blockTranslations, translatedUpToBlockIndex } = session;
  const startIndex = (translatedUpToBlockIndex ?? -1) + 1;

  if (startIndex >= parsedDocument.blocks.length) {
    const fullTranslation = mergeTranslatedBlocks(parsedDocument, blockTranslations || new Map());
    onChunk(fullTranslation);
    return {
      success: true,
      translation: fullTranslation,
      fromCache: true,
      translatedUpToBlockIndex: parsedDocument.blocks.length - 1,
      hasMoreBlocks: false,
    };
  }

  try {
    // Output already translated blocks
    const existingTranslations = blockTranslations || new Map<string, string>();
    let existingTranslation = '';
    for (let i = 0; i < startIndex; i++) {
      const block = parsedDocument.blocks[i];
      const translation = existingTranslations.get(block.hash);
      if (translation !== undefined) {
        if (existingTranslation.length > 0) {
          existingTranslation += '\n';
        }
        existingTranslation += translation;
      }
    }
    if (existingTranslation.length > 0) {
      onChunk(existingTranslation);
    }

    // Get all remaining blocks and split into internal chunks
    const remainingBlocks = parsedDocument.blocks.slice(startIndex);
    const internalChunks = splitIntoInternalChunks(remainingBlocks);

    let newTranslation = '';
    const newBlockTranslations = new Map<string, string>();
    const allMessages: vscode.LanguageModelChatMessage[] = [];

    // Add initial newline if there was existing content
    if (existingTranslation.length > 0) {
      onChunk('\n');
    }

    // Process each internal chunk
    for (let chunkIndex = 0; chunkIndex < internalChunks.length; chunkIndex++) {
      if (token.isCancellationRequested) {
        return { success: false, error: 'Translation cancelled' };
      }

      const internalBlocks = internalChunks[chunkIndex];
      const contentToTranslate = internalBlocks.map((b) => b.content).join('\n');

      // Add newline separator between internal chunks
      if (chunkIndex > 0 && newTranslation.length > 0) {
        newTranslation += '\n';
        onChunk('\n');
      }

      // Translate
      const prompt = `You are a professional translator. Translate the following Markdown content to ${targetLanguage}.
Preserve all Markdown formatting, code blocks, links, and structure exactly as they are.
Only translate the text content, not code or URLs.
Do not add any explanations or notes - output only the translated Markdown.

[Content to translate]

${contentToTranslate}`;

      const userMessage = vscode.LanguageModelChatMessage.User(prompt);
      const response = await model.sendRequest([userMessage], {}, token);

      let chunkTranslation = '';
      for await (const fragment of response.text) {
        if (token.isCancellationRequested) {
          return { success: false, error: 'Translation cancelled' };
        }
        chunkTranslation += fragment;
        newTranslation += fragment;
        onChunk(fragment);
      }

      // Parse and map translations for this internal chunk
      const parsedChunkTranslation = parseMarkdownToBlocks(chunkTranslation);
      const chunkBlockTranslations = buildBlockTranslationMapForRange(
        internalBlocks,
        parsedChunkTranslation
      );

      // Merge into new block translations
      for (const [hash, translation] of chunkBlockTranslations) {
        newBlockTranslations.set(hash, translation);
      }

      // Track messages for session
      const assistantMessage = vscode.LanguageModelChatMessage.Assistant(chunkTranslation);
      allMessages.push(userMessage, assistantMessage);
    }

    const allBlockTranslations = new Map([...existingTranslations, ...newBlockTranslations]);
    const fullTranslation = mergeTranslatedBlocks(parsedDocument, allBlockTranslations);

    // Cache
    if (enableCache) {
      translationCache.setBlocks(newBlockTranslations, targetLanguage);
      translationCache.set(session.originalContent, fullTranslation);
    }

    // Update session
    translationSession.updateSession(
      session.originalContent,
      fullTranslation,
      allMessages,
      parsedDocument,
      newBlockTranslations,
      parsedDocument.blocks.length - 1
    );

    return {
      success: true,
      translation: fullTranslation,
      blockTranslations: allBlockTranslations,
      parsedDocument,
      translatedUpToBlockIndex: parsedDocument.blocks.length - 1,
      hasMoreBlocks: false,
    };
  } catch (error) {
    return handleTranslationError(error);
  }
}

/**
 * Build a mapping from source block hashes to their translations
 * Uses position-based matching when block counts match
 */
function buildBlockTranslationMap(
  source: ParsedDocument,
  translation: ParsedDocument
): Map<string, string> {
  const map = new Map<string, string>();

  // If block counts match, use position-based mapping
  if (source.blocks.length === translation.blocks.length) {
    for (let i = 0; i < source.blocks.length; i++) {
      const sourceBlock = source.blocks[i];
      const translatedBlock = translation.blocks[i];
      map.set(sourceBlock.hash, translatedBlock.content);
    }
  } else {
    // Block counts don't match - try to match by type and relative position
    let translationIndex = 0;
    for (const sourceBlock of source.blocks) {
      // Find next matching block type in translation
      while (
        translationIndex < translation.blocks.length &&
        translation.blocks[translationIndex].type !== sourceBlock.type
      ) {
        translationIndex++;
      }

      if (translationIndex < translation.blocks.length) {
        map.set(sourceBlock.hash, translation.blocks[translationIndex].content);
        translationIndex++;
      } else {
        // No matching block found - use original content
        map.set(sourceBlock.hash, sourceBlock.content);
      }
    }
  }

  return map;
}

/**
 * Translate changed blocks incrementally using block-based approach
 */
export async function translateBlocksIncremental(
  newContent: string,
  targetLanguage: string,
  token: vscode.CancellationToken,
  onChunk: (chunk: string) => void,
  onProgress?: (message: string) => void,
  options?: BlockTranslationOptions
): Promise<TranslationResult> {
  const session = translationSession.getState();

  if (!session || !session.model) {
    return {
      success: false,
      error: 'No active translation session. Please translate the full document first.',
    };
  }

  const config = vscode.workspace.getConfiguration('markdownTranslate');
  const enableCache = config.get<boolean>('enableCache', true);

  // Get the previous translated block index
  const oldTranslatedUpToBlockIndex = session.translatedUpToBlockIndex;
  const oldDocument = session.parsedDocument;

  // Detect block-level changes
  const blockDiff = translationSession.detectBlockChanges(newContent);

  if (!blockDiff) {
    // No changes detected - return cached translation
    onChunk(session.translatedContent);
    return {
      success: true,
      translation: session.translatedContent,
      fromCache: true,
      translatedUpToBlockIndex: oldTranslatedUpToBlockIndex,
      hasMoreBlocks: oldTranslatedUpToBlockIndex !== undefined &&
        oldDocument && oldTranslatedUpToBlockIndex < oldDocument.blocks.length - 1,
    };
  }

  onProgress?.(`Detected changes: ${blockDiff.summary}`);

  try {
    // Parse new document
    const newDocument = parseMarkdownToBlocks(newContent);

    // Calculate new translatedUpToBlockIndex based on block mapping
    let newTranslatedUpToBlockIndex: number | undefined;
    if (oldTranslatedUpToBlockIndex !== undefined) {
      // Find where the translated boundary maps to in the new document
      // Use unchanged blocks to map the index
      const unchangedAfterBoundary = blockDiff.unchangedBlocks.filter(
        (ub) => ub.oldIndex <= oldTranslatedUpToBlockIndex
      );

      if (unchangedAfterBoundary.length > 0) {
        // Find the max new index among unchanged blocks that were within translated range
        const maxNewIndex = Math.max(...unchangedAfterBoundary.map((ub) => ub.newIndex));
        newTranslatedUpToBlockIndex = maxNewIndex;

        // Adjust for added/modified blocks within the translated range
        // Modified blocks at the boundary should preserve the boundary position
        for (const change of blockDiff.changes) {
          if (change.newIndex !== undefined && change.oldIndex !== undefined) {
            if (change.type === 'added' && change.newIndex <= newTranslatedUpToBlockIndex) {
              // An added block shifts the boundary
              newTranslatedUpToBlockIndex = Math.max(newTranslatedUpToBlockIndex, change.newIndex);
            } else if (change.type === 'modified' && change.oldIndex <= oldTranslatedUpToBlockIndex) {
              // A modified block that was within translated range should preserve boundary
              newTranslatedUpToBlockIndex = Math.max(newTranslatedUpToBlockIndex, change.newIndex);
            }
          }
        }
      } else {
        // If no unchanged blocks in translated range, check if there are modified blocks
        // that were within the translated range
        let maxModifiedNewIndex = -1;
        for (const change of blockDiff.changes) {
          if (change.type === 'modified' && change.oldIndex !== undefined &&
              change.newIndex !== undefined && change.oldIndex <= oldTranslatedUpToBlockIndex) {
            maxModifiedNewIndex = Math.max(maxModifiedNewIndex, change.newIndex);
          }
        }
        if (maxModifiedNewIndex >= 0) {
          newTranslatedUpToBlockIndex = maxModifiedNewIndex;
        } else {
          // No unchanged or modified blocks in range - keep same index but bounded
          newTranslatedUpToBlockIndex = Math.min(oldTranslatedUpToBlockIndex, newDocument.blocks.length - 1);
        }
      }
    }

    // Get existing block translations from session
    const existingTranslations = session.blockTranslations || new Map<string, string>();

    // Also check cache for any blocks that might be cached
    const blockHashes = newDocument.blocks.map((b) => b.hash);
    const cachedTranslations = enableCache
      ? translationCache.getBlocks(blockHashes, targetLanguage)
      : new Map<string, string>();

    // Merge existing and cached translations
    const availableTranslations = new Map([...existingTranslations, ...cachedTranslations]);

    // Identify blocks that need translation (added or modified) within translated range only
    const blocksToTranslate: MarkdownBlock[] = [];
    for (const change of blockDiff.changes) {
      if (change.type === 'added' || change.type === 'modified') {
        const block = change.newBlock!;
        // Only translate if within the previously translated range
        const withinTranslatedRange = newTranslatedUpToBlockIndex === undefined ||
          block.index <= newTranslatedUpToBlockIndex;
        const hasTranslation = availableTranslations.has(block.hash);
        if (withinTranslatedRange && !hasTranslation) {
          blocksToTranslate.push(block);
        }
      }
    }

    const hasMoreBlocks = newTranslatedUpToBlockIndex !== undefined &&
      newTranslatedUpToBlockIndex < newDocument.blocks.length - 1;

    // If no blocks need translation, merge and return
    if (blocksToTranslate.length === 0) {
      const translation = mergeTranslatedBlocks(newDocument, availableTranslations, newTranslatedUpToBlockIndex);
      onChunk(translation);

      // Update session
      translationSession.updateSession(
        newContent,
        translation,
        [],
        newDocument,
        availableTranslations,
        newTranslatedUpToBlockIndex
      );

      return {
        success: true,
        translation,
        fromCache: true,
        incremental: true,
        blockTranslations: availableTranslations,
        parsedDocument: newDocument,
        translatedUpToBlockIndex: newTranslatedUpToBlockIndex,
        hasMoreBlocks,
      };
    }

    onProgress?.(`Translating ${blocksToTranslate.length} changed block${blocksToTranslate.length > 1 ? 's' : ''}...`);

    // Translate blocks that need translation
    const newBlockTranslations = await translateBlocksStreaming(
      newDocument,
      blocksToTranslate,
      availableTranslations,
      targetLanguage,
      session.model,
      token,
      onChunk,
      newTranslatedUpToBlockIndex
    );

    if (token.isCancellationRequested) {
      return { success: false, error: 'Translation cancelled' };
    }

    // Merge all translations
    const allBlockTranslations = new Map([...availableTranslations, ...newBlockTranslations]);
    const translation = mergeTranslatedBlocks(newDocument, allBlockTranslations, newTranslatedUpToBlockIndex);

    // Cache new block translations
    if (enableCache) {
      translationCache.setBlocks(newBlockTranslations, targetLanguage);
      // Only cache the full document translation if fully translated
      if (!hasMoreBlocks) {
        translationCache.set(newContent, translation);
      }
    }

    // Update session
    const userMessage = vscode.LanguageModelChatMessage.User(`Updated translation: ${blockDiff.summary}`);
    const assistantMessage = vscode.LanguageModelChatMessage.Assistant(translation);
    translationSession.updateSession(
      newContent,
      translation,
      [userMessage, assistantMessage],
      newDocument,
      allBlockTranslations,
      newTranslatedUpToBlockIndex
    );

    return {
      success: true,
      translation,
      incremental: true,
      blockTranslations: allBlockTranslations,
      parsedDocument: newDocument,
      translatedUpToBlockIndex: newTranslatedUpToBlockIndex,
      hasMoreBlocks,
    };
  } catch (error) {
    return handleTranslationError(error);
  }
}

/**
 * Translate a list of blocks with streaming output
 * @param upToBlockIndex - Optional: only output blocks up to this index
 */
async function translateBlocksStreaming(
  document: ParsedDocument,
  blocksToTranslate: MarkdownBlock[],
  existingTranslations: Map<string, string>,
  targetLanguage: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  onChunk: (chunk: string) => void,
  upToBlockIndex?: number
): Promise<Map<string, string>> {
  const newTranslations = new Map<string, string>();
  const lastBlockIndex = upToBlockIndex ?? document.blocks.length - 1;

  // Sort blocks by index to translate in order
  const sortedBlocks = [...blocksToTranslate].sort((a, b) => a.index - b.index);

  // Build the full translation progressively
  let currentTranslation = '';
  let lastOutputIndex = -1;

  for (const block of sortedBlocks) {
    if (token.isCancellationRequested) {
      break;
    }

    // Skip blocks beyond the limit
    if (block.index > lastBlockIndex) {
      break;
    }

    // Output any unchanged blocks before this one (up to limit)
    for (let i = lastOutputIndex + 1; i < block.index && i <= lastBlockIndex; i++) {
      const prevBlock = document.blocks[i];
      const prevTranslation = existingTranslations.get(prevBlock.hash) ?? newTranslations.get(prevBlock.hash);
      if (prevTranslation !== undefined) {
        if (currentTranslation.length > 0) {
          currentTranslation += '\n';
          onChunk('\n');
        }
        currentTranslation += prevTranslation;
        onChunk(prevTranslation);
      }
    }

    // Build context for translation
    const context = buildBlockContext(document, block, existingTranslations, newTranslations);

    // Translate this block
    const translation = await translateSingleBlock(
      block,
      context,
      targetLanguage,
      model,
      token,
      (chunk) => {
        if (currentTranslation.length > 0 && !currentTranslation.endsWith('\n')) {
          currentTranslation += '\n';
          onChunk('\n');
        }
        currentTranslation += chunk;
        onChunk(chunk);
      }
    );

    if (translation !== undefined && translation !== null) {
      newTranslations.set(block.hash, translation);
    }

    lastOutputIndex = block.index;
  }

  // Output any remaining unchanged blocks (up to the limit)
  for (let i = lastOutputIndex + 1; i <= lastBlockIndex && i < document.blocks.length; i++) {
    const block = document.blocks[i];
    const translation = existingTranslations.get(block.hash) ?? newTranslations.get(block.hash);
    if (translation !== undefined) {
      if (currentTranslation.length > 0) {
        currentTranslation += '\n';
        onChunk('\n');
      }
      currentTranslation += translation;
      onChunk(translation);
    }
  }

  return newTranslations;
}

/**
 * Build translation context for a block
 */
function buildBlockContext(
  document: ParsedDocument,
  block: MarkdownBlock,
  existingTranslations: Map<string, string>,
  newTranslations: Map<string, string>
): BlockTranslationContext {
  const context: BlockTranslationContext = { block };

  // Get previous block's translation if available
  if (block.index > 0) {
    const prevBlock = document.blocks[block.index - 1];
    const prevTranslation = existingTranslations.get(prevBlock.hash) ?? newTranslations.get(prevBlock.hash);
    if (prevTranslation !== undefined) {
      context.previousTranslation = prevTranslation;
    }
  }

  // Get next block's content if available
  if (block.index < document.blocks.length - 1) {
    const nextBlock = document.blocks[block.index + 1];
    context.nextBlockContent = nextBlock.content;
  }

  return context;
}

/**
 * Translate a single block
 */
async function translateSingleBlock(
  block: MarkdownBlock,
  context: BlockTranslationContext,
  targetLanguage: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  onChunk: (chunk: string) => void
): Promise<string | null> {
  // Skip translation for certain block types
  if (block.type === 'code_block' || block.type === 'blank_lines' || block.type === 'thematic_break') {
    // Just pass through without translation
    onChunk(block.content);
    return block.content;
  }

  // Build prompt with context
  let prompt = `You are a professional translator. Translate the following Markdown block to ${targetLanguage}.
Preserve all Markdown formatting exactly as it is.
Only translate the text content, not code, URLs, or Markdown syntax.
Do not add any explanations or notes - output only the translated Markdown.

`;

  if (context.previousTranslation) {
    prompt += `[CONTEXT - Previous block (already translated)]:\n${context.previousTranslation}\n\n`;
  }

  prompt += `[TRANSLATE THIS BLOCK]:\n${block.content}`;

  if (context.nextBlockContent) {
    prompt += `\n\n[CONTEXT - Next block (original)]:\n${context.nextBlockContent}`;
  }

  const userMessage = vscode.LanguageModelChatMessage.User(prompt);
  const messages = [userMessage];

  try {
    const response = await model.sendRequest(messages, {}, token);

    let translation = '';
    for await (const fragment of response.text) {
      if (token.isCancellationRequested) {
        return null;
      }
      translation += fragment;
      onChunk(fragment);
    }

    return translation;
  } catch (error) {
    if (token.isCancellationRequested) {
      return null;
    }
    throw error;
  }
}

/**
 * Merge translated blocks into final document
 * @param document - The parsed document
 * @param translations - Map of block hash to translation
 * @param upToBlockIndex - Optional: only merge blocks up to this index (inclusive)
 */
export function mergeTranslatedBlocks(
  document: ParsedDocument,
  translations: Map<string, string>,
  upToBlockIndex?: number
): string {
  const translatedBlocks: string[] = [];
  const lastIndex = upToBlockIndex ?? document.blocks.length - 1;

  for (let i = 0; i <= lastIndex && i < document.blocks.length; i++) {
    const block = document.blocks[i];
    const translation = translations.get(block.hash);
    if (translation !== undefined) {
      translatedBlocks.push(translation);
    } else {
      // No translation available - use original (shouldn't happen normally)
      translatedBlocks.push(block.content);
    }
  }

  return translatedBlocks.join('\n');
}

// Re-export parseMarkdownToBlocks for use in other modules
export { parseMarkdownToBlocks } from './parser';
