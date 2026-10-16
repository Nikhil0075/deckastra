import { useEffect, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { WorkspaceUsage } from "@deckastra/workspace-contracts";

import { InlineError, Skeleton } from "../ui/feedback";
import { cx } from "../ui/cx";

/** Bytes in the words a person reads: "840 KB", "12.4 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}

/**
 * How much of the workspace's storage its pictures, clips, sounds and fonts
 * fill (2026-10-17). The service has always counted it and refused an upload
 * past the limit; nothing showed it, so the first a person heard of the limit
 * was an upload being refused. Absent where the service offers no count.
 */
export function StorageUsage({ className }: { className?: string }) {
  const client = useWorkspaceClient();
  const [state, setState] = useState<{ kind: "reading" } | { kind: "ready"; usage: WorkspaceUsage } | { kind: "failed" }>({ kind: "reading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!client.session.usage) return;
    const controller = new AbortController();
    setState({ kind: "reading" });
    client.session
      .usage({ signal: controller.signal })
      .then((usage) => setState({ kind: "ready", usage }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "failed" });
      });
    return () => controller.abort();
  }, [client, attempt]);

  if (!client.session.usage) return null;
  const storage = state.kind === "ready" ? state.usage.storage_bytes : null;
  return (
    <section className={cx("dk-credits", "dk-credits--card", className)} aria-label="Storage" data-testid="storage-usage">
      {state.kind === "reading" ? (
        <Skeleton label="Reading your storage" lines={2} />
      ) : state.kind === "failed" || !storage ? (
        <InlineError onRetry={() => setAttempt((value) => value + 1)}>Storage use could not be read.</InlineError>
      ) : (
        <>
          <p className="dk-credits__line">
            {storage.allowed === null
              ? `${formatBytes(storage.used)} used`
              : `${formatBytes(storage.used)} of ${formatBytes(storage.allowed)} used`}
          </p>
          {storage.allowed !== null ? (
            <span
              className="dk-credits__bar"
              role="meter"
              aria-label="Storage used"
              aria-valuemin={0}
              aria-valuemax={storage.allowed}
              aria-valuenow={storage.used}
            >
              <span
                className={cx("dk-credits__fill", (storage.fraction ?? 0) >= 0.9 && "dk-credits__fill--warn")}
                style={{ width: `${Math.min(100, Math.round((storage.fraction ?? 0) * 100))}%` }}
              />
            </span>
          ) : null}
          <p className="dk-muted">Pictures, clips, sounds and fonts you upload or generate.</p>
        </>
      )}
    </section>
  );
}
