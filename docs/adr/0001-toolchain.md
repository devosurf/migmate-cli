# ADR-0001: First-release toolchain

- Status: accepted
- Date: 2026-09-01
- Context: [spec #17](https://github.com/devosurf/migmate-cli/issues/17), [distribution #12](https://github.com/devosurf/migmate-cli/issues/12), [engine seam #9](https://github.com/devosurf/migmate-cli/issues/9)

## Context

The build spec fixes the runtime (Node 24 LTS), the state binding (`node:sqlite`), the package shape (one global npm package, one `migmate` bin, `web` as a subcommand of the same binary), and the language (TypeScript). It fixes nothing about how the repository is built, typechecked, tested, formatted, or run in CI. That gap blocks the first line of code, and the spec's testing decisions depend on it: the CLI contract is tested by invoking the command layer in-process **and** by spawning the real binary, and the webview adapter needs its static assets embedded in the installed artifact.

## Decision

**No bundler and no build step for the shipped CLI.** The package publishes TypeScript sources and relies on Node's built-in type stripping. `bin` points directly at the CLI entry module. This is only possible while the codebase stays inside erasable syntax, which is enforced by the compiler rather than by review (`erasableSyntaxOnly`).

**`tsc --noEmit` is a typechecker, never a compiler.** Relative imports carry the real `.ts` extension so that the specifier Node resolves and the specifier TypeScript checks are the same string (`allowImportingTsExtensions`, `verbatimModuleSyntax`, `module: nodenext`).

**`node:test` is the test runner.** No Vitest, no Jest. The suite's hard requirements are spawning real subprocesses, killing them, and reading a second SQLite connection from another process; a third-party runner adds a dependency and a worker model without helping any of that.

**Prettier formats; nothing lints.** One dev dependency for formatting keeps diffs boring. ESLint is deferred: the compiler under `strict` plus `erasableSyntaxOnly` already rejects what a 0.x lint config would catch, and a rule set is a decision surface this release does not need.

**CI is a three-OS matrix on Node 24** — Ubuntu, macOS, Windows — running typecheck and tests. The matrix is not cosmetic: the spec's supported platforms are exactly these, the unix-socket RC bind on Windows is inferred rather than documented, and the engine home path differs per OS.

## Consequences

- Three dev dependencies total: `typescript`, `prettier`, `@types/node`. Zero runtime dependencies until the webview package lands in stage 4.
- Enums, namespaces, parameter properties, and `experimental` decorators are unavailable. This is the price of shipping without a build, and the compiler enforces it.
- Two Node facilities the product now leans on are pre-stable in Node 24: type stripping and `node:sqlite`. The `node:sqlite` bet was already accepted in #12; type stripping extends the same bet to the build. The exit if either bites is a bundler and a `dist/`, which is a distribution change and touches no product behaviour.
- Stage 4 needs static webview assets inside the artifact. With no bundler, they are read from the installed package tree at runtime rather than inlined into a JavaScript string. That is a stage-4 decision, and it is not blocked by this one.
- The engine stays absent from `package.json` `exports`, per #9. The package exposes the `migmate` bin only.
