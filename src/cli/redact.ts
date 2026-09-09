const SENSITIVE_KEYS: Record<string, true> = {
  socketpath: true,
  socketprobed: true,
  workersocket: true,
  workersocketpath: true,
  workerpid: true,
  rcuser: true,
  rcpass: true,
  rcloneuser: true,
  rclonepass: true,
  rclonercuser: true,
  rclonercpass: true,
  authorization: true,
  authorizationheader: true,
  accesstoken: true,
  refreshtoken: true,
  providertoken: true,
  token: true,
  secret: true,
  secrets: true,
  clientsecret: true,
  password: true,
  cookie: true,
  setcookie: true,
  credential: true,
  credentials: true,
  rawsecretbytes: true,
  transienturl: true,
  downloadurl: true,
  preauthenticatedurl: true,
};
const RECOVERY_KEYS: Record<string, true> = {
  workerAlive: true,
  workerStatus: true,
  recordedHostId: true,
  thisHostId: true,
  holder: true,
  workerGroup: true,
  lastCheckpoint: true,
  reclaimable: true,
};
const HOLDER_KEYS: Record<string, true> = {
  ownerUuid: true,
  hostId: true,
  pid: true,
  processStartTime: true,
  heartbeatAt: true,
  heartbeatAgeMs: true,
  kind: true,
};

export function redact(value: unknown, key?: string): unknown {
  if (key && Object.hasOwn(SENSITIVE_KEYS, key.replace(/[^a-z]/giu, "").toLowerCase()))
    return undefined;
  if (typeof value === "string") {
    return value
      .replace(
        /\b(?:Bearer\s+\S+|(?:RCLONE_RC_(?:USER|PASS)|access_token|refresh_token|client_secret|authorization|cookie|password)\s*[:=]\s*\S+)/giu,
        "[redacted]",
      )
      .replace(/(?:\/[\w.\-]+)+\.sock\b/gu, "[redacted-socket]")
      .replace(/https?:\/\/[^\s"'<>]+/giu, (url) =>
        /[?&](?:token|sig|signature|access_token|tempauth|x-amz-|x-goog-)|\.sharepoint\.com\/.*(?:download|_layouts)|downloadUrl/iu.test(
          url,
        )
          ? "[redacted-url]"
          : url,
      );
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const recovery = key === "recovery" || ("recordedHostId" in object && "workerAlive" in object);
    const entries = Object.entries(object).filter(
      ([name]) =>
        (!recovery || Object.hasOwn(RECOVERY_KEYS, name)) &&
        (key !== "holder" || Object.hasOwn(HOLDER_KEYS, name)),
    );
    return Object.fromEntries(
      entries.flatMap(([name, entry]) => {
        const clean = redact(entry, name);
        return clean === undefined ? [] : [[name, clean]];
      }),
    );
  }
  return value;
}
