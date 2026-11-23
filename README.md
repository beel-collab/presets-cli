# presets-dev

Install coding rules and skills into your project's native AI tool folders. Browse the presets at [presets.dev](https://presets.dev).

## Install

Requires Node.js 22 or newer and an internet connection. Run from your project directory.

```bash
npx presets-dev add nextjs
```

The CLI fetches the current catalog from the public content repository when you run `list` or `add`.

## Usage

```bash
npx presets-dev list
npx presets-dev add nextjs --tool cursor
npx presets-dev add nextjs typescript --tool claude,codex
npx presets-dev add nextjs --tool cursor --dry-run
npx presets-dev list --tool claude --json
```

`list` shows available stacks and their skills. `add` installs one or more stacks.

When `--tool` is omitted, the CLI detects tools from your project's existing files and folders. Interactive runs prompt when a tool selection is needed. For scripts, specify `--tool` or use `--yes` to accept detected tools.

## Supported tools and install paths

All paths are relative to your project directory. `<stack>` is the selected stack, and `<skill>` is the skill name shown by `list`.

| Tool ID | Rules or instructions | Skill folder |
|---|---|---|
| `cursor` | `.cursor/rules/<stack>-rules.mdc` | `.cursor/skills/<skill>/` |
| `copilot` | `.github/instructions/<stack>.instructions.md` | `.github/skills/<skill>/` |
| `claude` | `.claude/rules/<stack>-rules.md` | `.claude/skills/<skill>/` |
| `windsurf` | `.devin/rules/<stack>-rules.md` | `.devin/skills/<skill>/` |
| `cline` | `.clinerules/<stack>-rules.md` | `.cline/skills/<skill>/` |
| `codex` | Marked section appended to `AGENTS.md` | `.agents/skills/<skill>/` |
| `antigravity` | Marked section appended to `GEMINI.md` | `.agents/skills/<skill>/` |

Skill folders contain `SKILL.md` and any supporting files provided by the preset. Codex and Antigravity share the `.agents/skills/` copy. Cursor, Copilot, Windsurf, and Cline read that folder too: when two or more of these six tools are selected, the skill is written once to `.agents/skills/` and their own copies are skipped. Each of them also skips its own copy when the shared skill's `SKILL.md` is already there. Claude Code doesn't read `.agents/skills/`, so it always gets its own copy.

Links that stay inside the project are followed: with `AGENTS.md -> CLAUDE.md`, the Codex section is appended to `CLAUDE.md`, and with `.claude/skills -> ../.agents/skills` each skill is written once. Links that point outside the project are left alone and reported as skipped.

When Codex and Antigravity are selected together, Antigravity's standards go to `AGENTS.md` once, because Antigravity CLI reads `AGENTS.md` as well as `GEMINI.md`. The Codex section is used. Pass `--gemini-md` to keep a separate `GEMINI.md` anyway. Use `--agents-md` to send Antigravity instructions to `AGENTS.md` when Codex isn't selected.

Existing files and installed sections are skipped by default. Instruction sections preserve the surrounding text and line endings. `--force` replaces eligible preset files or the contents of an existing marked section. Use `--dry-run` to preview the paths and actions before installing.

## Flags

`add <stack...>` accepts these flags.

| Flag | Purpose |
|---|---|
| `-t, --tool <tool,...>` | Select one or more tool IDs, separated by commas. |
| `--only <role>` | Install `standards` or `skill`. Both are installed by default. |
| `--dry-run` | Preview the install plan. |
| `--force` | Replace existing preset files or marked sections. |
| `--agents-md` | Append Antigravity instructions to `AGENTS.md`. This is the default when Codex is also selected. |
| `--gemini-md` | Keep Antigravity instructions in `GEMINI.md` even when Codex is selected. |
| `--ref <ref>` | Fetch content from a Git branch, tag, or commit. Defaults to `master`. |
| `--cwd <dir>` | Set the project directory. Defaults to the current directory. |
| `-y, --yes` | Accept detected tools without prompting. Supply `--tool` if none are detected. |

`list` accepts `--tool <tool>`, `--json`, and `--ref <ref>`. Use `--help` for command help and `--version` for the CLI version.

Developer documentation is available in the [development guide](https://github.com/beel-collab/presets-cli/blob/master/DEVELOPMENT.md) and [build specification](https://github.com/beel-collab/presets-cli/blob/master/docs/SPEC.md).

## License

[MIT](LICENSE)
