---
name: pr-to-main
description: Create a PR to main branch for feature/fix changes. Use when the user says "PRを作成", "mainにPR", or wants to submit changes for review.
---

# PR to Main Branch

Create PR for feature branches targeting main.

## Workflow

1. **Gather context** (parallel):
   - `git status` (no -uall flag)
   - `git diff` for staged/unstaged changes
   - `git log` for commit history on current branch
   - Check if branch tracks remote and needs push

2. **Analyze changes**:
   - Review ALL commits in the branch (not just latest)
   - Identify the type: bug fix, new feature, enhancement, refactor

3. **Create PR** (parallel if needed):
   - Push branch with `-u` flag if needed
   - Create PR using `gh pr create`
   - Use template from `assets/pr-template.md`

## PR Format

**Title**: Under 70 characters, descriptive

**Body**: Use template at `assets/pr-template.md`

## Example

```bash
gh pr create --title "fix: resolve cache invalidation issue" --body "$(cat <<'EOF'
## Problem

Cache not clearing when document changes.

### Current Behavior
1. Edit document
2. ❌ Old translation shown

### Expected Behavior
1. Edit document
2. ✅ Cache invalidated, new translation

## Solution

Add file watcher to detect changes and clear cache.

### Changes

**File**: `src/cache.ts`
- Added `watchFile()` method
- Clear cache on change event

## Impact

- Translations always reflect latest content
- No breaking changes

## Testing

- [x] Manual E2E testing
- [x] Cache invalidation verified

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
