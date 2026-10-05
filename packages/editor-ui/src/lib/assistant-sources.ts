import type { WorkspaceClient } from "@deckastra/workspace-contracts";

/**
 * Files the assistant reads (roadmap 08 §1.4, Assistant › Sources): a PDF, a
 * CSV or plain text, uploaded to the workspace as a document and named on the
 * tasks that use them (`source_asset_ids`). The service reads at most the
 * first twenty pages, or about twelve thousand characters, of each.
 */

export interface AttachedSource {
  id: string;
  name: string;
}

/** The service takes at most ten sources on one request. */
export const MAX_SOURCES = 10;
/** Larger than any of these needs to be for what the service reads of it. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
};

/** The type the service will read, from the name: browsers often report a CSV as nothing at all. */
export function sourceType(file: { name: string }): string | null {
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? (TYPES[extension] ?? null) : null;
}

export type AttachOutcome = { ok: true; source: AttachedSource } | { ok: false; message: string };

export async function attachSource(
  client: WorkspaceClient,
  file: File,
  attached: readonly AttachedSource[],
): Promise<AttachOutcome> {
  const contentType = sourceType(file);
  if (!contentType) return { ok: false, message: `${file.name} is not a PDF, CSV or text file.` };
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, message: `${file.name} is larger than 20 MB.` };
  if (attached.length >= MAX_SOURCES) return { ok: false, message: `Up to ${MAX_SOURCES} files can be attached at once.` };
  try {
    const session = await client.session.ensure();
    const asset = await client.assets.upload(file, { workspaceId: session.workspaceId, kind: "document", contentType });
    return { ok: true, source: { id: asset.id, name: file.name } };
  } catch (error) {
    return { ok: false, message: error instanceof Error && error.message ? error.message : `${file.name} could not be attached.` };
  }
}
