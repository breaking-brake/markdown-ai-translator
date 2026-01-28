import * as vscode from 'vscode';
import {
  translateContentStreaming,
  translateIncremental,
  getAvailableModels,
  hasTranslationSession,
  clearTranslationSession,
  ModelInfo,
} from './translator';
import { PreviewPanel, PreviewData, StreamingData, PartialTranslationInfo } from './preview';
import { translationCache } from './cache';

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
let outputChannel: vscode.OutputChannel | undefined;
let currentCancellationSource: vscode.CancellationTokenSource | undefined;

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

      // Set up handler for translation reload request
      panel.onRequestTranslation(async () => {
        if (currentState) {
          await reloadTranslation(panel, context, currentState.targetLanguage);
        }
      });

      // Set up handler for model change - re-translate with new model
      panel.onModelChange(async (modelId: string) => {
        await saveModelSetting(modelId);
        if (currentState) {
          currentState.selectedModelId = modelId;
          // Clear session since model changed
          clearTranslationSession();
          // Re-translate with new model, bypassing cache
          await reloadTranslation(panel, context, currentState.targetLanguage, { bypassCache: true });
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
        await saveChunkSizeSetting(newChunkSize);
      });

      // Set up handler for cancel translation
      panel.onCancelTranslation(() => {
        if (currentCancellationSource) {
          currentCancellationSource.cancel();
        }
      });

      // Start streaming - show original immediately
      const fileName = editor.document.fileName.split('/').pop() || 'document';
      const chunkSize = getChunkSize();
      const streamingData: StreamingData = {
        originalFull,
        models,
        selectedModelId,
        targetLanguage,
        chunkSize,
      };
      await panel.startStreaming(streamingData, `Translate: ${fileName}`);

      // Determine if we need to chunk the translation
      const needsChunking = originalFull.length > chunkSize;
      const splitPoint = needsChunking ? findSplitPoint(originalFull, chunkSize) : originalFull.length;
      const contentToTranslate = originalFull.slice(0, splitPoint);

      // Create cancellation source for webview cancel
      currentCancellationSource = new vscode.CancellationTokenSource();
      let partialTranslation = '';

      // Translate document with streaming
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Translating...',
          cancellable: true,
        },
        async (progress, progressToken) => {
          // Combine progress token with our own cancellation source
          const combinedToken = {
            isCancellationRequested: false,
            onCancellationRequested: (listener: () => void) => {
              progressToken.onCancellationRequested(listener);
              currentCancellationSource!.token.onCancellationRequested(listener);
              return { dispose: () => {} };
            },
          };

          // Track if cancelled from webview
          let cancelledFromWebview = false;
          currentCancellationSource!.token.onCancellationRequested(() => {
            cancelledFromWebview = true;
          });

          const result = await translateContentStreaming(
            contentToTranslate,
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
            // Estimate how much was translated based on partial translation length
            const estimatedPosition = estimateTranslatedPosition(
              partialTranslation,
              contentToTranslate.length,
              0,
              originalFull.length
            );

            // Save partial translation and show "続きを翻訳" button
            currentState = {
              editor,
              originalFull,
              translatedFull: partialTranslation,
              models,
              selectedModelId,
              targetLanguage,
              translatedUpTo: estimatedPosition,
            };

            // Start watching for document changes
            setupDocumentWatcher(editor.document, panel);

            // Show preview with partial info
            const partial = createPartialInfo(originalFull, estimatedPosition);
            panel.cancelStreaming(partial!);
            log(`Translation cancelled at ~${Math.round((estimatedPosition / originalFull.length) * 100)}%`);
            currentCancellationSource = undefined;
            return;
          }

          if (!result.success) {
            // Estimate how much was translated
            const estimatedPosition = estimateTranslatedPosition(
              partialTranslation,
              contentToTranslate.length,
              0,
              originalFull.length
            );

            // Save partial translation and show error
            currentState = {
              editor,
              originalFull,
              translatedFull: partialTranslation,
              models,
              selectedModelId,
              targetLanguage,
              translatedUpTo: estimatedPosition,
            };
            setupDocumentWatcher(editor.document, panel);
            const partial = createPartialInfo(originalFull, estimatedPosition);
            panel.cancelStreaming(partial!);
            panel.showError(result.error || 'Translation failed');
            currentCancellationSource = undefined;
            return;
          }

          // End streaming only on success
          panel.endStreaming();

          // Store state
          currentState = {
            editor,
            originalFull,
            translatedFull: result.translation!,
            models,
            selectedModelId,
            targetLanguage,
            translatedUpTo: splitPoint,
          };

          // Start watching for document changes
          setupDocumentWatcher(editor.document, panel);

          // Show preview with partial info if chunked
          if (needsChunking) {
            const partial = createPartialInfo(originalFull, splitPoint);
            const previewData: PreviewData = {
              originalFull,
              translatedFull: result.translation!,
              models,
              selectedModelId,
              targetLanguage,
              chunkSize,
              partial,
            };
            panel.showPreview(previewData, `Translate: ${fileName}`);
            log(`Translated ${Math.round((splitPoint / originalFull.length) * 100)}% (${splitPoint.toLocaleString()}/${originalFull.length.toLocaleString()} chars)`);
          } else {
            log('Translation complete');
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
 * Reload translation - uses incremental translation if session exists
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
    const incrementalData: StreamingData = {
      originalFull: newContent,
      models,
      selectedModelId,
      targetLanguage,
      chunkSize,
    };
    await panel.startIncremental(incrementalData, `Translate: ${fileName}`, 'Detecting changes...');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Updating Translation',
        cancellable: true,
      },
      async (progress, token) => {
        const result = await translateIncremental(
          newContent,
          targetLanguage,
          token,
          (translationProgress) => {
            progress.report({ message: translationProgress.message });
            panel.updateIncrementalProgress(translationProgress.message);
          }
        );

        // Check if cancelled
        if (token.isCancellationRequested) {
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
          return;
        }

        if (result.success && result.translation) {
          // Update state
          currentState = {
            editor,
            originalFull: newContent,
            translatedFull: result.translation,
            models,
            selectedModelId,
            targetLanguage,
            translatedUpTo: newContent.length, // Incremental always translates full content
          };

          // End incremental mode with translated content
          panel.endIncremental(result.translation);

          if (result.fromCache) {
          } else if (result.incremental) {
          } else {
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
      }
    );
  } else {
    // No session - do full translation with streaming
    const models = await getAvailableModels();
    const fileName = editor.document.fileName.split('/').pop() || 'document';
    const chunkSize = getChunkSize();

    const streamingData: StreamingData = {
      originalFull: newContent,
      models,
      selectedModelId,
      targetLanguage,
      chunkSize,
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
        // Track if cancelled from webview
        let cancelledFromWebview = false;
        currentCancellationSource!.token.onCancellationRequested(() => {
          cancelledFromWebview = true;
        });

        const result = await translateContentStreaming(
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

        currentState = {
          editor,
          originalFull: newContent,
          translatedFull: result.translation!,
          models,
          selectedModelId,
          targetLanguage,
          translatedUpTo: newContent.length, // Full translation from reload
        };

        currentCancellationSource = undefined;
      }
    );
  }
}

/**
 * Continue translation for chunked documents
 */
async function continueTranslation(
  panel: PreviewPanel,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!currentState) {
    return;
  }

  const { originalFull, translatedUpTo, targetLanguage, selectedModelId, models } = currentState;
  const previousTranslation = currentState.translatedFull;
  const editor = vscode.window.activeTextEditor || currentState.editor;

  // Determine next chunk
  const chunkSize = getChunkSize();
  const nextSplitPoint = findSplitPoint(originalFull, translatedUpTo + chunkSize);
  const contentToTranslate = originalFull.slice(translatedUpTo, nextSplitPoint);

  const fileName = editor.document.fileName.split('/').pop() || 'document';

  // Start streaming for continuation
  const streamingData: StreamingData = {
    originalFull,
    models,
    selectedModelId,
    targetLanguage,
    chunkSize,
  };
  await panel.startStreaming(streamingData, `Translate: ${fileName}`);

  // Send already translated content as initial chunk
  panel.sendStreamChunk(currentState.translatedFull);

  // Create cancellation source for webview cancel
  currentCancellationSource = new vscode.CancellationTokenSource();
  let partialChunkTranslation = '';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Continuing Translation',
      cancellable: true,
    },
    async (progress, progressToken) => {
      const percentage = Math.round((nextSplitPoint / originalFull.length) * 100);
      progress.report({ message: `Translating (${percentage}%)...` });

      // Track if cancelled from webview
      let cancelledFromWebview = false;
      currentCancellationSource!.token.onCancellationRequested(() => {
        cancelledFromWebview = true;
      });

      const result = await translateContentStreaming(
        contentToTranslate,
        targetLanguage,
        currentCancellationSource!.token,
        (chunk) => {
          partialChunkTranslation += chunk;
          panel.sendStreamChunk(chunk);
        },
        { modelId: selectedModelId || undefined }
      );

      const isCancelled = progressToken.isCancellationRequested || currentCancellationSource!.token.isCancellationRequested;

      if (isCancelled) {
        // Save combined translation and show "続きを翻訳" button
        const newTranslatedFull = previousTranslation + partialChunkTranslation;

        currentState = {
          ...currentState!,
          translatedFull: newTranslatedFull,
          translatedUpTo: translatedUpTo, // Keep at previous position since chunk wasn't completed
        };

        // Show preview with partial info
        const partial = createPartialInfo(originalFull, translatedUpTo);
        panel.cancelStreaming(partial!);
        log(`Translation cancelled during continuation`);
        currentCancellationSource = undefined;
        return;
      }

      if (!result.success) {
        // Save what we have and show error in preview
        const newTranslatedFull = previousTranslation + partialChunkTranslation;
        currentState = {
          ...currentState!,
          translatedFull: newTranslatedFull,
          translatedUpTo: translatedUpTo,
        };
        const partial = createPartialInfo(originalFull, translatedUpTo);
        panel.cancelStreaming(partial!);
        panel.showError(result.error || 'Translation failed');
        currentCancellationSource = undefined;
        return;
      }

      // End streaming
      panel.endStreaming();

      // Update state with combined translation
      const newTranslatedFull = currentState!.translatedFull + result.translation!;
      currentState = {
        ...currentState!,
        translatedFull: newTranslatedFull,
        translatedUpTo: nextSplitPoint,
      };

      // Show preview with partial info if more to translate
      const isComplete = nextSplitPoint >= originalFull.length;
      if (!isComplete) {
        const partial = createPartialInfo(originalFull, nextSplitPoint);
        const previewData: PreviewData = {
          originalFull,
          translatedFull: newTranslatedFull,
          models,
          selectedModelId,
          targetLanguage,
          chunkSize,
          partial,
        };
        panel.showPreview(previewData, `Translate: ${fileName}`);
        log(`Translated ${Math.round((nextSplitPoint / originalFull.length) * 100)}% (${nextSplitPoint.toLocaleString()}/${originalFull.length.toLocaleString()} chars)`);
      } else {
        log('Translation complete');
      }
      currentCancellationSource = undefined;
    }
  );
}

/**
 * Translate all remaining content at once
 */
async function translateAllRemaining(
  panel: PreviewPanel,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!currentState) {
    return;
  }

  const { originalFull, translatedUpTo, targetLanguage, selectedModelId, models } = currentState;
  const previousTranslation = currentState.translatedFull;
  const editor = vscode.window.activeTextEditor || currentState.editor;
  const chunkSize = getChunkSize();

  // Get all remaining content
  const remainingContent = originalFull.slice(translatedUpTo);

  const fileName = editor.document.fileName.split('/').pop() || 'document';

  log(`Translating all remaining content (${remainingContent.length.toLocaleString()} chars)...`);

  // Start streaming for the remaining content
  const streamingData: StreamingData = {
    originalFull,
    models,
    selectedModelId,
    targetLanguage,
    chunkSize,
  };
  await panel.startStreaming(streamingData, `Translate: ${fileName}`);

  // Send already translated content as initial chunk
  panel.sendStreamChunk(currentState.translatedFull);

  // Create cancellation source for webview cancel
  currentCancellationSource = new vscode.CancellationTokenSource();
  let partialChunkTranslation = '';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Translating All Remaining',
      cancellable: true,
    },
    async (progress, progressToken) => {
      progress.report({ message: 'Translating...' });

      // Track if cancelled from webview
      let cancelledFromWebview = false;
      currentCancellationSource!.token.onCancellationRequested(() => {
        cancelledFromWebview = true;
      });

      const result = await translateContentStreaming(
        remainingContent,
        targetLanguage,
        currentCancellationSource!.token,
        (chunk) => {
          partialChunkTranslation += chunk;
          panel.sendStreamChunk(chunk);
        },
        { modelId: selectedModelId || undefined }
      );

      const isCancelled = progressToken.isCancellationRequested || currentCancellationSource!.token.isCancellationRequested;

      if (isCancelled) {
        // Save combined translation and show "続きを翻訳" button
        const newTranslatedFull = previousTranslation + partialChunkTranslation;

        currentState = {
          ...currentState!,
          translatedFull: newTranslatedFull,
          translatedUpTo: translatedUpTo, // Keep at previous position since chunk wasn't completed
        };

        // Show preview with partial info
        const partial = createPartialInfo(originalFull, translatedUpTo);
        panel.cancelStreaming(partial!);
        log(`Translation cancelled during translate-all`);
        currentCancellationSource = undefined;
        return;
      }

      if (!result.success) {
        // Save what we have and show error in preview
        const newTranslatedFull = previousTranslation + partialChunkTranslation;
        currentState = {
          ...currentState!,
          translatedFull: newTranslatedFull,
          translatedUpTo: translatedUpTo,
        };
        const partial = createPartialInfo(originalFull, translatedUpTo);
        panel.cancelStreaming(partial!);
        panel.showError(result.error || 'Translation failed');
        currentCancellationSource = undefined;
        return;
      }

      // End streaming
      panel.endStreaming();

      // Update state with combined translation
      const newTranslatedFull = currentState!.translatedFull + result.translation!;
      currentState = {
        ...currentState!,
        translatedFull: newTranslatedFull,
        translatedUpTo: originalFull.length, // All content translated
      };

      log('Translation complete (all remaining content)');
      currentCancellationSource = undefined;
    }
  );
}

/**
 * Set up document change watcher to detect changes in the source file
 */
function setupDocumentWatcher(document: vscode.TextDocument, panel: PreviewPanel): void {
  // Dispose existing watcher
  if (documentWatcher) {
    documentWatcher.dispose();
  }

  documentWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
    // Only watch the specific document
    if (event.document !== document) {
      return;
    }

    // Check if content has changed from stored state
    if (currentState) {
      const currentContent = document.getText();
      const charDiff = currentContent.length - currentState.originalFull.length;
      panel.notifyDocumentChanged(charDiff);
    }
  });
}

export function deactivate() {
  if (documentWatcher) {
    documentWatcher.dispose();
    documentWatcher = undefined;
  }
  currentState = undefined;
  currentPanel = undefined;
  clearTranslationSession();
  console.log('Markdown AI Translator is now deactivated');
}
