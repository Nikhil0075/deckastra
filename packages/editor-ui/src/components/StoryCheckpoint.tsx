"use client";

import { useId, useState } from "react";
import type { StoryDecision, StoryOutline } from "@deckastra/workspace-contracts";

import { Button, StatusChip } from "../ui";

/**
 * The story checkpoint (doc 03 §17; Figma frame "previewing a proposal as an
 * image", the PAUSED card).
 *
 * A generation stopped here before anything was laid out: the person reads the
 * narrative and says go, or says what to change. The outline is words only —
 * headlines, key messages and which layout each slide asked for — because
 * geometry does not exist yet, and pretending it did would ask for a judgement
 * about something the composer has not decided.
 *
 * Presentational: deciding is the caller's, through the one route that resumes
 * a run. Revise needs a note, because a revision with nothing said about what
 * was wrong asks the model to guess, and it will guess the same outline.
 */
export function StoryCheckpoint({
  outline,
  busy,
  onDecide,
}: {
  outline: StoryOutline;
  /** A decision is running; nothing else can be decided until it answers. */
  busy: boolean;
  onDecide: (decision: StoryDecision) => void;
}) {
  const [note, setNote] = useState("");
  const noteId = useId();
  const canRevise = note.trim().length > 0;

  return (
    <article className="dk-checkpoint" data-testid="story-checkpoint" aria-label="Story checkpoint">
      <header className="dk-checkpoint__head">
        <span className="dk-label">Story checkpoint</span>
        <StatusChip tone="waiting">Paused</StatusChip>
      </header>
      <h3 className="dk-checkpoint__title">{outline.title || "Untitled deck"}</h3>
      {outline.narrative_arc ? <p className="dk-checkpoint__arc">{outline.narrative_arc}</p> : null}

      <ol className="dk-checkpoint__slides">
        {outline.slides.map((slide, index) => (
          <li key={index} className="dk-checkpoint__slide">
            <span className="dk-checkpoint__number" aria-hidden="true">
              {index + 1}
            </span>
            <span className="dk-checkpoint__text">
              <span className="dk-checkpoint__headline">{slide.headline}</span>
              {slide.key_message && slide.key_message !== slide.headline ? (
                <span className="dk-checkpoint__message">{slide.key_message}</span>
              ) : null}
            </span>
            {slide.layout ? <span className="dk-checkpoint__layout">{slide.layout}</span> : null}
          </li>
        ))}
      </ol>

      {outline.warnings.length ? (
        <ul className="dk-checkpoint__warnings">
          {outline.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <label className="dk-label" htmlFor={noteId}>
        What to change
      </label>
      <textarea
        id={noteId}
        className="dk-notes__input"
        value={note}
        placeholder="For example: open with the cost of doing nothing, and merge slides 3 and 4."
        onChange={(event) => setNote(event.target.value)}
        disabled={busy}
        data-testid="checkpoint-note"
      />

      <div className="dk-checkpoint__actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide({ action: "reject" })}
          data-testid="checkpoint-discard"
        >
          Discard
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !canRevise}
          title={canRevise ? undefined : "Say what to change first."}
          onClick={() => onDecide({ action: "revise", note: note.trim() })}
          data-testid="checkpoint-revise"
        >
          Revise
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => onDecide({ action: "approve" })}
          data-testid="checkpoint-approve"
        >
          Approve
        </Button>
      </div>
    </article>
  );
}
