import * as vscode from 'vscode';

export interface SessionState {
  originalContent: string;
  translatedContent: string;
  messages: vscode.LanguageModelChatMessage[];
  model: vscode.LanguageModelChat | null;
}

/**
 * Manages a translation session with conversation history
 */
export class TranslationSession {
  private state: SessionState | null = null;

  /**
   * Check if session exists
   */
  hasSession(): boolean {
    return this.state !== null;
  }

  /**
   * Get current session state
   */
  getState(): SessionState | null {
    return this.state;
  }

  /**
   * Initialize a new translation session
   */
  initSession(
    originalContent: string,
    translatedContent: string,
    messages: vscode.LanguageModelChatMessage[],
    model: vscode.LanguageModelChat
  ): void {
    this.state = {
      originalContent,
      translatedContent,
      messages,
      model,
    };
  }

  /**
   * Update session with new translation
   */
  updateSession(
    originalContent: string,
    translatedContent: string,
    newMessages: vscode.LanguageModelChatMessage[]
  ): void {
    if (!this.state) return;
    this.state.originalContent = originalContent;
    this.state.translatedContent = translatedContent;
    this.state.messages = [...this.state.messages, ...newMessages];
  }

  /**
   * Clear the session
   */
  clearSession(): void {
    this.state = null;
  }

  /**
   * Detect changes between old and new content
   * Returns a structured diff
   */
  detectChanges(newContent: string): ContentDiff | null {
    if (!this.state) return null;

    const oldLines = this.state.originalContent.split('\n');
    const newLines = newContent.split('\n');

    const changes: Change[] = [];
    let oldIndex = 0;
    let newIndex = 0;

    // Simple line-by-line diff algorithm
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      if (oldIndex >= oldLines.length) {
        // Lines added at the end
        changes.push({
          type: 'added',
          lineNumber: newIndex + 1,
          content: newLines[newIndex],
        });
        newIndex++;
      } else if (newIndex >= newLines.length) {
        // Lines removed from the end
        changes.push({
          type: 'removed',
          lineNumber: oldIndex + 1,
          content: oldLines[oldIndex],
        });
        oldIndex++;
      } else if (oldLines[oldIndex] === newLines[newIndex]) {
        // Lines match
        oldIndex++;
        newIndex++;
      } else {
        // Lines differ - try to find if it's a modification or add/remove
        const oldInNew = newLines.indexOf(oldLines[oldIndex], newIndex);
        const newInOld = oldLines.indexOf(newLines[newIndex], oldIndex);

        if (oldInNew === -1 && newInOld === -1) {
          // Line was modified
          changes.push({
            type: 'modified',
            lineNumber: newIndex + 1,
            oldContent: oldLines[oldIndex],
            content: newLines[newIndex],
          });
          oldIndex++;
          newIndex++;
        } else if (oldInNew !== -1 && (newInOld === -1 || oldInNew - newIndex <= newInOld - oldIndex)) {
          // Lines were added
          changes.push({
            type: 'added',
            lineNumber: newIndex + 1,
            content: newLines[newIndex],
          });
          newIndex++;
        } else {
          // Lines were removed
          changes.push({
            type: 'removed',
            lineNumber: oldIndex + 1,
            content: oldLines[oldIndex],
          });
          oldIndex++;
        }
      }
    }

    if (changes.length === 0) {
      return null; // No changes
    }

    return {
      hasChanges: true,
      changes,
      summary: this.summarizeChanges(changes),
    };
  }

  /**
   * Create a human-readable summary of changes
   */
  private summarizeChanges(changes: Change[]): string {
    const added = changes.filter(c => c.type === 'added');
    const removed = changes.filter(c => c.type === 'removed');
    const modified = changes.filter(c => c.type === 'modified');

    const parts: string[] = [];
    if (added.length > 0) parts.push(`${added.length} lines added`);
    if (removed.length > 0) parts.push(`${removed.length} lines removed`);
    if (modified.length > 0) parts.push(`${modified.length} lines modified`);

    return parts.join(', ');
  }

  /**
   * Format diff for the prompt
   */
  formatDiffForPrompt(diff: ContentDiff, newContent: string): string {
    const lines: string[] = [];

    lines.push('The original document has been updated. Here are the changes:');
    lines.push('');

    for (const change of diff.changes) {
      switch (change.type) {
        case 'added':
          lines.push(`[LINE ${change.lineNumber} ADDED]: ${change.content}`);
          break;
        case 'removed':
          lines.push(`[LINE ${change.lineNumber} REMOVED]: ${change.content}`);
          break;
        case 'modified':
          lines.push(`[LINE ${change.lineNumber} CHANGED]:`);
          lines.push(`  Old: ${change.oldContent}`);
          lines.push(`  New: ${change.content}`);
          break;
      }
    }

    lines.push('');
    lines.push('Please update the translation to reflect these changes.');
    lines.push('Output the complete updated translation in Markdown format.');
    lines.push('');
    lines.push('Here is the complete updated original document for reference:');
    lines.push('---');
    lines.push(newContent);

    return lines.join('\n');
  }
}

export interface Change {
  type: 'added' | 'removed' | 'modified';
  lineNumber: number;
  content: string;
  oldContent?: string;
}

export interface ContentDiff {
  hasChanges: boolean;
  changes: Change[];
  summary: string;
}

// Singleton instance
export const translationSession = new TranslationSession();
