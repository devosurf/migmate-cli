# ADR-0002: Drop Windows from the first-release platform matrix

- Status: accepted
- Date: 2026-09-12
- Context: [spec #17](https://github.com/devosurf/migmate-cli/issues/17) decision 17, [distribution decision #12](https://github.com/devosurf/migmate-cli/issues/12), [ADR-0001](0001-toolchain.md)

## Context

Spec #17 listed macOS, Windows 10/11, and Linux on x64 and arm64 as the supported desktop matrix. The operator has since stated that Migmate is deployed on macOS and Linux only, and explicitly approved removing Windows, exactly as the macOS 13.5 floor was approved on 2026-09-09.

Windows was never a free entry in that matrix. Windows has no POSIX mode bits, so four security-bearing checks were implemented as explicit `powershell.exe` invocations rather than `chmod`, `lstat`, and `/proc`: the 0700 run directory that is the transfer worker's trust seam, credential-reference file protection, the lease's process owner and start-time comparison, and worker socket liveness. Spec #17 also records the unix-socket RC bind on Windows as inferred from listener code rather than documented, and names it one of two standing release risks. That risk is carried by the highest-consequence surface in the product: the lease refusals, where a wrong answer silently corrupts a destination.

Two of the six vendored `rclone` binaries were Windows builds, shipped and checksum-verified inside every installed artifact regardless of host.

## Decision

**The supported matrix is macOS 13.5+ and Linux, on x64 and arm64 only.** `win32` is removed from the package manifest `os` field, so npm refuses installation on Windows.

**Every Windows code path is deleted rather than disabled.** The PowerShell ACL, process-inspection, cwd, and socket-probe scripts are gone; the POSIX implementations they shadowed are now unconditional, with their existing semantics unchanged. There is no Windows shim, capability flag, or "unsupported platform" stub left behind.

**Hosted CI is four native cells**, and the manual desktop and live-route gates offer the same four. The vendored binary set, its manifest, the qualification desktop cells, and the release-gate register all name exactly `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`.

**An unsupported platform refuses.** `scripts/platform.ts` throws, `migmate web` returns its existing unavailable refusal, and deriving a default engine home on an unsupported platform is a usage failure. No path falls back.

## Consequences

- The standing Windows AF_UNIX RC-bind risk recorded in spec #17 is retired rather than mitigated, and the PowerShell trust seam no longer exists to be reviewed or maintained.
- The installed artifact loses 163,184,640 bytes of vendored Windows executables.
- ADR-0001's six-cell CI statement is superseded; its Windows WebView2 prerequisite no longer applies.
- Windows operators are refused at install time rather than failing inside a job. No partial or degraded Windows behaviour is claimed anywhere.
- Re-adding Windows is a new decision with real cost: the ACL, process, and socket paths, the vendored binaries, the CI cells, and a re-run route matrix. Nothing was left in place to make that cheap, which is the point.
