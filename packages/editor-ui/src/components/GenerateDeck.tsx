"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import {
  isWorkspaceError,
  type GenerationStatus,
  type ReviewedGeneration,
  type StoryDecision,
  type StoryOutline,
} from "@deckastra/workspace-contracts";

import { generationRoute } from "../lib/generation-route";

import { Button, Drawer, NumberField, Section, StatusChip, TextField } from "../ui";
import { RepositoryPanel } from "./RepositoryPanel";
import { StoryCheckpoint } from "./StoryCheckpoint";

/**
 * Generate a deck from a prompt, stopping at the outline first when the server
 * can pause a run (editor Phase 6).
 *
 * The checkpoint is here rather than in the editor because it belongs to a deck
 * that does not exist yet: approving the outline is what makes one, and the
 * editor opens on it afterwards.
 *
 * A paused outline outlives this drawer. The server holds the run; this
 * remembers its id per project, in this browser only, so closing the drawer or
 * the app does not lose an outline someone was about to approve. The server is
 * the authority on whether it is still waiting — a remembered id it no longer
 * knows is forgotten, not shown.
 *
 * Two rules from the final package review:
 *
 * - **Only the server saying "no such run" forgets one** (item 03). A 404 is
 *   that answer. Offline, a timeout, a 5xx or an expired session say nothing
 *   about the run, and forgetting on them lost the only way back to an outline
 *   the server was still holding.
 * - **Everything belongs to the project that started it** (item 02). An answer
 *   that arrives after the person moved to another project, or closed the list,
 *   updates that project's remembered run and nothing on screen — it never shows
 *   A's outline under B, and never opens A's finished deck from B.
 */

type Phase =
  | { kind: "form" }
  | { kind: "writing" }
  | { kind: "review"; runId: string; outline: StoryOutline }
  | { kind: "deciding"; runId: string; outline: StoryOutline; decision: StoryDecision["action"] };

const rememberKey = (projectId: string) => `deckastra.pending-outline:${projectId}`;

function remembered(projectId: string): string | null {
  try {
    return localStorage.getItem(rememberKey(projectId));
  } catch {
    return null;
  }
}

function remember(projectId: string, runId: string) {
  try {
    localStorage.setItem(rememberKey(projectId), runId);
  } catch {
    /* A convenience: without storage, a closed drawer just forgets the outline's id. */
  }
}

/**
 * Forget a run, but only if it is still the one remembered. A late answer about
 * run A must not clear run B, started since for the same project.
 */
function forget(projectId: string, runId: string) {
  try {
    if (localStorage.getItem(rememberKey(projectId)) === runId) localStorage.removeItem(rememberKey(projectId));
  } catch {
    /* As above. */
  }
}

const FORM: Phase = { kind: "form" };

/**
 * Which request is the current one, per project — outside the component on
 * purpose (recheck of item 02, 2026-09-20).
 *
 * Closing the drawer and opening it again unmounts and remounts this component,
 * so anything held in it cannot tell an older request from a newer one across
 * that. It could not, and an older generation answering last overwrote the
 * remembered run with its own: on the next open the person was handed the
 * outline they had abandoned, and the newer one they were looking at had no way
 * back. Only the newest request for a project may write that project's pointer.
 */
const issued = new Map<string, number>();

function beginRequest(projectId: string): number {
  const next = (issued.get(projectId) ?? 0) + 1;
  issued.set(projectId, next);
  return next;
}

function isCurrentRequest(projectId: string, request: number): boolean {
  return issued.get(projectId) === request;
}

export function resetGenerationRequestsForTests(): void {
  issued.clear();
}

export function GenerateDeck({
  open = true,
  onClose,
  projectId,
  workspaceId,
  reviewAvailable,
  generation,
  onSetUp,
  onGenerated,
  onBlank,
  blankDisabled = false,
  disabled = false,
  focusToken = 0,
  seed,
  onOpenFile,
}: {
  /** Whether the home is on screen. The prompt bar is always shown there; this is kept for hosts that hide it. */
  open?: boolean;
  /** Put away the drawer of what is happening after Create. */
  onClose: () => void;
  projectId: string;
  workspaceId?: string;
  /** `capabilities.checkpoints`: whether a run here can stop at its outline. */
  reviewAvailable: boolean;
  /**
   * What generation will do here, from `/v1/account` (item 19). Shown before
   * anything starts: who writes the deck, and what leaves this machine.
   */
  generation?: GenerationStatus;
  /** The host's own set-up screen, where it has one (the desktop's Intelligence drawer). */
  onSetUp?: () => void;
  onGenerated: (presentationId: string) => void;
  /** Blank deck, beside Create. Absent: not offered here. */
  onBlank?: () => void;
  blankDisabled?: boolean;
  /** The person cannot create decks in this project (a viewer). */
  disabled?: boolean;
  /** Bumped to put the caret in the prompt (File › Generate, the palette). */
  focusToken?: number;
  /** Words to put in the prompt (the home's command palette), with a token so the same words can be sent twice. */
  seed?: { text: string; token: number };
  /** Open a `.mydeck` file (the host's dialog). Absent: not offered. */
  onOpenFile?: () => void;
}) {
  const client = useWorkspaceClient();
  const instructionId = useId();
  // The phase remembers which project it is for, and a different project reads
  // as the empty form — so B never draws A's outline, not even for one render.
  const [owned, setOwned] = useState<{ projectId: string; phase: Phase }>({ projectId, phase: FORM });
  const phase = owned.projectId === projectId ? owned.phase : FORM;
  const current = useRef(projectId);
  current.current = projectId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** Whether an answer for `origin` may still change what is on screen. */
  const live = (origin: string) => mounted.current && current.current === origin;
  const setPhaseFor = (origin: string, next: Phase) => {
    if (live(origin)) setOwned({ projectId: origin, phase: next });
  };
  // A paused outline that could not be loaded, kept so it can be retried.
  const [unreachable, setUnreachable] = useState<{ projectId: string; runId: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [instruction, setInstruction] = useState("");
  const [audience, setAudience] = useState("");
  const [slideCount, setSlideCount] = useState(6);
  const [review, setReview] = useState(true);
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The drawer of what happens after Create. Put away by the person; an
  // outline still waiting is then offered from the prompt bar instead.
  const [dismissed, setDismissed] = useState(false);
  const prompt = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (focusToken) prompt.current?.focus();
  }, [focusToken]);
  // Filled, never sent: Create is still the person's to press, because it
  // spends credits and starts a run.
  useEffect(() => {
    if (!seed) return;
    setInstruction(seed.text);
    prompt.current?.focus();
  }, [seed]);

  // Another project's draft is not this one's. The phase starts again from the
  // form too: a phase left at "writing" when the person moved away would show
  // "Writing…" forever on the way back, because the answer landed while this
  // project was not on screen. What that answer left behind is the remembered
  // run, which the effect below picks up.
  useEffect(() => {
    setOwned({ projectId, phase: FORM });
    setDismissed(false);
    setError(null);
    setNotice(null);
    setInstruction("");
    setRepositoryIds([]);
  }, [projectId]);

  // Pick up an outline this project was waiting on.
  useEffect(() => {
    if (!open || phase.kind !== "form") return;
    const origin = projectId;
    const runId = remembered(origin);
    if (!runId) return;
    const request = beginRequest(origin);
    let cancelled = false;
    client.generation
      .checkpoint(runId)
      .then((answer) => {
        if (cancelled || !isCurrentRequest(origin, request)) return;
        setUnreachable(null);
        // Shown as soon as it is found: an outline waiting on the person is a
        // decision, and a decision is not hidden behind a chip.
        if (answer.outline) setPhaseFor(origin, { kind: "review", runId, outline: answer.outline });
      })
      .catch((caught: unknown) => {
        if (isWorkspaceError(caught) && caught.status === 404) {
          // The server's answer: decided elsewhere, discarded, or never ours.
          forget(origin, runId);
          if (!cancelled && live(origin)) setUnreachable(null);
          return;
        }
        // Anything else says nothing about the run. Keep it, and say so.
        if (cancelled || !live(origin)) return;
        setUnreachable({
          projectId: origin,
          runId,
          message: caught instanceof Error ? caught.message : "The service did not answer.",
        });
      });
    return () => {
      cancelled = true;
    };
    // `setPhaseFor` and `live` read refs; they are not inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, open, phase.kind, projectId, attempt]);

  /**
   * A run answered. The project's remembered run follows only if this is still
   * that project's current request — an older one answering late must not
   * replace a newer run — and the screen only if the person is still there.
   */
  const settle = (origin: string, request: number, answer: ReviewedGeneration, asked?: string) => {
    const current = isCurrentRequest(origin, request);
    if (answer.status === "awaiting_story" && answer.outline) {
      if (current) remember(origin, answer.run_id);
      setPhaseFor(origin, { kind: "review", runId: answer.run_id, outline: answer.outline });
      return;
    }
    // Forgetting is safe whoever asks: it only removes the run it names.
    forget(origin, asked ?? answer.run_id);
    if (!live(origin) || !current) return;
    if (answer.status === "completed" && answer.generation) {
      setPhaseFor(origin, FORM);
      setInstruction("");
      onGenerated(answer.generation.presentation_id);
      return;
    }
    setPhaseFor(origin, FORM);
    setNotice("The outline was discarded. Nothing was made.");
  };

  const generate = async () => {
    const origin = projectId;
    const request = beginRequest(origin);
    setError(null);
    setNotice(null);
    setPhaseFor(origin, { kind: "writing" });
    setDismissed(false);
    const body = {
      instruction: instruction.trim(),
      audience: audience.trim(),
      slide_count: slideCount,
      repository_ids: repositoryIds,
      project_id: origin,
    };
    try {
      if (reviewAvailable && review) {
        settle(origin, request, await client.generation.review(body));
      } else {
        const made = await client.generation.run(body);
        if (!live(origin) || !isCurrentRequest(origin, request)) return;
        setPhaseFor(origin, FORM);
        setInstruction("");
        onGenerated(made.presentation_id);
      }
    } catch (caught) {
      if (!live(origin)) return;
      setPhaseFor(origin, FORM);
      setError(caught instanceof Error ? caught.message : "The deck could not be generated.");
    }
  };

  const decide = async (decision: StoryDecision) => {
    if (phase.kind !== "review") return;
    const origin = projectId;
    const request = beginRequest(origin);
    const { runId, outline } = phase;
    setError(null);
    setPhaseFor(origin, { kind: "deciding", runId, outline, decision: decision.action });
    try {
      settle(origin, request, await client.generation.decide(runId, decision), runId);
    } catch (caught) {
      // The server puts a run back at its checkpoint when a resume fails, so
      // the outline is still there to decide again.
      if (!live(origin) || !isCurrentRequest(origin, request)) return;
      setPhaseFor(origin, { kind: "review", runId, outline });
      setError(caught instanceof Error ? caught.message : "That decision did not go through.");
    }
  };

  const route = generationRoute(generation);

  const working =
    phase.kind === "writing"
      ? "Writing the outline… With a model on this computer this can take a few minutes."
      : phase.kind === "deciding"
        ? phase.decision === "approve"
          ? "Building the deck from the approved outline…"
          : phase.decision === "revise"
            ? "Rewriting the outline…"
            : "Discarding…"
        : null;
  const afterCreate = phase.kind !== "form";
  const busy = phase.kind === "writing";
  // One deck at a time per project. The prompt bar is always on screen, so
  // without this a second Create while an outline waits would start a new run
  // and silently replace the outline someone had not decided on yet — the
  // project remembers one run (item 02), and the older one would be lost.
  const canCreate = Boolean(instruction.trim()) && !afterCreate && !disabled && route?.available !== false;

  return (
    <>
      {/* The home's prompt bar (roadmap 08 §1.3, concept 08-home.png): the one
          place a new deck starts, generated or blank. What leaves the computer
          is said here, before Create (rule 6). */}
      <section
        className="dk-home-prompt"
        aria-label="Draft a deck"
        data-testid="home-prompt"
        hidden={!open}
        // The home makes room for the drawer while it is open (decks.css), so it
        // never sits over Blank deck or Open .mydeck file.
        data-drawer-open={open && afterCreate && !dismissed ? "" : undefined}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) void generate();
          }}
        >
          <label className="dk-visually-hidden" htmlFor={instructionId}>
            Describe a deck
          </label>
          <textarea
            ref={prompt}
            id={instructionId}
            className="dk-home-prompt__input"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              // Enter creates; Shift+Enter is a new line.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (canCreate) void generate();
              }
            }}
            rows={2}
            placeholder="Describe a deck and we'll draft it…"
            disabled={busy || disabled}
            data-testid="generate-instruction"
          />
          <div className="dk-home-prompt__row">
            {route ? (
              <div className="dk-home-prompt__route" data-testid="generation-route" data-available={route.available}>
                <StatusChip tone={route.tone}>{route.title}</StatusChip>
                <span className="dk-muted">{route.detail}</span>
                {!route.available && route.offerSetUp && onSetUp ? (
                  <Button size="sm" variant="ghost" onClick={onSetUp} data-testid="generation-set-up">
                    Set up
                  </Button>
                ) : null}
              </div>
            ) : (
              <span />
            )}
            <span className="dk-home-prompt__actions">
              <Button
                type="submit"
                variant="primary"
                disabled={!canCreate}
                title={afterCreate ? "Finish the deck already in progress first" : undefined}
                data-testid="generate-submit"
              >
                {busy ? "Writing…" : reviewAvailable && review ? "Create" : "Create deck"}
              </Button>
              {onBlank ? (
                <Button variant="secondary" onClick={onBlank} disabled={blankDisabled || disabled} data-testid="new-deck">
                  Blank deck
                </Button>
              ) : null}
              {onOpenFile ? (
                <Button variant="ghost" icon="upload" onClick={onOpenFile} data-testid="open-deck-file">
                  Open .mydeck file
                </Button>
              ) : null}
            </span>
          </div>
          <details className="dk-home-prompt__options">
            <summary>Options</summary>
            <div className="dk-home-prompt__option-grid">
              <TextField label="Audience" value={audience} onChange={setAudience} disabled={busy} />
              <NumberField
                label="Slides"
                value={slideCount}
                onCommit={setSlideCount}
                min={1}
                max={20}
                integer
                disabled={busy}
              />
            </div>
            {reviewAvailable ? (
              <label className="dk-generate__check">
                <input
                  type="checkbox"
                  checked={review}
                  onChange={(event) => setReview(event.target.checked)}
                  disabled={busy}
                  data-testid="generate-review"
                />
                Show me the outline before the deck is built
              </label>
            ) : null}
            <Section title="Ground in a repository" meta={repositoryIds.length ? `${repositoryIds.length} chosen` : undefined}>
              <RepositoryPanel selected={repositoryIds} onSelectionChange={setRepositoryIds} workspaceId={workspaceId} embedded />
            </Section>
          </details>
        </form>

        {!afterCreate && error ? (
          <p className="dk-generate__error" role="alert">
            {error}
          </p>
        ) : null}
        {!afterCreate && notice ? (
          <p className="dk-muted" role="status">
            {notice}
          </p>
        ) : null}
        {afterCreate ? (
          <div className="dk-home-prompt__waiting" role="status">
            <StatusChip tone="waiting">
              {phase.kind === "review" ? "An outline is waiting for you" : "Working on your deck"}
            </StatusChip>
            <span className="dk-muted">
              {phase.kind === "review" ? "Approve, revise or discard it before starting another." : "One deck at a time."}
            </span>
            {dismissed ? (
              <Button size="sm" variant="secondary" onClick={() => setDismissed(false)} data-testid="outline-waiting">
                {phase.kind === "review" ? "Review" : "Show"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {unreachable && unreachable.projectId === projectId && phase.kind === "form" ? (
          <div className="dk-generate__error" role="alert" data-testid="outline-unreachable">
            <p>
              This project has an outline waiting for your review, and it could not be loaded just now (
              {unreachable.message}). It is still kept.
            </p>
            <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)} data-testid="outline-retry">
              Try again
            </Button>
          </div>
        ) : null}
      </section>

      {/* What happens after Create: progress, then the outline to approve,
          revise or discard (StoryCheckpoint). Not modal, so the decks stay in
          reach while a model writes. */}
      <Drawer
        open={open && afterCreate && !dismissed}
        onClose={() => {
          setDismissed(true);
          onClose();
        }}
        title="Draft a deck"
        modal={false}
        width={420}
        data-testid="generate-drawer"
      >
        <div className="dk-generate">
          {working ? (
            <p className="dk-generate__working" role="status">
              {working}
            </p>
          ) : null}
          {error ? (
            <p className="dk-generate__error" role="alert">
              {error}
            </p>
          ) : null}
          {phase.kind === "review" || phase.kind === "deciding" ? (
            <>
              <StoryCheckpoint outline={phase.outline} busy={phase.kind === "deciding"} onDecide={(d) => void decide(d)} />
              <p className="dk-muted">This outline stays here until you decide, even if you close this panel.</p>
            </>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}
