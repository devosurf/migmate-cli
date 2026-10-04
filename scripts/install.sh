#!/bin/sh
# Migmate installer.
#
#   curl -fsSL https://github.com/devosurf/migmate-cli/releases/latest/download/install.sh | sh
#
# Installs one GitHub release into a versioned directory after checking it
# against the release's SHA256SUMS, then writes a `migmate` launcher. Running it
# again, or `migmate upgrade`, moves to the latest release; `--version X` pins one.
# It also installs Migmate's agent skill for the coding agents it finds, asking
# on the terminal the first time and refreshing the same places on upgrade.
#
# Environment:
#   MIGMATE_INSTALL_DIR   install root  (default ~/.local/share/migmate-cli)
#   MIGMATE_BIN_DIR       launcher dir  (default ~/.local/bin)
#   MIGMATE_NODE          auto | system | bundled  (default auto: system Node when it
#                         meets the release's floor and ships npm, else a private copy)
#   MIGMATE_VERSION       release to install  (default latest)
#   MIGMATE_SKILLS        ask | detected | none | agent ids such as claude,codex
#                         (default: the recorded choice, else ask on a terminal,
#                         else every detected agent); same as --skills
#   MIGMATE_RELEASES_URL  release host  (default https://github.com/devosurf/migmate-cli/releases)
#
# Everything runs inside main, so a truncated download executes nothing.

set -eu

info() { printf '%s\n' "$*"; }
fail() {
  printf 'migmate install: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--version X.Y.Z] [--skills ask|detected|none|AGENT,...]

Installs or upgrades Migmate from GitHub Releases. See the header of this
script for the MIGMATE_* environment variables.
EOF
}

# version_ge A B: A >= B, comparing up to three numeric components.
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { p = x[i] + 0; q = y[i] + 0; if (p > q) exit 0; if (p < q) exit 1 }
    exit 0
  }'
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "neither sha256sum nor shasum is available to verify downloads"
  fi
}

# download URL FILE [progress]
download() {
  if [ "${3-}" = progress ]; then
    curl -fL --retry 3 --progress-bar -o "$2" "$1" || fail "download failed: $1"
  else
    curl -fsSL --retry 3 -o "$2" "$1" || fail "download failed: $1"
  fi
}

# verify FILE EXPECTED_SHA256
verify() {
  [ "$(sha256 "$1")" = "$2" ] || fail "checksum mismatch for ${1##*/}; refusing to install it"
}

# Single-quote a value for the generated launcher.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      os=darwin
      # Official Node 24 builds need macOS 13.5 (ADR-0001).
      macos=$(sw_vers -productVersion)
      version_ge "$macos" 13.5 || fail "macOS 13.5 or later is required (found $macos)"
      # A shell running under Rosetta on Apple silicon still gets the native build.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
        arch=arm64
      fi
      ;;
    Linux)
      os=linux
      for loader in /lib/ld-musl-*; do
        if [ -e "$loader" ]; then
          fail "musl-based Linux (such as Alpine) is not supported; use a glibc distribution"
        fi
      done
      ;;
    *) fail "unsupported operating system $os; Migmate supports macOS and Linux" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported architecture $arch; Migmate supports x64 and arm64" ;;
  esac
}

resolve_version() {
  if [ -n "$version" ]; then
    version=${version#v}
    return
  fi
  # GitHub redirects /releases/latest to /releases/tag/vX.Y.Z; no API token or rate limit.
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest") ||
    fail "cannot reach $releases"
  case "$latest" in
    */releases/tag/v*) version=${latest##*/releases/tag/v} ;;
    *) fail "no published release found at $releases" ;;
  esac
}

# Sets node and npm_cli to a runtime that meets $1.
select_node() {
  floor=$1
  if [ "$node_mode" != bundled ]; then
    if candidate=$(command -v node 2>/dev/null); then
      found=$("$candidate" -p process.versions.node 2>/dev/null || true)
      # npm sits beside node in official, nvm and setup-node layouts. Elsewhere (Homebrew)
      # the npm on PATH is a symlink chain to npm-cli.js; shims that are not, use private Node.
      candidate_npm=$(dirname "$candidate")/../lib/node_modules/npm/bin/npm-cli.js
      if [ ! -f "$candidate_npm" ] && npm_bin=$(command -v npm 2>/dev/null); then
        candidate_npm=$("$candidate" -p 'require("fs").realpathSync(process.argv[1])' "$npm_bin" \
          2>/dev/null || true)
      fi
      case "$candidate_npm" in
        */npm-cli.js) [ -f "$candidate_npm" ] || candidate_npm= ;;
        *) candidate_npm= ;;
      esac
      if [ -z "$found" ] || ! version_ge "$found" "$floor"; then
        reason="Node ${found:-of unknown version} at $candidate is below $floor"
      elif [ -z "$candidate_npm" ]; then
        reason="Node at $candidate has no npm installed beside it"
      else
        node=$candidate
        npm_cli=$candidate_npm
        info "Using Node $found at $node"
        return
      fi
    else
      reason="no node is on PATH"
    fi
    if [ "$node_mode" = system ]; then
      fail "MIGMATE_NODE=system, but $reason"
    fi
    info "$reason; using a private Node runtime instead."
  fi
  install_private_node "$floor"
}

install_private_node() {
  major=${1%%.*}
  index="https://nodejs.org/dist/latest-v$major.x"
  download "$index/SHASUMS256.txt" "$tmp/node-SHASUMS256.txt"
  line=$(grep " node-v[0-9.]*-$os-$arch\.tar\.gz\$" "$tmp/node-SHASUMS256.txt" || true)
  [ -n "$line" ] || fail "nodejs.org lists no Node $major build for $os-$arch"
  file=${line##* }
  name=${file%.tar.gz}
  found=${name#node-v}
  found=${found%%-*}
  version_ge "$found" "$1" || fail "the latest Node $major ($found) is below the required $1"
  runtime="$install_dir/runtime/$name"
  if [ ! -x "$runtime/bin/node" ]; then
    info "Downloading Node $found for $os-$arch"
    download "$index/$file" "$tmp/$file" progress
    verify "$tmp/$file" "${line%% *}"
    mkdir -p "$stage/runtime" "$install_dir/runtime"
    tar -xzf "$tmp/$file" -C "$stage/runtime"
    rm -rf "$runtime"
    mv "$stage/runtime/$name" "$runtime"
  fi
  node="$runtime/bin/node"
  npm_cli="$runtime/lib/node_modules/npm/bin/npm-cli.js"
  info "Using private Node $found"
}

write_launcher() {
  mkdir -p "$bin_dir"
  launcher="$bin_dir/migmate"
  {
    printf '#!/bin/sh\n'
    printf '# Written by the Migmate installer. Run "migmate upgrade" for the latest release.\n'
    printf 'set -eu\n'
    printf 'install_dir=%s\n' "$(quote "$install_dir")"
    printf 'bin_dir=%s\n' "$(quote "$bin_dir")"
    printf 'releases=%s\n' "$(quote "$releases")"
    printf 'node_mode=%s\n' "$(quote "$node_mode")"
    cat <<'EOF'
if [ "${1-}" = upgrade ]; then
  shift
  installer=$(mktemp "${TMPDIR:-/tmp}/migmate-install.XXXXXX")
  trap 'rm -f "$installer"' EXIT
  curl -fsSL "$releases/latest/download/install.sh" -o "$installer"
  MIGMATE_INSTALL_DIR=$install_dir MIGMATE_BIN_DIR=$bin_dir MIGMATE_RELEASES_URL=$releases \
    MIGMATE_NODE=${MIGMATE_NODE:-$node_mode} sh "$installer" "$@"
  exit
fi
current=$install_dir/current
read -r node <"$current/.node"
if [ ! -x "$node" ]; then
  printf 'migmate: Node runtime %s is gone; run the installer again to repair this install.\n' "$node" >&2
  exit 1
fi
exec "$node" "$current/lib/node_modules/@devosurf/migmate/dist/cli/main.js" "$@"
EOF
  } >"$launcher.tmp.$$"
  chmod 755 "$launcher.tmp.$$"
  mv -f "$launcher.tmp.$$" "$launcher"
}

# Keep the new and the previous version, so a job still running from the
# previous one keeps its files; drop runtimes no kept version uses.
prune() {
  for dir in "$install_dir"/versions/*; do
    [ -d "$dir" ] || continue
    name=${dir##*/}
    [ "$name" = "$version" ] || [ "$name" = "$previous" ] || rm -rf "$dir"
  done
  for runtime in "$install_dir"/runtime/*; do
    [ -d "$runtime" ] || continue
    used=no
    for meta in "$install_dir"/versions/*/.node; do
      [ -f "$meta" ] || continue
      case "$(cat "$meta")" in "$runtime"/*) used=yes ;; esac
    done
    [ "$used" = yes ] || rm -rf "$runtime"
  done
}

path_hint() {
  case ":$PATH:" in
    *":$bin_dir:"*) return ;;
  esac
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc" ;;
    *) rc="your shell's startup file" ;;
  esac
  info ""
  info "$bin_dir is not on your PATH. Add it, for example:"
  info "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> $rc"
}

# Coding agents that load user-level Agent Skills, one per line as
# id|name|presence directory|binary|skills root. Paths and the variables that
# relocate them come from docs/research/agent-skill-directories.md. Most read the
# shared ~/.agents/skills; Claude Code and a relocated Copilot CLI need their own.
harness_table() {
  shared=$HOME/.agents/skills
  config=${XDG_CONFIG_HOME:-$HOME/.config}
  claude=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  copilot_root=$shared
  [ -z "${COPILOT_HOME-}" ] || copilot_root=$COPILOT_HOME/skills
  cat <<EOF
claude|Claude Code|$claude|claude|$claude/skills
codex|Codex|${CODEX_HOME:-$HOME/.codex}|codex|$shared
gemini|Gemini CLI|${GEMINI_CLI_HOME:-$HOME}/.gemini|gemini|${GEMINI_CLI_HOME:-$HOME}/.agents/skills
opencode|OpenCode|$config/opencode|opencode|$shared
pi|pi|${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}|pi|$shared
omp|omp|$HOME/.omp|omp|$shared
cursor|Cursor|$HOME/.cursor|cursor-agent|$shared
copilot|GitHub Copilot CLI|${COPILOT_HOME:-$HOME/.copilot}|copilot|$copilot_root
amp|Amp|$HOME/.config/amp|amp|$shared
droid|Factory Droid|$HOME/.factory|droid|$shared
goose|Goose|$config/goose|goose|$shared
EOF
}

# harness ID FIELD: one field of the agent's row (2 name, 5 skills root).
harness() {
  harness_table | awk -F'|' -v id="$1" -v field="$2" '$1 == id { print $field }'
}

tilde() {
  case $1 in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

has_terminal() {
  (exec </dev/tty >/dev/tty) 2>/dev/null
}

# Sets detected to the ids of agents with a config directory or a binary on PATH.
detect_harnesses() {
  detected=
  while IFS='|' read -r id name presence binary root; do
    if [ -d "$presence" ] || command -v "$binary" >/dev/null 2>&1; then
      detected="$detected $id"
    fi
  done <<EOF
$(harness_table)
EOF
  detected=${detected# }
}

# Prints the unique agent ids named by a list of agent ids or numbers from the
# detected list; fails on anything else, including an empty list.
pick_harnesses() {
  picked=
  for token in $(printf '%s' "$1" | tr ',' ' '); do
    case $token in
      *[!0-9]*) id=$(harness "$token" 1) ;;
      *) id=$( [ "$token" -gt 0 ] && printf '%s\n' $detected | sed -n "${token}p") ;;
    esac
    [ -n "$id" ] || return 1
    case " $picked " in
      *" $id "*) ;;
      *) picked="$picked $id" ;;
    esac
  done
  [ -n "$picked" ] || return 1
  printf '%s' "${picked# }"
}

# Sets selected from a numbered prompt on the terminal; the installer's own
# stdin may be the curl pipe. Enter accepts every detected agent.
ask_harnesses() {
  n=0
  defaults=
  {
    printf '\nMigmate ships an agent skill that guides coding agents through a migration.\n'
    printf 'Found these coding agents:\n'
    for id in $detected; do
      n=$((n + 1))
      defaults="$defaults $n"
      printf '  %d) %-19s %s/migmate\n' "$n" "$(harness "$id" 2)" "$(tilde "$(harness "$id" 5)")"
    done
  } >/dev/tty
  while :; do
    printf 'Install the skill for [%s]? Enter accepts, "none" skips: ' "${defaults# }" >/dev/tty
    # End of input (Ctrl-D) declines rather than accepting the defaults.
    IFS= read -r answer </dev/tty || answer=none
    case $answer in
      '') selected=$detected && return ;;
      none | n | no) selected= && return ;;
    esac
    if selected=$(pick_harnesses "$answer"); then
      return
    fi
    printf 'Pick numbers from the list, separated by spaces, or type none.\n' >/dev/tty
  done
}

# owned PATH: nothing is there, or Migmate put it there.
owned() {
  if [ -L "$1" ]; then
    [ "$(readlink "$1")" = "$HOME/.agents/skills/migmate" ]
  else
    [ ! -e "$1" ] || [ -f "$1/.migmate-installed" ]
  fi
}

# place_skill SOURCE TARGET [LINK]: replace TARGET with a copy of SOURCE, or a
# symlink to LINK, unless something Migmate did not install is already there.
place_skill() {
  if ! owned "$2"; then
    printf 'migmate install: %s was not installed by Migmate; leaving it alone\n' "$(tilde "$2")" >&2
    return 1
  fi
  mkdir -p "${2%/*}" || return 1
  next=${2%/*}/.migmate-skill.$$
  rm -rf "$next"
  if [ -n "${3-}" ]; then
    ln -s "$3" "$next" || return 1
  elif ! { cp -R "$1" "$next" && printf '%s\n' "$version" >"$next/.migmate-installed"; }; then
    rm -rf "$next"
    return 1
  fi
  rm -rf "$2" && mv "$next" "$2"
}

# Installs the release's agent skill for the chosen agents and records the
# choice, so upgrades refresh the same places without asking again. One copy
# goes to the shared ~/.agents/skills; other roots link to it, because several
# agents read both and warn about two copies.
install_skill() {
  skill=$install_dir/current/lib/node_modules/@devosurf/migmate/.agents/skills/migmate
  record=$install_dir/agent-skill
  if [ ! -f "$skill/SKILL.md" ]; then
    info "Migmate $version ships no agent skill."
    return
  fi
  detect_harnesses
  choice=$skills
  if [ -z "$choice" ]; then
    if [ -f "$record" ]; then
      choice=recorded
    elif has_terminal; then
      choice=ask
    else
      choice=detected
    fi
  fi
  seen=$detected
  case $choice in
    recorded)
      selected=$(sed -n 's/^harnesses //p' "$record")
      seen=$(sed -n 's/^seen //p' "$record")
      ;;
    ask)
      selected=
      [ -z "$detected" ] || ask_harnesses
      ;;
    detected) selected=$detected ;;
    none) selected= ;;
    *) selected=$(pick_harnesses "$choice") ;;
  esac

  roots=$(for id in $selected; do harness "$id" 5; done |
    awk -v shared="$HOME/.agents/skills" '!seen[$0]++ { if ($0 == shared) print; else rest = rest $0 "\n" }
      END { printf "%s", rest }')
  written=
  link=
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    if place_skill "$skill" "$root/migmate" "$link"; then
      written="$written
$root/migmate"
      [ "$root" != "$HOME/.agents/skills" ] || link=$root/migmate
    fi
  done <<EOF
$roots
EOF

  if [ -f "$record" ]; then
    while IFS= read -r old; do
      case $old in /*) ;; *) continue ;; esac
      if printf '%s\n' "$written" | grep -Fxq -- "$old"; then continue; fi
      if { [ -e "$old" ] || [ -L "$old" ]; } && owned "$old"; then
        rm -rf "$old"
        info "Removed the agent skill from $(tilde "$old")."
      fi
    done <"$record"
  fi

  new=
  for id in $detected; do
    case " $seen " in
      *" $id "*) ;;
      *) new="$new, $(harness "$id" 2)" && seen="$seen $id" ;;
    esac
  done
  {
    printf 'harnesses %s\n' "$selected"
    printf 'seen %s\n' "${seen# }"
    printf '%s\n' "$written" | sed '/^$/d'
  } >"$record.tmp.$$"
  mv -f "$record.tmp.$$" "$record"

  if [ -n "$written" ]; then
    names=
    for id in $selected; do names="$names, $(harness "$id" 2)"; done
    info "Agent skill for ${names#, }:"
    printf '%s\n' "$written" | sed '/^$/d' | while IFS= read -r path; do
      info "  $(tilde "$path")"
    done
  elif [ "$choice" != recorded ] && [ -z "$detected" ]; then
    info "Found no coding agent, so no agent skill was installed. Add it later with"
    info "migmate upgrade --skills AGENT, AGENT being one of: $(harness_table | cut -d'|' -f1 | tr '\n' ' ')"
  elif [ "$choice" != recorded ]; then
    info "No agent skill installed. Add it later with: migmate upgrade --skills ask"
  fi
  if [ -n "$new" ] && [ "$choice" = recorded ]; then
    info "Also found ${new#, }. Add the agent skill for it with: migmate upgrade --skills ask"
  fi
}

main() {
  version=${MIGMATE_VERSION-}
  skills=${MIGMATE_SKILLS-}
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || fail "--version needs a value"
        version=$2
        shift 2
        ;;
      --version=*)
        version=${1#*=}
        shift
        ;;
      --skills)
        [ $# -ge 2 ] || fail "--skills needs a value"
        skills=$2
        shift 2
        ;;
      --skills=*)
        skills=${1#*=}
        shift
        ;;
      -h | --help)
        usage
        return
        ;;
      *) fail "unknown option $1" ;;
    esac
  done

  [ -n "${HOME:-}" ] || fail "HOME is not set"
  case $skills in
    '' | detected | none) ;;
    ask) has_terminal || fail "--skills ask needs a terminal" ;;
    *)
      detected=
      pick_harnesses "$skills" >/dev/null ||
        fail "--skills takes ask, detected, none, or agents from: $(harness_table | cut -d'|' -f1 | tr '\n' ' ')"
      ;;
  esac
  # Not ~/.migmate: Migmate treats the nearest .migmate directory as a job store.
  install_dir=${MIGMATE_INSTALL_DIR:-$HOME/.local/share/migmate-cli}
  bin_dir=${MIGMATE_BIN_DIR:-$HOME/.local/bin}
  node_mode=${MIGMATE_NODE:-auto}
  releases=${MIGMATE_RELEASES_URL:-https://github.com/devosurf/migmate-cli/releases}
  case "$node_mode" in
    auto | system | bundled) ;;
    *) fail "MIGMATE_NODE must be auto, system, or bundled" ;;
  esac
  for tool in curl tar awk sed grep mktemp; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
  done

  detect_platform
  resolve_version
  previous=
  if [ -L "$install_dir/current" ]; then
    previous=$(readlink "$install_dir/current")
    previous=${previous##*/}
  fi
  if [ "$previous" = "$version" ] && [ -f "$install_dir/current/.node" ] &&
    [ -x "$(cat "$install_dir/current/.node")" ]; then
    write_launcher
    info "Migmate $version is already installed and current."
    install_skill
    path_hint
    return
  fi

  mkdir -p "$install_dir"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/migmate-install.XXXXXX")
  stage="$install_dir/.stage.$$"
  trap 'rm -rf "$tmp" "$stage"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -p "$stage"

  asset="migmate-$version.tgz"
  base="$releases/download/v$version"
  info "Installing Migmate $version for $os-$arch"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS"
  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS for $version does not list $asset"
  download "$base/$asset" "$tmp/$asset" progress
  verify "$tmp/$asset" "$expected"

  # The release states its own Node floor; nothing here duplicates it.
  floor=$(tar -xzOf "$tmp/$asset" package/package.json |
    sed -n 's/.*"node": *">=\([0-9][0-9.]*\)".*/\1/p' | sed -n 1p)
  [ -n "$floor" ] || fail "$asset does not declare a Node floor"
  select_node "$floor"

  # Lifecycle scripts resolve `node` through PATH, so put the chosen runtime first.
  PATH=$(dirname "$node"):$PATH "$node" "$npm_cli" install --global --prefix "$stage/$version" \
    --omit=dev --no-audit --no-fund --loglevel=error "$tmp/$asset" >/dev/null
  printf '%s\n' "$node" >"$stage/$version/.node"
  "$node" "$stage/$version/lib/node_modules/@devosurf/migmate/dist/cli/main.js" --help >/dev/null ||
    fail "the installed Migmate $version did not start"

  mkdir -p "$install_dir/versions"
  rm -rf "$install_dir/versions/$version"
  mv "$stage/$version" "$install_dir/versions/$version"
  ln -sfn "versions/$version" "$install_dir/current"
  write_launcher
  prune

  info "Installed Migmate $version: $bin_dir/migmate"
  [ -z "$previous" ] || info "Previous version $previous is kept until the next upgrade."
  install_skill
  path_hint
}

main "$@"
