# Markdown AI Translator

<p align="center">
  <a href="https://github.com/breaking-brake/markdown-ai-translator/stargazers"><img src="https://img.shields.io/github/stars/breaking-brake/markdown-ai-translator" alt="GitHub Stars" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=breaking-brake.markdown-ai-translator"><img src="https://img.shields.io/visual-studio-marketplace/v/breaking-brake.markdown-ai-translator?label=VS%20Marketplace" alt="VS Code Marketplace" /></a>
</p>

<p align="center">
  <strong>Translate Markdown files using VSCode's built-in Language Model API (GitHub Copilot)</strong>
</p>

<p align="center">
  <em>"Optimize for AI, Visualize for You."</em><br>
  Keep your markdown in English for better AI performance, but read it in your native language instantly.
</p>

---

<p align="center">
  <img src="./resource/hero_demo.gif" alt="Markdown AI Translator Demo" width="800">
</p>

<p align="center">
  <em>Translate Markdown files with real-time streaming preview</em>
</p>

---

## Key Features

🌐 **AI-Powered Translation** - Translate Markdown files using VSCode Language Model API (GitHub Copilot, Grok, etc.)

⚡ **Streaming Translation** - See translation results in real-time as they are generated

📄 **Chunked Translation** - Large documents are translated in chunks to manage premium request usage

🎯 **Multiple Languages** - Support for Japanese, Chinese (Simplified/Traditional), Korean, and custom languages

💾 **Translation Cache** - Caches translations for 24 hours to avoid redundant API calls

## Getting Started

1. Open a Markdown file in VSCode
2. Click the 🌐 icon in the top-right corner of the editor
3. Or use keyboard shortcut: `Cmd+Shift+T` (Mac) / `Ctrl+Shift+T` (Windows/Linux)
4. Or open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) → **"Markdown: Translate"**

## Requirements

- VSCode 1.90.0 or later
- GitHub Copilot extension (Free plan is sufficient)
  - Free plan: 50 [premium requests](https://docs.github.com/en/copilot/concepts/billing/copilot-requests#model-multipliers)/month
  - Default model `grok-code-fast-1` does not consume premium requests (as of Jan 28, 2026)

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `markdownTranslate.targetLanguage` | Target language for translation | `Japanese` |
| `markdownTranslate.customTargetLanguage` | Custom language (when "Other" is selected) | - |
| `markdownTranslate.modelId` | Language model ID to use | `grok-code-fast-1` |
| `markdownTranslate.chunkSize` | Max characters per translation chunk | `5000` |
| `markdownTranslate.enableCache` | Enable translation cache | `true` |

## Commands

| Command | Description |
|---------|-------------|
| `Markdown: Translate` | Open translation preview for current Markdown file |
| `Markdown: Clear Translation Cache` | Clear all cached translations |

## License

This project is licensed under the **MIT License**.

See the [LICENSE](./LICENSE.md) file for the full license text.

Copyright (c) 2026 breaking-brake

---

**Made with Markdown AI Translator**
