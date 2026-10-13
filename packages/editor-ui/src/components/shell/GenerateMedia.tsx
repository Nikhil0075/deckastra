import { useEffect, useRef, useState } from "react";
import { useOptionalWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AssistantCapabilities, AssistantRun } from "@deckastra/workspace-contracts";
import type { Slide } from "@deckastra/presentation-schema";
import { mediaSlotBrief, slideMediaSlots } from "@deckastra/presentation-core";

import { serviceWords } from "../../lib/assistant-words";
import { MEDIA_SLOT_LABELS } from "../../lib/media-slot-words";
import { Button, InlineError, Segmented, Skeleton } from "../../ui";

/**
 * Make a picture or a short video clip for this slide (UI audit follow-up,
 * 2026-10-11). Generation existed only as agent tools, so a person could not
 * find it anywhere in the app.
 *
 * The same two steps the agent tools take, in the same order: a price for this
 * exact description, then the job, started only once that price is accepted.
 * What it makes is a change like any other an agent proposes: it waits under
 * Assistant › Waiting for you, where it is approved or declined. When the
 * service cannot generate (nobody signed in, no provider), this says why in
 * words instead of not being there.
 */

type Kind = "image" | "video";

type Phase =
  | { kind: "idle" }
  | { kind: "pricing" }
  | { kind: "priced"; token: string; credits: number }
  | { kind: "running"; runId: string }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

const TERMINAL = new Set<AssistantRun["status"]>(["completed", "failed", "cancelled", "interrupted"]);

export interface GenerateMediaProps {
  presentationId?: string;
  slideId?: string;
  currentVersionId?: () => string;
  saveNow?: () => Promise<boolean>;
  /** The slide pictures are made for, so a picture frame on it can say what it needs (2026-10-13). */
  slide?: Slide;
}

export function GenerateMedia({ presentationId, slideId, currentVersionId, saveNow, slide }: GenerateMediaProps) {
  const client = useOptionalWorkspaceClient();
  const assistant = client?.assistant;
  const [kind, setKind] = useState<Kind>("image");
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState<4 | 6 | 8>(4);
  const [capabilities, setCapabilities] = useState<AssistantCapabilities | null | "failed">(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!assistant || !presentationId) return;
    let current = true;
    assistant
      .capabilities({ presentationId, slideId })
      .then((value) => current && setCapabilities(value))
      .catch(() => current && setCapabilities("failed"));
    return () => {
      current = false;
    };
  }, [assistant, presentationId, slideId]);

  // A price is for one exact description, length and slide; any change asks again.
  useEffect(() => {
    setPhase((current) => (current.kind === "priced" ? { kind: "idle" } : current));
  }, [prompt, seconds, kind, slideId]);

  const ready = Boolean(assistant && presentationId && slideId && currentVersionId);

  if (!ready) {
    return (
      <section className="dk-generate" data-testid="generate-media">
        <h4 className="dk-library__heading">Generate</h4>
        <p className="dk-field__hint">Open a deck to generate pictures and video clips for its slides.</p>
      </section>
    );
  }

  const task = capabilities && capabilities !== "failed" ? capabilities.tasks[kind] : null;
  // The frame a generated picture goes in: the first empty one, else the first.
  const slots = slide ? slideMediaSlots(slide) : [];
  const frame = slots.find((one) => !one.filled) ?? slots[0];
  const brief = frame ? mediaSlotBrief(frame.slot, frame, prompt.length > 0 && prompt.length <= 200 ? prompt : undefined) : undefined;
  const unavailable = task && !task.available;
  const noun = kind === "image" ? "picture" : "video clip";

  const price = async () => {
    setPhase({ kind: "pricing" });
    try {
      if (saveNow && !(await saveNow())) {
        setPhase({ kind: "failed", message: "Save your latest edits, then ask for the price again." });
        return;
      }
      if (kind === "image") {
        const quote = await assistant!.quoteImage(presentationId!, { expected_version_id: currentVersionId!(), slide_id: slideId!, prompt });
        if (live.current) setPhase({ kind: "priced", token: quote.quote_token, credits: quote.credit_cost });
      } else {
        if (!assistant!.quoteVideo) throw new Error("This service cannot make video clips.");
        const quote = await assistant!.quoteVideo(presentationId!, { prompt, duration_seconds: seconds, aspect_ratio: "16:9" });
        if (live.current) setPhase({ kind: "priced", token: quote.quote_token, credits: quote.credit_cost });
      }
    } catch (error) {
      if (live.current) setPhase({ kind: "failed", message: serviceWords(error instanceof Error ? error.message : null, `The ${noun} price could not be checked.`) });
    }
  };

  const generate = async (token: string) => {
    try {
      const run = await assistant!.start({
        task: kind,
        presentation_id: presentationId!,
        expected_version_id: currentVersionId!(),
        operation_key: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        instruction: prompt,
        scope: { kind: "slide", slide_ids: [slideId!], element_ids: [] },
        ...(kind === "image"
          ? { image_quote_token: token }
          : { video_quote_token: token, video_duration_seconds: seconds, video_aspect_ratio: "16:9" as const, video_generate_audio: false as const }),
      });
      if (!live.current) return;
      setPhase({ kind: "running", runId: run.id });
      let current = run;
      while (!TERMINAL.has(current.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!live.current) return;
        current = await assistant!.get(run.id);
      }
      if (!live.current) return;
      if (current.status === "completed") {
        setPrompt("");
        setPhase({ kind: "done", message: `Your ${noun} is ready. Approve it under Assistant › Waiting for you to put it on the slide.` });
      } else {
        setPhase({ kind: "failed", message: serviceWords(current.error, `The ${noun} could not be made.`) });
      }
    } catch (error) {
      if (live.current) setPhase({ kind: "failed", message: serviceWords(error instanceof Error ? error.message : null, `The ${noun} could not be made.`) });
    }
  };

  const busy = phase.kind === "pricing" || phase.kind === "running";
  return (
    <section className="dk-generate" data-testid="generate-media">
      <h4 className="dk-library__heading">Generate</h4>
      <Segmented
        label="What to make"
        size="sm"
        value={kind}
        onChange={setKind}
        items={[
          { value: "image", label: "Picture", "data-testid": "generate-kind-image" },
          { value: "video", label: "Video clip", "data-testid": "generate-kind-video" },
        ]}
      />
      {capabilities === null ? (
        <Skeleton label="Checking what can be generated" lines={2} />
      ) : capabilities === "failed" ? (
        <InlineError>Whether generation is available could not be checked.</InlineError>
      ) : unavailable ? (
        <p className="dk-field__hint" role="status" data-testid="generate-unavailable">
          {serviceWords(task?.reason, `Generating a ${noun} is not available here. Sign in to your Deckastra account to use your credits.`)}
        </p>
      ) : (
        <>
          {kind === "image" && frame && brief ? (
            <div className="dk-generate__slot" data-testid="generate-slot" data-slot-kind={brief.kind}>
              <p className="dk-field__hint">
                This slide has a {MEDIA_SLOT_LABELS[frame.slot.role] ?? "picture"} frame: it needs a {brief.kind}, {brief.aspectRatio}
                {frame.slot.mask ? `, cut to ${frame.slot.mask === "arch" ? "an arch" : `a ${frame.slot.mask}`}` : ""}.
              </p>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setPrompt(brief.prompt.slice(0, 2000))}
                data-testid="generate-use-brief"
              >
                {prompt.trim() ? "Add the frame's brief to my description" : "Use the frame's brief"}
              </Button>
              <ul className="dk-generate__checks" aria-label="Check the picture for">
                {brief.checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <label className="dk-field dk-generate__field">
            <span className="dk-label">Describe the {noun}</span>
            <textarea
              className="dk-input"
              rows={3}
              maxLength={2000}
              value={prompt}
              disabled={busy}
              placeholder={kind === "image" ? "A wind farm at dawn, wide, soft light" : "Slow aerial pass over solar panels at sunrise"}
              onChange={(event) => setPrompt(event.target.value)}
              data-testid="generate-prompt"
            />
          </label>
          {kind === "video" ? (
            <Segmented
              label="Length"
              size="sm"
              value={String(seconds) as "4" | "6" | "8"}
              onChange={(value) => setSeconds(Number(value) as 4 | 6 | 8)}
              items={[
                { value: "4", label: "4 s" },
                { value: "6", label: "6 s" },
                { value: "8", label: "8 s" },
              ]}
            />
          ) : null}
          {phase.kind === "priced" ? (
            <div className="dk-generate__confirm">
              <span data-testid="generate-price">
                {phase.credits} credit{phase.credits === 1 ? "" : "s"} for this {noun}.
              </span>
              <Button size="sm" variant="primary" onClick={() => void generate(phase.token)} data-testid="generate-confirm">
                Generate
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !prompt.trim()}
              onClick={() => void price()}
              data-testid="generate-price-check"
            >
              {phase.kind === "pricing" ? "Checking the price…" : phase.kind === "running" ? `Making the ${noun}…` : "See the price"}
            </Button>
          )}
          <p className="dk-field__hint">Nothing is charged until you press Generate. The {noun} is added for this slide.</p>
        </>
      )}
      {phase.kind === "done" ? (
        <p className="dk-field__hint" role="status" data-testid="generate-done">
          {phase.message}
        </p>
      ) : null}
      {phase.kind === "failed" ? <InlineError data-testid="generate-error">{phase.message}</InlineError> : null}
    </section>
  );
}
