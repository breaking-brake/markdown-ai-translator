import * as Tooltip from '@radix-ui/react-tooltip';
import { HelpCircle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { type ModelInfo, PRESET_LANGUAGES, type ViewMode } from '../types';

const CHUNK_SIZE_OPTIONS = [
  { value: 500, label: '500 (debug)' },
  { value: 2000, label: '2,000' },
  { value: 5000, label: '5,000' },
  { value: 10000, label: '10,000' },
  { value: 20000, label: '20,000' },
  { value: 50000, label: '50,000' },
];

interface ToolbarProps {
  viewMode: ViewMode;
  syncScroll: boolean;
  models: ModelInfo[];
  selectedModelId: string;
  targetLanguage: string;
  chunkSize: number;
  onViewModeChange: (mode: ViewMode) => void;
  onSyncScrollChange: (sync: boolean) => void;
  onModelChange: (modelId: string) => void;
  onLanguageChange: (language: string) => void;
  onChunkSizeChange: (chunkSize: number) => void;
  onReload: () => void;
  isStreaming?: boolean;
  charDiff?: number;
}

export function Toolbar({
  viewMode,
  syncScroll,
  models,
  selectedModelId,
  targetLanguage,
  chunkSize,
  onViewModeChange,
  onSyncScrollChange,
  onModelChange,
  onLanguageChange,
  onChunkSizeChange,
  onReload,
  isStreaming = false,
  charDiff = 0,
}: ToolbarProps) {
  const hasDocumentChanges = charDiff !== 0;
  const charDiffLabel = charDiff > 0 ? `+${charDiff}` : `${charDiff}`;

  // Check if current language is a preset or custom
  const isPresetLanguage = PRESET_LANGUAGES.some((lang) => lang.id === targetLanguage);
  const [showCustomInput, setShowCustomInput] = useState(!isPresetLanguage);
  const [customLanguage, setCustomLanguage] = useState(isPresetLanguage ? '' : targetLanguage);

  const handleLanguageSelectChange = (value: string) => {
    if (value === '__custom__') {
      setShowCustomInput(true);
    } else {
      setShowCustomInput(false);
      onLanguageChange(value);
    }
  };

  const handleCustomLanguageSubmit = () => {
    if (customLanguage.trim()) {
      onLanguageChange(customLanguage.trim());
    }
  };

  const handleCustomLanguageKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCustomLanguageSubmit();
    }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <div className="toolbar-group">
          <span className="toolbar-label">View:</span>
          <button
            type="button"
            className={`toggle-btn ${viewMode === 'side-by-side' ? 'active' : ''}`}
            onClick={() => onViewModeChange('side-by-side')}
          >
            Side by Side
          </button>
          <button
            type="button"
            className={`toggle-btn ${viewMode === 'translation-only' ? 'active' : ''}`}
            onClick={() => onViewModeChange('translation-only')}
          >
            Translation Only
          </button>
        </div>
        <div className="toolbar-group toolbar-actions">
          {hasDocumentChanges && (
            <span className="change-indicator" title="Source document has changed">
              {charDiffLabel} chars
            </span>
          )}
          <button
            type="button"
            className={`action-btn icon-btn ${isStreaming ? 'streaming' : ''} ${hasDocumentChanges ? 'has-changes' : ''}`}
            onClick={onReload}
            title={hasDocumentChanges ? 'Re-translate (document changed)' : 'Reload translation'}
            disabled={isStreaming}
          >
            <RefreshCw size={14} className={isStreaming ? 'spin' : ''} />
          </button>
          <button
            type="button"
            className="action-btn"
            onClick={() => onSyncScrollChange(!syncScroll)}
          >
            Sync Scroll: {syncScroll ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
      <div className="toolbar-row">
        <div className="toolbar-group">
          <span className="toolbar-label">Language:</span>
          <select
            className="language-select"
            value={showCustomInput ? '__custom__' : targetLanguage}
            onChange={(e) => handleLanguageSelectChange(e.target.value)}
          >
            {PRESET_LANGUAGES.map((lang) => (
              <option key={lang.id} value={lang.id}>
                {lang.nativeName} ({lang.name})
              </option>
            ))}
            <option value="__custom__">Other...</option>
          </select>
          {showCustomInput && (
            <input
              type="text"
              className="custom-language-input"
              placeholder="Enter language..."
              value={customLanguage}
              onChange={(e) => setCustomLanguage(e.target.value)}
              onBlur={handleCustomLanguageSubmit}
              onKeyDown={handleCustomLanguageKeyDown}
            />
          )}
        </div>
        <div className="toolbar-group">
          <span className="toolbar-label">Model:</span>
          <select
            className="model-select"
            value={selectedModelId}
            onChange={(e) => onModelChange(e.target.value)}
          >
            <option value="">Auto (default)</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar-group">
          <span className="toolbar-label">
            Chunk:
            <Tooltip.Provider delayDuration={0}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <span className="help-icon">
                    <HelpCircle size={12} />
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="tooltip-content" sideOffset={5}>
                    <p>Number of characters to translate at once.</p>
                    <ul>
                      <li>
                        <strong>Larger:</strong> Translates more text at once, but may consume more
                        premium requests for large documents.
                      </li>
                      <li>
                        <strong>Smaller:</strong> Splits translation into smaller chunks, making it
                        easier to save premium requests.
                      </li>
                    </ul>
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </span>
          <select
            className="chunk-select"
            value={chunkSize}
            onChange={(e) => onChunkSizeChange(Number(e.target.value))}
          >
            {CHUNK_SIZE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} chars
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
