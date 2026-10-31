import type {
  DestinationConstraintRoot,
  DestinationPathFinding,
  FileProviderCapabilities,
} from "./capabilities.ts";
import { sharepointDestinationName, sharepointSourceName } from "./rclone-name-encoding.ts";

/** SharePoint rewrites these document types on upload; differing bytes remain disclosed. */
const rewrittenTypes =
  /\.(pdf|docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm|html?|mhtml?)$/i;
export const sharepointCapabilities: FileProviderCapabilities = {
  id: "sharepoint",
  rcloneBackend: "onedrive",
  rootField: "folderPath",
  creationParent: "siteId",
  // Graph list-create documents no idempotency key; displayName is not a stable URL.
  // https://learn.microsoft.com/en-us/graph/api/list-create
  idempotentCreation: false,
  inheritsSiteAccess: true,
  sourceName: sharepointSourceName,
  destinationName: sharepointDestinationName,
  destinationSiblingKey: (name) => name.toLowerCase(),
  destinationNameFindings: nameFindings,
  destinationPathFindings: pathFindings,
  hashType: "quickxor",
  ignoreSizeAndChecksum: true,
  uploadQuota: false,
  ledgerAccountedUploads: false,
  creatorRole: "owner",
  memberRole(role) {
    switch (role) {
      case "reader":
      case "read":
        return "read";
      case "writer":
      case "write":
        return "write";
      case "manager":
      case "owner":
        return "owner";
      default:
        return undefined;
    }
  },
  rewritesPath: (path) => rewrittenTypes.test(path),
};

// Reserved native names remain source-fix-only even if encoding would disguise them.
// https://support.microsoft.com/en-us/onedrive/restrictions-and-limitations-in-onedrive-and-sharepoint
// Ordinary invalid punctuation is projected using the pinned OneDrive default encoder.
function nameFindings(name: string, kind: "file" | "folder"): DestinationPathFinding[] {
  if (
    name.length === 0 ||
    // A lone UTF-16 surrogate cannot survive the JSON/UTF-8 transfer unchanged.
    !name.isWellFormed()
  )
    return [
      {
        code: "destination_invalid_name",
        message: "SharePoint cannot represent an empty name or malformed Unicode basename.",
      },
    ];
  if (
    /^(?:\.lock|desktop\.ini|con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(name) ||
    /_vti_/iu.test(name) ||
    /^~\$/u.test(name) ||
    (kind === "folder" && /^[\u309b\u1027]/u.test(name))
  )
    return [
      {
        code: "destination_invalid_name",
        message: "This file or folder name is reserved by SharePoint.",
      },
    ];
  return [];
}

function rootPath(root?: DestinationConstraintRoot): string | undefined {
  if (root?.serverRelativePath?.startsWith("/"))
    return root.serverRelativePath.replace(/\/+$/u, "");
  if (!root?.webUrl) return;
  try {
    const url = new URL(root.webUrl);
    if (url.protocol !== "https:" || url.search || url.hash) return;
    return decodeURIComponent(url.pathname).replace(/\/+$/u, "");
  } catch {
    return;
  }
}

function pathFindings(
  path: string,
  kind: "file" | "folder",
  root?: DestinationConstraintRoot,
  options?: { checkPaths?: boolean },
): DestinationPathFinding[] {
  const findings: DestinationPathFinding[] = [];
  if (options?.checkPaths !== false) {
    const prefix = rootPath(root);
    if (prefix === undefined)
      findings.push({
        code: "destination_path_unverified",
        message:
          "The actual destination root URL or decoded server-relative path is unavailable; full SharePoint path length is not proven.",
      });
    else {
      // The service limit is 400 decoded characters, not URL-encoded bytes:
      // https://learn.microsoft.com/en-us/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-limits#file-size-and-file-path-length
      // Count the full server-relative prefix and encoded names, including escape runes.
      const length = prefix.length + (path ? path.length + 1 : 0);
      if (length > 400)
        findings.push({
          code: "destination_path_too_long",
          message: `The decoded server-relative destination path is ${length} characters; SharePoint permits at most 400.`,
        });
    }
  }
  if (!path) return findings;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    findings.push(...nameFindings(segment, index === segments.length - 1 ? kind : "folder"));
    if (index === 0 && /^forms$/iu.test(segment) && (root?.folderDepth ?? 0) === 0)
      findings.push({
        code: "destination_invalid_name",
        message:
          root?.folderDepth === undefined
            ? "Forms is reserved at the library root, and the destination folder depth is unproven."
            : "Forms is reserved at the SharePoint library root.",
      });
  }
  // Do not invent a 255-character cloud segment limit: current Microsoft guidance
  // explicitly allows longer browser-created folders, but desktop sync cannot use them.
  // https://support.microsoft.com/en-us/onedrive/what-are-file-path-length-limits#folders-that-dont-appear-on-your-computer
  return findings;
}
