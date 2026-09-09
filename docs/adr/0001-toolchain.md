# ADR-0001: First-release toolchain

- Status: accepted
- Date: 2026-09-01
- Amended: 2026-09-09 for the installed distribution
- Context: [spec #17](https://github.com/devosurf/migmate-cli/issues/17), [distribution decision #12](https://github.com/devosurf/migmate-cli/issues/12), [distribution implementation #22](https://github.com/devosurf/migmate-cli/issues/22), [engine seam #9](https://github.com/devosurf/migmate-cli/issues/9)

## Context

The build spec fixes the runtime (Node 24 LTS), the state binding (`node:sqlite`), the package shape (one global npm package, one `migmate` bin, `web` as a subcommand of the same binary), and the language (TypeScript). It fixes nothing about how the repository is built, typechecked, tested, formatted, or run in CI. That gap blocks the first line of code, and the spec's testing decisions depend on it: the CLI contract is tested by invoking the command layer in-process **and** by spawning the real binary, and the webview adapter needs its static assets embedded in the installed artifact.

The original source-only decision was disproven by an actual Node 24 installed-package probe: executing TypeScript inside `node_modules` failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Node's source-checkout type stripping therefore cannot serve as the npm distribution format.

## Decision

**No bundler; minimal `tsc` emission for the shipped CLI.** `tsconfig.build.json` overrides the development configuration with `noEmit: false`, `noEmitOnError`, `rewriteRelativeImportExtensions`, `rootDir: "src"`, and `outDir: "dist"`. It includes `src/**/*.ts`, including the runtime qualification validator. Emitted JavaScript preserves the source tree's relative layout, so the sole `migmate` bin is `dist/cli/main.js`. There is no second package manifest inside `dist`.

**Development still uses Node 24 type stripping and `tsc --noEmit`.** Relative source imports retain their `.ts` extensions; emission rewrites them to `.js`. `erasableSyntaxOnly`, `verbatimModuleSyntax`, and `module: nodenext` remain in force. `scripts/build-package.ts` copies every non-TypeScript source asset beside its emitted module, including the SQLite schema and static web assets, and marks the bin executable. `prepack` builds and verifies all managed vendor binaries before npm constructs the artifact.

**`node:test` is the test runner.** No Vitest, no Jest. The suite's hard requirements are spawning real subprocesses, killing them, and reading a second SQLite connection from another process; a third-party runner adds a dependency and a worker model without helping any of that.

**Prettier formats; nothing lints.** One dev dependency for formatting keeps diffs boring. ESLint is deferred: the compiler under `strict` plus `erasableSyntaxOnly` already rejects what a 0.x lint config would catch, and a rule set is a decision surface this release does not need.

**Runtime dependencies are pinned: `@webviewjs/webview` 0.4.5, `parse5` 8.0.0, and `smol-toml` 1.8.0.** The first implements the native in-process webview chosen in #12, with platform-specific optional binaries; `parse5` supports archive HTML handling; `smol-toml` parses and writes the actual TOML operator configuration required by #15 instead of putting JSON in a `.toml` file. All three are pinned in the package manifest and lockfile. Optional native packages remain enabled, but loading the desktop runtime belongs only to the `web` command, so a missing Linux WebKitGTK runtime must not disable the CLI.

**Hosted CI covers six native Node 24 cells**, not merely three OS names: macOS x64 (`macos-15-intel`) and arm64 (`macos-15`), Linux x64 (`ubuntu-24.04`) and arm64 (`ubuntu-24.04-arm`), and Windows x64 (`windows-2025`) and arm64 (`windows-11-arm`). The [hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) identifies their architectures. Each job checks its actual Node cell, uses `npm ci`, typechecks, runs tests, and packs and globally installs the artifact in a temporary prefix. The installed smoke invokes npm's real bin shim, creates and reads a durable job, checks embedded assets, verifies the managed host binary's exact version and all six checksums, and confirms that package imports are blocked.

**Native desktop launch and live route qualification are separate manual, self-hosted gates.** `workflow_dispatch` selects one exact cell. A protected desktop environment requires an interactive session, native runtime libraries, and an operator who inspects and closes the installed window; process exit alone is not visual evidence. A protected live-route environment points at an operator-prepared config outside the checkout and runs the real tenant probe, retaining only its sanitized immutable evidence. Hosted CLI success does not claim GUI behavior or qualify a route, and no passing desktop or live-tenant result is asserted by this decision.

## Consequences

- Three dev dependencies remain: `typescript`, `prettier`, and `@types/node`; the three runtime dependencies above are shipped through normal npm dependency resolution.
- The source language remains erasable TypeScript for direct development execution; installed users execute emitted JavaScript instead of depending on type stripping inside `node_modules`.
- `node:sqlite` remains a pre-stable Node 24 runtime dependency. The rejected source-only package format is not retained as a fallback.
- The package allowlist contains `dist`, managed `vendor` files, and qualification evidence; repository scripts, tests, and TypeScript tooling are not shipped. Embedded resources stay package-local rather than being downloaded or served over a loopback listener.
- An explicit empty `exports` map blocks both the package root and deep package imports. There is no public engine SDK: the installed interaction surface is the single `migmate` command, including its `web` subcommand.
- The six-cell workflow and manual gates are executable checks, not recorded qualification results. Native desktop access, Linux WebKitGTK 4.1 and libxdo, Windows WebView2, prepared tenant credentials, and actual route evidence remain external prerequisites.
- The user explicitly raised the supported macOS floor to **13.5+** on x64 and arm64, retaining Node 24. This resolves the earlier 10.15+ incompatibility with [official Node 24.20.0](https://raw.githubusercontent.com/nodejs/node/v24.20.0/BUILDING.md); it is not an outstanding gate. Distribution checks use the host's actual macOS product version, and no alternate runtime fallback is shipped.
