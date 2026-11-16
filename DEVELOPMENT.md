# Development

Use Node 24 for development. The installed CLI supports Node 18 and newer.
`npm ci` installs the locked dependencies. `npm test` runs synthetic fixtures and
builds the CLI for subprocess tests; it does not need network access or download
third-party preset content.

Tests cover the seven native install mappings, export byte preservation, shared
skills, role filters, marked sections, CRLF, force and dry-run behavior, every
auto-detection signal, prompts, manifest overrides, pinned refs, error codes,
failed downloads, bounded download concurrency, legacy Cline files, unsupported
hard links, concurrent file changes, traversal attempts, and symlink handling. GitHub Actions runs
lint, typecheck, tests, build, and a package check on Node 18, 20, and 22 across
Linux, macOS, and Windows. POSIX permission and process-signal tests run on
Linux and macOS because Windows uses different permission and signal behavior.

The npm package contains only `dist/`, `README.md`, `LICENSE`, and `package.json`.
Run `npm pack` to test the tarball locally. Both `presets-dev` and `presets` point
to the compiled executable. Do not publish from an agent session.

The build includes a separate writer executable under `dist/`. The CLI passes
downloaded bytes to it as data. The worker pins and verifies each destination
directory before using relative file operations, and serializes shared-section
updates with per-file locks. The main CLI's working directory stays unchanged.
Tests build both executables once before running. Fault tests exercise the
write primitives directly; subprocess regressions cover overlapping installs,
directory substitution, root replacement, exact permission preservation,
in-place and atomic editor saves, and shared skills appearing during downloads.
New sections use append-only writes. Forced section replacements detect edits
before publishing, but the final check and rename are separate operations;
other editors should finish saving before a forced replacement.

## Node 18 dependency constraints

Commander 12, ESLint 9, Vitest 3, and Vite 6 retain Node 18 support. The overrides
keep Vite on that compatible major and patch esbuild and minimatch used by the
development tools.

Some locked development-only transitive dependencies declare newer Node engines.
Node 24 satisfies those declarations, including with `engine-strict=true`.
The Node 18/20/22 CI jobs still exercise runtime compatibility with npm's default
engine checks; this does not claim Node 18 support for strict development installs.

At implementation time, `npm audit --omit=dev` reported no vulnerabilities.
The full audit reported three development-only findings in Vitest 3 and its
`@vitest/mocker` and `tinypool` dependencies. Available upstream fixes require
newer Node versions. The tests run with `vitest run`; this project does not
expose the Vitest browser mocking server or accept external worker options.
Revisit those dependencies when the minimum development Node version changes.
