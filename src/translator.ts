import * as vscode from 'vscode';
import { translationCache } from './cache';
import { translationSession, ContentDiff } from './session';

export interface TranslationResult {
  success: boolean;
  translation?: string;
  error?: string;
  fromCache?: boolean;
  incremental?: boolean;
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

---

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

---

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
