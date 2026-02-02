import * as vscode from 'vscode';
import {
  translateIncremental,
  translateContentBlockBased,
  translateBlocksIncremental,
  translateNextBlockChunk,
  translateAllRemainingBlocks,
  getAvailableModels,
  hasTranslationSession,
  clearTranslationSession,
  ModelInfo,
} from './translator';
import { PreviewPanel, PreviewData, StreamingData, PartialTranslationInfo } from './preview';
import { translationCache } from './cache';
import { translationSession } from './session';

interface TranslationState {
  editor: vscode.TextEditor;
  originalFull: string;
  translatedFull: string;
  models: ModelInfo[];
  selectedModelId: string;
  targetLanguage: string;
  /** Position in original content where translation stopped (for chunked translation) */
  translatedUpTo: number;
}

let currentState: TranslationState | undefined;
let currentPanel: PreviewPanel | undefined;
let documentWatcher: vscode.Disposable | undefined;
let documentSaveWatcher: vscode.Disposable | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let currentCancellationSource: vscode.CancellationTokenSource | undefined;
let lastChangedBlockCount: number = 0;

/**
 * Get or create the output channel for logging
 */
function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Markdown AI Translator');
  }
  return outputChannel;
}

/**
 * Log a message to the output channel
 */
function log(message: string): void {
  const channel = getOutputChannel();
  const timestamp = new Date().toLocaleTimeString();
  channel.appendLine(`[${timestamp}] ${message}`);
}

/**
 * Get effective target language from configuration
 * If "Other" is selected, use customTargetLanguage
 */
function getEffectiveTargetLanguage(): string {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  const targetLanguage = config.get<string>('targetLanguage', 'Japanese');
  if (targetLanguage === 'Other') {
    const customLanguage = config.get<string>('customTargetLanguage', '');
    return customLanguage.trim() || 'Japanese'; // Fallback to Japanese if empty
  }
  return targetLanguage;
}

/**
 * Find a good split point in Markdown content (at heading or paragraph boundary)
 */
function findSplitPoint(content: string, targetLength: number): number {
  if (content.length <= targetLength) {
    return content.length;
  }

  // Look for a good split point within the target range
  const searchStart = Math.max(0, targetLength - 500);
  const searchEnd = Math.min(content.length, targetLength + 500);
  const searchArea = content.slice(searchStart, searchEnd);

  // Priority 1: Split at heading (# at start of line)
  const headingMatch = searchArea.match(/\n(#{1,6}\s)/);
  if (headingMatch && headingMatch.index !== undefined) {
    return searchStart + headingMatch.index + 1; // Include the newline before
  }

  // Priority 2: Split at empty line (paragraph boundary)
  const paragraphMatch = searchArea.match(/\n\n/);
  if (paragraphMatch && paragraphMatch.index !== undefined) {
    return searchStart + paragraphMatch.index + 2; // After the double newline
  }

  // Priority 3: Split at single newline
  const lineMatch = searchArea.match(/\n/);
  if (lineMatch && lineMatch.index !== undefined) {
    return searchStart + lineMatch.index + 1;
  }

  // Fallback: split at target length
  return targetLength;
}

/**
 * Get the chunk size from configuration
 */
function getChunkSize(): number {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  return config.get<number>('chunkSize', 5000);
}

/**
 * Get debug mode from configuration
 */
function getDebugMode(): boolean {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  return config.get<boolean>('debugMode', false);
}

/**
 * Get auto-translate threshold from configuration
 * @returns Number of block changes to trigger auto-translate (0 = disabled)
 */
function getAutoTranslateThreshold(): number {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  return config.get<number>('autoTranslateThreshold', 0);
}

/**
 * Create partial translation info
 */
function createPartialInfo(originalFull: string, translatedUpTo: number): PartialTranslationInfo | undefined {
  const totalChars = originalFull.length;
  if (translatedUpTo >= totalChars) {
    return undefined; // Fully translated
  }
  return {
    hasMore: true,
    remainingChars: totalChars - translatedUpTo,
    translatedUpTo,
    totalChars,
  };
}

/**
 * Estimate translated position based on partial translation length
 * Assumes roughly 1:1 character ratio between source and translation
 */
function estimateTranslatedPosition(
  partialTranslation: string,
  sourceChunkLength: number,
  previousTranslatedUpTo: number,
  totalLength: number
): number {
  if (partialTranslation.length === 0) {
    return previousTranslatedUpTo;
  }
  // Estimate based on translation length ratio
  const estimatedChunkProgress = Math.min(partialTranslation.length / sourceChunkLength, 1);
  const estimatedPosition = previousTranslatedUpTo + Math.floor(sourceChunkLength * estimatedChunkProgress);
  return Math.min(estimatedPosition, totalLength);
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Markdown AI Translator is now active');

  // Register main translate command (icon button)
  const translateCommand = vscode.commands.registerCommand(
    'markdownTranslate.translatePreview',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      if (editor.document.languageId !== 'markdown') {
        return;
      }

      const originalFull = editor.document.getText();
      if (!originalFull.trim()) {
        return;
      }

      const config = vscode.workspace.getConfiguration('markdownTranslate');
      const targetLanguage = getEffectiveTargetLanguage();
      const selectedModelId = config.get<string>('modelId', '');

      // Create or show preview panel
      const panel = PreviewPanel.createOrShow(context.extensionUri);
      currentPanel = panel;
      panel.showLoading('Loading models...');

      // Get available models
      const models = await getAvailableModels();

      panel.showLoading('Translating document...');

      // Set up handler for translation reload request (legacy)
      panel.onRequestTranslation(async () => {
        if (currentState) {
          await reloadTranslation(panel, context, currentState.targetLanguage);
        }
      });

      // Set up handler for update translation (incremental - changed blocks only)
      panel.onUpdateTranslation(async () => {
        if (currentState) {
          await reloadTranslation(panel, context, currentState.targetLanguage);
        }
      });

      // Set up handler for retranslate (from scratch)
      panel.onRetranslate(async () => {
        if (currentState) {
          // Clear session to force full re-translation
          clearTranslationSession();
          await reloadTranslation(panel, context, currentState.targetLanguage, { bypassCache: true });
        }
      });

      // Set up handler for model change - just save setting, don't re-translate
      panel.onModelChange(async (modelId: string) => {
        await saveModelSetting(modelId);
        if (currentState) {
          currentState.selectedModelId = modelId;
          // Update UI immediately
          panel.updateModelId(modelId);
          // Next Continue/Diff Update/Retranslate will use the new model
        }
      });

      // Set up handler for language change - re-translate with new language
      panel.onLanguageChange(async (language: string) => {
        await saveLanguageSetting(language);
        if (currentState) {
          currentState.targetLanguage = language;
          // Clear session since language changed
          clearTranslationSession();
          // Re-translate with new language, bypassing cache
          await reloadTranslation(panel, context, language, { bypassCache: true });
        }
      });

      // Set up handler for continue translation (chunked documents)
      panel.onContinueTranslation(async () => {
        if (currentState && currentState.translatedUpTo < currentState.originalFull.length) {
          await continueTranslation(panel, context);
        }
      });

      // Set up handler for translate all (translate remaining content at once)
      panel.onTranslateAll(async () => {
        if (currentState && currentState.translatedUpTo < currentState.originalFull.length) {
          await translateAllRemaining(panel, context);
        }
      });

      // Set up handler for chunk size change
      panel.onChunkSizeChange(async (newChunkSize: number) => {
        const wasStreaming = currentCancellationSource !== undefined;

        // Cancel current translation if streaming
        if (wasStreaming) {
          currentCancellationSource!.cancel();
        }

        // Save new chunk size setting
        await saveChunkSizeSetting(newChunkSize);

        // Update chunk size in webview UI
        panel.updateChunkSize(newChunkSize);

        // If was streaming, continue translation with new chunk size after a short delay
        if (wasStreaming && currentState && hasTranslationSession()) {
          // Wait for cancellation to complete
          await new Promise(resolve => setTimeout(resolve, 100));

          // Continue translation with new chunk size
          await continueTranslation(panel, context);
        }
      });

      // Set up handler for cancel translation
      panel.onCancelTranslation(() => {
        if (currentCancellationSource) {
          currentCancellationSource.cancel();
        }
      });

      // Set up handler for auto-translate threshold change
      panel.onAutoTranslateThresholdChange(async (threshold: number) => {
        await saveAutoTranslateThresholdSetting(threshold);
        panel.updateAutoTranslateThreshold(threshold);
      });

      // Start streaming - show original immediately
      const fileName = editor.document.fileName.split('/').pop() || 'document';
      const chunkSize = getChunkSize();
      const imageBaseUri = panel.getImageBaseUri(editor.document.uri);
      const debugMode = getDebugMode();
      const autoTranslateThreshold = getAutoTranslateThreshold();
      const streamingData: StreamingData = {
        originalFull,
        models,
        selectedModelId,
        targetLanguage,
        chunkSize,
        imageBaseUri,
        debugMode,
        autoTranslateThreshold,
      };
      await panel.startStreaming(streamingData, `Translate: ${fileName}`);

      // Create cancellation source for webview cancel
      currentCancellationSource = new vscode.CancellationTokenSource();
      let partialTranslation = '';

      // Translate document with block-based streaming
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Translating...',
          cancellable: true,
        },
        async (progress, progressToken) => {
          // Track if cancelled from webview
          currentCancellationSource!.token.onCancellationRequested(() => {
            // Cancelled from webview
          });

          const result = await translateContentBlockBased(
            originalFull,
            targetLanguage,
            currentCancellationSource!.token,
            (chunk) => {
              partialTranslation += chunk;
              panel.sendStreamChunk(chunk);
            },
            { modelId: selectedModelId || undefined }
          );

          // Check if cancelled
          const isCancelled = progressToken.isCancellationRequested || currentCancellationSource!.token.isCancellationRequested;

          if (isCancelled) {
            // Save partial translation
            currentState = {
              editor,
              originalFull,
              translatedFull: partialTranslation,
              models,
              selectedModelId,
              targetLanguage,
              translatedUpTo: partialTranslation.length,
            };

            // Start watching for document changes
            setupDocumentWatcher(editor.document, panel);

            // Show preview with partial info
            const partial = createPartialInfo(originalFull, partialTranslation.length);
            panel.cancelStreaming(partial!);
            log('Translation cancelled');
            currentCancellationSource = undefined;
            return;
          }

          if (!result.success) {
            // Save partial translation and show error
            currentState = {
              editor,
              originalFull,
              translatedFull: partialTranslation,
              models,
              selectedModelId,
              targetLanguage,
              translatedUpTo: partialTranslation.length,
            };
            setupDocumentWatcher(editor.document, panel);
            const partial = createPartialInfo(originalFull, partialTranslation.length);
            panel.cancelStreaming(partial!);
            panel.showError(result.error || 'Translation failed');
            currentCancellationSource = undefined;
            return;
          }

          // End streaming only on success
          panel.endStreaming();

          // Calculate approximate position based on block index
          const blockIndex = result.translatedUpToBlockIndex ?? 0;
          const totalBlocks = result.parsedDocument?.blocks.length ?? 1;
          const approxPosition = result.hasMoreBlocks
            ? Math.round(((blockIndex + 1) / totalBlocks) * originalFull.length)
            : originalFull.length;

          // Store state
          currentState = {
            editor,
            originalFull,
            translatedFull: result.translation!,
            models,
            selectedModelId,
            targetLanguage,
            translatedUpTo: approxPosition,
          };

          // Start watching for document changes
          setupDocumentWatcher(editor.document, panel);

          // Show preview with partial info if more to translate
          if (result.hasMoreBlocks) {
            const partial = createPartialInfo(originalFull, approxPosition);
            const previewData: PreviewData = {
              originalFull,
              translatedFull: result.translation!,
              models,
              selectedModelId,
              targetLanguage,
              chunkSize,
              partial,
              imageBaseUri,
              debugMode,
              autoTranslateThreshold,
            };
            panel.showPreview(previewData, `Translate: ${fileName}`);
            log(`Translated ${Math.round(((blockIndex + 1) / totalBlocks) * 100)}% (${blockIndex + 1}/${totalBlocks} blocks)`);
          } else {
            log('Block-based translation complete');
          }
          currentCancellationSource = undefined;
        }
      );
    }
  );

  // Register clear cache command
  const clearCacheCommand = vscode.commands.registerCommand(
    'markdownTranslate.clearCache',
    () => {
      translationCache.clear();
      clearTranslationSession();
    }
  );

  context.subscriptions.push(translateCommand, clearCacheCommand);
}

async function saveModelSetting(modelId: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  await config.update('modelId', modelId, vscode.ConfigurationTarget.Global);
}

const PRESET_LANGUAGES = ['Japanese', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Korean'];

async function saveChunkSizeSetting(chunkSize: number): Promise<void> {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  await config.update('chunkSize', chunkSize, vscode.ConfigurationTarget.Global);
}

async function saveAutoTranslateThresholdSetting(threshold: number): Promise<void> {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  await config.update('autoTranslateThreshold', threshold, vscode.ConfigurationTarget.Global);
}

async function saveLanguageSetting(language: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('markdownTranslate');
  if (PRESET_LANGUAGES.includes(language)) {
    // Preset language - save directly
    await config.update('targetLanguage', language, vscode.ConfigurationTarget.Global);
  } else {
    // Custom language - save to customTargetLanguage and set targetLanguage to "Other"
    await config.update('targetLanguage', 'Other', vscode.ConfigurationTarget.Global);
    await config.update('customTargetLanguage', language, vscode.ConfigurationTarget.Global);
  }
}

interface ReloadOptions {
  bypassCache?: boolean;
}

/**
 * Reload translation - uses block-based incremental translation if session exists
 */
async function reloadTranslation(
  panel: PreviewPanel,
  context: vscode.ExtensionContext,
  targetLanguage: string,
  options?: ReloadOptions
): Promise<void> {
  const bypassCache = options?.bypassCache ?? false;
  // Use active editor or fall back to editor from currentState (when webview has focus)
  const editor = vscode.window.activeTextEditor || currentState?.editor;
  if (!editor) {
    return;
  }

  const newContent = editor.document.getText();
  if (!newContent.trim()) {
    return;
  }

  const config = vscode.workspace.getConfiguration('markdownTranslate');
  const selectedModelId = config.get<string>('modelId', '');

  // Check if we have an active session for incremental translation (skip if bypassCache)
  if (hasTranslationSession() && !bypassCache) {
    const models = currentState?.models || [];
    const fileName = editor.document.fileName.split('/').pop() || 'document';

    // Start incremental mode - show original immediately
    const chunkSize = getChunkSize();
    const imageBaseUri = panel.getImageBaseUri(editor.document.uri);
    const debugMode = getDebugMode();
    const autoTranslateThreshold = getAutoTranslateThreshold();
    const incrementalData: StreamingData = {
      originalFull: newContent,
      models,
      selectedModelId,
      targetLanguage,
      chunkSize,
      imageBaseUri,
      debugMode,
      autoTranslateThreshold,
    };
    await panel.startIncremental(incrementalData, `Translate: ${fileName}`, 'Detecting changes...');

    // Create cancellation source for webview cancel
    currentCancellationSource = new vscode.CancellationTokenSource();
    let partialTranslation = '';

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Updating Translation',
        cancellable: true,
      },
      async (progress, progressToken) => {
        // Use block-based incremental translation
        const result = await translateBlocksIncremental(
          newContent,
          targetLanguage,
          currentCancellationSource!.token,
          (chunk) => {
            partialTranslation += chunk;
            panel.sendStreamChunk(chunk);
          },
          (message) => {
            progress.report({ message });
            panel.updateIncrementalProgress(message);
          },
          { modelId: selectedModelId || undefined }
        );

        const isCancelled = progressToken.isCancellationRequested || currentCancellationSource!.token.isCancellationRequested;

        // Check if cancelled
        if (isCancelled) {
          // Keep previous translation (if any) and show with "続きを翻訳" option
          const previousTranslation = currentState?.translatedFull || '';
          const previousTranslatedUpTo = currentState?.translatedUpTo || 0;
          currentState = {
            editor,
            originalFull: newContent,
            translatedFull: previousTranslation,
            models,
            selectedModelId,
            targetLanguage,
            translatedUpTo: previousTranslatedUpTo,
          };
          const partial = createPartialInfo(newContent, previousTranslatedUpTo);
          panel.cancelStreaming(partial!);
          currentCancellationSource = undefined;
          return;
        }

        if (result.success && result.translation) {
          // Calculate approximate position based on block index
          const blockIndex = result.translatedUpToBlockIndex ?? 0;
          const totalBlocks = result.parsedDocument?.blocks.length ?? 1;
          const approxPosition = result.hasMoreBlocks
            ? Math.round(((blockIndex + 1) / totalBlocks) * newContent.length)
            : newContent.length;

          // Update state
          currentState = {
            editor,
            originalFull: newContent,
            translatedFull: result.translation,
            models,
            selectedModelId,
            targetLanguage,
            translatedUpTo: approxPosition,
          };

          // End incremental mode with translated content
          panel.endIncremental(result.translation);

          // Show preview with partial info if more to translate
          if (result.hasMoreBlocks) {
            const partial = createPartialInfo(newContent, approxPosition);
            const previewData: PreviewData = {
              originalFull: newContent,
              translatedFull: result.translation,
              models,
              selectedModelId,
              targetLanguage,
              chunkSize,
              partial,
              imageBaseUri,
              debugMode,
              autoTranslateThreshold,
            };
            panel.showPreview(previewData, `Translate: ${fileName}`);
            log(`Incremental translation: ${Math.round(((blockIndex + 1) / totalBlocks) * 100)}% (${blockIndex + 1}/${totalBlocks} blocks)`);
          } else if (result.fromCache) {
            log('Translation loaded from cache');
          } else if (result.incremental) {
            log('Block-based incremental translation complete');
          }
        } else {
          // Keep previous translation and show error
          const previousTranslation = currentState?.translatedFull || '';
          const previousTranslatedUpTo = currentState?.translatedUpTo || 0;
          currentState = {
            editor,
            originalFull: newContent,
            translatedFull: previousTranslation,
            models,
            selectedModelId,
            targetLanguage,
            translatedUpTo: previousTranslatedUpTo,
          };
          const partial = createPartialInfo(newContent, previousTranslatedUpTo);
          panel.cancelStreaming(partial!);
          panel.showError(result.error || 'Translation update failed');
        }
        currentCancellationSource = undefined;
      }
    );
  } else {
    // No session - do full block-based translation with streaming
    const models = await getAvailableModels();
    const fileName = editor.document.fileName.split('/').pop() || 'document';
    const chunkSize = getChunkSize();
    const imageBaseUri = panel.getImageBaseUri(editor.document.uri);
    const debugMode = getDebugMode();
    const autoTranslateThreshold = getAutoTranslateThreshold();

    const streamingData: StreamingData = {
      originalFull: newContent,
      models,
      selectedModelId,
      targetLanguage,
      chunkSize,
      imageBaseUri,
      debugMode,
      autoTranslateThreshold,
    };
    await panel.startStreaming(streamingData, `Translate: ${fileName}`);

    // Create cancellation source for webview cancel
    currentCancellationSource = new vscode.CancellationTokenSource();
    let partialTranslation = '';

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Translating...',
        cancellable: true,
      },
      async (progress, progressToken) => {
        // Use block-based translation
        const result = await translateContentBlockBased(
          newContent,
          targetLanguage,
          currentCancellationSource!.token,
          (chunk) => {
            partialTranslation += chunk;
            panel.sendStreamChunk(chunk);
          },
          { modelId: selectedModelId || undefined, bypassCache }
        );

        const isCancelled = progressToken.isCancellationRequested || currentCancellationSource!.token.isCancellationRequested;

        if (isCancelled) {
          // Estimate how much was translated
          const estimatedPosition = estimateTranslatedPosition(
            partialTranslation,
            newContent.length,
            0,
            newContent.length
          );

          // Save partial translation and show "続きを翻訳" button
          currentState = {
            editor,
            originalFull: newContent,
            translatedFull: partialTranslation,
            models,
            selectedModelId,
            targetLanguage,
            translatedUpTo: estimatedPosition,
          };

          const partial = createPartialInfo(newContent, estimatedPosition);
          panel.cancelStreaming(partial!);
          log(`Translation cancelled during reload at ~${Math.round((estimatedPosition / newContent.length) * 100)}%`);
          currentCancellationSource = undefined;
          return;
        }

        if (!result.success) {
          // Estimate how much was translated
          const estimatedPosition = estimateTranslatedPosition(
            partialTranslation,
            newContent.length,
            0,
            newContent.length
          );

          // Save partial translation and show error
          currentState = {
            editor,
            originalFull: newContent,
            translatedFull: partialTranslation,
            models,
            selectedModelId,
            targetLanguage,
            translatedUpTo: estimatedPosition,
          };
          panel.cancelStreaming(createPartialInfo(newContent, estimatedPosition)!);
          panel.showError(result.error || 'Translation failed');
          currentCancellationSource = undefined;
          return;
        }

        // End streaming only on success
        panel.endStreaming();

        // Calculate approximate position based on block index
        const blockIndex = result.translatedUpToBlockIndex ?? 0;
        const totalBlocks = result.parsedDocument?.blocks.length ?? 1;
        const approxPosition = result.hasMoreBlocks
          ? Math.round(((blockIndex + 1) / totalBlocks) * newContent.length)
          : newContent.length;

        currentState = {
          editor,
          originalFull: newContent,
          translatedFull: result.translation!,
          models,
          selectedModelId,
          targetLanguage,
          translatedUpTo: approxPosition,
        };

        // Show preview with partial info if more to translate
        if (result.hasMoreBlocks) {
          const partial = createPartialInfo(newContent, approxPosition);
          const previewData: PreviewData = {
            originalFull: newContent,
            translatedFull: result.translation!,
            models,
            selectedModelId,
            targetLanguage,
            chunkSize,
            partial,
            imageBaseUri,
            debugMode,
            autoTranslateThreshold,
          };
          panel.showPreview(previewData, `Translate: ${fileName}`);
          log(`Translated ${Math.round(((blockIndex + 1) / totalBlocks) * 100)}% (${blockIndex + 1}/${totalBlocks} blocks)`);
        } else {
          log('Block-based translation complete');
        }
        currentCancellationSource = undefined;
      }
    );
  }
}

/**
 * Continue translation for chunked documents (block-based)
 */
async function continueTranslation(
  panel: PreviewPanel,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!currentState) {
    return;
  }

  const { originalFull, targetLanguage, selectedModelId, models } = currentState;
  const editor = vscode.window.activeTextEditor || currentState.editor;

  const chunkSize = getChunkSize();
  const fileName = editor.document.fileName.split('/').pop() || 'document';
  const imageBaseUri = panel.getImageBaseUri(editor.document.uri);
  const debugMode = getDebugMode();
  const autoTranslateThreshold = getAutoTranslateThreshold();

  // Get existing translation for continuation
  const existingTranslation = currentState.translatedFull || '';

  // Start streaming for continuation
  const streamingData: StreamingData = {
    originalFull,
    models,
    selectedModelId,
    targetLanguage,
    chunkSize,
    imageBaseUri,
    existingTranslation,
    debugMode,
    autoTranslateThreshold,
  };
  await panel.startStreaming(streamingData, `Translate: ${fileName}`);

  // Create cancellation source for webview cancel
  currentCancellationSource = new vscode.CancellationTokenSource();
  // Initialize with existing translation (webview already shows this via existingTranslation)
  let partialTranslation = existingTranslation;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Continuing Translation',
      cancellable: true,
    },
    async (progress, progressToken) => {
      progress.report({ message: 'Translating...' });

      const result = await translateNextBlockChunk(
        targetLanguage,
        chunkSize,
        currentCancellationSource!.token,
        (chunk) => {
          partialTranslation += chunk;
          panel.sendStreamChunk(chunk);
        },
        { modelId: selectedModelId || undefined }
      );

      const isCancelled = progressToken.isCancellationRequested || currentCancellationSource!.token.isCancellationRequested;

      if (isCancelled) {
        currentState = {
          ...currentState!,
          translatedFull: partialTranslation,
        };
        const partial = createPartialInfo(originalFull, currentState.translatedUpTo);
        panel.cancelStreaming(partial!);
        log('Translation cancelled during continuation');
        currentCancellationSource = undefined;
        return;
      }

      if (!result.success) {
        currentState = {
          ...currentState!,
          translatedFull: partialTranslation,
        };
        const partial = createPartialInfo(originalFull, currentState.translatedUpTo);
        panel.cancelStreaming(partial!);
        panel.showError(result.error || 'Translation failed');
        currentCancellationSource = undefined;
        return;
      }

      // End streaming
      panel.endStreaming();

      // Calculate approximate position based on block index
      const blockIndex = result.translatedUpToBlockIndex ?? 0;
      const totalBlocks = result.parsedDocument?.blocks.length ?? 1;
      const approxPosition = result.hasMoreBlocks
        ? Math.round(((blockIndex + 1) / totalBlocks) * originalFull.length)
        : originalFull.length;

      // Update state with new translated position
      currentState = {
        ...currentState!,
        translatedFull: result.translation!,
        translatedUpTo: approxPosition,
      };

      // Show preview with partial info if more to translate
      if (result.hasMoreBlocks) {
        const partial = createPartialInfo(originalFull, approxPosition);
        const previewData: PreviewData = {
          originalFull,
          translatedFull: result.translation!,
          models,
          selectedModelId,
          targetLanguage,
          chunkSize,
          partial,
          imageBaseUri,
          debugMode,
          autoTranslateThreshold,
        };
        panel.showPreview(previewData, `Translate: ${fileName}`);
        log(`Translated ${Math.round(((blockIndex + 1) / totalBlocks) * 100)}% (${blockIndex + 1}/${totalBlocks} blocks)`);
      } else {
        log('Translation complete');
      }
      currentCancellationSource = undefined;
    }
  );
}

/**
 * Translate all remaining content at once (block-based)
 */
async function translateAllRemaining(
  panel: PreviewPanel,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!currentState) {
    return;
  }

  const { originalFull, targetLanguage, selectedModelId, models } = currentState;
  const editor = vscode.window.activeTextEditor || currentState.editor;
  const chunkSize = getChunkSize();
  const debugMode = getDebugMode();
  const autoTranslateThreshold = getAutoTranslateThreshold();

  const fileName = editor.document.fileName.split('/').pop() || 'document';
  const imageBaseUri = panel.getImageBaseUri(editor.document.uri);

  log('Translating all remaining blocks...');

  // Start streaming for the remaining content
  const streamingData: StreamingData = {
    originalFull,
    models,
    selectedModelId,
    targetLanguage,
    chunkSize,
    imageBaseUri,
    debugMode,
    autoTranslateThreshold,
  };
  await panel.startStreaming(streamingData, `Translate: ${fileName}`);

  // Create cancellation source for webview cancel
  currentCancellationSource = new vscode.CancellationTokenSource();
  let partialTranslation = '';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Translating All Remaining',
      cancellable: true,
    },
    async (progress, progressToken) => {
      progress.report({ message: 'Translating...' });

      const result = await translateAllRemainingBlocks(
        targetLanguage,
        currentCancellationSource!.token,
        (chunk) => {
          partialTranslation += chunk;
          panel.sendStreamChunk(chunk);
        },
        { modelId: selectedModelId || undefined }
      );

      const isCancelled = progressToken.isCancellationRequested || currentCancellationSource!.token.isCancellationRequested;

      if (isCancelled) {
        currentState = {
          ...currentState!,
          translatedFull: partialTranslation,
        };
        const partial = createPartialInfo(originalFull, currentState.translatedUpTo);
        panel.cancelStreaming(partial!);
        log('Translation cancelled during translate-all');
        currentCancellationSource = undefined;
        return;
      }

      if (!result.success) {
        currentState = {
          ...currentState!,
          translatedFull: partialTranslation,
        };
        const partial = createPartialInfo(originalFull, currentState.translatedUpTo);
        panel.cancelStreaming(partial!);
        panel.showError(result.error || 'Translation failed');
        currentCancellationSource = undefined;
        return;
      }

      // End streaming
      panel.endStreaming();

      // Update state - all content is now translated
      currentState = {
        ...currentState!,
        translatedFull: result.translation!,
        translatedUpTo: originalFull.length,
      };

      log('Translation complete (all remaining blocks)');
      currentCancellationSource = undefined;
    }
  );
}

/**
 * Set up document change watcher to detect changes in the source file
 * - onDidChangeTextDocument: Real-time UI update (change count indicator)
 * - onDidSaveTextDocument: Auto-translate trigger (only on save)
 */
function setupDocumentWatcher(document: vscode.TextDocument, panel: PreviewPanel): void {
  // Dispose existing watchers
  if (documentWatcher) {
    documentWatcher.dispose();
  }
  if (documentSaveWatcher) {
    documentSaveWatcher.dispose();
  }

  // Real-time change detection for UI (shows "X blocks changed" indicator)
  documentWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
    // Only watch the specific document
    if (event.document !== document) {
      return;
    }

    // Check if content has changed from stored state
    if (currentState) {
      const currentContent = document.getText();
      // Detect block-level changes
      const blockDiff = translationSession.detectBlockChanges(currentContent);
      // Get the translated range - only count changes within translated blocks
      const translatedUpToBlockIndex = translationSession.getTranslatedUpToBlockIndex();
      // Filter changes:
      // 1. Exclude blank_lines (they don't need re-translation)
      // 2. Only count changes within the translated range
      const changedBlockCount = blockDiff
        ? blockDiff.changes.filter((change) => {
            const blockType = change.newBlock?.type ?? change.oldBlock?.type;
            if (blockType === 'blank_lines') return false;

            // If no translation yet, no changes to report
            if (translatedUpToBlockIndex === undefined) return false;

            // Check if the change is within the translated range
            if (change.type === 'modified' || change.type === 'removed') {
              // For modified/removed, check old index
              return (change.oldIndex ?? Infinity) <= translatedUpToBlockIndex;
            } else {
              // For added, check new index (inserted within translated area)
              return (change.newIndex ?? Infinity) <= translatedUpToBlockIndex;
            }
          }).length
        : 0;

      // Update UI and store count for save-time check
      lastChangedBlockCount = changedBlockCount;
      panel.notifyDocumentChanged(changedBlockCount);
    }
  });

  // Auto-translate trigger on save only
  documentSaveWatcher = vscode.workspace.onDidSaveTextDocument((savedDocument) => {
    // Only watch the specific document
    if (savedDocument !== document) {
      return;
    }

    // Check if auto-translate should trigger
    const threshold = getAutoTranslateThreshold();
    if (threshold > 0 && lastChangedBlockCount >= threshold && !currentCancellationSource && currentState && currentPanel) {
      log(`Auto-translate triggered on save: ${lastChangedBlockCount} blocks changed (threshold: ${threshold})`);
      reloadTranslation(panel, {} as vscode.ExtensionContext, currentState.targetLanguage);
    }
  });
}

export function deactivate() {
  if (documentWatcher) {
    documentWatcher.dispose();
    documentWatcher = undefined;
  }
  if (documentSaveWatcher) {
    documentSaveWatcher.dispose();
    documentSaveWatcher = undefined;
  }
  currentState = undefined;
  currentPanel = undefined;
  lastChangedBlockCount = 0;
  clearTranslationSession();
  console.log('Markdown AI Translator is now deactivated');
}
