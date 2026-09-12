"use client";

import { useMemo, type CSSProperties } from "react";
import type { PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { auditAccessibility, readingOrder } from "../lib/accessibility";

export function AccessibilityPanel({
  document,
  slideId,
  onSelect,
}: {
  document: PresentationDocument;
  slideId?: string;
  onSelect: (slideId: string, elementId?: string) => void;
}) {
  const issues = useMemo(() => auditAccessibility(document), [document]);
  const currentSlide = document.slides.find((slide) => slide.id === slideId);
  const order = currentSlide ? readingOrder(currentSlide.elements) : [];

  return (
    <section aria-label="Accessibility review" style={panel}>
      <div style={headingRow}>
        <h3 style={heading}>Accessibility</h3>
        <span aria-label={`${issues.length} accessibility issues`} style={badge}>{issues.length}</span>
      </div>

      {issues.length === 0 ? (
        <p role="status" style={muted}>No automated accessibility issues found.</p>
      ) : (
        <ul style={list}>
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${issue.slideId ?? "deck"}:${issue.elementId ?? index}`}>
              <button
                type="button"
                style={issueButton}
                onClick={() => issue.slideId && onSelect(issue.slideId, issue.elementId)}
                disabled={!issue.slideId}
              >
                <span style={{ color: "var(--danger)" }}>Error</span>
                <span>{issue.message}</span>
                <span style={muted}>{issue.fix}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {currentSlide ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", color: "var(--fg-muted)" }}>
            Reading order · {order.length} objects
          </summary>
          {order.length ? (
            <ol aria-label="Current slide reading order" style={{ ...list, marginTop: 6 }}>
              {order.map((element) => (
                <li key={element.id}>
                  <button type="button" style={orderButton} onClick={() => onSelect(currentSlide.id, element.id)}>
                    {labelFor(element)}
                  </button>
                </li>
              ))}
            </ol>
          ) : <p style={muted}>This slide has no meaningful objects.</p>}
        </details>
      ) : null}
    </section>
  );
}

function labelFor(element: PresentationElement): string {
  return element.name?.trim() || `${element.type} ${element.id.slice(3, 11)}`;
}

const panel: CSSProperties = { borderTop: "1px solid var(--border)", padding: "14px 16px" };
const headingRow: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const heading: CSSProperties = { fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--fg-subtle)", margin: 0 };
const badge: CSSProperties = { minWidth: 22, padding: "1px 6px", borderRadius: 999, background: "var(--surface-alt)", color: "var(--fg-muted)", textAlign: "center", fontSize: 11 };
const list: CSSProperties = { listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 5 };
const issueButton: CSSProperties = { width: "100%", display: "grid", gap: 3, textAlign: "left", border: "1px solid var(--border)", borderRadius: 6, padding: 7, background: "var(--surface-alt)", color: "var(--fg-muted)", fontSize: 11 };
const orderButton: CSSProperties = { width: "100%", textAlign: "left", border: 0, borderRadius: 5, padding: "4px 7px", background: "transparent", color: "var(--fg-muted)", fontSize: 11 };
const muted: CSSProperties = { color: "var(--fg-subtle)", fontSize: 11, margin: "6px 0 0" };
