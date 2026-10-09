import { useEffect, useMemo, useState } from "react";
import { NAMED_EASING_VALUES, type PatchOperation } from "@deckastra/presentation-schema";
import type { buildDocumentScene } from "@deckastra/renderer";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { MotionCapabilities, MotionStyleId, PresetCatalog } from "@deckastra/workspace-contracts";

import { budgetLine, carryableRoles, measurePlan, planFingerprint, slideRoles, type MeasuredPlan } from "../../lib/motion-plan";
import {
  DIRECTIONS,
  EDITABLE_KINDS,
  TRANSITION_MS,
  addPair,
  pairCandidates,
  pairRows,
  removeBrokenPairs,
  removePair,
  setTransitionDirection,
  setTransitionDuration,
  setTransitionEasing,
  setTransitionKind,
  transitionState,
  type EditableKind,
  type TransitionChange,
} from "../../lib/transition-editing";
import type { EditorApi } from "../../lib/useEditor";
import { Button, IconButton, NumberField, Section, Segmented, Select, StatusChip } from "../../ui";
import { PairPreview } from "./PairPreview";
import { TransitionPreview } from "./TransitionPreview";

const KIND_LABEL: Record<EditableKind, string> = {
  cut: "Cut", fade: "Fade", slide: "Slide", cover: "Cover", push: "Push", zoom: "Zoom",
  wipe: "Wipe", split: "Split", iris: "Iris", flip: "Flip", blurDissolve: "Blur dissolve", morph: "Morph",
};
const PACING = ["tight", "measured", "deliberate"] as const;
type Pacing = (typeof PACING)[number];
const PLAN_KINDS = ["fade", "slide", "cover", "push", "zoom", "wipe", "split", "iris", "flip", "blurDissolve", "morph", "cut"] as const;
type PlanKind = (typeof PLAN_KINDS)[number];

/**
 * Motion mode's right panel (Figma frame "agent-planned motion").
 *
 * Two halves. **Transition** edits how the deck moves into this slide: kind,
 * duration, easing, direction and a morph's shared elements, each an ordinary
 * undoable patch. **Plan by roles** asks the product's own motion planner — the
 * one agents use — for a plan in roles and a word of pacing, shows it measured
 * against the entrance budget, and applies it only when the person says so, as
 * their own edit. The timeline stays in the dock under the canvas.
 */
export function MotionModePanel({
  editor,
  presentationId,
  scene,
  resolveAssetUrl,
  embedded = false,
}: {
  editor: EditorApi;
  presentationId: string;
  scene: ReturnType<typeof buildDocumentScene>;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** Host extensions can append the established controls inside their panel. */
  embedded?: boolean;
}) {
  const slide = editor.document.slides[editor.slideIndex];
  if (!slide) return null;
  return (
    <div className={embedded ? "dk-motion-legacy" : "dk-modepanel"} data-testid="motion-panel">
      <Section title={`Transition into slide ${editor.slideIndex + 1}`} defaultOpen>
        <TransitionEditor key={slide.id} editor={editor} scene={scene} resolveAssetUrl={resolveAssetUrl} />
      </Section>
      <Section title="Preview transition" defaultOpen>
        <TransitionPreview scene={scene} slideIndex={editor.slideIndex} resolveAssetUrl={resolveAssetUrl} />
      </Section>
      <Section title="Plan by roles" defaultOpen>
        <RolePlanner key={slide.id} editor={editor} presentationId={presentationId} />
      </Section>
      <Section title="Motion style" defaultOpen>
        <MotionStylePicker editor={editor} presentationId={presentationId} />
      </Section>
    </div>
  );
}

function MotionStylePicker({ editor, presentationId }: { editor: EditorApi; presentationId: string }) {
  const client = useWorkspaceClient();
  const [catalog, setCatalog] = useState<PresetCatalog | null>(null);
  const [style, setStyle] = useState<MotionStyleId>("restrained");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.presets.list()
      .then((answer) => {
        if (!live || !answer?.motionStyles || !Object.keys(answer.motionStyles).length) return;
        setCatalog(answer);
        const stored = editor.document.metadata.motionStyle;
        if (typeof stored === "string" && stored in answer.motionStyles) setStyle(stored as MotionStyleId);
      })
      .catch((error) => { if (live) setNotice(error instanceof Error ? error.message : "Motion styles could not be loaded."); });
    return () => { live = false; };
  }, [client, editor.document.metadata.motionStyle]);

  const applyStyle = async () => {
    setNotice(null);
    if (!(await editor.saveNow())) {
      setNotice("Save your current edits, then apply the style again.");
      return;
    }
    setBusy(true);
    try {
      const answer = await client.motion.proposeStyle(presentationId, {
        expected_version_id: editor.currentVersionId(),
        style,
        intent: `Apply ${catalog?.motionStyles[style]?.name ?? style} motion style`,
        client_label: "editor",
        dry_run: true,
      });
      if (!answer.operations?.length) {
        setNotice(answer.outcome === "none" ? "That motion style is already applied." : "Nothing changed.");
        return;
      }
      editor.apply(answer.operations, { label: `Motion style: ${catalog?.motionStyles[style]?.name ?? style}` });
      setNotice(`Applied to ${answer.slides_changed} slide${answer.slides_changed === 1 ? "" : "s"}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That motion style could not be applied.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dk-motion">
      <Select
        label="Style"
        value={style}
        options={catalog ? Object.entries(catalog.motionStyles).map(([value, item]) => ({ value, label: item.name })) : [{ value: style, label: "Loading…" }]}
        onChange={(value) => setStyle(value as MotionStyleId)}
        data-testid="motion-style-select"
      />
      {catalog ? <p className="dk-muted">{catalog.motionStyles[style].summary}</p> : null}
      <Button variant="secondary" size="sm" disabled={!catalog || busy} onClick={() => void applyStyle()} data-testid="motion-style-apply">
        {busy ? "Applying…" : "Apply to deck"}
      </Button>
      {notice ? <p className="dk-muted" role="status">{notice}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------ transition

function TransitionEditor({
  editor,
  scene,
  resolveAssetUrl,
}: {
  editor: EditorApi;
  scene: ReturnType<typeof buildDocumentScene>;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}) {
  const document = editor.document;
  const index = editor.slideIndex;
  const slide = document.slides[index]!;
  const first = index === 0;
  const state = transitionState(slide);
  const transition = state.transition;
  const [notice, setNotice] = useState<string | null>(null);
  const [pickSource, setPickSource] = useState("");
  const [pickDestination, setPickDestination] = useState("");
  // The pair being looked at, drawn in the preview (MA-27). Hovering or
  // focusing a row shows that pair; otherwise the "Add pair" picks.
  const [looking, setLooking] = useState<{ sourceId: string; destinationId: string } | null>(null);

  const run = (change: TransitionChange, label: string) => {
    setNotice(change.notice ?? null);
    if (change.operations.length) editor.apply(change.operations, { label });
  };

  const rows = useMemo(
    () =>
      state.kind === "morph"
        ? pairRows(document, slide.id, { from: scene.slides[index - 1], to: scene.slides[index] })
        : [],
    [document, slide.id, scene, index, state.kind],
  );
  const candidates = useMemo(
    () => (state.kind === "morph" && !first ? pairCandidates(document, slide.id) : { sources: [], destinations: [] }),
    [document, slide.id, state.kind, first],
  );

  return (
    <div className="dk-motion">
      {state.foreign ? (
        <p className="dk-muted">
          This slide enters by <StatusChip tone="neutral">{state.foreign}</StatusChip>, which this panel does not edit.
          Choosing a kind below replaces it.
        </p>
      ) : null}
      <Segmented
        label="Transition"
        value={(state.kind ?? "") as EditableKind}
        items={EDITABLE_KINDS.map((kind) => ({
          value: kind,
          label: KIND_LABEL[kind],
          // A morph carries objects from the slide before; the first has none.
          disabled: kind === "morph" && first,
          "data-testid": `transition-kind-${kind}`,
        }))}
        onChange={(kind) => run(setTransitionKind(document, slide.id, kind), `Transition: ${KIND_LABEL[kind]}`)}
        size="sm"
      />
      {first ? (
        <p className="dk-muted" data-testid="first-slide-note">
          Slide 1 is where the talk starts, so there is no slide before it to move from. Morph is unavailable here; a
          fade or slide plays as the deck opens.
        </p>
      ) : null}

      {transition && state.kind && state.kind !== "cut" ? (
        <div className="dk-motion__grid">
          <NumberField
            label="Duration"
            unit="ms"
            value={transition.durationMs}
            min={TRANSITION_MS.min}
            max={TRANSITION_MS.max}
            step={50}
            integer
            onCommit={(ms) => run(setTransitionDuration(document, slide.id, ms), "Transition duration")}
            data-testid="transition-duration"
          />
          <Select
            label="Easing"
            value={transition.easing ?? "easeInOut"}
            options={NAMED_EASING_VALUES.map((easing) => ({ value: easing, label: easing }))}
            onChange={(easing) => run(setTransitionEasing(document, slide.id, easing), "Transition easing")}
            data-testid="transition-easing"
          />
          {state.kind === "slide" ? (
            <Segmented
              label="Direction"
              value={transition.direction ?? "left"}
              items={DIRECTIONS.map((direction) => ({ value: direction, label: direction[0]!.toUpperCase() + direction.slice(1) }))}
              onChange={(direction) => run(setTransitionDirection(document, slide.id, direction), "Transition direction")}
              size="sm"
            />
          ) : null}
        </div>
      ) : state.kind === "cut" ? (
        <p className="dk-muted">A cut: the slide is simply there. Nothing is stored for it.</p>
      ) : null}

      {state.kind === "morph" ? (
        <div className="dk-motion__pairs">
          <span className="dk-label">Shared elements</span>
          <PairPreview
            viewport={scene.viewport}
            from={scene.slides[index - 1]}
            to={scene.slides[index]}
            sourceId={looking?.sourceId ?? (pickSource || candidates.sources[0]?.id)}
            destinationId={looking?.destinationId ?? (pickDestination || candidates.destinations[0]?.id)}
            resolveAssetUrl={resolveAssetUrl}
          />
          {rows.some((row) => row.missing) ? (
            <div className="dk-motion__repair" role="status">
              <span>Some pairs name objects that are no longer on these slides, so they will not play.</span>
              <Button
                size="sm"
                variant="secondary"
                data-testid="pair-repair"
                onClick={() => run(removeBrokenPairs(document, slide.id), "Remove broken pairs")}
              >
                Remove broken pairs
              </Button>
            </div>
          ) : null}
          {rows.length === 0 ? (
            <p className="dk-muted">No pairs. Without one, a morph fades like any other transition.</p>
          ) : (
            <ul className="dk-motion__pair-list">
              {rows.map((row) => (
                <li
                  key={`${row.origin}:${row.sourceId}:${row.destinationId}`}
                  className="dk-motion__pair"
                  data-testid="pair-row"
                  data-origin={row.origin}
                  title={row.reason}
                  tabIndex={0}
                  onMouseEnter={() => setLooking({ sourceId: row.sourceId, destinationId: row.destinationId })}
                  onMouseLeave={() => setLooking(null)}
                  onFocus={() => setLooking({ sourceId: row.sourceId, destinationId: row.destinationId })}
                  onBlur={() => setLooking(null)}
                >
                  <span className="dk-motion__pair-names">
                    {row.sourceLabel} → {row.destinationLabel}
                    {row.missing ? <span className="dk-proposals__error"> · no longer on its slide</span> : null}
                  </span>
                  <StatusChip tone={row.origin === "auto" ? "waiting" : "neutral"}>
                    {row.origin === "auto" ? "Auto" : "Manual"}
                  </StatusChip>
                  {row.origin === "manual" ? (
                    <IconButton
                      icon="close"
                      label={`Break the pair ${row.sourceLabel} to ${row.destinationLabel}`}
                      size="sm"
                      variant="secondary"
                      onClick={() => run(removePair(document, slide.id, row.index!), "Break shared-element pair")}
                      data-testid="pair-break"
                    />
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => run(addPair(document, slide.id, row.sourceId, row.destinationId), "Keep suggested pair")}
                      data-testid="pair-keep"
                    >
                      Keep
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {rows.some((row) => row.origin === "auto") ? (
            <p className="dk-muted">Auto pairs are suggestions. Only kept pairs are saved and played.</p>
          ) : null}
          {candidates.sources.length && candidates.destinations.length ? (
            <div className="dk-motion__add">
              <Select
                label="From the slide before"
                value={pickSource || candidates.sources[0]!.id}
                options={candidates.sources.map((choice) => ({ value: choice.id, label: choice.label }))}
                onChange={setPickSource}
              />
              <Select
                label="On this slide"
                value={pickDestination || candidates.destinations[0]!.id}
                options={candidates.destinations.map((choice) => ({ value: choice.id, label: choice.label }))}
                onChange={setPickDestination}
              />
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                data-testid="pair-add"
                onClick={() =>
                  run(
                    addPair(
                      document,
                      slide.id,
                      pickSource || candidates.sources[0]!.id,
                      pickDestination || candidates.destinations[0]!.id,
                    ),
                    "Add shared-element pair",
                  )
                }
              >
                Add pair
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p className="dk-muted" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------- plan by roles

type Plan =
  | {
      what: "entrances" | "transition";
      operations: PatchOperation[];
      measured: MeasuredPlan;
      fingerprint: string;
      summary: string;
      warnings: string[];
    }
  | { what: "refused"; message: string; warnings: string[] };

function RolePlanner({ editor, presentationId }: { editor: EditorApi; presentationId: string }) {
  const client = useWorkspaceClient();
  const document = editor.document;
  const index = editor.slideIndex;
  const slide = document.slides[index]!;
  const previous = index > 0 ? document.slides[index - 1] : undefined;
  const roles = useMemo(() => slideRoles(slide), [slide]);
  const carryable = useMemo(() => carryableRoles(previous, slide), [previous, slide]);

  const [tab, setTab] = useState<"entrances" | "transition">("entrances");
  const [capabilities, setCapabilities] = useState<MotionCapabilities | null>(null);
  const [sequence, setSequence] = useState<string[]>(() => roles.map((entry) => entry.role));
  const [entrance, setEntrance] = useState("fade");
  const [pacing, setPacing] = useState<Pacing>("measured");
  const [clicks, setClicks] = useState(0);
  // Start from what the slide already does: re-planning a morph is the common case.
  const [kind, setKind] = useState<PlanKind>(() =>
    (PLAN_KINDS as readonly string[]).includes(slide.transition?.type ?? "") ? (slide.transition!.type as PlanKind) : "fade",
  );
  const [carry, setCarry] = useState<string[]>(carryable);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.motion
      .capabilities()
      .then((answer) => {
        if (!cancelled) setCapabilities(answer);
      })
      .catch(() => {
        /* The planner still works with its defaults; the preset list is a nicety. */
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const ordered = roles.map((entry) => entry.role);
  const chosen = ordered.filter((role) => sequence.includes(role));
  const toggle = (role: string, list: string[], set: (next: string[]) => void) =>
    set(list.includes(role) ? list.filter((item) => item !== role) : [...list, role]);
  const move = (role: string, by: -1 | 1) => {
    const at = sequence.indexOf(role);
    const to = at + by;
    if (at < 0 || to < 0 || to >= sequence.length) return;
    const next = [...sequence];
    [next[at], next[to]] = [next[to]!, next[at]!];
    setSequence(next);
  };
  const orderedSequence = sequence.filter((role) => chosen.includes(role));

  const ask = async () => {
    setNotice(null);
    setPlan(null);
    // The plan names element ids from the stored deck, so the stored deck has
    // to be the one on screen: unsaved edits first, or the plan is of a slide
    // the person is no longer looking at.
    if (!(await editor.saveNow())) {
      setNotice("Your edits are not saved yet, so the planner cannot see them. Save, then plan again.");
      return;
    }
    setBusy(true);
    try {
      const common = { slide_id: slide.id, expected_version_id: editor.currentVersionId(), pacing, dry_run: true };
      const answer =
        tab === "entrances"
          ? await client.motion.propose(presentationId, {
              ...common,
              sequence: orderedSequence,
              entrance,
              click_reveals: clicks,
              intent: "Plan motion by roles",
            })
          : await client.motion.proposeTransition(presentationId, {
              ...common,
              kind,
              carry: kind === "morph" ? carry : [],
              intent: "Plan transition by roles",
            });
      if (answer.outcome !== "planned" || !answer.operations) {
        setPlan({ what: "refused", message: answer.refusal ?? "Nothing to plan.", warnings: answer.warnings ?? [] });
        return;
      }
      const replaces = tab === "entrances" ? "animations" : "transition";
      const measured = measurePlan(editor.document, slide.id, answer.operations);
      const transition = measured.after?.slides[index]?.transition;
      const summary =
        tab === "entrances"
          ? `${measured.tracks.length} ${measured.tracks.length === 1 ? "track" : "tracks"}`
          : transition
            ? `${transition.type} · ${transition.durationMs}ms${transition.sharedElements?.length ? ` · ${transition.sharedElements.length} shared ${transition.sharedElements.length === 1 ? "element" : "elements"}` : ""}`
            : "A cut: no transition";
      setPlan({
        what: tab,
        operations: answer.operations,
        measured,
        fingerprint: planFingerprint(editor.document, slide.id, replaces),
        summary,
        warnings: answer.warnings ?? [],
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The planner did not answer.");
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!plan || plan.what === "refused") return;
    const replaces = plan.what === "entrances" ? "animations" : "transition";
    // A plan is for the slide it was planned against. If that slide changed,
    // its element ids may not be the ones the plan names.
    if (planFingerprint(editor.document, slide.id, replaces) !== plan.fingerprint) {
      setPlan(null);
      setNotice("The slide changed since this plan was made. Plan again.");
      return;
    }
    editor.apply(plan.operations, {
      label: plan.what === "entrances" ? "Plan motion by roles" : "Plan transition by roles",
    });
    setPlan(null);
    setNotice("Applied as one change. Undo takes it back.");
  };

  return (
    <div className="dk-motion">
      <Segmented
        label="Plan"
        value={tab}
        items={[
          { value: "entrances", label: "Entrances", "data-testid": "plan-tab-entrances" },
          { value: "transition", label: "Transition", "data-testid": "plan-tab-transition" },
        ]}
        onChange={(next) => {
          setTab(next);
          setPlan(null);
        }}
        size="sm"
      />

      {tab === "entrances" ? (
        roles.length === 0 ? (
          <p className="dk-muted">
            Nothing on this slide carries a role, so there is nothing to plan by. Roles come from generation, or from
            an agent that names them.
          </p>
        ) : (
          <>
            <span className="dk-label">Reveal in this order</span>
            <ol className="dk-motion__roles">
              {orderedSequence.map((role, position) => (
                <li key={role} className="dk-motion__role">
                  <label className="dk-generate__check">
                    <input type="checkbox" checked onChange={() => toggle(role, sequence, setSequence)} data-testid="plan-role" />
                    {role}
                  </label>
                  <span className="dk-proposal__step">
                    <IconButton icon="chevronDown" label={`Move ${role} later`} size="sm" variant="secondary" disabled={position === orderedSequence.length - 1} onClick={() => move(role, 1)} />
                  </span>
                </li>
              ))}
              {ordered
                .filter((role) => !sequence.includes(role))
                .map((role) => (
                  <li key={role} className="dk-motion__role dk-motion__role--off">
                    <label className="dk-generate__check">
                      <input type="checkbox" checked={false} onChange={() => toggle(role, sequence, setSequence)} data-testid="plan-role" />
                      {role} <span className="dk-muted">· on screen from the start</span>
                    </label>
                  </li>
                ))}
            </ol>
            <div className="dk-motion__grid">
              <Select
                label="Entrance"
                value={entrance}
                options={(capabilities?.presets ?? ["fade", "fadeUp"]).map((preset) => ({ value: preset, label: preset }))}
                onChange={setEntrance}
              />
              <NumberField label="On click" value={clicks} min={0} max={6} integer onCommit={setClicks} />
            </div>
          </>
        )
      ) : previous === undefined ? (
        <p className="dk-muted">The first slide has nothing to come from.</p>
      ) : (
        <>
          <Select
            label="Kind"
            value={kind}
            options={PLAN_KINDS.map((value) => ({ value, label: value }))}
            onChange={setKind}
          />
          {kind === "morph" ? (
            carryable.length ? (
              <>
                <span className="dk-label">Carry across</span>
                {carryable.map((role) => (
                  <label key={role} className="dk-generate__check">
                    <input
                      type="checkbox"
                      checked={carry.includes(role)}
                      onChange={() => toggle(role, carry, setCarry)}
                      data-testid="plan-carry"
                    />
                    {role}
                  </label>
                ))}
              </>
            ) : (
              <p className="dk-muted">No role is on both slides, so a morph has nothing to carry.</p>
            )
          ) : null}
        </>
      )}

      <Segmented
        label="Pacing"
        value={pacing}
        items={PACING.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))}
        onChange={setPacing}
        size="sm"
      />
      <Button
        size="sm"
        variant="secondary"
        icon="motion"
        disabled={busy || (tab === "entrances" && orderedSequence.length === 0) || (tab === "transition" && !previous)}
        onClick={() => void ask()}
        data-testid="plan-submit"
      >
        {busy ? "Planning…" : tab === "entrances" ? "Plan motion by roles" : "Plan transition by roles"}
      </Button>

      {plan ? (
        plan.what === "refused" ? (
          <p className="dk-muted" role="status" data-testid="plan-refused">
            {plan.message}
          </p>
        ) : (
          <article className="dk-proposal" data-testid="plan-card">
            <header className="dk-proposal__head">
              <StatusChip tone="waiting">Not applied</StatusChip>
              <span className="dk-proposal__who">Proposed plan · {plan.summary}</span>
            </header>
            {plan.what === "entrances" ? (
              <>
                <ul className="dk-motion__tracks">
                  {plan.measured.tracks.map((line, position) => (
                    <li key={position}>{line}</li>
                  ))}
                </ul>
                <p className="dk-proposal__intent" data-testid="plan-budget">
                  {budgetLine(plan.measured.budget)}
                </p>
              </>
            ) : null}
            {plan.measured.error ? <p className="dk-proposals__error">{plan.measured.error}</p> : null}
            {plan.warnings.map((warning) => (
              <p key={warning} className="dk-proposal__reason">
                {warning}
              </p>
            ))}
            <div className="dk-proposal__actions">
              <Button size="sm" variant="secondary" onClick={() => setPlan(null)} data-testid="plan-discard">
                Discard
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={Boolean(plan.measured.error)}
                onClick={apply}
                data-testid="plan-apply"
              >
                Apply plan
              </Button>
            </div>
          </article>
        )
      ) : null}
      {notice ? (
        <p className="dk-muted" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
