import { Check, Copy } from 'lucide-react';
import mermaid from 'mermaid';
import { forwardRef, useEffect, useRef } from 'react';

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
  (
    { type, html, hidden = false, onScroll, isStreaming = false, onCopy, showCopied = false },
    ref
  ) => {
    const label = type === 'original' ? 'Original' : 'Translation';
    const contentRef = useRef<HTMLDivElement>(null);
    const mermaidIdRef = useRef(0);

    // Render Mermaid diagrams after HTML is set
    // biome-ignore lint/correctness/useExhaustiveDependencies: html is needed to re-render Mermaid when content changes
    useEffect(() => {
      if (!contentRef.current || isStreaming) return;

      const renderMermaid = async () => {
        const container = contentRef.current;
        if (!container) return;

        // Find all code blocks with class "language-mermaid"
        const mermaidBlocks = container.querySelectorAll('code.language-mermaid');

        for (const codeBlock of mermaidBlocks) {
          const pre = codeBlock.parentElement;
          if (!pre || pre.tagName !== 'PRE') continue;

          const code = codeBlock.textContent || '';
          if (!code.trim()) continue;

          try {
            const id = `mermaid-${type}-${mermaidIdRef.current++}`;
            const { svg } = await mermaid.render(id, code);

            // Create a wrapper div for the rendered diagram
            const wrapper = document.createElement('div');
            wrapper.className = 'mermaid-diagram';
            wrapper.innerHTML = svg;

            // Replace the pre block with the rendered diagram
            pre.replaceWith(wrapper);
          } catch (e) {
            // Keep the original code block on error
            console.error('Mermaid render error:', e);
          }
        }
      };

      renderMermaid();
    }, [html, type, isStreaming]);

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
          ref={(node) => {
            // Handle both refs
            (contentRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') {
              ref(node);
            } else if (ref) {
              ref.current = node;
            }
          }}
          onScroll={onScroll}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }
);

PreviewPane.displayName = 'PreviewPane';
