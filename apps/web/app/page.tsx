"use client";

import { useEffect, useMemo, useState } from "react";
import { buildDocumentScene, type DocumentScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { PresentMode } from "../components/PresentMode";
import { getSession } from "../lib/session";

/**
 * Phase 1 shell: prompt in, deck out, present.
 *
 * Deliberately plain. The editor is Phase 3, and building chrome around a
 * document model that cannot yet be edited would be scaffolding for its own sake.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Diagnostics {
  source: "model" | "stub";
  model: string;
  attempts: number;
  plan_valid_first_attempt: boolean;
  validation_errors: string[];
  warnings: string[];
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

type Status =
  | { phase: "idle" }
  | { phase: "generating" }
  | { phase: "ready"; document: PresentationDocument; diagnostics: Diagnostics }
  | { phase: "error"; message: string };

const EXAMPLES = [
  "Explain how a payments reconciliation service works, for engineers joining the team",
  "Make the case for replacing our nightly batch job with a streaming pipeline",
  "Introduce our design system to a new product team",
];

export default function Home() {
  const [instruction, setInstruction] = useState("");
  const [audience, setAudience] = useState("");
  const [slideCount, setSlideCount] = useState(5);
  const [status, setStatus] = useState<Status>({ phase: "idle" });
  const [presenting, setPresenting] = useState(false);
  const [generationMode, setGenerationMode] = useState<"model" | "stub" | null>(null);
  const [presentationId, setPresentationId] = useState<string | null>(null);

  // Ask the API up front whether it has a key, so the user learns their deck will
  // be stub-composed *before* they wait for it rather than after.
  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then((d) => setGenerationMode(d.generation))
      .catch(() => setGenerationMode(null));
  }, []);

  const scene: DocumentScene | null = useMemo(() => {
    if (status.phase !== "ready") return null;
    return buildDocumentScene(status.document);
  }, [status]);

  async function generate() {
    setStatus({ phase: "generating" });
    try {
      const { token } = await getSession();

      const response = await fetch(`${API}/v1/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          instruction,
          audience,
          slide_count: slideCount,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = body.detail;
        throw new Error(
          typeof detail === "string"
            ? detail
            : (detail?.message ?? `Request failed (${response.status})`),
        );
      }

      const body = await response.json();
      setPresentationId(body.presentation_id);
      setStatus({ phase: "ready", document: body.document, diagnostics: body.diagnostics });
    } catch (error) {
      setStatus({
        phase: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not reach the API. Is it running on port 8000?",
      });
    }
  }

  if (presenting && scene) {
    return <PresentMode scene={scene} onExit={() => setPresenting(false)} />;
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "48px 24px 96px" }}>
      <header style={{ marginBottom: 40 }}>
        <div
          style={{
            fontSize: 12,
            letterSpacing: 3,
            color: "var(--accent)",
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Deckastra · Phase 1
        </div>
        <h1 style={{ fontSize: 44, margin: "0 0 10px", letterSpacing: -1 }}>
          Turn an idea into a deck
        </h1>
        <p style={{ color: "var(--fg-muted)", margin: 0, fontSize: 17, maxWidth: 640 }}>
          A model writes the narrative and picks a layout. Deterministic code places
          every object. Everything you see is a real editable element, not an image.
        </p>
      </header>

      {generationMode === "stub" ? (
        <div style={noticeStyle}>
          <strong>No API key configured.</strong> Decks will be composed by the
          deterministic stub planner with placeholder copy. Set{" "}
          <code>ANTHROPIC_API_KEY</code> and restart the API for real generation.
        </div>
      ) : null}

      <section style={cardStyle}>
        <label style={labelStyle} htmlFor="instruction">
          What should the deck be about?
        </label>
        <textarea
          id="instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={4}
          placeholder="Explain how our payments reconciliation service works…"
          style={inputStyle}
        />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 20px" }}>
          {EXAMPLES.map((example) => (
            <button key={example} onClick={() => setInstruction(example)} style={exampleStyle}>
              {example.length > 52 ? `${example.slice(0, 52)}…` : example}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 320px" }}>
            <label style={labelStyle} htmlFor="audience">
              Audience <span style={{ opacity: 0.5 }}>(optional)</span>
            </label>
            <input
              id="audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="Engineers joining the team"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle} htmlFor="count">
              Slides
            </label>
            <select
              id="count"
              value={slideCount}
              onChange={(e) => setSlideCount(Number(e.target.value))}
              style={{ ...inputStyle, width: 90 }}
            >
              {[3, 5, 7, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => void generate()}
            disabled={!instruction.trim() || status.phase === "generating"}
            style={primaryButtonStyle}
          >
            {status.phase === "generating" ? "Generating…" : "Generate deck"}
          </button>
        </div>
      </section>

      {status.phase === "generating" ? (
        <p style={{ color: "var(--fg-muted)", marginTop: 28 }}>
          Designing the narrative, then composing slides…
        </p>
      ) : null}

      {status.phase === "error" ? (
        <div style={{ ...noticeStyle, borderColor: "var(--danger)", marginTop: 28 }}>
          <strong>Generation failed.</strong>
          <div style={{ marginTop: 6, color: "var(--fg-muted)" }}>{status.message}</div>
        </div>
      ) : null}

      {status.phase === "ready" && scene ? (
        <Deck
          scene={scene}
          diagnostics={status.diagnostics}
          onPresent={() => setPresenting(true)}
          onEdit={presentationId ? () => { window.location.href = `/edit/${presentationId}`; } : undefined}
        />
      ) : null}
    </main>
  );
}

function Deck({
  scene,
  diagnostics,
  onPresent,
  onEdit,
}: {
  scene: DocumentScene;
  diagnostics: Diagnostics;
  onPresent: () => void;
  onEdit?: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const current = scene.slides[selected];

  return (
    <section style={{ marginTop: 44 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 16,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 26 }}>{scene.title}</h2>
          <div style={{ color: "var(--fg-subtle)", fontSize: 14 }}>
            {scene.slides.length} slides · {scene.viewport.width}×{scene.viewport.height}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {onEdit ? (
            <button onClick={onEdit} style={secondaryButtonStyle}>
              Edit
            </button>
          ) : null}
          <button onClick={onPresent} style={primaryButtonStyle}>
            Present
          </button>
        </div>
      </div>

      {current ? (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 12,
            overflow: "hidden",
            background: "#000",
          }}
        >
          <ScaledSlide scene={current} width={1040} mode="present" />
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "18px 0" }}>
        {scene.slides.map((slide, i) => (
          <button
            key={slide.slideId}
            onClick={() => setSelected(i)}
            title={slide.keyMessage}
            style={{
              flex: "0 0 auto",
              padding: 0,
              border: `2px solid ${i === selected ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8,
              overflow: "hidden",
              background: "#000",
              lineHeight: 0,
            }}
          >
            <ScaledSlide scene={slide} width={168} mode="present" />
          </button>
        ))}
      </div>

      <details style={{ marginTop: 20, color: "var(--fg-muted)", fontSize: 14 }}>
        <summary style={{ cursor: "pointer", color: "var(--fg-subtle)" }}>
          Generation diagnostics
        </summary>
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 20px", marginTop: 12 }}>
          <dt>Source</dt>
          <dd style={{ margin: 0 }}>
            {diagnostics.source === "model" ? diagnostics.model : "deterministic stub"}
          </dd>
          <dt>Attempts</dt>
          <dd style={{ margin: 0 }}>
            {diagnostics.attempts}
            {diagnostics.source === "model"
              ? diagnostics.plan_valid_first_attempt
                ? " (valid on first attempt)"
                : " (first attempt failed validation)"
              : ""}
          </dd>
          {diagnostics.source === "model" ? (
            <>
              <dt>Tokens</dt>
              <dd style={{ margin: 0 }}>
                {diagnostics.input_tokens} in · {diagnostics.output_tokens} out
              </dd>
              <dt>Duration</dt>
              <dd style={{ margin: 0 }}>{(diagnostics.duration_ms / 1000).toFixed(1)}s</dd>
            </>
          ) : null}
        </dl>
        {diagnostics.warnings.map((warning) => (
          <p key={warning} style={{ color: "var(--warning)", marginTop: 10 }}>
            {warning}
          </p>
        ))}
      </details>
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 24,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  color: "var(--fg-muted)",
  marginBottom: 8,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface-alt)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "12px 14px",
  fontSize: 15,
  resize: "vertical",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-fg)",
  border: "none",
  borderRadius: 10,
  padding: "13px 24px",
  fontSize: 15,
  fontWeight: 600,
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "var(--surface-alt)",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "13px 22px",
  fontSize: 15,
  fontWeight: 600,
};

const exampleStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--fg-muted)",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 13,
};

const noticeStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderLeft: "3px solid var(--warning)",
  borderRadius: 10,
  padding: "14px 18px",
  marginBottom: 24,
  fontSize: 14,
};
