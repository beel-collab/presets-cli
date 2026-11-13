# presets-cli

The command-line installer for [presets.dev](https://presets.dev). It drops original, tested AI coding presets (rules/instructions and skills) into a project in the right native place for each tool.

```bash
npx presets-dev add nextjs              # auto-detects your tool(s)
npx presets-dev add nextjs --tool claude
npx presets-dev list
```

> **Status:** spec only. This README is the build brief. Build exactly what's here, keep v1 small, and ship it.

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
| Runtime | Node >= 18 (built-in `fetch`), ESM, TypeScript compiled to `dist/` |
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
4. **Shared skill path:** Codex and Antigravity share `.agents/skills/<skill>/SKILL.md`; write it once even if both tools are selected. Cursor, Copilot and Devin also read `.agents/skills`, so if `.agents/skills/<skill>/` already exists when installing for those tools, skip their own copy and print a note (avoids duplicate skills with the same name).
5. **Never overwrite an existing file** unless `--force` is given. Report it as `skipped (exists)`.

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
- Separate from existing content with one blank line. Preserve the file's existing line endings (detect CRLF vs LF and match it) and keep a trailing newline.

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
- Several detected: interactive multi-select (all preselected); with `--yes`, use all of them.
- None: interactive single/multi-select of all 7; with `--yes` or a non-TTY, exit 1 with "No AI tool detected. Pass --tool <cursor|copilot|claude|windsurf|cline|codex|antigravity>."

## 8. Errors and exit codes

- Unknown stack: exit 1, and suggest the closest ids (simple edit distance) plus `presets-dev list`.
- Unknown tool: exit 1, and list valid ids.
- Network/HTTP failure: exit 2 with the URL that failed; no partial writes for that file. Write files only after their content is fully downloaded; download everything first, then write.
- Exit 0 on success, including when everything was skipped.
- `--dry-run` never touches disk.

## 9. Safety

- Only write inside `--cwd`. Reject any computed path that escapes it (after normalising) or is absolute.
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

- [ ] `npx presets-dev list` shows 30 stacks from the live manifest.
- [ ] `add nextjs --tool cursor` in an empty dir creates `.cursor/rules/nextjs-rules.mdc` and `.cursor/skills/nextjs-code-review/SKILL.md`, byte-identical to the export files.
- [ ] Same check passes for copilot, claude, windsurf (`.devin/` only; nothing under `.windsurf/`) and cline.
- [ ] `add nextjs --tool codex` with an existing `AGENTS.md` keeps its original content and appends one marked section; re-running changes nothing.
- [ ] `add nextjs --tool codex,antigravity` writes `.agents/skills/nextjs-code-review/SKILL.md` once and appends to `AGENTS.md` and `GEMINI.md` respectively.
- [ ] `--agents-md` sends antigravity's section to `AGENTS.md`, not `GEMINI.md`, and doesn't duplicate if codex's section is already there for that stack.
- [ ] A CRLF `AGENTS.md` stays CRLF after appending.
- [ ] Existing files are skipped without `--force` and replaced with it.
- [ ] `--dry-run` prints the full plan and writes nothing.
- [ ] Auto-detect works for each signal in §7; no-tool + `--yes` exits 1 with the message.
- [ ] Unknown stack suggests close matches; network failure exits 2 and leaves no partial files.
- [ ] Path-escape attempts in a malicious fixture manifest are rejected.
- [ ] Unit tests cover every row of §4; CI (GitHub Actions, Node 18/20/22) runs lint, typecheck and tests.
- [ ] `npm pack` contains only `dist/`, `README.md`, `LICENSE` and `package.json`.

## 12. Working rules for this repo

- Commit with sign-off: `git commit -s`.
- Work on a branch and open a PR; the owner merges and publishes. **Agents do not run `npm publish`.**
- Don't copy third-party preset content into this repo; the CLI only fetches from `beel-collab/presets.dev`.

## 13. Later (not v1)

`remove`/`update` commands, `init` wizard, presets.dev download-endpoint fallback, `@presetsdev/*` scoped packages, agent presets once formats settle, and opt-in anonymous install counts.
