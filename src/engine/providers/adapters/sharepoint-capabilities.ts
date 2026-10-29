import type { FileProviderCapabilities } from "./capabilities.ts";

/** SharePoint rewrites these document types on upload; differing bytes remain disclosed. */
const rewrittenTypes =
  /\.(pdf|docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm|html?|mhtml?)$/i;
export const sharepointCapabilities: FileProviderCapabilities = {
  id: "sharepoint",
  rcloneBackend: "onedrive",
  rootField: "folderPath",
  hashType: "quickxor",
  ignoreSizeAndChecksum: true,
  uploadQuota: false,
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
