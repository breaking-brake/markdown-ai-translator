import { Check, Copy } from 'lucide-react';
import { forwardRef } from 'react';

interface PreviewPaneProps {
  type: 'original' | 'translation';
  html: string;
  hidden?: boolean;
  onScroll?: () => void;
  isStreaming?: boolean;
  onCopy?: () => void;
  showCopied?: boolean;
}

export const PreviewPane = forwardRef<HTMLDivElement, PreviewPaneProps>(
  ({ type, html, hidden = false, onScroll, onCopy, showCopied = false }, ref) => {
    const label = type === 'original' ? 'Original' : 'Translation';

    return (
      <div className={`pane ${type} ${hidden ? 'hidden' : ''}`}>
        <div className="pane-header">
          <span>{label}</span>
          {onCopy && (
            <button
              type="button"
              className={`copy-btn ${showCopied ? 'copied' : ''}`}
              onClick={onCopy}
              title={`Copy ${label.toLowerCase()}`}
            >
              {showCopied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
        </div>
        <div
          className="pane-content markdown-content"
          ref={ref}
          onScroll={onScroll}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }
);

PreviewPane.displayName = 'PreviewPane';
