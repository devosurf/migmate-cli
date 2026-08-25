# Infisical external secret provider research

This note captures the Infisical facts that matter for designing a reusable migration CLI secret-provider interface.

## Recommendation

- **Use a machine-identity bootstrap that yields a short-lived bearer token.** Infisical’s machine identities are the umbrella primitive, and Universal Auth is explicitly described as platform-agnostic and short-lived; it exchanges a Client ID + Client Secret for an access token. Infisical also supports Kubernetes, AWS, Azure, GCP, OIDC, and SPIFFE auth methods for workloads that already have a native identity. [Machine Identities](https://infisical.com/docs/documentation/platform/identities/machine-identities), [Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth), [Login API](https://infisical.com/docs/api-reference/endpoints/universal-auth/login)
- **Prefer the HTTP API or the official SDK, not spawning the `infisical` CLI.** Infisical’s current Node SDK is a typed REST wrapper with an optional `siteUrl` and direct `auth().universalAuth.login(...)` / `secrets().listSecrets(...)` calls; the CLI adds shell/history concerns, domain-resolution rules, and stdout parsing that are unnecessary for an adapter. [Node SDK README](https://github.com/Infisical/node-sdk-v2), [Node SDK source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/index.ts), [SDK auth source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/custom/auth.ts), [SDK secrets source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/custom/secrets.ts), [CLI login docs](https://infisical.com/docs/cli/commands/login), [CLI quickstart](https://infisical.com/docs/cli/usage)
- **Treat service tokens as legacy fallback only.** Infisical’s CLI marks `service-token` as deprecated and says to switch to Machine Identities. The service-token docs scope tokens by environment/path, recommend least privilege, and recommend periodic rotation, but they are still project-level bearer/decryption credentials. [CLI service-token docs](https://infisical.com/docs/cli/commands/service-token), [Service tokens internals](https://infisical.com/docs/internals/service-tokens)

## What the provider interface should expose

### 1) Instance / deployment target

- Make the base URL explicit and generic, e.g. `baseUrl` or `domain`.
- Support US Cloud (`https://app.infisical.com`), EU Cloud (`https://eu.infisical.com`), and self-hosted instances.
- Pass the **instance origin/root**, not `/api`; the CLI helper appends `/api` when needed, and the Node SDK accepts a `siteUrl` that defaults to `https://app.infisical.com`. [CLI quickstart](https://infisical.com/docs/cli/usage), [CLI project config](https://infisical.com/docs/cli/project-config), [CLI helper source](https://raw.githubusercontent.com/Infisical/cli/main/packages/util/helper.go), [Node SDK README](https://github.com/Infisical/node-sdk-v2), [Node SDK source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/index.ts), [SDK base client source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/api/base.ts)
- For non-interactive CLI usage, Infisical resolves the domain in this order: `--domain` → `INFISICAL_DOMAIN` → `.infisical.json` → default US Cloud. `INFISICAL_API_URL` is still honored as a legacy fallback. [CLI quickstart](https://infisical.com/docs/cli/usage), [CLI project config](https://infisical.com/docs/cli/project-config), [CLI helper source](https://raw.githubusercontent.com/Infisical/cli/main/packages/util/helper.go)

### 2) Scope

- Make `projectId` required. Infisical’s CLI says `--projectId` is required when authenticating with a machine identity, and the SDK’s secrets API also takes a project identifier plus environment and secret path. [CLI secrets docs](https://infisical.com/docs/cli/commands/secrets), [SDK secrets source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/custom/secrets.ts), [Node SDK docs](https://infisical.com/docs/sdks/languages/node)
- Make `environment` explicit, and keep the path scope explicit as `path`/`secretPath`. Infisical secret reads are scoped by project, environment slug, and folder path; the CLI uses `--env` and `--path`, and the SDK exposes `environment`, `secretPath`, `recursive`, and `includeImports`. [CLI secrets docs](https://infisical.com/docs/cli/commands/secrets), [CLI run docs](https://infisical.com/docs/cli/commands/run), [SDK secrets source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/custom/secrets.ts), [Node SDK docs](https://infisical.com/docs/sdks/languages/node)
- If you need multi-organization support, allow an optional `organizationSlug` (or equivalent tenant field). Infisical’s Universal Auth login API accepts `organizationSlug` and otherwise defaults to the organization where the identity was created. [Login API](https://infisical.com/docs/api-reference/endpoints/universal-auth/login)
- For machine identities, prefer project-level identities when possible; organization-level identities must be added to projects and can span multiple projects. [Machine Identities](https://infisical.com/docs/documentation/platform/identities/machine-identities), [Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth)

### 3) Auth model

- Model auth as a pluggable bootstrap strategy, but default to a **short-lived machine-identity token** rather than a long-lived static token.
- If the runtime already has a trusted native identity, expose that as another bootstrap option under the same generic interface; Infisical supports Kubernetes, AWS, Azure, GCP, OIDC, and SPIFFE auth methods for machine identities. [Machine Identities](https://infisical.com/docs/documentation/platform/identities/machine-identities)
- Keep a pre-minted access token path only as a compatibility mode. Infisical’s Token Auth is conceptually API-key-like and the docs position it as simpler, but it is still a static bearer token compared with a short-lived machine-identity bootstrap. [Token Auth](https://infisical.com/docs/documentation/platform/identities/token-auth), [Machine Identities](https://infisical.com/docs/documentation/platform/identities/machine-identities)

## Rotation, TTL, and revocation behavior

- Universal Auth access tokens are short-lived and renewable. Infisical documents configurable access-token TTL, max TTL, max uses, and optional periodic tokens that can be renewed repeatedly; the docs also show a default 7200-second login token TTL and a 30-day default in the UI for token-period settings. [Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth)
- Client secrets can also be given a TTL and max number of uses. Infisical recommends setting a finite TTL for the client secret when possible and using credential-expiry alerts for TTL-backed secrets. [Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth), [Machine Identities](https://infisical.com/docs/documentation/platform/identities/machine-identities)
- Revocation is immediate in the normal case, but Infisical documents a rare cache edge where a specific revoked token can remain accepted for up to 12 minutes until the revocation check is re-evaluated. Deleting the identity or the underlying client secret invalidates the token regardless of cache state. [Machine Identities](https://infisical.com/docs/documentation/platform/identities/machine-identities)
- Legacy service tokens should be treated as finite-lived credentials with narrow environment/path scopes and periodic rotation. Infisical recommends least privilege, IP whitelisting, secure storage, and periodic rotation for them. [Service tokens internals](https://infisical.com/docs/internals/service-tokens)

## Audit / log leakage risks

- Infisical explicitly warns that terminal history retains commands and recommends ignoring `infisical secrets set` in `HISTIGNORE`; the CLI also recommends `--silent` / `--plain` when scripting secret output. Machine-identity login via the CLI prints an access token to the console. [CLI quickstart](https://infisical.com/docs/cli/usage), [CLI login docs](https://infisical.com/docs/cli/commands/login), [CLI secrets docs](https://infisical.com/docs/cli/commands/secrets)
- `.infisical.json` can pin the instance domain, but Infisical warns that this file is usually committed and that the CLI prints the host name because all requests and credentials are sent there. [CLI project config](https://infisical.com/docs/cli/project-config)
- For a migration engine, shelling out to the CLI increases the chance of leaking credentials through process arguments, stdout/stderr capture, shell history, or committed per-project config. A direct API/SDK integration avoids those extra surfaces. [CLI usage](https://infisical.com/docs/cli/usage), [CLI login docs](https://infisical.com/docs/cli/commands/login), [Node SDK source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/index.ts)

## Interface implication

Keep the migration-engine interface generic and Infisical-agnostic:

```text
SecretProviderConfig {
  baseUrl: string
  auth: {
    kind: "machine-identity" | "access-token"
    clientId?: string
    clientSecret?: string
    organizationSlug?: string
    token?: string
  }
  scope: {
    projectId: string
    environment: string
    path: string
  }
  options?: {
    recursive?: boolean
    includeImports?: boolean
  }
}
```

For Infisical specifically, the adapter should:

1. Normalize the instance URL once.
2. Bootstrap a short-lived token with Universal Auth by default.
3. Cache/refresh that token in memory for the duration of the run.
4. Fetch secrets through the REST API or official SDK.
5. Avoid spawning the `infisical` binary unless you need a temporary compatibility shim.

That keeps the migration engine decoupled from Infisical-specific flag names (`--domain`, `--projectId`, `--env`, `--path`) while still matching Infisical’s real auth and scoping model. [CLI usage](https://infisical.com/docs/cli/usage), [CLI secrets docs](https://infisical.com/docs/cli/commands/secrets), [Node SDK docs](https://infisical.com/docs/sdks/languages/node), [Node SDK source](https://raw.githubusercontent.com/Infisical/node-sdk-v2/main/src/index.ts)
