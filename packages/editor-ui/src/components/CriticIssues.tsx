"use client";

/** Persisted review findings remain visible after reload and export/import. */
export function CriticIssues({ value, slideId }: { value: unknown; slideId?: string }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const groups = Object.entries(value).filter(([key]) => key === "" || key === slideId);
  const issues = groups.flatMap(([key, entries]) =>
    Array.isArray(entries) ? entries.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const issue = entry as Record<string, unknown>;
      if (typeof issue.message !== "string") return [];
      return [{ scope: key ? "This slide" : "Whole deck", message: issue.message,
        fix: typeof issue.suggested_fix === "string" ? issue.suggested_fix : "" }];
    }) : [],
  );
  if (!issues.length) return null;
  return (
    <section aria-label="Unresolved review issues" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 13 }}>Review before presenting</h3>
      <ul style={{ paddingLeft: 18, fontSize: 12 }}>
        {issues.map((issue, index) => (
          <li key={index} style={{ marginBottom: 8 }}>
            <strong>{issue.scope}: </strong>{issue.message}
            {issue.fix ? <div>{issue.fix}</div> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
