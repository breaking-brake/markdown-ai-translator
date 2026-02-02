export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  maxInputTokens: number;
}

export interface LanguageOption {
  id: string;
  name: string;
  nativeName: string;
}

export const PRESET_LANGUAGES: LanguageOption[] = [
  { id: 'Japanese', name: 'Japanese', nativeName: '日本語' },
  { id: 'Chinese (Simplified)', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { id: 'Chinese (Traditional)', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { id: 'Korean', name: 'Korean', nativeName: '한국어' },
];

export interface PartialTranslationInfo {
  /** Whether there's more content to translate */
  hasMore: boolean;
  /** Remaining characters to translate */
  remainingChars: number;
  /** Position in original content where translation stopped */
  translatedUpTo: number;
  /** Total characters in original content */
  totalChars: number;
}

export interface PreviewData {
  originalFull: string;
  translatedFull: string;
  models: ModelInfo[];
  selectedModelId: string;
  targetLanguage: string;
  /** Chunk size for large documents */
  chunkSize: number;
  /** Partial translation info (if document is large) */
  partial?: PartialTranslationInfo;
  /** Base URI for resolving relative image paths */
  imageBaseUri?: string;
}

export interface StreamingData {
  originalFull: string;
  models: ModelInfo[];
  selectedModelId: string;
  targetLanguage: string;
  /** Chunk size for large documents */
  chunkSize: number;
  /** Base URI for resolving relative image paths */
  imageBaseUri?: string;
  /** Existing translation content (for continue translation) */
  existingTranslation?: string;
}

export type ViewMode = 'side-by-side' | 'translation-only';

export interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VSCodeApi;
}
