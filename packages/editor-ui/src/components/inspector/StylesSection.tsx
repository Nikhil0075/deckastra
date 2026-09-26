import { useState } from "react";
import type { PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";

import {
  applyStyleOperations,
  deleteStyleOperations,
  detachOperations,
  drifted,
  objectStyles,
  renameStyleOperations,
  saveStyleOperations,
  styleNameProblem,
  updateStyleOperations,
} from "../../lib/object-styles";
import { Button, IconButton, Section, Select, StatusChip, TextField } from "../../ui";
import { Hint } from "./controls";

type Edit = (operations: PatchOperation[], label: string) => void;

/**
 * Styles for the selection (design review, 2026-09-27): which style it follows,
 * whether it has drifted from it, and save, apply, update and detach. The
 * first selected object is the one a style is taken from.
 */
export function StylesSection({ document, elements, edit }: { document: PresentationDocument; elements: readonly PresentationElement[]; edit: Edit }) {
  const [naming, setNaming] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const styles = objectStyles(document);
  const first = elements[0];
  if (!first) return null;
  const refs = new Set(elements.map((element) => element.styleRef ?? ""));
  const shared = refs.size === 1 ? first.styleRef : undefined;
  const changed = elements.filter((element) => drifted(document, element)).length;
  const n = elements.length;

  const save = () => {
    const name = naming ?? "";
    const why = styleNameProblem(document, name);
    if (why) {
      setProblem(why);
      return;
    }
    edit(saveStyleOperations(document, name, first, elements), `Save style "${name.trim()}"`);
    setNaming(undefined);
    setProblem(undefined);
  };

  return (
    <Section title="Object style" meta={shared ?? (refs.size > 1 ? "Mixed" : undefined)} defaultOpen={Boolean(shared) || styles.length > 0}>
      {shared ? (
        <div className="dk-styles__current">
          <StatusChip tone="action">{shared}</StatusChip>
          {changed ? <span className="dk-muted">{n === 1 ? "Changed since applied" : `${changed} changed since applied`}</span> : null}
        </div>
      ) : null}

      {styles.length ? (
        <Select
          label="Apply a style"
          value={shared ?? ""}
          data-testid="style-apply"
          options={[
            ...(shared ? [] : [{ value: "", label: refs.size > 1 ? "Mixed" : "None" }]),
            ...styles.map((entry) => ({ value: entry.name, label: `${entry.name}${entry.uses ? ` · ${entry.uses}` : ""}` })),
          ]}
          onChange={(name) => {
            if (!name) return;
            edit(applyStyleOperations(document, name, elements), n > 1 ? `Apply "${name}" to ${n} objects` : `Apply "${name}"`);
          }}
        />
      ) : (
        <Hint>Save how this looks as a style, then apply it to other objects in one click.</Hint>
      )}

      <div className="dk-styles__actions">
        {shared && changed ? (
          <Button size="sm" onClick={() => edit(updateStyleOperations(document, shared, first), `Update style "${shared}"`)} data-testid="style-update" title="Every object using this style takes this look">
            Update style
          </Button>
        ) : null}
        {shared && changed ? (
          <Button size="sm" onClick={() => edit(applyStyleOperations(document, shared, elements), `Reset to "${shared}"`)}>
            Reset
          </Button>
        ) : null}
        {[...refs].some(Boolean) ? (
          <Button size="sm" onClick={() => edit(detachOperations(document, elements), "Detach from style")} data-testid="style-detach">
            Detach
          </Button>
        ) : null}
        {naming === undefined ? (
          <Button size="sm" icon="plus" onClick={() => setNaming("")} data-testid="style-save-open">
            Save as style…
          </Button>
        ) : null}
      </div>

      {naming !== undefined ? (
        <div className="dk-styles__save">
          <TextField
            label="Style name"
            value={naming}
            placeholder="Metric card"
            error={problem}
            data-testid="style-name"
            onChange={(value) => {
              setNaming(value);
              setProblem(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
            }}
          />
          <div className="dk-styles__actions">
            <Button size="sm" variant="primary" onClick={save} data-testid="style-save">
              Save
            </Button>
            <Button size="sm" onClick={() => setNaming(undefined)}>
              Cancel
            </Button>
          </div>
          <Hint>Taken from {n > 1 ? "the first selected object" : "this object"}: fill, outline, corners, shadow, blur, text and opacity.</Hint>
        </div>
      ) : null}
    </Section>
  );
}

/** The deck's styles, for renaming and deleting, under Slide design. */
export function ThemeStylesSection({ document, edit }: { document: PresentationDocument; edit: Edit }) {
  const styles = objectStyles(document);
  const [renaming, setRenaming] = useState<{ name: string; draft: string; problem?: string } | undefined>();
  if (styles.length === 0) return null;
  return (
    <Section title="Styles" meta={`${styles.length}`}>
      <ul className="dk-a11y__list" aria-label="Object styles">
        {styles.map((entry) => (
          <li key={entry.name} className="dk-styles__row">
            {renaming?.name === entry.name ? (
              <span className="dk-styles__rename">
                <TextField
                  label={`Name of ${entry.name}`}
                  hideLabel
                  value={renaming.draft}
                  error={renaming.problem}
                  onChange={(draft) => setRenaming({ name: entry.name, draft })}
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const why = styleNameProblem(document, renaming.draft, entry.name);
                    if (why) return setRenaming({ ...renaming, problem: why });
                    edit(renameStyleOperations(document, entry.name, renaming.draft), `Rename style "${entry.name}"`);
                    setRenaming(undefined);
                  }}
                >
                  Rename
                </Button>
              </span>
            ) : (
              <>
                <span className="dk-styles__name">{entry.name}</span>
                <span className="dk-muted">{entry.uses === 1 ? "1 object" : `${entry.uses} objects`}</span>
                <Button size="sm" aria-label={`Rename ${entry.name}`} onClick={() => setRenaming({ name: entry.name, draft: entry.name })}>
                  Rename
                </Button>
                <IconButton
                  icon="trash"
                  label={`Delete ${entry.name}`}
                  size="sm"
                  onClick={() => edit(deleteStyleOperations(document, entry.name), `Delete style "${entry.name}"`)}
                />
              </>
            )}
          </li>
        ))}
      </ul>
      <Hint>Deleting a style keeps how its objects look.</Hint>
    </Section>
  );
}
