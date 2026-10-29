const MAX_VALUE_CHARS = 16 * 1024 * 1024;

type Frame = {
  kind: "object" | "array";
  state: "keyOrEnd" | "key" | "colon" | "value" | "valueOrEnd" | "commaOrEnd";
  key?: string;
  selected?: boolean;
};

/** Validates the complete JSON document while emitting one selected top-level
 * array entry at a time. Neither ignored arrays nor the selected array are
 * retained. The bound applies to a single value/token, never the inventory. */
export async function parseListingJson(
  chunks: AsyncIterable<Uint8Array>,
  field: "list" | "hashsum",
  accept: (value: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const frames: Frame[] = [];
  let root = false;
  let complete = false;
  let found = false;
  let capture: string[] | undefined;
  let captureSize = 0;
  let captureDepth = 0;
  let token = "";
  let quoted = false;
  let escaped = false;
  function invalid(): never {
    throw new SyntaxError("Invalid listing JSON");
  }

  function emit(text: string): void {
    if (complete) invalid();
    const frame = frames.at(-1);
    if (
      frame?.selected &&
      (frame.state === "value" || frame.state === "valueOrEnd") &&
      text !== "]"
    ) {
      capture = [];
      captureSize = 0;
      captureDepth = frames.length;
    }
    if (capture !== undefined) {
      captureSize += text.length;
      if (captureSize > MAX_VALUE_CHARS) invalid();
      capture.push(text);
    }
    if (!root) {
      if (text !== "{") invalid();
      root = true;
      frames.push({ kind: "object", state: "keyOrEnd" });
      return;
    }
    if (frame === undefined) invalid();
    if (frame.state === "key" || frame.state === "keyOrEnd") {
      if (text === "}" && frame.state === "keyOrEnd") frames.pop();
      else {
        if (!text.startsWith('"')) invalid();
        frame.key = JSON.parse(text) as string;
        frame.state = "colon";
        return;
      }
    } else if (frame.state === "colon") {
      if (text !== ":") invalid();
      frame.state = "value";
      return;
    } else if (frame.state === "commaOrEnd") {
      if (text === ",") {
        frame.state = frame.kind === "object" ? "key" : "value";
        return;
      }
      if (text !== (frame.kind === "object" ? "}" : "]")) invalid();
      frames.pop();
    } else if (text === "]" && frame.kind === "array" && frame.state === "valueOrEnd") {
      frames.pop();
    } else {
      const selected = frames.length === 1 && frame.kind === "object" && frame.key === field;
      if (selected) {
        // Ambiguous repeated inventory fields cannot safely be streamed with
        // JSON.parse's last-property-wins semantics. Refuse rather than combine.
        if (found || text !== "[") invalid();
        found = true;
      }
      frame.state = "commaOrEnd";
      if (text === "{") frames.push({ kind: "object", state: "keyOrEnd" });
      else if (text === "[") frames.push({ kind: "array", state: "valueOrEnd", selected });
      else {
        if (text === "}" || text === "]" || text === ":" || text === ",") invalid();
        JSON.parse(text);
      }
    }
    if (frames.length > 256) invalid();
    if (capture !== undefined && frames.length === captureDepth) {
      accept(JSON.parse(capture.join("")) as unknown);
      capture = undefined;
    }
    if (frames.length === 0) complete = true;
  }

  function consume(text: string): void {
    for (const char of text) {
      if (quoted) {
        token += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          quoted = false;
          emit(token);
          token = "";
        }
      } else if (char === '"') {
        if (token !== "") invalid();
        quoted = true;
        token = char;
      } else if (
        "{}[]:,".includes(char) ||
        char === " " ||
        char === "\n" ||
        char === "\r" ||
        char === "\t"
      ) {
        if (token !== "") {
          emit(token);
          token = "";
        }
        if ("{}[]:,".includes(char)) emit(char);
      } else token += char;
      if (token.length > MAX_VALUE_CHARS) invalid();
    }
  }

  for await (const chunk of chunks) consume(decoder.decode(chunk, { stream: true }));
  consume(decoder.decode());
  if (token !== "") {
    if (quoted) invalid();
    emit(token);
  }
  if (!complete || !found || capture !== undefined) invalid();
}
