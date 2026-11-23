# Changelog

## 0.1.2

### Changed

- **Codex and Antigravity together load the stack once.** Antigravity CLI reads `AGENTS.md` as well as `GEMINI.md`. When both tools are selected, Antigravity's standards now go to `AGENTS.md` and the Codex section is written once. A one-line note says so. Pass the new `--gemini-md` flag to keep a separate `GEMINI.md`.
- **One skill copy for tools that share a folder.** Cursor, Copilot, Windsurf, Cline, Codex and Antigravity all read `.agents/skills/`. When two or more of them are selected, each skill is written there once and their own copies are skipped. Claude Code doesn't read that folder, so it keeps its own copy. A single tool still installs to its own folder. Cline now also skips its copy when the shared skill already exists.
- **Scripts must choose tools.** Without a terminal and without `--yes`, finding several tools now exits 1, lists them, and asks for `--tool` or `--yes`. It no longer installs for all of them silently.
- **Content comes from `master` by default.** The content repo's default branch is `master`. `main` only worked through GitHub's rename redirect.
- **Clearer output.** The summary links to the installed stacks on presets.dev. The skip for a tool's own skill copy now reads `skipped (uses shared .agents/skills/<skill>)`.

### Fixed

- **Symlinked `AGENTS.md` and `GEMINI.md`.** A link that stays inside the project, such as `AGENTS.md -> CLAUDE.md`, is now followed: the section is appended to the real file, shown as `AGENTS.md -> CLAUDE.md`. Folder links such as `.claude/skills -> ../.agents/skills` work the same way, and a file reached twice is written once. Links that point outside the project are still skipped.
- **Stale lock after a crash.** A `.presets-AGENTS.md.lock` left behind by a crash or `kill -9` made every later Codex or Antigravity install fail. The lock now records its owner's pid and is broken when that process is gone, or when it has no owner and is older than 30 seconds.
- **Unknown stack suggestions.** Only close matches are suggested now. `presets-dev add zzz` no longer offers unrelated stacks.

### Added

- A warning when `AGENTS.md` grows past 28 KiB, because Codex reads the first 32 KiB by default.
- `--gemini-md`.

### Unchanged

- Node.js 22 or later is still required. The `engines` field, README, and CI (Node 22, 24 and 26 on Linux, macOS and Windows) all agree.

## 0.1.1

- First public release.
