# Agent Skill directories per coding-agent harness

This note captures, for each AI coding-agent harness the installer may detect, where it discovers **user-level** (global) Agent Skills (`<root>/<name>/SKILL.md`), what relocates that root, whether it also reads the shared `~/.agents/skills/` or `~/.claude/skills/`, how it resolves same-named skills, and how a POSIX `sh` installer can tell that the tool is present.

Every claim cites the primary source that owns it: official docs, or official repository source pinned to the commit we read. `UNVERIFIED` means the primary sources we read do not settle the point. It does not mean the feature is missing. Research date: 2026-10-04.

## Recommendation

- **Write one canonical copy to `~/.agents/skills/migmate/`.** Codex, Gemini CLI, OpenCode, pi, omp, Cursor, Copilot CLI, Amp, Factory Droid and Goose all read it at user scope by default (see table). So do Mistral Vibe, Kimi Code, Roo Code, Kilo Code, Windsurf, Junie, Warp and Crush. Codex itself now documents `~/.agents/skills` as _the_ user location and labels `$CODEX_HOME/skills` deprecated. [Codex skills docs](https://learn.chatgpt.com/docs/build-skills), [Codex `host_roots.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/ext/skills/src/host_roots.rs#L28-L130)
- **Claude Code needs its own copy at `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/migmate/`.** Its official location table lists no `~/.agents` path. [Claude Code skills](https://code.claude.com/docs/en/skills#where-skills-live)
- **Avoid installing two different physical copies where one harness reads both roots.** Duplicate handling varies:
  - Gemini CLI prints a "Skill conflict detected" warning.
  - OpenCode logs "duplicate skill name".
  - pi emits collision diagnostics.
  - Codex lists both copies.
  - omp namespaces a copy whose content differs.

  The exact same file reached through a symlink is silently deduplicated by Claude Code, Codex, pi and omp. Several harnesses scan both `~/.agents/skills` and `~/.claude/skills`: Cursor, Amp, Goose, OpenCode, Crush, Windsurf, Warp, and omp when Claude is opted in. For these, a symlink `~/.claude/skills/migmate -> ~/.agents/skills/migmate` is safer than a second copy. One exception: OpenCode's classic loader deduplicates by path string, not canonical file, so it may still log a duplicate. Do **not** make `SKILL.md` _itself_ a symlink: Codex ignores symlinked `SKILL.md` files and follows only directory symlinks. [Codex discovery tests](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/ext/skills/src/loader/discovery_tests.rs#L43-L95)

- **Exception: Copilot CLI with `COPILOT_HOME` set.** In that case Copilot stops reading `~/.agents/skills`, so the skill must go to `$COPILOT_HOME/skills/`. [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) ("COPILOT_HOME and --config-dir stop loading skills from ~/.agents/skills")
- **Do not create `~/.config/agents/skills/`.** The older Python Kimi CLI picks the _first existing_ of `~/.config/agents/skills` and `~/.agents/skills`, so creating the former hides the latter. [kimi-cli `skill/__init__.py`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/skill/__init__.py)
- **Frontmatter: write strictly spec-compliant `name: migmate` + `description` (≤1024 chars) in a directory named `migmate`.** It satisfies every harness below. Several are laxer than the spec. None we checked is stricter in a way that conflicts with it.

## Agent Skills specification on locations

- The format spec defines only the folder format, not where skills live. A skill directory contains `SKILL.md`: YAML frontmatter followed by Markdown. Other files in the directory are allowed, and `scripts/`, `references/` and `assets/` are optional conventions. [Specification](https://agentskills.io/specification)
- **`name`** is required: 1–64 characters, lowercase alphanumerics and hyphens, no leading, trailing or consecutive hyphens, and it **must match the parent directory name**. **`description`** is required: 1–1024 characters. Optional fields are `license`, `compatibility` (1–500 characters), `metadata` (a string→string map) and `allowed-tools` (experimental). [Specification](https://agentskills.io/specification)
- The first-party client integration guide treats scopes as client choices:
  - It suggests user-scope `~/.<your-client>/skills/` and `~/.agents/skills/`, plus project analogues.
  - It calls `.agents/skills/` a widely adopted cross-client convention.
  - It notes some clients also scan `.claude/skills/` for compatibility.
  - It mentions XDG config dirs and user-configured paths as options.

  [Adding skills support](https://agentskills.io/client-implementation/adding-skills-support), [repo source](https://github.com/agentskills/agentskills/blob/main/docs/client-implementation/adding-skills-support.mdx)

- On collisions, the guide asks for deterministic precedence and calls project-over-user "the universal convention". It recommends logging a warning. It also recommends lenient loading: warn but load on a name mismatch or a name over 64 characters, and skip a skill with no description or unparseable YAML. Claude Code does **not** follow project-over-user (see below). [Adding skills support](https://agentskills.io/client-implementation/adding-skills-support)
- Neither document says anything about symlinks. The Anthropic repo `anthropics/skills` defers to agentskills.io for the standard. [anthropics/skills README](https://github.com/anthropics/skills/blob/main/README.md)

## Summary

Paths assume POSIX defaults. "Shared" in the last column means `~/.agents/skills`.

| Harness       | User skills dir(s)                                                                                                      | Env relocation                                                                                                                       | Reads `~/.agents/skills`?                                | Reads `~/.claude/skills`?                                                 | Presence signal (dir; binary)                        | Same-name across dirs                                                                                 |
| :------------ | :---------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------- | :------------------------------------------------------------------------ | :--------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| Claude Code   | `~/.claude/skills/`                                                                                                     | `CLAUDE_CONFIG_DIR` replaces `~/.claude`                                                                                             | Not documented (absent from the official location table) | Yes (native)                                                              | `${CLAUDE_CONFIG_DIR:-~/.claude}`; `claude`          | Enterprise > personal > project; symlinks to the same target load once                                |
| Codex CLI     | `~/.agents/skills/` (documented); `$CODEX_HOME/skills/` (deprecated, still scanned)                                     | `CODEX_HOME` (default `~/.codex`) moves only the legacy root                                                                         | Yes                                                      | No                                                                        | `${CODEX_HOME:-~/.codex}`; `codex`                   | Both kept and listed; silent dedupe only by canonical `SKILL.md` path                                 |
| Gemini CLI    | `~/.gemini/skills/`, `~/.agents/skills/`                                                                                | `GEMINI_CLI_HOME` replaces the _home base_ (moves both)                                                                              | Yes                                                      | No                                                                        | `${GEMINI_CLI_HOME:-~}/.gemini`; `gemini`            | Later source wins with a "Skill conflict detected" warning; user `.agents` overrides user `.gemini`   |
| OpenCode      | `${XDG_CONFIG_HOME:-~/.config}/opencode/skill{,s}/`, `~/.opencode/skill{,s}/`, `~/.claude/skills/`, `~/.agents/skills/` | `XDG_CONFIG_HOME`; `OPENCODE_CONFIG_DIR` (adds a root); `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE[_SKILLS]` | Yes (unless disabled)                                    | Yes (unless disabled)                                                     | `${XDG_CONFIG_HOME:-~/.config}/opencode`; `opencode` | Classic: logs "duplicate skill name", last write wins, order non-deterministic                        |
| pi            | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills/`, `~/.agents/skills/`                                                      | `PI_CODING_AGENT_DIR` (native root only)                                                                                             | Yes                                                      | Only if added to `skills` setting                                         | `${PI_CODING_AGENT_DIR:-~/.pi/agent}`; `pi`          | First wins with a collision warning; same canonical file silently skipped                             |
| omp           | `~/.omp/agent/skills/`, `~/.agents/skills/`, `~/.agent/skills/`                                                         | `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `OMP_PROFILE`/`PI_PROFILE` (native root only)                                                | Yes                                                      | Opt-in (`enabledProviders`), or automatic when `CLAUDE_CONFIG_DIR` is set | `~/.omp`; `omp`                                      | Native > claude > agents; identical copies silently dropped; differing copy namespaced with a warning |
| Cursor        | `~/.cursor/skills/`, `~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`                                       | UNVERIFIED (`CURSOR_CONFIG_DIR` / `XDG_CONFIG_HOME` move CLI config only)                                                            | Yes                                                      | Yes                                                                       | `~/.cursor`; `agent` (legacy alias `cursor-agent`)   | UNVERIFIED                                                                                            |
| Copilot CLI   | `~/.copilot/skills/`, `~/.agents/skills/`                                                                               | `COPILOT_HOME` replaces `~/.copilot` **and** disables `~/.agents/skills`; `COPILOT_SKILLS_DIRS` adds roots                           | Yes, unless `COPILOT_HOME`/`--config-dir` is set         | No (project `.claude/skills` only)                                        | `${COPILOT_HOME:-~/.copilot}`; `copilot`             | First found wins by `name`; `~/.copilot/skills` > `~/.agents/skills`; warning UNVERIFIED              |
| Amp           | `~/.config/agents/skills/`, `~/.agents/skills/`, `~/.config/amp/skills/`, `~/.claude/skills/`                           | UNVERIFIED                                                                                                                           | Yes (also `~/.config/agents/skills`)                     | Yes                                                                       | `~/.config/amp`; `amp`                               | First wins by `name`, in the listed order; warning UNVERIFIED                                         |
| Factory Droid | `~/.factory/skills/`, `~/.agents/skills/`, `~/.agent/skills/`                                                           | UNVERIFIED                                                                                                                           | Yes                                                      | Not documented (has a `/skills` import from `.claude/skills`)             | `~/.factory` (created on first run); `droid`         | One effective version; lower one shown as "Overridden"; order among the three user roots UNVERIFIED   |
| Goose         | `~/.agents/skills/`, `${XDG_CONFIG_HOME:-~/.config}/goose/skills/`, `~/.claude/skills/`, `~/.config/agents/skills/`     | `GOOSE_PATH_ROOT` (→ `$GOOSE_PATH_ROOT/config/skills`), `XDG_CONFIG_HOME` (Goose root only)                                          | Yes (also `~/.config/agents/skills`)                     | Yes                                                                       | `${XDG_CONFIG_HOME:-~/.config}/goose`; `goose`       | Silent first-wins: `~/.agents` > goose > `~/.claude` > `~/.config/agents`                             |

### Additional harnesses with documented user-level skills

| Harness                  | User skills dir(s)                                                                                                                                                | Env relocation                                                  | Reads `~/.agents/skills`? | Reads `~/.claude/skills`?       | Presence signal (dir; binary)                                          | Same-name across dirs                                                    |
| :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------- | :------------------------ | :------------------------------ | :--------------------------------------------------------------------- | :----------------------------------------------------------------------- |
| Qwen Code                | `~/.qwen/skills/`                                                                                                                                                 | `QWEN_HOME`                                                     | UNVERIFIED                | UNVERIFIED                      | `${QWEN_HOME:-~/.qwen}`; `qwen`                                        | project > user > extension > bundled                                     |
| Kimi CLI (Python)        | first existing of `~/.kimi`/`~/.claude`/`~/.codex` `/skills`; first existing of `~/.config/agents/skills`, `~/.agents/skills`                                     | none for skills (`KIMI_SHARE_DIR` moves config only)            | Conditionally             | Conditionally                   | `${KIMI_SHARE_DIR:-~/.kimi}`; UNVERIFIED                               | Silent case-folded first-wins                                            |
| Kimi Code (TypeScript)   | `${KIMI_CODE_HOME:-~/.kimi-code}/skills/`, `~/.agents/skills/`                                                                                                    | `KIMI_CODE_HOME` (native root only)                             | Yes                       | No                              | `${KIMI_CODE_HOME:-~/.kimi-code}`; `kimi`                              | First registered wins (native before shared)                             |
| Mistral Vibe             | `${VIBE_HOME:-~/.vibe}/skills/`, `~/.agents/skills/`                                                                                                              | `VIBE_HOME`; `VIBE_SKILL_PATHS` adds roots                      | Yes                       | No                              | `${VIBE_HOME:-~/.vibe}`; `vibe`                                        | First wins (native > shared); duplicate logged at debug                  |
| Crush                    | `${XDG_CONFIG_HOME:-~/.config}/crush/skills/`, `${XDG_CONFIG_HOME:-~/.config}/agents/skills/`, `~/.agents/skills/`, `~/.claude/skills/`                           | `CRUSH_SKILLS_DIR` **replaces** all defaults; `XDG_CONFIG_HOME` | Yes                       | Yes                             | `${CRUSH_GLOBAL_CONFIG:-${XDG_CONFIG_HOME:-~/.config}/crush}`; `crush` | Last wins after sorting by path; no warning                              |
| Cline                    | `~/.cline/skills/`                                                                                                                                                | UNVERIFIED                                                      | UNVERIFIED                | UNVERIFIED                      | UNVERIFIED                                                             | Global > project                                                         |
| Roo Code                 | `~/.roo/skills/`, `~/.agents/skills/` (+ `skills-{mode}` variants)                                                                                                | UNVERIFIED                                                      | Yes                       | UNVERIFIED                      | UNVERIFIED                                                             | `.roo` > `.agents`; project > global                                     |
| Kilo Code                | `~/.kilo/skills/`, `~/.agents/skills/`, `~/.claude/skills/` (compat mode)                                                                                         | UNVERIFIED                                                      | Yes                       | When Claude compatibility is on | `~/.config/kilo`; `kilo`                                               | Project > global; rest UNVERIFIED                                        |
| Windsurf / Devin Desktop | `~/.codeium/windsurf/skills/`, `~/.config/devin/skills/`, `~/.agents/skills/`, `~/.claude/skills/` (if enabled)                                                   | UNVERIFIED                                                      | Yes                       | If enabled                      | UNVERIFIED                                                             | UNVERIFIED                                                               |
| Kiro                     | `~/.kiro/skills/`                                                                                                                                                 | UNVERIFIED                                                      | UNVERIFIED                | UNVERIFIED                      | UNVERIFIED                                                             | Workspace > global                                                       |
| JetBrains Junie          | `~/.junie/skills/`, `~/.agents/skills/`                                                                                                                           | UNVERIFIED                                                      | Yes                       | UNVERIFIED                      | UNVERIFIED                                                             | UNVERIFIED                                                               |
| Letta Code               | `~/.letta/skills/`                                                                                                                                                | `HOME` only                                                     | No                        | No                              | UNVERIFIED; `letta`                                                    | Silent dedupe by skill id; project > agent > global                      |
| Warp                     | `~/.agents/skills/`, `~/.warp/skills/`, plus `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.copilot`, `~/.factory`, `~/.github`, `~/.opencode` `/skills/` | `WARP_SKILL_DIRS` (cloud runs only)                             | Yes                       | Yes                             | UNVERIFIED                                                             | No dedupe: all copies offered; background resolution prefers home skills |

## Per-harness notes

### Claude Code

- **User dir:** personal skills live at `~/.claude/skills/<skill-name>/SKILL.md` and load in all local projects. They do not load in Cowork or cloud sessions. The location table also lists enterprise (managed settings dir), project, nested, `--add-dir`, plugin and claude.ai-synced skills, and **no `~/.agents` path**. A search of the official `CHANGELOG.md` (top version 2.1.289) also found no `.agents/skills` match. [Skills: where skills live](https://code.claude.com/docs/en/skills#where-skills-live), [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- **Relocation:** `CLAUDE_CONFIG_DIR` relocates every `~/.claude` path, including `skills/`. It can be set from the shell, user settings or managed settings, but not from project or local settings. `XDG_CONFIG_HOME` has no documented effect on skills. [.claude directory](https://code.claude.com/docs/en/claude-directory), [Env vars](https://code.claude.com/docs/en/env-vars#variables)
- **Duplicates:** enterprise beats personal, and personal beats project. Plugin skills coexist as `/plugin-name:skill-name`. A skill beats a `.claude/commands/` file of the same name. A collision warning for ordinary duplicates is UNVERIFIED. [Resolve skills that share a name](https://code.claude.com/docs/en/skills#resolve-skills-that-share-a-name)
- **Symlinks:** a `<skill-name>` entry in the enterprise, personal or project location may be a symlink to a directory. Claude Code loads the skill once even if several locations point at the same target. [Skills: where skills live](https://code.claude.com/docs/en/skills#where-skills-live)
- **Reserved names:** `synced` (Claude Code uses `~/.claude/skills/synced/` for claude.ai skills) and `anthropic-skills*`. [Skills](https://code.claude.com/docs/en/skills#where-skills-live)
- **Presence:** Claude Code writes application data such as transcripts and shell snapshots under `~/.claude` (or `CLAUDE_CONFIG_DIR`). Installing creates no `settings.json`, so don't key on that file. That the directory exists right after the first run is UNVERIFIED. The binary is `claude`. [.claude directory: application data](https://code.claude.com/docs/en/claude-directory#application-data), [Settings: which files you have](https://code.claude.com/docs/en/settings#which-files-you-have)
- **Frontmatter:** all fields are optional. `name` defaults to the directory name and need not match it; the directory name stays an alias. `description` defaults to the first non-empty line. Unparseable YAML still loads with empty metadata. The listing is truncated at 1,536 characters of `description` + `when_to_use`. [Frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference), [How a skill gets its command name](https://code.claude.com/docs/en/skills#how-a-skill-gets-its-command-name)

### OpenAI Codex CLI

Source read: `openai/codex@de3721a7` (2026-10-04).

- **User dirs:** the docs give `~/.agents/skills/` as the user location. Source still scans `$CODEX_HOME/skills/` (default `~/.codex/skills/`) and labels it deprecated/backward-compatible. Other roots are system skills cached in `$CODEX_HOME/skills/.system` and the admin root `/etc/codex/skills`. Codex does not scan `~/.claude/skills` or `~/.config/agents/skills`. [Build skills](https://learn.chatgpt.com/docs/build-skills), [`host_roots.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/ext/skills/src/host_roots.rs#L28-L130), [`skills/src/lib.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/skills/src/lib.rs#L57-L72)
- **Relocation:** `CODEX_HOME` _is_ the config dir (default `~/.codex`). A non-empty value must already exist as a directory and is canonicalized. It does **not** move `~/.agents/skills`. [`home-dir/src/lib.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/utils/home-dir/src/lib.rs#L1-L62)
- **Duplicates:** distinct files with the same `name` are both kept, and the docs say both can appear in skill selectors. Dedupe happens only by canonical `SKILL.md` path, keeping the first. Display order is Repo, User, System, Admin. [Build skills](https://learn.chatgpt.com/docs/build-skills), [`host_merge.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/ext/skills/src/loader/host_merge.rs#L201-L269)
- **Symlinks:** directory symlinks are followed for the User, Repo and Admin scopes, but not System. A symlinked `SKILL.md` file is ignored. [`host.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/ext/skills/src/loader/host.rs), [`discovery_tests.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/ext/skills/src/loader/discovery_tests.rs#L43-L95)
- **Presence:** `${CODEX_HOME:-~/.codex}` holds Codex config and state. The binary is `codex`. That the directory exists after every kind of invocation is UNVERIFIED. [`core/src/config/mod.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/core/src/config/mod.rs#L962-L972), [README](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/README.md#L38-L64)
- **Frontmatter:** the docs require `name` and `description`. The parser is looser:
  - YAML frontmatter is required.
  - `name` falls back to the directory name and may be 1–64 Unicode characters, with no pattern or directory-match check.
  - `description` must be non-empty, with no maximum length.

  [`parser.rs`](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/skills/src/parser.rs#L1-L96)

### Gemini CLI

Source read: `google-gemini/gemini-cli@fb972b2f` (2026-10-02).

- **User dirs:** `~/.gemini/skills/` and `~/.agents/skills/`. Skills are on by default (`skills.enabled` and `admin.skills.enabled` default `true`), with no experimental flag. Workspace skills need a trusted workspace; user skills do not. Gemini does not read `~/.claude/skills` or `~/.config/agents/skills`. [Gemini CLI skills](https://geminicli.com/docs/cli/skills/), [`skillManager.ts`](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/skills/skillManager.ts#L50-L147), [`settingsSchema.ts`](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/cli/src/config/settingsSchema.ts#L2516-L2545)
- **Relocation:** `GEMINI_CLI_HOME` replaces the **home base**, not `.gemini` itself. `GEMINI_CLI_HOME=/x` yields `/x/.gemini/skills` and `/x/.agents/skills`. `XDG_CONFIG_HOME` has no effect. [`paths.ts`](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/utils/paths.ts#L13-L28), [`storage.ts`](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/config/storage.ts#L54-L148)
- **Duplicates:** skills go into a name-keyed map where the later source wins. Order, lowest to highest: built-in < extension < user `.gemini` < user `.agents` < workspace `.gemini` < workspace `.agents`. A conflict across locations prints "Skill conflict detected … overriding …". [`skillManager.ts`](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/skills/skillManager.ts#L50-L147)
- **Symlinks:** followed. The official `gemini skills link` command itself creates directory symlinks. [`skillUtils.ts`](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/cli/src/utils/skillUtils.ts#L242-L283)
- **Presence:** `${GEMINI_CLI_HOME:-~}/.gemini`, which holds `settings.json` and runtime state. The binary is `gemini`. [`storage.ts`](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/config/storage.ts#L54-L148)
- **Frontmatter:** the docs require `name` and `description` and say `name` should match the directory. The loader enforces no spec limits, and it replaces `: / \ < > * ? " |` in names with `-`. [Creating skills](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/docs/cli/creating-skills.md#L149-L173), [`skillLoader.ts`](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/skills/skillLoader.ts)

### OpenCode

The current official repo is `anomalyco/opencode` (formerly `sst/opencode`); source read at `@907b3bc5`, v1.18.34. Two loaders exist at this commit, classic and core/v2. The live `/v2/docs` describe different semantics, so this section is version-sensitive.

- **User dirs (classic loader):**
  - `${XDG_CONFIG_HOME:-~/.config}/opencode/{skill,skills}/**/SKILL.md`
  - `~/.opencode/{skill,skills}/`
  - `$OPENCODE_CONFIG_DIR/{skill,skills}/` (scanned _in addition_, not instead)
  - `~/.claude/skills/`
  - `~/.agents/skills/` (not `~/.config/agents/skills`)

  [OpenCode skills](https://opencode.ai/docs/skills/), [`skill/index.ts`](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/skill/index.ts#L21-L245), [`config/paths.ts`](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/config/paths.ts#L23-L40)

- **Toggles:** `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` and `OPENCODE_DISABLE_CLAUDE_CODE` disable the `.claude` roots. `OPENCODE_DISABLE_EXTERNAL_SKILLS` disables both `.claude` and `.agents`. [`runtime-flags.ts`](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/effect/runtime-flags.ts#L16-L30)
- **Duplicates:**
  - Classic: logs "duplicate skill name" and overwrites the entry. Loading runs with unbounded concurrency, so which copy wins is **not deterministic**.
  - v2 docs: last-registered wins by path-derived ID, ordered built-ins < Claude < agents < native global < native project < configured paths.
  - Core/v2 source: overwrites the map entry silently.

  [`skill/index.ts`](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/skill/index.ts#L21-L245), [v2 skills docs](https://opencode.ai/v2/docs/skills/), [`core/src/skill.ts`](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/skill.ts#L33-L118)

- **Symlinks:** followed (`symlink: true` in both loaders' globs). Dedupe is by path string, not canonical file. [`skill/index.ts`](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/skill/index.ts#L21-L245)
- **Presence:** the core global module creates `${XDG_CONFIG_HOME:-~/.config}/opencode` on import. The binary is `opencode`. [`core/src/global.ts`](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/global.ts#L1-L71), [`package.json`](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/package.json#L1-L20)
- **Frontmatter:** the classic docs mirror the spec (kebab-case 1–64, matches the directory, description 1–1024). The classic loader only checks types, and a skill without a description is not advertised. The v2 docs make every field optional. [OpenCode skills](https://opencode.ai/docs/skills/), [v2 skills docs](https://opencode.ai/v2/docs/skills/)

### pi (pi coding agent)

`badlogic/pi-mono` now redirects to `earendil-works/pi`; source read at `@f5d20047`, `@earendil-works/pi-coding-agent` 1.0.2.

- **User dirs:** `${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills/` and `~/.agents/skills/`, both discovered recursively. `~/.claude/skills` and `~/.codex/skills` are **not** automatic. They load only if added to the `skills` array in settings. [`docs/skills.md`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/docs/skills.md), [`package-manager.ts`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/core/package-manager.ts#L2413-L2561), [settings docs](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/docs/settings.md#resources)
- **Relocation:** `PI_CODING_AGENT_DIR` replaces `~/.pi/agent` (a leading `~` is expanded). The `~/.agents` root uses `process.env.HOME || os.homedir()` and does not move with it. [`config.ts`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/config.ts#L538-L592), [`package-manager.ts`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/core/package-manager.ts#L227-L229)
- **Duplicates:** first discovered wins, and later distinct files produce a collision warning naming the winner and loser paths. The same canonical file seen twice is skipped silently. Default order is project `.pi/skills` → project `.agents/skills` → user agent-dir → `~/.agents/skills`, so the native user root beats the shared one. [`skills.ts`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/core/skills.ts), [`package-manager.ts`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/core/package-manager.ts#L2413-L2561)
- **Symlinks:** directory links are followed and broken links are skipped. [`skills.ts`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/core/skills.ts)
- **Presence:** `${PI_CODING_AGENT_DIR:-~/.pi/agent}`; auth storage creates it. The binary is `pi`. [`auth-storage.ts`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/core/auth-storage.ts#L49-L98), [`package.json`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/package.json#L1-L11)
- **Frontmatter:** `name` is optional (it defaults to the directory) and a mismatch is not flagged. A bad name pattern, a name over 64 characters or a description over 1024 characters warns but still loads. A missing or blank `description`, or malformed frontmatter, skips the skill. [`docs/skills.md`](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/docs/skills.md)

### omp (oh-my-pi)

Source read: `can1357/oh-my-pi@898b09d3` (2026-10-04); local install `omp/18.6.1`; plus the bundled docs `omp://skills.md` and `omp://config-usage.md`.

- **User dirs:**
  - Native: `~/.omp/agent/skills/*/SKILL.md`, scanned one level only.
  - Shared: `~/.agents/skills/` **and** `~/.agent/skills/`, from the `agents` provider, on by default.
  - Foreign user roots for Claude, Codex, Cursor, Gemini, OpenCode, Windsurf and GitHub are **opt-in** through the `enabledProviders` setting. An exception: the Claude user root is enabled automatically when `CLAUDE_CONFIG_DIR` is set, and then reads `$CLAUDE_CONFIG_DIR/skills`.
  - `skills.customDirectories` adds further roots.

  [`discovery/builtin.ts` L312-316](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/packages/coding-agent/src/discovery/builtin.ts#L312-L316), [`discovery/agents.ts` L28-30, L123-127, L158-164](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/packages/coding-agent/src/discovery/agents.ts#L28-L164), [`capability/index.ts` L51-60, L359-367](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/packages/coding-agent/src/capability/index.ts#L51-L367), [config-usage docs](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/docs/config-usage.md)

- **Relocation:** all three variables move only the native root; `~/.agents/skills` is never profile-scoped.
  - `PI_CODING_AGENT_DIR` replaces the agent dir (default profile only), giving `$PI_CODING_AGENT_DIR/skills`.
  - `PI_CONFIG_DIR` renames `.omp`, giving `~/$PI_CONFIG_DIR/agent/skills`.
  - A named profile (`OMP_PROFILE`, legacy `PI_PROFILE`, or `--profile`) uses `~/.omp/profiles/<name>/agent/skills`.

  [`utils/src/dirs.ts` L306-314, L619-621](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/packages/utils/src/dirs.ts#L306-L621), [config-usage docs](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/docs/config-usage.md)

- **Duplicates:** provider priority is native (100) > claude (80) > agents/codex/claude-plugins (70) > opencode (55).
  - A skill reached via the same `realpath` loads once.
  - An identical copy (same body and parsed frontmatter) is dropped silently.
  - A _differing_ copy keeps loading under a namespaced name `<namespace>/<name>` with a collision warning. The higher-precedence copy keeps the bare name.

  [skills docs](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/docs/skills.md)

- **Symlinks:** followed. The directory scanner accepts symlink entries, and dedupe is symlink-safe through `realpath`. [`discovery/helpers.ts` L514](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/packages/coding-agent/src/discovery/helpers.ts#L514), [skills docs](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/docs/skills.md)
- **Presence:** `~/.omp` (agent dir `~/.omp/agent` holds `config.yml`, sessions and `agent.db`). The binary is `omp`. [config-usage docs](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/docs/config-usage.md)
- **Frontmatter:**
  - `name` defaults to the directory name.
  - `description` is required for native `~/.omp` skills and custom directories, but optional for the claude/codex/agents/opencode providers.
  - A raw `name` containing `/` or `\` is rejected.

  [skills docs](https://github.com/can1357/oh-my-pi/blob/898b09d32f147887a2242cf5ec9a1967bcac8873/docs/skills.md)

### Cursor (editor and Agent CLI)

- **User dirs:** `~/.agents/skills/` and `~/.cursor/skills/`. For compatibility, Cursor also loads `~/.claude/skills/` and `~/.codex/skills/`. Supported in the editor and CLI since 2.4 (2026-01-22). Only `~/.cursor/skills/` syncs to Cloud Agents. [Cursor skills](https://cursor.com/docs/skills), [Changelog 2.4](https://cursor.com/changelog/2-4)
- **Relocation:** `CURSOR_CONFIG_DIR` and, on Linux/BSD, `XDG_CONFIG_HOME` relocate the CLI config file (`cli-config.json`). Whether they also move skills is UNVERIFIED. [CLI configuration](https://cursor.com/docs/cli/reference/configuration)
- **Duplicates / symlinks:** UNVERIFIED. No primary source documents them; only forum reports exist.
- **Presence:** `~/.cursor` (home of `~/.cursor/cli-config.json`). The official installer also creates `~/.local/share/cursor-agent/versions/`. The binary is `agent`, with legacy alias `cursor-agent`; both are installed to `~/.local/bin`. [CLI configuration](https://cursor.com/docs/cli/reference/configuration), [installer](https://cursor.com/install), [CLI overview](https://cursor.com/docs/cli/overview)
- **Frontmatter:** `name` and `description` are required. `name` uses lowercase letters, numbers and hyphens and must match the folder. [Cursor skills](https://cursor.com/docs/skills)

### GitHub Copilot CLI

- **User dirs:** `~/.copilot/skills/` and `~/.agents/skills/`. The latter was added in 1.0.11 "aligning with VS Code's GHCP4A extension default". Extra roots come from `COPILOT_SKILLS_DIRS` (comma-separated) or `skillDirectories` in `settings.json`. Copilot does not read `~/.claude/skills`; only project `.claude/skills` is documented. [Add skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills), [CLI command reference: skills](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skills-reference), [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- **Relocation:** `COPILOT_HOME` replaces `~/.copilot` (the older `--config-dir` is deprecated in its favour). Since 1.0.66, setting either one **stops loading `~/.agents/skills`**. Legacy XDG config locations are migrated into `~/.copilot` on startup. [Config dir reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference), [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- **Duplicates:** first found wins, deduplicated by frontmatter `name`. Order: project `.github/skills` → `.agents/skills` → `.claude/skills` → inherited parent → `~/.copilot/skills` → `~/.agents/skills` → plugins → custom dirs. A plugin skill that conflicts is silently ignored. Whether a warning is printed for two personal copies is UNVERIFIED. [CLI plugin reference: loading order](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#loading-order-and-precedence), [CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skills-reference)
- **Symlinks:** followed. 1.0.62 loads skills from symlinked directories outside the root, and 1.0.68 deduplicates parse errors from symlinked scan roots. [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- **Presence:** `${COPILOT_HOME:-~/.copilot}` holds config, auth state, sessions and logs. The binary is `copilot`. [Config dir reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference), [README](https://github.com/github/copilot-cli/blob/main/README.md)
- **Frontmatter:** `name` and `description` are required. `name` may be up to 64 characters of letters, digits, `-_.:` and spaces, starting with a letter or digit, so it is broader than the spec. It "typically" matches the directory. `description` is at most 1024 characters. [CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skills-reference), [Add skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- **VS Code:** the general Copilot page lists the same personal roots (`~/.copilot/skills`, `~/.agents/skills`) for VS Code agent mode. [About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)

### Amp (Sourcegraph / ampcode.com)

These facts come from the docs only. The public `ampcode/amp` repo returned 404, so no source was read.

- **User dirs, in precedence order:**
  1. `~/.config/agents/skills/`
  2. `~/.agents/skills/`
  3. `~/.config/amp/skills/`
  4. project `.agents/skills/`
  5. project `.claude/skills/`
  6. `~/.claude/skills/`
  7. `~/.claude/plugins/cache/`
  8. `amp.skills.path` entries (colon-separated)
  9. built-ins, then hosted personal and workspace repos

  `amp skill add --global` installs to `~/.config/agents/skills/`. Roots are searched up to five levels deep. [Amp skills](https://ampcode.com/docs/markdown/customize/skills), [Amp settings](https://ampcode.com/docs/markdown/cli/settings)

- **Toggles:** `amp.skills.disableGlobalAgentsSkills` turns off both `agents` roots. `amp.skills.disableClaudeCodeSkills` turns off the `.claude` roots. Both default to `false`. [Amp settings](https://ampcode.com/docs/markdown/cli/settings)
- **Relocation:** UNVERIFIED. `XDG_CONFIG_HOME` is documented only for plugins (`$XDG_CONFIG_HOME/amp/plugins/`). [Amp plugins](https://ampcode.com/docs/markdown/customize/plugins)
- **Duplicates:** the first skill with a given frontmatter `name` wins. Whether a warning is printed is UNVERIFIED. [Amp skills](https://ampcode.com/docs/markdown/customize/skills)
- **Symlinks:** UNVERIFIED.
- **Presence:** `~/.config/amp/` (`settings.json`/`settings.jsonc`); that it is created on first run is UNVERIFIED. The binary is `amp`. [Amp settings](https://ampcode.com/docs/markdown/cli/settings), [Amp CLI](https://ampcode.com/docs/markdown/cli)
- **Frontmatter:** `name` and `description` are required. A directory/name match is documented only for hosted skill repos. [Amp skills](https://ampcode.com/docs/markdown/customize/skills)

### Factory Droid

- **User dirs:** `~/.factory/skills/`, `~/.agents/skills/` and `~/.agent/skills/`. Automatic scanning of `~/.claude/skills` is not documented. v0.26.0 added a `/skills` _import_ from `.claude/skills`. The public GitHub docs are older than the hosted docs, and we used the hosted docs. [Factory skills](https://docs.factory.com/harness/skills), [release notes (import)](https://github.com/Factory-AI/factory/blob/485a0c3b5d3d11c52d50cd2a8889e1a71e86905a/docs/changelog/release-notes.mdx#L3434-L3439)
- **Relocation:** UNVERIFIED. No env var is documented.
- **Duplicates:** one effective version per sanitized name, and lower-priority copies show as "Overridden". Order: folder/project > project plugin > personal > user plugin > built-in. Precedence among the three personal roots is UNVERIFIED. [Factory skills](https://docs.factory.com/harness/skills)
- **Symlinks:** v0.56.0 fixed discovery of symlinked skill directories in `.factory/skills`. Behaviour for the other roots is UNVERIFIED. [release notes](https://github.com/Factory-AI/factory/blob/485a0c3b5d3d11c52d50cd2a8889e1a71e86905a/docs/changelog/release-notes.mdx#L2789-L2805)
- **Presence:** `~/.factory/`. `~/.factory/settings.json` is created with defaults the first time `droid` runs. The binary is `droid`. [Droid settings](https://docs.factory.com/droid-cli/settings), [README](https://github.com/Factory-AI/factory/blob/485a0c3b5d3d11c52d50cd2a8889e1a71e86905a/README.md)
- **Frontmatter:** the hosted docs require `name` (lowercase letters, numbers, hyphens) and `description`. The entry point must be `SKILL.md`; `skill.mdx` is rejected. [Factory skills](https://docs.factory.com/harness/skills)

### Goose

The repo is now `aaif-goose/goose`, formerly `block/goose`; source read at `@591edd47`.

- **User dirs:** Skills are a built-in platform extension, enabled by default. User roots, in precedence order:
  1. `~/.agents/skills/`
  2. `<goose config dir>/skills/` (default `~/.config/goose/skills/`)
  3. `~/.claude/skills/`
  4. literal `~/.config/agents/skills/`
  5. user plugin roots

  [Using skills](https://goose-docs.ai/docs/guides/context-engineering/using-skills/), [`skills/mod.rs`](https://github.com/aaif-goose/goose/blob/591edd47cf2cfea4957d720c607cf2a4def8673d/crates/goose/src/skills/mod.rs)

- **Relocation:** an absolute `GOOSE_PATH_ROOT` gives `$GOOSE_PATH_ROOT/config/skills`. Otherwise an absolute `XDG_CONFIG_HOME` gives `$XDG_CONFIG_HOME/goose/skills`, on macOS too. The shared roots never move. [`config/paths.rs`](https://github.com/aaif-goose/goose/blob/591edd47cf2cfea4957d720c607cf2a4def8673d/crates/goose/src/config/paths.rs), [etcetera XDG strategy](https://github.com/lunacookies/etcetera/blob/master/src/base_strategy/xdg.rs)
- **Duplicates:** silent first-wins by case-sensitive name. Project roots come before user roots. [`skills/mod.rs`](https://github.com/aaif-goose/goose/blob/591edd47cf2cfea4957d720c607cf2a4def8673d/crates/goose/src/skills/mod.rs)
- **Symlinks:** followed, with canonicalized visited-dir tracking. [`skills/mod.rs`](https://github.com/aaif-goose/goose/blob/591edd47cf2cfea4957d720c607cf2a4def8673d/crates/goose/src/skills/mod.rs)
- **Presence:** `${XDG_CONFIG_HOME:-~/.config}/goose` (`config.yaml`). The binary is `goose`. [Config file](https://goose-docs.ai/docs/guides/config-file/)
- **Frontmatter:** the docs require `name` and `description`. Discovery only requires a non-empty `name` without `/`. [`skills/mod.rs`](https://github.com/aaif-goose/goose/blob/591edd47cf2cfea4957d720c607cf2a4def8673d/crates/goose/src/skills/mod.rs)

### Additional harnesses (sources)

- **Qwen Code:** `~/.qwen/skills/`, relocated by `QWEN_HOME`. Precedence is project > user > extension > bundled. `name` may use Unicode letters, digits and `_:.-`. [Qwen skills](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/), [Qwen settings](https://github.com/QwenLM/qwen-code-docs/blob/main/website/content/en/users/configuration/settings.md)
- **Kimi CLI (Python, `MoonshotAI/kimi-cli@9ab1286b`):** discovery chooses the _first existing_ directory in each group:
  - Brand group: `~/.kimi/skills` > `~/.claude/skills` > `~/.codex/skills`, unless `merge_brands` is set.
  - Generic group: `~/.config/agents/skills` > `~/.agents/skills`.

  Name lookup is case-folded and first-wins. [`skill/__init__.py`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/skill/__init__.py), [`share.py`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/share.py)

- **Kimi Code (TypeScript, `MoonshotAI/kimi-code@21406fb4`):** `${KIMI_CODE_HOME:-~/.kimi-code}/skills/` and `~/.agents/skills/`. Binary `kimi`. [Kimi Code skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html), [`skillRoots.ts`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts), [`package.json`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/apps/kimi-code/package.json)
- **Mistral Vibe (`mistralai/mistral-vibe@7c19608a`):** `${VIBE_HOME:-~/.vibe}/skills/` and `~/.agents/skills/`. The second root is in source but missing from the live docs. Symlinks are followed. A name/directory mismatch only warns. Binary `vibe`. [Vibe skills](https://docs.mistral.ai/vibe/code/cli/skills), [`_paths.py`](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/core/config/harness_files/_paths.py), [`skills/manager.py`](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/core/skills/manager.py)
- **Crush (`charmbracelet/crush@8da34906`):** a non-empty `CRUSH_SKILLS_DIR` _replaces_ the default list. Dedupe keeps the last copy after sorting by lowercased path. Symlinks are followed (`fastwalk Follow:true`). `name` may contain uppercase letters, and the directory match is case-insensitive. [`config/load.go`](https://github.com/charmbracelet/crush/blob/8da349060b7df148d209979be0a5e9c9281d1f15/internal/config/load.go), [`skills/skills.go`](https://github.com/charmbracelet/crush/blob/8da349060b7df148d209979be0a5e9c9281d1f15/internal/skills/skills.go)
- **Cline:** `~/.cline/skills/`. Global beats project. `name` must equal the directory name. [Cline skills](https://docs.cline.bot/customization/skills)
- **Roo Code:** `~/.roo/skills/` and `~/.agents/skills/`. Symlinks are documented, and `name` must match the _link_ name, not the target's. [Roo skills](https://roocodeinc.github.io/Roo-Code/features/skills/)
- **Kilo Code:** `~/.kilo/skills/` and `~/.agents/skills/`, plus `~/.claude/skills/` in Claude-compat mode. Binary `kilo`. [Kilo skills](https://kilo.ai/docs/customize/skills)
- **Windsurf Cascade (docs now under Devin Desktop):** `~/.codeium/windsurf/skills/`, `~/.config/devin/skills/` and `~/.agents/skills/`, plus `~/.claude/skills/` if enabled. [Cascade skills](https://docs.devin.ai/desktop/cascade/skills)
- **Kiro:** `~/.kiro/skills/`. Workspace beats global. Follows the spec's frontmatter rules. [Kiro skills](https://kiro.dev/docs/skills/)
- **JetBrains Junie:** `~/.junie/skills/` and `~/.agents/skills/`; `--skill-default-locations false` disables both. `description` is optional. [Junie agent skills](https://junie.jetbrains.com/docs/agent-skills.html)
- **Letta Code (`letta-ai/letta-code@20f4a311`):** `~/.letta/skills/` only, with no `~/.agents` or `~/.claude` at user scope. Symlinks are followed. Binary `letta`. [`src/agent/skills.ts`](https://github.com/letta-ai/letta-code/blob/20f4a311fc5cc57108fdeb20ba75497cf40bb3c6/src/agent/skills.ts)
- **Warp:** scans `~/.agents/skills/`, `~/.warp/skills/`, and the `skills/` dirs of Claude, Codex, Cursor, Gemini, Copilot, Factory, GitHub and OpenCode. Same-name copies are all offered rather than deduplicated. [Warp skills](https://docs.warp.dev/agents/capabilities/skills)
