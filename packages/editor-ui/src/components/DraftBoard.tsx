"use client";

import { useEffect, useMemo, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { DraftBlock, DraftBoard as DraftBoardModel, DraftCard, DraftOperation } from "@deckastra/workspace-contracts";
import { Button, IconButton, Select, StatusChip } from "../ui";

const LAYOUTS = ["title", "statement", "bullets", "metrics", "quote", "split", "chart", "diagram", "timeline", "image"];

function cardId() {
  const token = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random()}`.replace(/\D/g, "");
  return `crd_${token.slice(0, 24)}`;
}

function starter(layout = "statement"): DraftCard {
  const blocks: DraftBlock[] = [{ role: "headline", text: "A clear slide claim" }];
  if (layout === "title") blocks.push({ role: "subtitle", text: "A concise subtitle" });
  else if (layout === "bullets") blocks.push({ role: "bullet", text: "Supporting point" }, { role: "bullet", text: "Another point" });
  else if (layout === "metrics") blocks.push({ role: "metric", data: { value: "—", label: "Add metric" } });
  else if (layout === "quote") blocks.push({ role: "quote", text: "A memorable quotation" }, { role: "subtitle", text: "Attribution" });
  else if (layout === "image") blocks.push({ role: "image", image: { subject: "Describe the picture", style_source: "deck" } });
  else if (layout === "split") blocks.push({ role: "body", text: "Supporting detail" }, { role: "image", image: { subject: "Describe the supporting picture", style_source: "deck" } });
  else if (layout === "chart") blocks.push({ role: "chart", data: { type: "column", categories: ["Category 1", "Category 2"], series: [{ name: "Value", values: [0, 0] }] } });
  else if (layout === "diagram") blocks.push({ role: "diagram", data: { kind: "flow", direction: "LR", view: "flat", nodes: [{ key: "start", label: "Start" }, { key: "finish", label: "Finish" }], edges: [{ source: "start", target: "finish", label: "Next" }] } });
  else if (layout === "timeline") blocks.push({ role: "timeline", data: [{ when: "Stage 1", label: "Start", detail: "First step" }, { when: "Stage 2", label: "Finish", detail: "Next step" }] });
  else blocks.push({ role: "body", text: "Supporting detail" });
  return { id: cardId(), layout, blocks, alternatives: [], locked: false };
}

function structuredSummary(block: DraftBlock) {
  if (block.role === "chart") {
    const data = block.data as { categories?: unknown[]; points?: unknown[]; series?: unknown[] } | undefined;
    return `${data?.categories?.length ?? data?.points?.length ?? 0} points · ${data?.series?.length ?? 1} series`;
  }
  if (block.role === "diagram") {
    const data = block.data as { nodes?: unknown[]; edges?: unknown[] } | undefined;
    return `${data?.nodes?.length ?? 0} nodes · ${data?.edges?.length ?? 0} connections`;
  }
  if (block.role === "timeline") return `${Array.isArray(block.data) ? block.data.length : 0} stages`;
  if (block.role === "metric") {
    const data = block.data as { value?: string; label?: string } | undefined;
    return `${data?.value ?? "—"} ${data?.label ?? ""}`.trim();
  }
  return "Structured data";
}

function buildError(reason: unknown, cards: DraftCard[]) {
  const fallback = reason instanceof Error ? reason.message : "The draft could not be built.";
  const detail = (reason as { detail?: { message?: unknown; issues?: unknown } } | null)?.detail;
  if (!detail || !Array.isArray(detail.issues) || !detail.issues.length) return fallback;
  const issue = detail.issues[0] as { card_id?: unknown; message?: unknown };
  const index = cards.findIndex((card) => card.id === issue.card_id);
  const where = index >= 0 ? `Card ${index + 1}: ` : "";
  return `${typeof detail.message === "string" ? detail.message : fallback} ${where}${typeof issue.message === "string" ? issue.message : ""}`.trim();
}

export interface DraftBoardProps {
  draftId?: string;
  initial?: DraftBoardModel;
  projectId?: string;
  presentationId?: string;
  onBuilt?: (presentationId: string, kind: "deck" | "proposal") => void;
  onClose: () => void;
}

export function DraftBoard({ draftId, initial, projectId, presentationId, onBuilt, onClose }: DraftBoardProps) {
  const client = useWorkspaceClient();
  const [draft, setDraft] = useState<DraftBoardModel | null>(initial ?? null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<string[]>(LAYOUTS);
  const [asking, setAsking] = useState<{ cardId: string; message: string; kind: "content" | "layout" | "motion" | "image" }>({ cardId: "", message: "", kind: "content" });
  const [notice, setNotice] = useState<string | null>(null);
  const [requestCount, setRequestCount] = useState(0);
  const [newLayout, setNewLayout] = useState("statement");

  useEffect(() => {
    if (initial) return;
    let live = true;
    const load = draftId
      ? client.drafts.read(draftId, { fresh: true })
      : presentationId
        ? client.drafts.seed(presentationId)
        : projectId
          ? client.drafts.create(projectId, { title: "Untitled rough canvas", body: { cards: [starter("title"), starter("bullets")] } })
          : Promise.reject(new Error("A draft needs a project or a deck."));
    void load.then((value) => { if (live) setDraft(value); }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "The draft could not be opened."); });
    return () => { live = false; };
  }, [client, draftId, initial, presentationId, projectId]);

  useEffect(() => {
    let live = true;
    void client.presets.list().then((catalog) => {
      if (!live) return;
      setPatterns([...new Set([...LAYOUTS, ...Object.keys(catalog.patternDefinitions ?? {})])]);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [client]);

  useEffect(() => {
    if (!draft) return;
    let live = true;
    void client.drafts.requests(draft.id, "open", { fresh: true }).then((items) => { if (live && Array.isArray(items)) setRequestCount(items.length); }).catch(() => undefined);
    return () => { live = false; };
  }, [client, draft?.id]);

  const apply = async (operations: DraftOperation[]) => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      setDraft(await client.drafts.update(draft.id, draft.revision, operations));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That draft change did not save.");
      try { setDraft(await client.drafts.read(draft.id, { fresh: true })); } catch { /* keep the actionable first error */ }
    } finally {
      setBusy(false);
    }
  };

  const move = (id: string, to: number) => void apply([{ op: "move", card_id: id, index: Math.max(0, to) }]);
  const cards = draft?.body.cards ?? [];
  const selectedIds = useMemo(() => [...selected].filter((id) => cards.some((card) => card.id === id)), [cards, selected]);

  const duplicate = (card: DraftCard, index: number) => void apply([{ op: "add", index: index + 1, card: { ...card, id: cardId(), locked: false } }]);
  const split = (card: DraftCard, index: number) => {
    const bullets = card.blocks.filter((block) => block.role === "bullet");
    if (bullets.length < 2) return;
    const at = Math.ceil(bullets.length / 2);
    const fixed = card.blocks.filter((block) => block.role !== "bullet");
    void apply([
      { op: "set_blocks", card_id: card.id, blocks: [...fixed, ...bullets.slice(0, at)] },
      { op: "add", index: index + 1, card: { ...card, id: cardId(), blocks: [...fixed, ...bullets.slice(at)], locked: false } },
    ]);
  };
  const merge = (card: DraftCard, index: number) => {
    const next = cards[index + 1];
    if (!next) return;
    void apply([{ op: "set_blocks", card_id: card.id, blocks: [...card.blocks, ...next.blocks] }, { op: "remove", card_id: next.id }]);
  };

  const build = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.drafts.build(draft.id, draft.revision, selectedIds.length ? selectedIds : undefined);
      onBuilt?.(result.presentation_id, result.kind);
      if (result.kind === "deck") onClose();
      else setDraft(await client.drafts.read(draft.id, { fresh: true }));
    } catch (reason) {
      setError(buildError(reason, cards));
    } finally {
      setBusy(false);
    }
  };

  // A card whose slide was edited in the deck since the board took it: take the
  // deck's version back in (the board's edit to it is replaced, by choice).
  const syncCards = async (cardIds: string[]) => {
    if (!draft || busy || !client.drafts.sync) return;
    setBusy(true);
    setError(null);
    try {
      setDraft(await client.drafts.sync(draft.id, draft.revision, cardIds));
      setNotice(`Took the deck's version of ${cardIds.length === 1 ? "that card" : `${cardIds.length} cards`} back into the board.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Those cards could not be synced.");
    } finally {
      setBusy(false);
    }
  };
  const deckChanged = new Set(draft?.deck_changed_card_ids ?? []);
  const deckConflicts = draft?.deck_conflict_card_ids ?? [];

  const askAgent = async () => {
    if (!draft || !asking.cardId || !asking.message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.drafts.createRequest(draft.id, { card_ids: [asking.cardId], kind: asking.kind, message: asking.message.trim(), revision: draft.revision });
      setRequestCount((count) => count + 1);
      setNotice("Request sent. It will wait here for your connected agent.");
      setAsking({ cardId: "", message: "", kind: "content" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  if (!draft) return <div className="dk-draft-board dk-draft-board--loading">{error ?? "Opening the rough canvas…"}</div>;

  return (
    <section className="dk-draft-board" data-testid="draft-board">
      <header className="dk-draft-board__bar">
        <div>
          <p className="dk-eyebrow">ROUGH CANVAS</p>
          <h2>{draft.title}</h2>
          <p className="dk-muted">{draft.changed_since_build ? "Changed since built" : draft.built_version_id ? "Matches its last build" : "Not built yet"} · Revision {draft.revision}{requestCount ? ` · ${requestCount} waiting for your agent` : ""}</p>
        </div>
        <div className="dk-draft-board__actions">
          <Select label="New card layout" hideLabel value={newLayout} options={patterns.map((value) => ({ value, label: value }))} onChange={setNewLayout} />
          <Button variant="secondary" icon="plus" disabled={busy} onClick={() => void apply([{ op: "add", card: starter(newLayout), index: cards.length }])}>Add {newLayout} card</Button>
          {selectedIds.length ? <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear {selectedIds.length} selected</Button> : null}
          <Button variant="primary" disabled={busy || cards.length === 0} onClick={() => void build()} data-testid="draft-build">
            {selectedIds.length ? `Build ${selectedIds.length} selected` : draft.presentation_id ? "Build all changes" : "Build deck"}
          </Button>
          <IconButton icon="close" label="Close draft" onClick={onClose} />
        </div>
      </header>
      {error ? <div className="dk-banner dk-banner--danger" role="alert">{error}</div> : null}
      {notice ? <div className="dk-banner dk-banner--notice" role="status">{notice}</div> : null}
      {deckConflicts.length ? (
        <div className="dk-banner dk-banner--danger" role="status" data-testid="draft-deck-conflict">
          <span>
            The deck changed on {deckConflicts.length === 1 ? "the slide" : `the slides`} behind{" "}
            {deckConflicts.map((id) => `card ${cards.findIndex((card) => card.id === id) + 1}`).join(", ")}, and this board changed{" "}
            {deckConflicts.length === 1 ? "it" : "them"} too. Building would lose the deck edits.
          </span>
          {client.drafts.sync ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void syncCards(deckConflicts)} data-testid="draft-sync-conflicts">
              Use the deck's version
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="dk-draft-board__hint">Drag cards or use Alt+↑/↓. Grey regions are wireframes; the deterministic composer owns the final geometry.</p>
      <ol className="dk-draft-board__cards">
        {cards.map((card, index) => (
          <li
            key={card.id}
            className="dk-draft-card"
            draggable={!busy}
            onDragStart={() => setDragged(card.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => { if (dragged && dragged !== card.id) move(dragged, index); setDragged(null); }}
            onKeyDown={(event) => {
              if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              move(card.id, index + (event.key === "ArrowUp" ? -1 : 1));
            }}
            tabIndex={0}
            data-card-id={card.id}
          >
            <div className="dk-draft-card__head">
              <label><input type="checkbox" checked={selected.has(card.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(card.id) : next.delete(card.id); return next; })} aria-label={`Select card ${index + 1}`} /></label>
              <span className="dk-draft-card__number">{index + 1}</span>
              <Select label="Layout" hideLabel value={card.layout} options={patterns.map((value) => ({ value, label: value }))} onChange={(layout) => {
                setNotice("Layout converted. Previous content is available as an alternative if anything needs restoring.");
                void apply([{ op: "set_layout", card_id: card.id, layout }]);
              }} />
              {card.locked ? <StatusChip tone="waiting">Locked</StatusChip> : null}
              {deckConflicts.includes(card.id) ? (
                <StatusChip tone="danger" title="Changed on the board and in the deck">Deck changed too</StatusChip>
              ) : deckChanged.has(card.id) ? (
                <StatusChip tone="neutral" title="Building keeps the deck's newer version of this slide">Deck edited</StatusChip>
              ) : null}
              <span className="dk-draft-card__spacer" />
              <Button size="sm" variant="ghost" onClick={() => duplicate(card, index)}>Duplicate</Button>
              <Button size="sm" variant="ghost" disabled={card.blocks.filter((block) => block.role === "bullet").length < 2} onClick={() => split(card, index)}>Split</Button>
              <Button size="sm" variant="ghost" disabled={!cards[index + 1]} onClick={() => merge(card, index)}>Merge next</Button>
              <Button size="sm" variant="ghost" onClick={() => void apply([{ op: "set_locked", card_id: card.id, locked: !card.locked }])}>{card.locked ? "Unlock" : "Lock"}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAsking({ cardId: card.id, message: "", kind: "content" })}>Ask agent…</Button>
              <IconButton icon="trash" label={`Delete card ${index + 1}`} size="sm" disabled={card.locked} onClick={() => void apply([{ op: "remove", card_id: card.id }])} />
            </div>
            <div className={`dk-draft-wireframe dk-draft-wireframe--${card.layout}`}>
              {card.blocks.map((block, blockIndex) => (
                <label key={`${block.role}-${blockIndex}`} className={`dk-draft-block dk-draft-block--${block.role}`}>
                  <span>{block.role}</span>
                  {block.role === "chart" || block.role === "diagram" || block.role === "timeline" || block.role === "metric" ? (
                    <code>{structuredSummary(block)}</code>
                  ) : (
                    <textarea
                      value={block.image?.subject ?? block.text ?? ""}
                      rows={block.role === "headline" ? 2 : 3}
                      disabled={busy || card.locked}
                      onChange={(event) => {
                        const blocks = card.blocks.map((candidate, at) => at === blockIndex
                          ? block.role === "image" ? { ...candidate, image: { ...candidate.image, subject: event.target.value, style_source: candidate.image?.style_source ?? "deck" } } : { ...candidate, text: event.target.value }
                          : candidate);
                        setDraft({ ...draft, body: { ...draft.body, cards: cards.map((candidate) => candidate.id === card.id ? { ...candidate, blocks } : candidate) } });
                      }}
                      onBlur={(event) => {
                        const blocks = card.blocks.map((candidate, at) => at === blockIndex
                          ? block.role === "image" ? { ...candidate, image: { ...candidate.image, subject: event.target.value || "Describe the picture", style_source: candidate.image?.style_source ?? "deck" } } : { ...candidate, text: event.target.value }
                          : candidate);
                        void apply([{ op: "set_blocks", card_id: card.id, blocks }]);
                      }}
                    />
                  )}
                </label>
              ))}
            </div>
            {(draft.density_warnings[card.id] ?? []).map((warning) => <p key={warning} className="dk-draft-card__warning">{warning}</p>)}
            {card.alternatives?.length ? (
              <div className="dk-draft-card__alternatives">
                <span>{card.alternatives.length} alternative{card.alternatives.length === 1 ? "" : "s"}</span>
                {card.alternatives.map((_alternative, alternativeIndex) => <Button key={alternativeIndex} size="sm" variant="ghost" disabled={card.locked} onClick={() => void apply([{ op: "choose_alternative", card_id: card.id, alternative_index: alternativeIndex }])}>Use {alternativeIndex + 1}</Button>)}
              </div>
            ) : null}
            {asking.cardId === card.id ? (
              <div className="dk-draft-card__ask">
                <Select label="Request kind" value={asking.kind} onChange={(kind) => setAsking((current) => ({ ...current, kind: kind as typeof current.kind }))} options={[
                  { value: "content", label: "Tighter words" }, { value: "layout", label: "Simpler layout" },
                  { value: "motion", label: "Different motion" }, { value: "image", label: "Another picture" },
                ]} />
                <textarea className="dk-input dk-textarea" rows={3} maxLength={2000} value={asking.message} onChange={(event) => setAsking((current) => ({ ...current, message: event.target.value }))} placeholder="What should the agent reconsider?" />
                <div><Button size="sm" variant="primary" disabled={!asking.message.trim() || busy} onClick={() => void askAgent()}>Send request</Button><Button size="sm" variant="ghost" onClick={() => setAsking({ cardId: "", message: "", kind: "content" })}>Cancel</Button></div>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
