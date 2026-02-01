import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ModelInfo } from './translator';

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
}

export interface PreviewMessage {
  type: 'requestTranslation' | 'updateTranslation' | 'retranslate' | 'modelChange' | 'languageChange' | 'chunkSizeChange' | 'continueTranslation' | 'translateAll' | 'cancelTranslation' | 'ready';
  modelId?: string;
  language?: string;
  chunkSize?: number;
}

export class PreviewPanel {
  public static currentPanel: PreviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _onRequestTranslation: (() => void) | undefined;
  private _onUpdateTranslation: (() => void) | undefined;
  private _onRetranslate: (() => void) | undefined;
  private _onModelChange: ((modelId: string) => void) | undefined;
  private _onLanguageChange: ((language: string) => void) | undefined;
  private _onContinueTranslation: (() => void) | undefined;
  private _onTranslateAll: (() => void) | undefined;
  private _onChunkSizeChange: ((chunkSize: number) => void) | undefined;
  private _onCancelTranslation: (() => void) | undefined;
  private _isReady: boolean = false;
  private _readyResolver: (() => void) | undefined;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.webview.html = this._getLoadingHtml('Loading...');
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      (message: PreviewMessage) => {
        switch (message.type) {
          case 'ready':
            this._isReady = true;
            if (this._readyResolver) {
              this._readyResolver();
              this._readyResolver = undefined;
            }
            break;
          case 'requestTranslation':
            if (this._onRequestTranslation) {
              this._onRequestTranslation();
            }
            break;
          case 'updateTranslation':
            if (this._onUpdateTranslation) {
              this._onUpdateTranslation();
            }
            break;
          case 'retranslate':
            if (this._onRetranslate) {
              this._onRetranslate();
            }
            break;
          case 'modelChange':
            if (this._onModelChange && message.modelId !== undefined) {
              this._onModelChange(message.modelId);
            }
            break;
          case 'languageChange':
            if (this._onLanguageChange && message.language !== undefined) {
              this._onLanguageChange(message.language);
            }
            break;
          case 'continueTranslation':
            if (this._onContinueTranslation) {
              this._onContinueTranslation();
            }
            break;
          case 'translateAll':
            if (this._onTranslateAll) {
              this._onTranslateAll();
            }
            break;
          case 'chunkSizeChange':
            if (this._onChunkSizeChange && message.chunkSize !== undefined) {
              this._onChunkSizeChange(message.chunkSize);
            }
            break;
          case 'cancelTranslation':
            if (this._onCancelTranslation) {
              this._onCancelTranslation();
            }
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public static createOrShow(extensionUri: vscode.Uri): PreviewPanel {
    const column = vscode.ViewColumn.Beside;

    if (PreviewPanel.currentPanel) {
      PreviewPanel.currentPanel._panel.reveal(column);
      return PreviewPanel.currentPanel;
    }

    // Get workspace folders for local resource access
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const localResourceRoots = [
      vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'dist'),
      ...workspaceFolders.map(folder => folder.uri),
    ];

    // Add active editor's directory if available
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const documentDir = vscode.Uri.joinPath(activeEditor.document.uri, '..');
      localResourceRoots.push(documentDir);
    }

    const panel = vscode.window.createWebviewPanel(
      'markdownTranslatePreview',
      'Translation Preview',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots,
      }
    );

    PreviewPanel.currentPanel = new PreviewPanel(panel, extensionUri);
    return PreviewPanel.currentPanel;
  }

  public onRequestTranslation(callback: () => void): void {
    this._onRequestTranslation = callback;
  }

  public onUpdateTranslation(callback: () => void): void {
    this._onUpdateTranslation = callback;
  }

  public onRetranslate(callback: () => void): void {
    this._onRetranslate = callback;
  }

  public onModelChange(callback: (modelId: string) => void): void {
    this._onModelChange = callback;
  }

  public onLanguageChange(callback: (language: string) => void): void {
    this._onLanguageChange = callback;
  }

  public onContinueTranslation(callback: () => void): void {
    this._onContinueTranslation = callback;
  }

  public onTranslateAll(callback: () => void): void {
    this._onTranslateAll = callback;
  }

  public onChunkSizeChange(callback: (chunkSize: number) => void): void {
    this._onChunkSizeChange = callback;
  }

  public onCancelTranslation(callback: () => void): void {
    this._onCancelTranslation = callback;
  }

  public showLoading(message: string = 'Translating...'): void {
    this._panel.webview.postMessage({ type: 'setLoading', text: message });
  }

  public showError(message: string): void {
    this._panel.webview.postMessage({ type: 'setError', text: message });
  }

  public showProgress(current: number, total: number, message: string): void {
    const percentage = Math.round((current / total) * 100);
    this._panel.webview.postMessage({ type: 'setLoading', text: `${message} (${percentage}%)` });
  }

  /**
   * Start incremental translation mode - show original immediately, loading in translation pane
   */
  public async startIncremental(data: StreamingData, title: string = 'Translation', message: string = 'Updating...'): Promise<void> {
    this._panel.title = title;
    await this._ensureWebviewReady();
    this._panel.webview.postMessage({ type: 'incrementalStart', data, message });
  }

  /**
   * Update incremental translation progress message
   */
  public updateIncrementalProgress(message: string): void {
    this._panel.webview.postMessage({ type: 'incrementalProgress', message });
  }

  /**
   * End incremental translation mode with the translated content
   */
  public endIncremental(translatedFull: string): void {
    this._panel.webview.postMessage({ type: 'incrementalEnd', translatedFull });
  }

  public async showPreview(data: PreviewData, title: string = 'Translation'): Promise<void> {
    this._panel.title = title;
    await this._ensureWebviewReady();
    this._panel.webview.postMessage({ type: 'setPreview', data });
  }

  /**
   * Start streaming mode - show original immediately
   */
  public async startStreaming(data: StreamingData, title: string = 'Translation'): Promise<void> {
    this._panel.title = title;
    await this._ensureWebviewReady();
    this._panel.webview.postMessage({ type: 'streamStart', data });
  }

  /**
   * Ensure webview is loaded and ready to receive messages
   */
  private async _ensureWebviewReady(): Promise<void> {
    const html = this._getWebviewHtml();
    if (this._panel.webview.html !== html) {
      this._isReady = false;
      this._panel.webview.html = html;
    }

    // If already ready, return immediately
    if (this._isReady) {
      return;
    }

    // Wait for ready message from webview (with timeout)
    await Promise.race([
      new Promise<void>((resolve) => {
        this._readyResolver = resolve;
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)), // 3 second timeout fallback
    ]);
  }

  /**
   * Send a streaming chunk
   */
  public sendStreamChunk(chunk: string): void {
    this._panel.webview.postMessage({ type: 'streamChunk', chunk });
  }

  /**
   * End streaming mode
   */
  public endStreaming(): void {
    this._panel.webview.postMessage({ type: 'streamEnd' });
  }

  /**
   * Cancel streaming and convert to partial preview (keeps partial translation)
   */
  public cancelStreaming(partial: PartialTranslationInfo): void {
    this._panel.webview.postMessage({ type: 'streamCancel', partial });
  }

  /**
   * Notify webview that the source document has changed
   * @param changedBlockCount Number of changed blocks (0 means no changes)
   */
  public notifyDocumentChanged(changedBlockCount: number): void {
    this._panel.webview.postMessage({ type: 'documentChanged', charDiff: changedBlockCount });
  }

  /**
   * Update the chunk size in the webview
   */
  public updateChunkSize(chunkSize: number): void {
    this._panel.webview.postMessage({ type: 'chunkSizeUpdate', chunkSize });
  }

  /**
   * Get webview URI for a document's directory (for resolving relative image paths)
   */
  public getImageBaseUri(documentUri: vscode.Uri): string {
    const documentDir = vscode.Uri.joinPath(documentUri, '..');
    return this._panel.webview.asWebviewUri(documentDir).toString() + '/';
  }

  private _getWebviewHtml(): string {
    const webviewDistPath = path.join(this._extensionUri.fsPath, 'src', 'webview', 'dist');

    // Check if the built webview exists
    const indexPath = path.join(webviewDistPath, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return this._getFallbackHtml('Webview not built. Run: npm run build:webview');
    }

    // Read the built index.html
    let html = fs.readFileSync(indexPath, 'utf-8');

    // Get URIs for the built assets
    const scriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'dist', 'assets', 'main.js')
    );
    const styleUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'dist', 'assets', 'main.css')
    );

    // Replace paths with webview URIs
    html = html.replace(/\/assets\/main\.js/g, scriptUri.toString());
    html = html.replace(/\/assets\/main\.css/g, styleUri.toString());

    // Add CSP meta tag (unsafe-eval required for Mermaid)
    const cspSource = this._panel.webview.cspSource;
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-eval'; img-src ${cspSource} https: data:; font-src ${cspSource} data:;`;
    html = html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);

    return html;
  }

  private _getLoadingHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loading</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
    }
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 20px;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--vscode-editor-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-message { font-size: 14px; }
  </style>
</head>
<body>
  <div class="loading-container">
    <div class="spinner"></div>
    <div class="loading-message">${this._escapeHtml(message)}</div>
  </div>
</body>
</html>`;
  }

  private _getFallbackHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
    }
    .error-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 20px;
      padding: 20px;
      text-align: center;
    }
    .error-icon { font-size: 48px; }
    .error-message {
      color: var(--vscode-errorForeground);
      font-size: 14px;
      max-width: 400px;
    }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-icon">⚠️</div>
    <div class="error-message">${this._escapeHtml(message)}</div>
  </div>
</body>
</html>`;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  public dispose(): void {
    PreviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
