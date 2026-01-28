---
name: pr-to-production
description: Create a release PR from main to production branch. Use when the user says "リリースPR", "productionにPR", "リリース準備", or wants to trigger a release.
---

# PR to Production Branch (Release)

Create release PR from main to production for semantic-release.

## Workflow

1. **Gather context** (parallel):
   - `git log production..main --oneline` for commits to release
   - `git tag --sort=-v:refname | head -1` for latest release version
   - Check if main is ahead of production

2. **Analyze commits**:
   - Categorize by type: feat, fix, chore, etc.
   - Calculate expected version bump

3. **Create PR**:
   - Use `gh pr create` with base `production`
   - Use template from `assets/pr-template.md`

## Version Bump Rules

- `feat:` → **minor** (1.0.0 → 1.1.0)
- `fix:`, `perf:`, `revert:` → **patch** (1.0.0 → 1.0.1)
- `BREAKING CHANGE` → **major** (1.0.0 → 2.0.0)
- `docs:`, `chore:`, `ci:` → no bump

## PR Format

**Title**: `Release: vX.Y.Z`

**Body**: Use template at `assets/pr-template.md`

## Example

```bash
gh pr create --base production --title "Release: v0.2.0" --body "$(cat <<'EOF'
## Summary

Merge latest changes from `main` to `production` for automated release v0.2.0.

## Included Changes

### Features
- feat: add chunk-based translation for large documents (#5)

### Enhancements
- chore: setup semantic-release (#4)

## Release Version Calculation

**v0.2.0** (minor bump)

Semantic Release will analyze commits since v0.1.1:
- ✅ `feat: add chunk-based translation` (#5) → **minor bump**
- ❌ `chore: setup semantic-release` (#4) → no version bump

Result: **0.1.1 + minor = 0.2.0**

## CHANGELOG.md Contents

The following features will be included:
- Add chunk-based translation for large documents (#5)

Setup semantic-release (#4) will not appear in CHANGELOG.

## Release Automation

This merge will trigger:
1. Analyze commit messages (0.1.1 → 0.2.0)
2. Update version in package.json files
3. Generate CHANGELOG.md with features
4. Create GitHub release
5. Build and upload VSIX package
6. Sync version changes back to main

## Merge Strategy

**Use merge commit** (not squash) to preserve commit history for Semantic Release.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
