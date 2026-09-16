# ADR-0001: First-release toolchain

- Status: accepted
- Date: 2026-09-01
- Amended: 2026-09-09 for the installed distribution; 2026-09-12 for the platform matrix ([ADR-0002](0002-drop-windows.md)); 2026-09-16 for the runtime version policy below
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

**Hosted CI covers four native Node 24 cells**, not merely two OS names: macOS x64 (`macos-15-intel`) and arm64 (`macos-15`), and Linux x64 (`ubuntu-24.04`) and arm64 (`ubuntu-24.04-arm`). The [hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) identifies their architectures. Each job checks its actual Node cell, uses `npm ci`, typechecks, runs tests, and packs and globally installs the artifact in a temporary prefix. The installed smoke invokes npm's real bin shim, creates and reads a durable job, checks embedded assets, verifies the managed host binary's exact version and all four checksums, and confirms that package imports are blocked. Windows cells were removed by ADR-0002.

**Native desktop launch and live route qualification are separate manual, self-hosted gates.** `workflow_dispatch` selects one exact cell. A protected desktop environment requires an interactive session, native runtime libraries, and an operator who inspects and closes the installed window; process exit alone is not visual evidence. A protected live-route environment points at an operator-prepared config outside the checkout and runs the real tenant probe, retaining only its sanitized immutable evidence. Hosted CLI success does not claim GUI behavior or qualify a route, and no passing desktop or live-tenant result is asserted by this decision.

## Consequences

- Three dev dependencies remain: `typescript`, `prettier`, and `@types/node`; the three runtime dependencies above are shipped through normal npm dependency resolution.
- The source language remains erasable TypeScript for direct development execution; installed users execute emitted JavaScript instead of depending on type stripping inside `node_modules`.
- `node:sqlite` remains a pre-stable Node runtime dependency. The rejected source-only package format is not retained as a fallback.
- The package allowlist contains `dist`, managed `vendor` files, and qualification evidence; repository scripts, tests, and TypeScript tooling are not shipped. Embedded resources stay package-local rather than being downloaded or served over a loopback listener.
- An explicit empty `exports` map blocks both the package root and deep package imports. There is no public engine SDK: the installed interaction surface is the single `migmate` command, including its `web` subcommand.
- The four-cell workflow and manual gates are executable checks, not recorded qualification results. Native desktop access, Linux WebKitGTK 4.1 and libxdo, prepared tenant credentials, and actual route evidence remain external prerequisites.
- The user explicitly raised the supported macOS floor to **13.5+** on x64 and arm64, retaining Node 24. This resolves the earlier 10.15+ incompatibility with [official Node 24.20.0](https://raw.githubusercontent.com/nodejs/node/v24.20.0/BUILDING.md); it is not an outstanding gate. Distribution checks use the host's actual macOS product version, and no alternate runtime fallback is shipped.

## Amendment 2026-09-16: the runtime requirement is a tested set with a floor

"Node 24" was expressed as a bare major, written as five separate literals in three forms — `!== 24`, `=== "24"`, and `/^v24\./` in the evidence validator — while `engines` asked only for `>=24.0.0` with no `.npmrc`, making it advisory, and the shipped code carried no runtime check at all. The strictness therefore landed on maintainer scripts, where it only cost friction, and not on the consumer runtime, where the risk actually sits. Node 24 also enters maintenance on 2026-10-20, eight days before Node 26 becomes LTS, so widening was about to be archaeology across those literals.

**The requirement is now data, in `src/versions.ts`, as a map of tested major to its minimum version.** `TESTED_NODE` holds `{ "24": "24.15.0" }`. The floor is not cosmetic: `node:sqlite` reached stability 1.2 (release candidate) in 24.15.0, and earlier 24.x releases carry 1.1, so the previous `>=24.0.0` admitted a weaker tier than any evidence covers. `engines` matches the floor. The transfer binary version gets the same treatment in the same file, replacing eight `"v1.75.0"` literals, one of which sat in the bundle validator.

**An unsupported runtime refuses in the CLI**, as a `usage` refusal at exit 2, raised before the engine opens so it never reaches the store. `--help` still answers on any runtime, because an operator on the wrong Node needs to be able to read the requirement off the tool. The evidence validator now asks the same question of a bundle's recorded `nodeVersion` instead of matching `v24.` by prefix; both published bundles were captured on v24.21.0 and remain valid.

Widening to Node 26 after its LTS promotion is now one entry in `TESTED_NODE` plus CI cells, and it stays a decision with evidence attached rather than a dependency bump. Tests assert the version literals independently, so a wrong constant fails rather than agreeing with itself.
