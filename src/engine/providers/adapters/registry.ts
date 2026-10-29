import { GoogleAdapter } from "./google.ts";
import { SharePointAdapter } from "./sharepoint.ts";
import { fileProviderPair } from "./capabilities.ts";
import type { AdapterInput, FileAdapter } from "./effects.ts";

/** The registry is the only effect-composition code that names concrete providers. */
export function createFileAdapters(
  config: unknown,
  input: AdapterInput,
): {
  source: FileAdapter;
  destination: FileAdapter;
} {
  const pair = fileProviderPair(config);
  const adapters: Record<string, FileAdapter> = {
    sharepoint: new SharePointAdapter(input),
    google_shared_drive: new GoogleAdapter(input),
  };
  return { source: adapters[pair.source.id]!, destination: adapters[pair.destination.id]! };
}
