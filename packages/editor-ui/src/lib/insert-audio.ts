import type { AssetReference } from "@deckastra/presentation-schema";
import type { UploadedAsset, WorkspaceClient } from "@deckastra/workspace-contracts";

import type { MeasuredAudio } from "./recorder";

/**
 * Put a recording or a sound file in the workspace (integration plan 01 §3.5).
 * The service measures the file itself where it can read the container; the
 * browser's measurement travels only as the fallback for one it cannot.
 */
export async function uploadAudio(
  client: Pick<WorkspaceClient, "assets" | "session">,
  measured: MeasuredAudio,
): Promise<UploadedAsset> {
  const session = await client.session.ensure();
  return client.assets.upload(measured.file, {
    workspaceId: session.workspaceId,
    kind: "audio",
    contentType: measured.file.type || "audio/wav",
    durationMs: measured.durationMs,
    waveformPeaks: measured.peaks,
  });
}

/** The manifest entry a document cites an uploaded audio file by. */
export function audioAssetReference(uploaded: UploadedAsset, measured?: MeasuredAudio): AssetReference {
  return {
    id: uploaded.id,
    type: "audio",
    storageKey: uploaded.storage_key,
    ...(uploaded.filename ? { fileName: uploaded.filename } : {}),
    ...(uploaded.content_type ? { mimeType: uploaded.content_type } : {}),
    byteSize: uploaded.bytes,
    durationMs: uploaded.duration_ms ?? measured?.durationMs ?? 0,
    createdBy: "upload",
  };
}
