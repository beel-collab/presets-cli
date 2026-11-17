# presets-dev

Install coding rules and skills into your project's native AI tool folders. Browse the presets at [presets.dev](https://presets.dev).

## Install

Requires Node.js 18 or newer and an internet connection. Run from your project directory.

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

Skill folders contain `SKILL.md` and any supporting files provided by the preset. Codex and Antigravity share the `.agents/skills/` copy. Cursor, Copilot, and Windsurf skip their own copy when the shared skill's `SKILL.md` is already present or installed by the same command.

Use `--agents-md` to send Antigravity instructions to `AGENTS.md`. When Codex and Antigravity are selected together with this flag, the Codex section is used once.

Existing files and installed sections are skipped by default. Instruction sections preserve the surrounding text and line endings. `--force` replaces eligible preset files or the contents of an existing marked section. Use `--dry-run` to preview the paths and actions before installing.

## Flags

`add <stack...>` accepts these flags.

| Flag | Purpose |
|---|---|
| `-t, --tool <tool,...>` | Select one or more tool IDs, separated by commas. |
| `--only <role>` | Install `standards` or `skill`. Both are installed by default. |
| `--dry-run` | Preview the install plan. |
| `--force` | Replace existing preset files or marked sections. |
| `--agents-md` | Append Antigravity instructions to `AGENTS.md`. |
| `--ref <ref>` | Fetch content from a Git branch, tag, or commit. Defaults to `main`. |
| `--cwd <dir>` | Set the project directory. Defaults to the current directory. |
| `-y, --yes` | Accept detected tools without prompting. Supply `--tool` if none are detected. |

`list` accepts `--tool <tool>`, `--json`, and `--ref <ref>`. Use `--help` for command help and `--version` for the CLI version.

Developer documentation is available in the [development guide](https://github.com/beel-collab/presets-cli/blob/main/DEVELOPMENT.md) and [build specification](https://github.com/beel-collab/presets-cli/blob/main/docs/SPEC.md).

## License

[MIT](LICENSE)
