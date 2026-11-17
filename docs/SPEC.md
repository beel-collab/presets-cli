# presets-cli

The command-line installer for [presets.dev](https://presets.dev). It drops original, tested AI coding presets (rules/instructions and skills) into a project in the right native place for each tool.

```bash
npx presets-dev add nextjs              # auto-detects your tool(s)
npx presets-dev add nextjs --tool claude
npx presets-dev list
```

> **Status:** v1 implemented. This document remains the build brief and behavior reference. The owner merges and publishes.

To work on the CLI locally:

```bash
npm ci
npm run build
node dist/cli.js list
node dist/cli.js add nextjs --tool cursor --dry-run
npm run lint
npm run typecheck
npm test
npm pack --dry-run
```

See [DEVELOPMENT.md](../DEVELOPMENT.md) for test coverage and dependency constraints.

---

## 1. Goals and non-goals

**v1 goals**
- One command installs a stack's presets for one or more tools, in the correct native paths.
- Never destroys user content: it appends to shared files and skips files that already exist.
- Zero config and no account; works with `npx`.
- Presets are fetched at runtime from the public content repo, so new presets reach users without a CLI release.

**Non-goals for v1:** login, telemetry, a generator or wizard UI, agent presets (skipped for now), editing or removing installed presets, private registries, or bundling preset content inside the npm package.

## 2. Package facts

| Item | Value |
|---|---|
| npm name | `presets-dev` (also reserve `presets.dev`, and create the npm org `presetsdev` for later `@presetsdev/*`) |
| Binaries | `presets-dev` (main) and `presets` (alias) |
| Runtime | Node >= 22 (built-in `fetch`), ESM, TypeScript compiled to `dist/` |
| Dependencies | Keep tiny: an arg parser (`commander` or `cac`), `picocolors`, `prompts` (only for the multi-tool prompt). No heavy frameworks. |
| Build/test | `tsup` for building, `vitest` for tests |
| License | MIT, © presets.dev |
| Repo | `beel-collab/presets-cli` (private until launch) |

## 3. Source of truth (content)

Content lives in the public repo **`beel-collab/presets.dev`**. The CLI reads it over HTTPS (no git clone):

- Base URL: `https://raw.githubusercontent.com/beel-collab/presets.dev/<ref>/`
- `<ref>` defaults to `main`; `--ref <tag|sha>` overrides it (useful for pinning and tests).
- **Manifest:** `release/original-2026-11/stacks.json`, with top-level keys `release`, `tools`, `note` and `stacks`. Each stack:

```json
{
  "id": "nextjs",
  "status": "complete",
  "entries": [
    {
      "catalog": "cursor/nextjs/nextjs-rules.mdc",
      "tool": "cursor",
      "role": "standards",
      "type": "rule",
      "exports": ["release/nextjs/native/cursor/.cursor/rules/nextjs-rules.mdc"]
    }
  ]
}
```

- `role` is `standards` (the rules/instructions file) or `skill`.
- Entries for tools unsupported by the installed CLI are ignored, so adding a tool to the live manifest does not break existing installations.
- **Install the `exports` file, never the `catalog` file.** Catalog files carry presets.dev metadata frontmatter; export files are the clean native versions.
- The project-relative destination is the export path with the `release/<stack>/native/<bucket>/` prefix stripped. For example, `release/nextjs/native/claude/.claude/rules/nextjs-rules.md` installs to `.claude/rules/nextjs-rules.md`.
- Only stacks with `status: "complete"` can be installed.
- Read the manifest dynamically. Don't hardcode stack names or the release folder; a future release folder may be added, so keep the manifest path in one constant, overridable with the `PRESETS_MANIFEST` env var.

There are 30 stacks today: angular, django, docker, dotnet, express, fastapi, flutter, go, kotlin, laravel, mcp, nestjs, nextjs, nodejs, nuxt, playwright, prisma, python, rails, react, react-native, rust, spring, supabase, svelte, swiftui, tailwind, terraform, typescript and vue.

## 4. Tools and install rules

Seven tools. These rules come from `release/README.md` in the content repo, which is authoritative if the two ever disagree.

| `--tool` | Standards go to | Write mode | Skill goes to |
|---|---|---|---|
| `cursor` | `.cursor/rules/<stack>-rules.mdc` | create file | `.cursor/skills/<skill>/SKILL.md` |
| `copilot` | `.github/instructions/<stack>.instructions.md` | create file | `.github/skills/<skill>/SKILL.md` |
| `claude` | `.claude/rules/<stack>-rules.md` | create file | `.claude/skills/<skill>/SKILL.md` |
| `windsurf` | `.devin/rules/<stack>-rules.md` | create file | `.devin/skills/<skill>/SKILL.md` |
| `cline` | `.clinerules/<stack>-rules.md` | create file | `.cline/skills/<skill>/SKILL.md` |
| `codex` | content of `AGENTS.<stack>-section.md`, **appended** to `AGENTS.md` | append section | `.agents/skills/<skill>/SKILL.md` (shared) |
| `antigravity` | content of `GEMINI.<stack>-section.md`, **appended** to `GEMINI.md` (or `AGENTS.md` with `--agents-md`) | append section | `.agents/skills/<skill>/SKILL.md` (shared) |

Hard rules:
1. **Windsurf installs only under `.devin/`.** Never also write to `.windsurf/`.
2. **Never replace `AGENTS.md`, `GEMINI.md` or `CLAUDE.md`.** Append a marked section (see §6). Create the file if it's missing.
3. **Antigravity:** append to `GEMINI.md` *or* `AGENTS.md`, never both.
4. **Shared skill path:** Codex and Antigravity share `.agents/skills/<skill>/SKILL.md`; write it once even if both tools are selected. Cursor, Copilot and Devin also read `.agents/skills`, so if `.agents/skills/<skill>/SKILL.md` already exists, or this run writes it, skip their own copy and print a note (avoids duplicate skills with the same name). An empty or unsearchable skill folder doesn't count, so their own copy still installs.
5. **Never overwrite an existing file** unless `--force` is given. Report it as `skipped (exists)`.
6. **Legacy Cline files:** if `.clinerules` is a file, preserve it and skip Cline standards with a note. Continue installing skills and presets for other selected tools, including with `--force`.
7. **Shared AGENTS sections:** when Codex and Antigravity are both selected with `--agents-md`, use the Codex standards export regardless of manifest order. Antigravity alone uses its own export.

## 5. Commands

### `add <stack...>`
Installs one or more stacks.

| Flag | Meaning |
|---|---|
| `-t, --tool <tool,...>` | One or more tool ids. If omitted, auto-detect (§7). |
| `--only <standards\|skill>` | Install just one role (default: both). |
| `--dry-run` | Print the plan (paths and actions), write nothing. |
| `--force` | Overwrite existing files and replace an existing marked section. |
| `--agents-md` | For antigravity, append to `AGENTS.md` instead of `GEMINI.md`. |
| `--ref <ref>` | Content git ref (default `main`). |
| `--cwd <dir>` | Project root (default: current directory). |
| `-y, --yes` | Don't prompt; with no tool detected, fail with a helpful message. |

Output: one line per file with its action (`created`, `appended`, `skipped (exists)`, `skipped (shared skill already present)`, `would create` in dry-run), then a summary line and a link to the stack page `https://presets.dev/<tool>/...` if cheap to build, otherwise `https://presets.dev`.

### `list`
Prints installable stacks: id, plus the skill name per stack. `--json` prints machine-readable output. `--tool <tool>` filters to entries for one tool.

### `--help` and `--version`
Standard.

## 6. Appending to shared files (idempotent)

Wrap every appended section in markers so re-runs are safe:

```md
<!-- presets.dev:nextjs:start -->
...section content...
<!-- presets.dev:nextjs:end -->
```

- If the marker for that stack already exists, skip it (`skipped (exists)`); with `--force`, replace only the content between the markers.
- If the file's markers for that stack are malformed (a lone, repeated or out-of-order marker), leave the file untouched and report `skipped (malformed presets.dev markers)`; the other files still install.
- If the file is not UTF-8 text (a UTF-16 or UTF-32 byte-order mark, or NUL bytes, as Windows PowerShell 5.1's `>` produces), leave it untouched and report `skipped (unsupported text encoding)`. A UTF-8 byte-order mark is fine.
- If appending fails partway (for example, the disk is full), preserve the file and report the write error with instructions to inspect and remove any unfinished presets.dev section by hand before retrying. This preserves edits made by other programs during error recovery.
- If a downloaded section export itself contains `presets.dev` markers, don't write it (`skipped (export contains presets.dev markers)`), so a content mistake can't leave a file later runs refuse. Dry runs don't download, so only a real run reports this.
- Separate from existing content with one blank line, preserving any existing trailing blank lines. Preserve the file's existing line endings (detect CRLF vs LF and match it) and keep a trailing newline.
- Section updates use a temporary per-file lock, so overlapping CLI installs re-read and merge the latest contents. Locks are removed on completion; a stale lock after a terminated process produces a retry message instead of being removed automatically.
- New sections append through an open file handle without rewriting existing text. If an editor replaces the file, the worker re-reads and retries. Forced replacements check the original identity and contents after preparing the new file, and abort on detected edits; this check is not an atomic compare-and-swap against editors, so avoid simultaneous editor saves during `--force`.

## 7. Tool auto-detection

Look in `--cwd` for these signals:

| Tool | Signals |
|---|---|
| cursor | `.cursor/` or `.cursorrules` |
| copilot | `.github/copilot-instructions.md` or `.github/instructions/` |
| claude | `.claude/` or `CLAUDE.md` |
| windsurf | `.devin/`, `.windsurf/` or `.windsurfrules` |
| cline | `.clinerules` (file or dir) or `.cline/` |
| codex | `AGENTS.md` or `.codex/` |
| antigravity | `GEMINI.md` or `.gemini/` |

- One detected: use it.
- Several detected: interactive multi-select of all 7 tools, with detected tools preselected; with `--yes`, use all detected tools.
- None: interactive single/multi-select of all 7; with `--yes` or a non-TTY, exit 1 with "No AI tool detected. Pass --tool <cursor|copilot|claude|windsurf|cline|codex|antigravity>."

## 8. Errors and exit codes

- Unknown stack: exit 1, and suggest the closest ids (simple edit distance) plus `presets-dev list`.
- Unknown tool: exit 1, and list valid ids.
- Network/HTTP failure: exit 2 with the URL that failed; no partial writes for that file. Write files only after their content is fully downloaded; download everything first, then write.
- Downloads are deduplicated and run up to six at a time. A failed download stops new requests; in-flight requests finish before the command exits without writing.
- A `--cwd` that doesn't exist, isn't a folder, or can't be searched: exit 1 before detection or any download.
- Exit 0 on success, including when everything was skipped.
- `--dry-run` never touches disk.

## 9. Safety

- Only write inside `--cwd`. Reject any computed path that escapes it (after normalising) or is absolute.
- Read-only checks for existing files and shared skills may follow symlinks. Paths that will be written must not contain symlinks.
- A problem with one target is reported for that file and the other files still install:
  - a parent folder that is a regular file (for example a `.github` file): `skipped (parent folder is a file)`;
  - a folder or other non-file where a file should be: `skipped (not a regular file)`;
  - a read-only or unreadable file, or a folder that can't be written or searched: `skipped (permission denied)`. A file that already has what would be installed still reports `skipped (exists)`. Windows reports every folder as writable, so a folder denied by its access list is only caught if the write fails with `EACCES`;
  - a hard-linked file: `skipped (file is hard-linked)`. Appending would change another filename outside the project, and replacing (`--force`) would silently split the names apart, so both are refused. Make an independent project copy before retrying. A `.presets-<uuid>.tmp` link left by an interrupted earlier run is the installer's own and doesn't count; it is removed before writing.
- Safety failures (a symlink or swapped folder found while writing, a project directory that changed) still stop the install and list the files already written.
- Writes run in an isolated Node worker with its working directory pinned to each validated destination parent. Directory swaps cannot redirect writes through a replacement symlink. Replacement preserves the existing file's permission bits.
- Fetch only from the configured raw GitHub base URL over HTTPS. No `eval`, no executing downloaded content, and no postinstall scripts in the package.
- No telemetry in v1.

## 10. Suggested layout

```
presets-cli/
  src/
    cli.ts          # arg parsing, commands
    manifest.ts     # fetch and parse stacks.json, list stacks
    plan.ts         # stack + tools -> list of file actions (pure, unit-tested)
    install.ts      # executes a plan (writes, appends, skips)
    detect.ts       # tool auto-detection
    markers.ts      # append/replace marked sections, EOL handling
    fetch.ts        # raw fetch with base URL + ref
    writer-client.ts # sends downloaded bytes to the isolated writer
    writer.ts       # pinned directories and shared-file locks
    write-file.ts   # file-handle reads and atomic publication
  test/
    fixtures/       # tiny fake manifest + files
    *.test.ts
  package.json
  tsconfig.json
  README.md
  LICENSE
```

Keep `plan.ts` pure (no I/O) so the install rules in §4 are fully covered by unit tests.

## 11. Acceptance checklist

The build is done when all of these pass:

Verified locally against the live content and the packed npm tarball. Registry publication is owner-run. GitHub Actions is configured for Node 22/24/26 across Linux, macOS, and Windows.

- [x] `npx presets-dev list` shows 30 stacks from the live manifest (tested using the local tarball).
- [x] `add nextjs --tool cursor` in an empty dir creates `.cursor/rules/nextjs-rules.mdc` and `.cursor/skills/nextjs-code-review/SKILL.md`, byte-identical to the export files.
- [x] Same check passes for copilot, claude, windsurf (`.devin/` only; nothing under `.windsurf/`) and cline.
- [x] `add nextjs --tool codex` with an existing `AGENTS.md` keeps its original content and appends one marked section; re-running changes nothing.
- [x] `add nextjs --tool codex,antigravity` writes `.agents/skills/nextjs-code-review/SKILL.md` once and appends to `AGENTS.md` and `GEMINI.md` respectively.
- [x] `--agents-md` sends antigravity's section to `AGENTS.md`, not `GEMINI.md`, and doesn't duplicate if codex's section is already there for that stack.
- [x] A CRLF `AGENTS.md` stays CRLF after appending.
- [x] Existing files are skipped without `--force` and replaced with it.
- [x] `--dry-run` prints the full plan and writes nothing.
- [x] Auto-detect works for each signal in §7; no-tool + `--yes` exits 1 with the message.
- [x] Unknown stack suggests close matches; network failure exits 2 and leaves no partial files.
- [x] Path-escape attempts in a malicious fixture manifest are rejected.
- [x] Unit tests cover every row of §4; CI (GitHub Actions, Node 22/24/26) is configured to run lint, typecheck and tests.
- [x] `npm pack` contains only `dist/`, `README.md`, `LICENSE` and `package.json`.

## 12. Working rules for this repo

- Commit with sign-off: `git commit -s`.
- Work on a branch and open a PR; the owner merges and publishes. **Agents do not run `npm publish`.**
- Don't copy third-party preset content into this repo; the CLI only fetches from `beel-collab/presets.dev`.

## 13. Later (not v1)

`remove`/`update` commands, `init` wizard, presets.dev download-endpoint fallback, `@presetsdev/*` scoped packages, agent presets once formats settle, and opt-in anonymous install counts.
