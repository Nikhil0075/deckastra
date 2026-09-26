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
    <section aria-label="Unresolved review issues" className="dk-critic">
      <h3 className="dk-critic__title">Review before presenting</h3>
      <ul className="dk-critic__list">
        {issues.map((issue, index) => (
          <li key={index} className="dk-critic__item">
            <strong>{issue.scope}: </strong>{issue.message}
            {issue.fix ? <div className="dk-muted">{issue.fix}</div> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
