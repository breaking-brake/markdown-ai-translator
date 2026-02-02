import 'katex/dist/katex.min.css';
import { marked } from 'marked';
import markedAlert from 'marked-alert';
import markedKatex from 'marked-katex-extension';
import mermaid from 'mermaid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorMessage } from './components/Error';
import { Loading } from './components/Loading';
import { PreviewPane } from './components/PreviewPane';
import { Toolbar } from './components/Toolbar';
import type {
  PartialTranslationInfo,
  PreviewData,
  StreamingData,
  ViewMode,
  VSCodeApi,
} from './types';

// Initialize mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
});

// Initialize marked options with extensions
marked.use(markedAlert());
marked.use(markedKatex({ throwOnError: false }));
marked.setOptions({ gfm: true, breaks: true });

/**
 * Parse markdown with image path resolution
 * Converts relative image paths to absolute webview URIs
 */
async function parseMarkdown(markdown: string, imageBaseUri?: string): Promise<string> {
  if (!imageBaseUri) {
    return marked.parse(markdown);
  }

  // Create a custom renderer for this parse call
  const renderer = new marked.Renderer();
  const originalImage = renderer.image.bind(renderer);

  renderer.image = (href: string, title: string | null, text: string) => {
    // If href is relative (not http/https/data:), prepend imageBaseUri
    if (href && !href.match(/^(https?:|data:)/i)) {
      href = imageBaseUri + href;
    }
    return originalImage(href, title, text);
  };

  return marked.parse(markdown, { renderer });
}

type AppState =
  | { type: 'loading'; message: string }
  | { type: 'error'; message: string }
  | { type: 'streaming'; data: StreamingData; translationMd: string }
  | { type: 'incremental'; data: StreamingData; message: string }
  | { type: 'preview'; data: PreviewData };

interface ParsedContent {
  original: { md: string; html: string };
  translation: { md: string; html: string };
}

const vscode: VSCodeApi = acquireVsCodeApi();

const STORAGE_KEY_VIEW_MODE = 'markdownTranslator.viewMode';

function getInitialViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_VIEW_MODE);
    if (stored === 'side-by-side' || stored === 'translation-only') {
      return stored;
    }
  } catch {
    // localStorage not available
  }
  return 'side-by-side';
}

function App() {
  const [state, setState] = useState<AppState>({ type: 'loading', message: 'Loading...' });
  const [viewMode, setViewMode] = useState<ViewMode>(getInitialViewMode);
  const [syncScroll, setSyncScroll] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<'original' | 'translation' | null>(null);
  const [charDiff, setCharDiff] = useState<number>(0);
  const [isContinuing, setIsContinuing] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [lastPartialInfo, setLastPartialInfo] = useState<PartialTranslationInfo | null>(null);

  const originalRef = useRef<HTMLDivElement>(null);
  const translationRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);

  // Ref to track latest streaming state (avoids stale closure in streamEnd)
  const streamingStateRef = useRef<{ data: StreamingData; translationMd: string } | null>(null);

  // Parse content from preview data
  const getParsedContent = useCallback(async (data: PreviewData): Promise<ParsedContent> => {
    const originalFullHtml = await parseMarkdown(data.originalFull, data.imageBaseUri);
    const translatedFullHtml = await parseMarkdown(data.translatedFull, data.imageBaseUri);

    return {
      original: { md: data.originalFull, html: originalFullHtml },
      translation: { md: data.translatedFull, html: translatedFullHtml },
    };
  }, []);

  const [parsedContent, setParsedContent] = useState<ParsedContent | null>(null);

  // For streaming mode: parsed original and streaming translation
  const [streamingOriginalHtml, setStreamingOriginalHtml] = useState<string>('');
  const [streamingTranslationHtml, setStreamingTranslationHtml] = useState<string>('');

  // For incremental mode: parsed original
  const [incrementalOriginalHtml, setIncrementalOriginalHtml] = useState<string>('');
  // Ref to track latest incremental state (avoids stale closure)
  const incrementalStateRef = useRef<{ data: StreamingData } | null>(null);

  // Calculate streaming progress percentage
  const calculateStreamingProgress = useCallback(
    (translationMdLength: number, originalLength: number, chunkSize: number): number | null => {
      if (lastPartialInfo) {
        // Continuation: calculate based on starting position and current chunk progress
        const { translatedUpTo, totalChars } = lastPartialInfo;
        const remainingChars = totalChars - translatedUpTo;
        const currentChunkSize = Math.min(chunkSize, remainingChars);
        // Estimate: translation length roughly correlates with source length
        const chunkProgress = Math.min(translationMdLength / currentChunkSize, 1);
        const estimatedPosition = translatedUpTo + currentChunkSize * chunkProgress;
        return Math.round((estimatedPosition / totalChars) * 100);
      } else {
        // Initial translation: estimate based on chunk being translated
        const targetChunkSize = Math.min(chunkSize, originalLength);
        const chunkProgress = Math.min(translationMdLength / targetChunkSize, 1);
        const estimatedPosition = targetChunkSize * chunkProgress;
        return Math.round((estimatedPosition / originalLength) * 100);
      }
    },
    [lastPartialInfo]
  );

  // Notify extension that webview is ready
  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
  }, []);

  // Persist viewMode to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_VIEW_MODE, viewMode);
    } catch {
      // localStorage not available
    }
  }, [viewMode]);

  // Handle messages from extension
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case 'setLoading':
          setState({ type: 'loading', message: message.text });
          break;
        case 'setError':
          setState({ type: 'error', message: message.text });
          break;
        case 'setPreview': {
          const parsed = await getParsedContent(message.data);
          setParsedContent(parsed);
          setState({ type: 'preview', data: message.data });
          setCharDiff(0); // Reset on new preview
          break;
        }
        case 'streamStart': {
          // Start streaming: show original immediately, translation will stream in
          const originalHtml = await parseMarkdown(
            message.data.originalFull,
            message.data.imageBaseUri
          );
          setStreamingOriginalHtml(originalHtml);

          // Use existing translation if provided (for continue translation)
          const existingTranslation = message.data.existingTranslation || '';
          if (existingTranslation) {
            const existingHtml = await parseMarkdown(
              existingTranslation,
              message.data.imageBaseUri
            );
            setStreamingTranslationHtml(existingHtml);
          } else {
            setStreamingTranslationHtml('');
          }

          // Initialize ref for tracking latest state
          streamingStateRef.current = { data: message.data, translationMd: existingTranslation };
          setState({ type: 'streaming', data: message.data, translationMd: existingTranslation });
          setCharDiff(0); // Reset on new translation
          break;
        }
        case 'streamChunk': {
          // Append chunk to translation using ref (avoids stale closure)
          if (streamingStateRef.current) {
            const newTranslationMd = streamingStateRef.current.translationMd + message.chunk;
            streamingStateRef.current.translationMd = newTranslationMd;
            const imageBaseUri = streamingStateRef.current.data.imageBaseUri;
            // Parse the markdown asynchronously
            (async () => {
              const html = await parseMarkdown(newTranslationMd, imageBaseUri);
              setStreamingTranslationHtml(html);
            })();
            setState((prev) => {
              if (prev.type !== 'streaming') return prev;
              return { ...prev, translationMd: newTranslationMd };
            });
          }
          break;
        }
        case 'streamEnd': {
          // Streaming complete - convert to preview state using ref (avoids stale closure)
          if (streamingStateRef.current) {
            const finalData: PreviewData = {
              ...streamingStateRef.current.data,
              translatedFull: streamingStateRef.current.translationMd,
            };
            const parsed = await getParsedContent(finalData);
            setParsedContent(parsed);
            setState({ type: 'preview', data: finalData });
            streamingStateRef.current = null;
          }
          setIsContinuing(false);
          setIsCanceling(false);
          setLastPartialInfo(null);
          break;
        }
        case 'streamCancel': {
          // Streaming cancelled by user - convert to preview state with partial translation
          if (streamingStateRef.current) {
            const partialTranslation = streamingStateRef.current.translationMd;
            const finalData: PreviewData = {
              ...streamingStateRef.current.data,
              translatedFull: partialTranslation,
              partial: message.partial,
            };
            (async () => {
              const parsed = await getParsedContent(finalData);
              setParsedContent(parsed);
              setState({ type: 'preview', data: finalData });
            })();
            streamingStateRef.current = null;
          }
          setIsContinuing(false);
          setIsCanceling(false);
          setLastPartialInfo(null);
          break;
        }
        case 'incrementalStart': {
          // Start incremental translation: show original immediately, loading in translation
          const originalHtml = await parseMarkdown(
            message.data.originalFull,
            message.data.imageBaseUri
          );
          setIncrementalOriginalHtml(originalHtml);
          incrementalStateRef.current = { data: message.data };
          setState({ type: 'incremental', data: message.data, message: message.message });
          setCharDiff(0);
          break;
        }
        case 'incrementalProgress': {
          // Update progress message in incremental mode
          setState((prev) => {
            if (prev.type !== 'incremental') return prev;
            return { ...prev, message: message.message };
          });
          break;
        }
        case 'incrementalEnd': {
          // Incremental translation complete - convert to preview state
          if (incrementalStateRef.current) {
            const finalData: PreviewData = {
              ...incrementalStateRef.current.data,
              translatedFull: message.translatedFull,
            };
            const parsed = await getParsedContent(finalData);
            setParsedContent(parsed);
            setState({ type: 'preview', data: finalData });
            incrementalStateRef.current = null;
          }
          setIsContinuing(false);
          setIsCanceling(false);
          setLastPartialInfo(null);
          break;
        }
        case 'documentChanged': {
          // Source document has changed
          setCharDiff(message.charDiff);
          break;
        }
        case 'chunkSizeUpdate': {
          // Chunk size was changed - update state
          setState((prev) => {
            if (prev.type === 'preview') {
              return {
                ...prev,
                data: { ...prev.data, chunkSize: message.chunkSize },
              };
            }
            if (prev.type === 'streaming' || prev.type === 'incremental') {
              return {
                ...prev,
                data: { ...prev.data, chunkSize: message.chunkSize },
              };
            }
            return prev;
          });
          break;
        }
        case 'modelUpdate': {
          // Model was changed - update state
          setState((prev) => {
            if (prev.type === 'preview') {
              return {
                ...prev,
                data: { ...prev.data, selectedModelId: message.modelId },
              };
            }
            if (prev.type === 'streaming' || prev.type === 'incremental') {
              return {
                ...prev,
                data: { ...prev.data, selectedModelId: message.modelId },
              };
            }
            return prev;
          });
          break;
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [getParsedContent]);

  // Handle model change
  const handleModelChange = useCallback((modelId: string) => {
    vscode.postMessage({ type: 'modelChange', modelId });
  }, []);

  // Handle language change
  const handleLanguageChange = useCallback((language: string) => {
    vscode.postMessage({ type: 'languageChange', language });
  }, []);

  // Handle update (incremental translation)
  const handleUpdate = useCallback(() => {
    vscode.postMessage({ type: 'updateTranslation' });
  }, []);

  // Handle retranslate (from scratch)
  const handleRetranslate = useCallback(() => {
    vscode.postMessage({ type: 'retranslate' });
  }, []);

  // Handle continue translation (for chunked documents)
  const handleContinueTranslation = useCallback(() => {
    if (state.type === 'preview' && state.data.partial) {
      setLastPartialInfo(state.data.partial);
      setIsContinuing(true);
    }
    vscode.postMessage({ type: 'continueTranslation' });
  }, [state]);

  // Handle chunk size change
  const handleChunkSizeChange = useCallback((chunkSize: number) => {
    vscode.postMessage({ type: 'chunkSizeChange', chunkSize });
  }, []);

  // Handle translate all (translate remaining content at once)
  const handleTranslateAll = useCallback(() => {
    if (state.type === 'preview' && state.data.partial) {
      setLastPartialInfo(state.data.partial);
      setIsContinuing(true);
    }
    vscode.postMessage({ type: 'translateAll' });
  }, [state]);

  // Handle cancel translation
  const handleCancelTranslation = useCallback(() => {
    setIsCanceling(true);
    vscode.postMessage({ type: 'cancelTranslation' });
  }, []);

  // Handle copy
  const handleCopy = useCallback(
    async (type: 'original' | 'translation') => {
      let text = '';
      if (state.type === 'streaming') {
        text = type === 'original' ? state.data.originalFull : state.translationMd;
      } else if (state.type === 'incremental') {
        // In incremental mode, only original is available
        if (type === 'original') {
          text = state.data.originalFull;
        }
      } else if (parsedContent) {
        text = type === 'original' ? parsedContent.original.md : parsedContent.translation.md;
      }
      if (text) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback(type);
        setTimeout(() => setCopyFeedback(null), 1500);
      }
    },
    [parsedContent, state]
  );

  // Synchronized scrolling
  const handleScroll = useCallback(
    (source: 'original' | 'translation') => {
      if (!syncScroll || isScrollingRef.current || viewMode !== 'side-by-side') return;

      const sourceEl = source === 'original' ? originalRef.current : translationRef.current;
      const targetEl = source === 'original' ? translationRef.current : originalRef.current;

      if (!sourceEl || !targetEl) return;

      isScrollingRef.current = true;
      const ratio = sourceEl.scrollTop / (sourceEl.scrollHeight - sourceEl.clientHeight || 1);
      targetEl.scrollTop = ratio * (targetEl.scrollHeight - targetEl.clientHeight);
      setTimeout(() => {
        isScrollingRef.current = false;
      }, 50);
    },
    [syncScroll, viewMode]
  );

  // Render based on state
  if (state.type === 'loading') {
    return <Loading message={state.message} />;
  }

  if (state.type === 'error') {
    return <ErrorMessage message={state.message} />;
  }

  // Streaming mode
  if (state.type === 'streaming') {
    return (
      <div className="app">
        <Toolbar
          viewMode={viewMode}
          syncScroll={syncScroll}
          models={state.data.models}
          selectedModelId={state.data.selectedModelId}
          targetLanguage={state.data.targetLanguage}
          chunkSize={state.data.chunkSize}
          debugMode={state.data.debugMode}
          onViewModeChange={setViewMode}
          onSyncScrollChange={setSyncScroll}
          onModelChange={handleModelChange}
          onLanguageChange={handleLanguageChange}
          onChunkSizeChange={handleChunkSizeChange}
          onUpdate={handleUpdate}
          onRetranslate={handleRetranslate}
          isStreaming={true}
          changedBlockCount={0}
        />
        <div className={`preview-container ${viewMode}`}>
          <PreviewPane
            type="original"
            html={streamingOriginalHtml}
            hidden={viewMode === 'translation-only'}
            ref={originalRef}
            onScroll={() => handleScroll('original')}
            onCopy={() => handleCopy('original')}
            showCopied={copyFeedback === 'original'}
          />
          <div className={`divider ${viewMode === 'translation-only' ? 'hidden' : ''}`} />
          <PreviewPane
            type="translation"
            html={
              streamingTranslationHtml || '<div class="streaming-indicator">Translating...</div>'
            }
            ref={translationRef}
            onScroll={() => handleScroll('translation')}
            isStreaming={true}
            onCopy={() => handleCopy('translation')}
            showCopied={copyFeedback === 'translation'}
          />
        </div>
        <div className="continue-bar">
          <span className="progress-text translating">
            {(() => {
              const progress = calculateStreamingProgress(
                state.translationMd.length,
                state.data.originalFull.length,
                state.data.chunkSize
              );
              return progress !== null ? `Translating... ${progress}%` : 'Translating...';
            })()}
          </span>
          <button
            type="button"
            className="cancel-btn"
            onClick={handleCancelTranslation}
            disabled={isCanceling}
          >
            {isCanceling ? 'Canceling...' : 'Cancel'}
          </button>
        </div>
      </div>
    );
  }

  // Incremental translation mode
  if (state.type === 'incremental') {
    return (
      <div className="app">
        <Toolbar
          viewMode={viewMode}
          syncScroll={syncScroll}
          models={state.data.models}
          selectedModelId={state.data.selectedModelId}
          targetLanguage={state.data.targetLanguage}
          chunkSize={state.data.chunkSize}
          debugMode={state.data.debugMode}
          onViewModeChange={setViewMode}
          onSyncScrollChange={setSyncScroll}
          onModelChange={handleModelChange}
          onLanguageChange={handleLanguageChange}
          onChunkSizeChange={handleChunkSizeChange}
          onUpdate={handleUpdate}
          onRetranslate={handleRetranslate}
          isStreaming={true}
          changedBlockCount={0}
        />
        <div className={`preview-container ${viewMode}`}>
          <PreviewPane
            type="original"
            html={incrementalOriginalHtml}
            hidden={viewMode === 'translation-only'}
            ref={originalRef}
            onScroll={() => handleScroll('original')}
            onCopy={() => handleCopy('original')}
            showCopied={copyFeedback === 'original'}
          />
          <div className={`divider ${viewMode === 'translation-only' ? 'hidden' : ''}`} />
          <PreviewPane
            type="translation"
            html={`<div class="incremental-indicator">${state.message}</div>`}
            ref={translationRef}
            onScroll={() => handleScroll('translation')}
            isStreaming={true}
          />
        </div>
        <div className="continue-bar">
          <span className="progress-text translating">
            {lastPartialInfo
              ? `Translating... ${Math.round((lastPartialInfo.translatedUpTo / lastPartialInfo.totalChars) * 100)}%`
              : 'Translating...'}
          </span>
          <button
            type="button"
            className="cancel-btn"
            onClick={handleCancelTranslation}
            disabled={isCanceling}
          >
            {isCanceling ? 'Canceling...' : 'Cancel'}
          </button>
        </div>
      </div>
    );
  }

  if (!parsedContent) {
    return <Loading message="Processing..." />;
  }

  const currentContent = parsedContent;
  const partial = state.data.partial;
  const hasMoreToTranslate = partial?.hasMore ?? false;

  // Create continue button HTML for translation pane
  const translationHtml = hasMoreToTranslate
    ? `${currentContent.translation.html}<div class="continue-translation-placeholder"></div>`
    : currentContent.translation.html;

  return (
    <div className="app">
      <Toolbar
        viewMode={viewMode}
        syncScroll={syncScroll}
        models={state.data.models}
        selectedModelId={state.data.selectedModelId}
        targetLanguage={state.data.targetLanguage}
        chunkSize={state.data.chunkSize}
        debugMode={state.data.debugMode}
        onViewModeChange={setViewMode}
        onSyncScrollChange={setSyncScroll}
        onModelChange={handleModelChange}
        onLanguageChange={handleLanguageChange}
        onChunkSizeChange={handleChunkSizeChange}
        onUpdate={handleUpdate}
        onRetranslate={handleRetranslate}
        isStreaming={false}
        changedBlockCount={charDiff}
      />
      <div className={`preview-container ${viewMode}`}>
        <PreviewPane
          type="original"
          html={currentContent.original.html}
          hidden={viewMode === 'translation-only'}
          ref={originalRef}
          onScroll={() => handleScroll('original')}
          onCopy={() => handleCopy('original')}
          showCopied={copyFeedback === 'original'}
        />
        <div className={`divider ${viewMode === 'translation-only' ? 'hidden' : ''}`} />
        <PreviewPane
          type="translation"
          html={translationHtml}
          ref={translationRef}
          onScroll={() => handleScroll('translation')}
          onCopy={() => handleCopy('translation')}
          showCopied={copyFeedback === 'translation'}
        />
      </div>
      {hasMoreToTranslate && partial && !isContinuing && (
        <div className="continue-bar">
          <button type="button" className="continue-btn" onClick={handleContinueTranslation}>
            Continue
          </button>
          <button
            type="button"
            className="continue-btn translate-all-btn"
            onClick={handleTranslateAll}
          >
            Translate All ({partial.remainingChars.toLocaleString()} chars)
          </button>
          <span className="progress-text">
            {Math.round((partial.translatedUpTo / partial.totalChars) * 100)}% complete
          </span>
        </div>
      )}
      {isContinuing && lastPartialInfo && (
        <div className="continue-bar">
          <span className="progress-text translating">
            Translating...{' '}
            {Math.round((lastPartialInfo.translatedUpTo / lastPartialInfo.totalChars) * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}

export default App;
