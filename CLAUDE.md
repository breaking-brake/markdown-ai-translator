# Markdown AI Translator - Development Guidelines

## Project Structure

```
markdown-ai-translator/
├── src/
│   ├── extension.ts      # VSCode extension entry point
│   ├── translator.ts     # Translation logic using LanguageModel API
│   ├── preview.ts        # Webview panel management
│   ├── session.ts        # Translation session with conversation history
│   ├── cache.ts          # Translation cache
│   └── webview/          # React webview (separate package)
│       ├── src/
│       ├── biome.json    # Biome configuration
│       └── package.json
├── package.json          # Extension manifest
└── tsconfig.json
```

## Build Process

### Before Building

**Always run Biome checks on the webview before building:**

```bash
# Navigate to webview directory
cd src/webview

# Format code
npm run format

# Lint and fix issues
npm run lint

# Run all checks (format + lint)
npm run check

# Return to root
cd ../..
```

### Building

```bash
# Build everything (webview + extension)
npm run build

# Or build separately
npm run build:webview
npm run build:extension
```

### Quick Command (from project root)

```bash
cd src/webview && npm run check && cd ../.. && npm run build
```

## Biome Commands (in src/webview)

| Command | Description |
|---------|-------------|
| `npm run format` | Format all files |
| `npm run lint` | Lint and auto-fix issues |
| `npm run check` | Run both format and lint with auto-fix |
| `npm run biome:ci` | CI mode (no auto-fix, fails on errors) |

## Development Workflow

1. Make changes to code
2. Run `npm run check` in `src/webview` to format and lint
3. Run `npm run build` from project root to compile
4. Press F5 in VSCode to launch Extension Development Host
5. Open a Markdown file and use `Cmd+Shift+T` to translate

## Key Features

- **Streaming Translation**: Shows translation output as it streams from LLM
- **Incremental Translation**: Uses conversation history to only translate changed parts
- **Document Change Detection**: Monitors source file and shows indicator when changes detected
- **Model Selection**: Switch between available language models
