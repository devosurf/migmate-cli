# ADR-0021: A default credential directory with short reference names

- Status: accepted
- Date: 2026-11-04
- Amends: the resolution of [#15](https://github.com/devosurf/migmate-cli/issues/15), which kept typed file references as the only secret surface but left their location to the operator.

Onboarding a new project, the agent asked the operator where to keep credential files and proposed a folder of its own. Migmate had no answer: one wizard suggested `~/.config/migmate`, the other asked with no default, and the engine knew neither. Where secrets live is not a decision an operator should have to make per project.

## Decisions

### D1: One credential directory per operator

Credential files live by default in `${XDG_CONFIG_HOME:-~/.config}/migmate/credentials`, on macOS as on Linux, so documentation, wizards and agents name one place. `MIGMATE_CREDENTIALS_DIR` overrides it. It is separate from the engine home (state) and from every job folder, so credentials never enter job evidence, backups of `.migmate/`, or a repository.

### D2: Migmate owns the directory's permissions

`migmate creds dir`, and any config that uses a short name, creates the directory `0700`, tightens an existing directory the operator owns to `0700`, and refuses a symlink or a directory owned by someone else. Each file keeps the existing reference checks (`0600`, owner, regular file, outside the job).

### D3: Short names expand before anything is stored

A file reference whose `path` is a plain relative name (`rclone.conf`, `entra/client-secret.txt`) names a file in the credential directory. The CLI expands it to an absolute path when it reads config, before the engine validates or stores it, so `job.toml` keeps only absolute paths and every later command resolves the same file from any working directory or environment. The engine's reference contract is unchanged: it still accepts only absolute paths. Absolute references keep working, and other relative paths are still refused.

### Not done

Migmate does not write secrets it did not already write: the operator or the wizards still create each file (Dropbox `creds init` keeps writing its token into the referenced rclone file). No keychain or secret-manager resolver is added; #15's `file`-only resolver stands.
