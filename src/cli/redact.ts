const SENSITIVE_KEYS: Record<string, true> = {
  socketPath: true,
  socket_path: true,
  socketProbed: true,
  socket_probed: true,
  workerPid: true,
  worker_pid: true,
  authorization: true,
  authorizationHeader: true,
  authorization_header: true,
  accessToken: true,
  access_token: true,
  refreshToken: true,
  refresh_token: true,
  providerToken: true,
  provider_token: true,
  token: true,
  secret: true,
  secrets: true,
  credential: true,
  credentials: true,
  rawSecretBytes: true,
  raw_secret_bytes: true,
  transientUrl: true,
  transient_url: true,
};

const SENSITIVE_VALUE_RE =
  /\b(?:Authorization:\s*Bearer\s+\S+|Bearer\s+\S+|token=\S+|access_token=\S+|refresh_token=\S+|signature=\S+|sig=\S+|x-amz-signature=\S+|x-amz-security-token=\S+)\b/gi;
const SOCKET_PATH_RE = /\/[^\s"'<>]+(?:\/[^\s"'<>]+)*\.sock\b/gi;
const TRANSIENT_URL_RE = /https?:\/\/[^\s"'<>]+(?:\?[^\s"'<>]+)?/gi;

function redactString(value: string, key?: string): string | null {
  if (key !== undefined && SENSITIVE_KEYS[key] === true) {
    if (
      key === "socketPath" ||
      key === "socket_path" ||
      key === "socketProbed" ||
      key === "socket_probed" ||
      key === "workerPid" ||
      key === "worker_pid"
    ) {
      return null;
    }

    return "[redacted]";
  }

  if (value.length === 0) return value;

  let output = value.replace(SENSITIVE_VALUE_RE, "[redacted]");
  output = output.replace(SOCKET_PATH_RE, "[redacted-socket]");
  output = output.replace(TRANSIENT_URL_RE, "[redacted-url]");
  return output;
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    const redacted = redact(entry, key);
    if (redacted !== undefined) {
      output[key] = redacted;
    }
  }

  return output;
}

export function redact<T>(value: T, key?: string): T {
  if (value === null || value === undefined) return value;

  if (key !== undefined && SENSITIVE_KEYS[key] === true) {
    if (
      key === "socketPath" ||
      key === "socket_path" ||
      key === "socketProbed" ||
      key === "socket_probed" ||
      key === "workerPid" ||
      key === "worker_pid"
    ) {
      return null as T;
    }

    return "[redacted]" as T;
  }

  if (typeof value === "string") return redactString(value, key) as T;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return value;
  if (typeof value === "symbol" || typeof value === "function") return undefined as T;

  if (value instanceof Date) {
    return value.toISOString() as T;
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return "[redacted-bytes]" as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry)) as T;
  }

  if (typeof value === "object") {
    return redactObject(value as Record<string, unknown>) as T;
  }

  return value;
}
