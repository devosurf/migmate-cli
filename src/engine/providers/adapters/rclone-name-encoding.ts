// Pinned rclone v1.75.0, not a generic filename sanitizer:
// https://github.com/rclone/rclone/blob/v1.75.0/lib/encoder/encoder.go
// https://github.com/rclone/rclone/blob/v1.75.0/lib/encoder/standard.go
// OneDrive uses Display (Standard) plus these flags; EncodeZero is always active.
// https://github.com/rclone/rclone/blob/v1.75.0/backend/onedrive/onedrive.go#L456-L497
export const SHAREPOINT_DESTINATION_ENCODING =
  "Slash,LtGt,DoubleQuote,Colon,Question,Asterisk,Pipe,BackSlash,Del,Ctl,LeftSpace,LeftTilde,RightSpace,RightPeriod,InvalidUtf8,Dot";

const quote = "‛";
const fullOffset = 0xfee0;
const symbolOffset = 0x2400;
type Encoding = "standard" | "google" | "sharepoint-source" | "sharepoint-destination";
const punctuation: Record<Encoding, string> = {
  standard: "/",
  google: "",
  "sharepoint-source": "/",
  "sharepoint-destination": '/<>":?*|\\',
};
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Encode a raw Unicode basename, including literal replacement glyphs and QuoteRune. */
function encode(name: string, encoding: Encoding): string {
  const standard = encoding === "standard" || encoding === "sharepoint-destination";
  if (standard) {
    if (name === ".") return "．";
    if (name === "..") return "．．";
    if (name === "．") return "‛．";
    if (name === "．．") return "‛．‛．";
  }
  let prefix = "";
  let suffix = "";
  if (encoding === "sharepoint-destination") {
    // rclone replaces only the first/last rune, not the entire run of spaces/dots.
    const first = name[0];
    if (first === " " || first === "~" || first === "␠" || first === "～") {
      prefix = first === " " ? "␠" : first === "~" ? "～" : quote + first;
      name = name.slice(1);
    }
    const last = name.at(-1);
    if (last === " " || last === "." || last === "␠" || last === "．") {
      suffix = last === " " ? "␠" : last === "." ? "．" : quote + last;
      name = name.slice(0, -1);
    }
  }
  let result = prefix;
  const characters = punctuation[encoding];
  for (const rune of name) {
    const code = rune.codePointAt(0)!;
    if (code === 0) result += "␀";
    else if (rune === "␀" || rune === quote) result += quote + rune;
    else if (characters.includes(rune)) result += String.fromCodePoint(code + fullOffset);
    else if (characters.includes(String.fromCodePoint(Math.max(0, code - fullOffset))))
      result += quote + rune;
    else if (standard && code >= 1 && code <= 0x1f)
      result += String.fromCodePoint(symbolOffset + code);
    else if (standard && code > symbolOffset && code <= symbolOffset + 0x1f) result += quote + rune;
    else if (standard && code === 0x7f) result += "␡";
    else if (standard && rune === "␡") result += quote + rune;
    else result += rune;
  }
  return result + suffix;
}

/** Undefined means InvalidUtf8.Decode produced bytes that cannot cross a JSON listing. */
function decode(name: string, encoding: Encoding): string | undefined {
  const standard = encoding === "standard" || encoding === "sharepoint-destination";
  const invalidUtf8 = encoding === "google" || encoding === "sharepoint-destination";
  if (invalidUtf8 && !name.isWellFormed()) return undefined;
  if (standard) {
    if (name === "．") return ".";
    if (name === "．．") return "..";
    if (name === "‛．") return "．";
    if (name === "‛．‛．") return "．．";
  }
  let prefix = "";
  let suffix = "";
  if (encoding === "sharepoint-destination") {
    // Decode edge substitutions before processing quotes in the remaining body.
    // In particular, a suffix consumes its immediately preceding QuoteRune.
    if (name[0] === "␠" || name[0] === "～") {
      prefix = name[0] === "␠" ? " " : "~";
      name = name.slice(1);
    } else if (name[0] === quote && (name[1] === "␠" || name[1] === "～")) {
      prefix = name[1]!;
      name = name.slice(2);
    }
    const last = name.at(-1);
    if (last === "␠" || last === "．") {
      name = name.slice(0, -1);
      if (name.at(-1) === quote) {
        suffix = last;
        name = name.slice(0, -1);
      } else {
        suffix = last === "␠" ? " " : ".";
      }
    }
  }
  const parts: (string | number)[] = [prefix];
  const characters = punctuation[encoding];
  let unquote = false;
  for (let index = 0; index < name.length;) {
    const code = name.codePointAt(index)!;
    const rune = String.fromCodePoint(code);
    index += rune.length;
    const quoted = unquote;
    unquote = false;
    if (rune === quote) {
      if (quoted) parts.push(rune);
      else unquote = true;
      continue;
    }
    let raw: string | undefined;
    if (rune === "␀") raw = "\0";
    else if (characters.includes(String.fromCodePoint(Math.max(0, code - fullOffset))))
      raw = String.fromCodePoint(code - fullOffset);
    else if (standard && code > symbolOffset && code <= symbolOffset + 0x1f)
      raw = String.fromCodePoint(code - symbolOffset);
    else if (standard && rune === "␡") raw = "\x7f";
    if (raw !== undefined) {
      parts.push(quoted ? rune : raw);
      continue;
    }
    if (quoted) {
      // InvalidUtf8.Decode consumes two hex bytes after QuoteRune, even when the
      // resulting byte is ASCII. Adjacent bytes may form a valid Unicode rune.
      const hex = rune + (name[index] ?? "");
      if (invalidUtf8 && /^[0-9a-f]{2}$/iu.test(hex)) {
        parts.push(Number.parseInt(hex, 16));
        index++;
        continue;
      }
      parts.push(quote);
    }
    parts.push(rune);
  }
  if (unquote) parts.push(quote);
  parts.push(suffix);
  if (!invalidUtf8) return parts.join("");
  try {
    return utf8.decode(
      Buffer.concat(
        parts.map((part) => (typeof part === "number" ? Buffer.from([part]) : Buffer.from(part))),
      ),
    );
  } catch {
    return undefined;
  }
}

// Drive's default is InvalidUtf8, not Raw: it also decodes NUL pictures and quotes.
// https://github.com/rclone/rclone/blob/v1.75.0/backend/drive/drive.go#L776-L782
/** Null means the decoded name cannot be represented losslessly in a JSON listing. */
export function googleSourceName(nativeName: string): string | null {
  const raw = decode(nativeName, "google");
  return raw === undefined ? null : encode(raw, "standard");
}

/** SharePoint source wrappers retain the existing encoding=Slash behavior. */
export function sharepointSourceName(nativeName: string): string {
  return encode(decode(nativeName, "sharepoint-source")!, "standard");
}

/** FromStandardName = destination.Encode(Standard.Decode(name)), never a path split. */
export function sharepointDestinationName(standardName: string): string {
  return encode(decode(standardName, "standard")!, "sharepoint-destination");
}

/** ToStandardName for destination listings/roots; source wrappers still use Slash. */
export function sharepointDestinationNameToStandard(nativeName: string): string | null {
  const raw = decode(nativeName, "sharepoint-destination");
  return raw === undefined ? null : encode(raw, "standard");
}

/** Drive destination behavior remains its pinned InvalidUtf8 default. */
export function googleDestinationName(standardName: string): string {
  return encode(decode(standardName, "standard")!, "google");
}
