import { googleCredentialAdapter } from "./google.ts";
import { sharepointCredentialAdapter } from "./sharepoint.ts";

export const credentialAdapters = {
  sharepoint: sharepointCredentialAdapter,
  google_shared_drive: googleCredentialAdapter,
};

export const credentialBindings = Object.values(credentialAdapters).flatMap(
  (adapter) => adapter.bindings,
);
