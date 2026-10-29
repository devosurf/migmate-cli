/** Only static, secret-free messages and explicitly selected evidence belong here. */
export class ProviderFault extends Error {
  readonly code: string;
  readonly evidence: Record<string, unknown>;

  constructor(code: string, message: string, evidence: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProviderFault";
    this.code = code;
    this.evidence = evidence;
  }
}
