import type { ExportJob } from "@deckastra/workspace-contracts";

/**
 * Hand a finished export to the person. Shared by the export panel and the
 * task centre, so a file downloads the same way from either.
 *
 * Handed over as bytes rather than linked directly: the download endpoint is
 * authenticated and a bare <a href> cannot carry a credential. Resolves false
 * when the file is no longer there, which the caller says in words.
 */
export async function downloadExport(
  exports: { download(jobId: string): Promise<Blob> },
  job: Pick<ExportJob, "id" | "kind" | "filename">,
): Promise<boolean> {
  let bytes: Blob;
  try {
    bytes = await exports.download(job.id);
  } catch {
    return false;
  }
  const url = URL.createObjectURL(bytes);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = job.filename ?? `deck.${job.kind}`;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}
