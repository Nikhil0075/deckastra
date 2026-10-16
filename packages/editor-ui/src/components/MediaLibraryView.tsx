"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AccountContext, AssetListRequest, AssetUses, AssistantAsset } from "@deckastra/workspace-contracts";

import { relativeTime } from "../lib/deck-list";
import { imageSize } from "../lib/insert-image";
import { Button, Icon, IconButton, InlineError, ScrollArea, Select, SkeletonCards, StatusChip, TextField, cx, type IconName } from "../ui";
import { formatBytes } from "./StorageUsage";

/**
 * The Media page (2026-10-17): every file the workspace holds — uploads,
 * generated pictures and clips, voices, fonts, source documents — with what
 * the service could always do and nothing showed. Rename, describe and tag a
 * file (each edit undoable), see which decks show it, move an unused one to
 * Trash and bring it back, and find duplicates.
 *
 * Deleting is refused by the service while a deck shows the file, and the
 * page says which decks before anyone presses anything: a picture removed
 * from under a deck is a gap on a slide with nothing to say why.
 */

type Filter = "all" | "unused" | "untagged" | "deleted" | "duplicates";
type Kind = NonNullable<AssetListRequest["kind"]> | "any";

const PAGE = 48;
const THUMB_PX = 256;

const KIND_WORDS: Record<string, { label: string; icon: IconName }> = {
  image: { label: "Picture", icon: "image" },
  video: { label: "Clip", icon: "play" },
  audio: { label: "Sound", icon: "sound" },
  font: { label: "Font", icon: "text" },
  document: { label: "Document", icon: "list" },
};

/** What a file is, for the upload's `kind`, from what the browser says it is. */
export function uploadKind(file: File): "image" | "video" | "audio" | "font" | "document" | null {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("font/") || /\.(ttf|otf|woff2?)$/.test(name)) return "font";
  if (type === "application/pdf" || type === "text/plain" || type === "text/csv" || /\.(pdf|txt|csv)$/.test(name)) return "document";
  return null;
}

/** Tags as typed ("brand, hero,  q3 ") to the list the service keeps. */
export function parseTags(value: string): string[] {
  const out: string[] = [];
  const kept = new Set<string>();
  for (const raw of value.split(",")) {
    const tag = raw.trim().slice(0, 50);
    if (tag && !kept.has(tag.toLowerCase())) {
      kept.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out.slice(0, 30);
}

function describeAsset(asset: AssistantAsset): string {
  const parts = [KIND_WORDS[asset.kind ?? ""]?.label ?? "File"];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (asset.duration_ms) parts.push(`${Math.round(asset.duration_ms / 100) / 10}s`);
  if (asset.bytes) parts.push(formatBytes(asset.bytes));
  return parts.join(" · ");
}

export interface MediaLibraryViewProps {
  account: AccountContext;
  /** The workspace the page opens on: the one the home is showing. */
  workspaceId?: string;
  query: string;
  now: number;
  onOpenDeck: (presentationId: string) => void;
}

export function MediaLibraryView({ account, workspaceId: initialWorkspace, query, now, onOpenDeck }: MediaLibraryViewProps) {
  const client = useWorkspaceClient();
  const assistant = client.assistant;
  const workspaces = account.workspaces;
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace ?? workspaces[0]?.id ?? "");
  const workspace = workspaces.find((one) => one.id === workspaceId);
  const editable = workspace ? workspace.role !== "viewer" : false;
  const [filter, setFilter] = useState<Filter>("all");
  const [kind, setKind] = useState<Kind>("any");
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [assets, setAssets] = useState<AssistantAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<{ asset_ids: string[]; kind: "exact" | "candidate" }[]>([]);
  const [uploading, setUploading] = useState(false);
  const thumbs = useThumbnails(assets);
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  // The bar's search is the server's `q`, so a large library is searched
  // whole rather than only the page that happens to be loaded.
  const [needle, setNeedle] = useState(query.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (after?: string | null) => {
      if (!assistant || !workspaceId) return;
      const ticket = ++generation.current;
      setLoading(true);
      try {
        if (filter === "duplicates") {
          const answer = await assistant.assetDuplicates(workspaceId, undefined, { fresh: true });
          const ids = [...new Set(answer.groups.flatMap((group) => group.asset_ids))];
          const listed = await assistant.assetList({ workspace_id: workspaceId, limit: 100, order: "newest" }, { fresh: true });
          if (ticket !== generation.current) return;
          setDuplicates(answer.groups);
          setAssets(listed.assets.filter((asset) => ids.includes(asset.id)));
          setCursor(null);
        } else {
          const answer = await assistant.assetList(
            {
              workspace_id: workspaceId,
              filter,
              order,
              limit: PAGE,
              ...(kind !== "any" ? { kind } : {}),
              ...(needle ? { q: needle } : {}),
              ...(after ? { cursor: after } : {}),
            },
            { fresh: true },
          );
          if (ticket !== generation.current) return;
          setAssets((current) => (after ? [...current, ...answer.assets] : answer.assets));
          setCursor(answer.next_cursor);
        }
        setError(null);
      } catch (reason) {
        if (ticket === generation.current) setError(reason instanceof Error ? reason.message : "Your media could not be read.");
      } finally {
        if (ticket === generation.current) setLoading(false);
      }
    },
    [assistant, filter, kind, needle, order, workspaceId],
  );

  useEffect(() => {
    setSelected(null);
    void load(null);
  }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files?.length || !workspaceId) return;
    setUploading(true);
    setNotice(null);
    let added = 0;
    const refused: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const fileKind = uploadKind(file);
        if (!fileKind) {
          refused.push(`${file.name} is not a picture, clip, sound, font or document`);
          continue;
        }
        try {
          await client.assets.upload(file, {
            workspaceId,
            kind: fileKind,
            ...(fileKind === "image" ? await imageSize(file) : {}),
            ...(file.type ? {} : fileKind === "font" ? { contentType: `font/${file.name.split(".").pop()}` } : {}),
          });
          added += 1;
        } catch (reason) {
          refused.push(reason instanceof Error ? `${file.name}: ${reason.message}` : `${file.name} could not be uploaded`);
        }
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
    setNotice({ text: [added ? `Added ${added} file${added === 1 ? "" : "s"}.` : "", ...refused].filter(Boolean).join(" ") });
    if (filter !== "all" && filter !== "untagged") setFilter("all");
    else void load(null);
  };

  const remove = async (asset: AssistantAsset) => {
    if (!client.assets.remove) return;
    try {
      await client.assets.remove(asset.id, workspaceId);
      setSelected(null);
      setAssets((current) => current.filter((one) => one.id !== asset.id));
      setNotice({
        text: `Moved “${asset.filename ?? "file"}” to Trash.`,
        undo: () => void restore(asset),
      });
    } catch (reason) {
      setNotice({ text: reason instanceof Error ? reason.message : "That file could not be removed." });
    }
  };

  const restore = async (asset: AssistantAsset) => {
    if (!client.assets.restore) return;
    try {
      await client.assets.restore(asset.id, workspaceId);
      setNotice({ text: `Restored “${asset.filename ?? "file"}”.` });
      setSelected(null);
      await load(null);
    } catch (reason) {
      setNotice({ text: reason instanceof Error ? reason.message : "That file could not be restored." });
    }
  };

  const replaced = (asset: AssistantAsset) => setAssets((current) => current.map((one) => (one.id === asset.id ? { ...one, ...asset } : one)));

  const chosen = assets.find((asset) => asset.id === selected) ?? null;
  const pairsFor = useMemo(() => {
    const map = new Map<string, { other: string; kind: "exact" | "candidate" }[]>();
    for (const group of duplicates) {
      const [left, right] = group.asset_ids;
      if (!left || !right) continue;
      map.set(left, [...(map.get(left) ?? []), { other: right, kind: group.kind }]);
      map.set(right, [...(map.get(right) ?? []), { other: left, kind: group.kind }]);
    }
    return map;
  }, [duplicates]);

  if (!assistant) {
    return (
      <main className="dk-decks__main" data-home-destination="media">
        <p className="dk-muted">This service does not offer a media library.</p>
      </main>
    );
  }

  const emptyText =
    filter === "deleted"
      ? "Trash is empty. Files you remove wait here until they are cleaned up."
      : filter === "duplicates"
        ? "No duplicates found."
        : filter === "unused"
          ? "Every file is used in at least one deck version."
          : needle
            ? `No files match “${needle}”.`
            : "No media yet. Upload pictures, clips, sounds, fonts or documents, or place a generated picture on a slide.";

  return (
    <main className="dk-decks__main dk-media" data-home-destination="media">
      <div className="dk-decks__heading">
        <div>
          <h2 className="dk-decks__title">Media</h2>
          <p className="dk-muted">Everything this workspace holds. Rename, tag and tidy files here; place them from a slide’s Add panel.</p>
        </div>
        <div className="dk-decks__heading-actions">
          {workspaces.length > 1 ? (
            <Select
              label="Workspace"
              hideLabel
              value={workspaceId}
              onChange={setWorkspaceId}
              options={workspaces.map((one) => ({ value: one.id, label: one.name }))}
              data-testid="media-workspace"
            />
          ) : null}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,video/*,audio/*,.pdf,.txt,.csv,.ttf,.otf,.woff,.woff2"
            onChange={(event) => void upload(event.target.files)}
            data-testid="media-upload-input"
          />
          <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()} disabled={!editable || uploading} data-testid="media-upload">
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </div>

      <div className="dk-media__toolbar">
        <div className="dk-agent-tasks__filters" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["unused", "Unused"],
              ["untagged", "Untagged"],
              ["duplicates", "Duplicates"],
              ["deleted", "Trash"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "primary" : "secondary"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              data-testid={`media-filter-${value}`}
            >
              {label}
            </Button>
          ))}
        </div>
        {filter !== "duplicates" ? (
          <span className="dk-media__selects">
            <Select
              label="Kind"
              hideLabel
              value={kind}
              onChange={(value) => setKind(value as Kind)}
              options={[
                { value: "any", label: "Every kind" },
                { value: "image", label: "Pictures" },
                { value: "video", label: "Clips" },
                { value: "audio", label: "Sounds" },
                { value: "font", label: "Fonts" },
                { value: "document", label: "Documents" },
              ]}
              data-testid="media-kind"
            />
            <Select
              label="Order"
              hideLabel
              value={order}
              onChange={(value) => setOrder(value as "newest" | "oldest")}
              options={[
                { value: "newest", label: "Newest first" },
                { value: "oldest", label: "Oldest first" },
              ]}
            />
          </span>
        ) : null}
      </div>

      {notice ? (
        <p className="dk-media__notice" role="status" data-testid="media-notice">
          {notice.text}
          {notice.undo ? (
            <Button size="sm" variant="ghost" onClick={() => { const undo = notice.undo; setNotice(null); undo?.(); }} data-testid="media-undo">
              Undo
            </Button>
          ) : null}
        </p>
      ) : null}
      {error ? <InlineError onRetry={() => void load(null)}>{error}</InlineError> : null}

      <div className="dk-media__body">
        <ScrollArea className="dk-decks__scroll dk-media__scroll" label="Media files">
          {loading && assets.length === 0 && !error ? <SkeletonCards label="Reading your media" count={8} gridClassName="dk-media__grid" /> : null}
          {!loading && !error && assets.length === 0 ? (
            <div className="dk-decks__empty">
              <span className="dk-accent-rule" aria-hidden="true" />
              <p>{emptyText}</p>
            </div>
          ) : null}
          <ul className="dk-media__grid" aria-label="Files">
            {assets.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  className={cx("dk-media__card", selected === asset.id && "dk-media__card--selected")}
                  aria-pressed={selected === asset.id}
                  onClick={() => setSelected(selected === asset.id ? null : asset.id)}
                  data-testid="media-card"
                  data-asset-id={asset.id}
                >
                  <span className="dk-media__thumb">
                    {thumbs[asset.id] ? <img src={thumbs[asset.id]} alt="" /> : <Icon name={KIND_WORDS[asset.kind ?? ""]?.icon ?? "list"} size={22} />}
                  </span>
                  <span className="dk-media__name" title={asset.filename ?? asset.id} dir="auto">
                    {asset.filename ?? "Untitled file"}
                  </span>
                  <span className="dk-media__meta">{describeAsset(asset)}</span>
                  <span className="dk-media__chips">
                    {asset.tags.includes("generated") ? <StatusChip tone="action">Generated</StatusChip> : null}
                    {filter === "duplicates" && pairsFor.get(asset.id)?.some((pair) => pair.kind === "exact") ? <StatusChip tone="waiting">Exact copy</StatusChip> : null}
                    {filter === "duplicates" && !pairsFor.get(asset.id)?.some((pair) => pair.kind === "exact") ? <StatusChip tone="neutral">Looks alike</StatusChip> : null}
                    {filter === "deleted" && asset.deleted_at ? <StatusChip tone="neutral">Removed {relativeTime(asset.deleted_at, now)}</StatusChip> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {cursor ? (
            <div className="dk-media__more">
              <Button variant="secondary" onClick={() => void load(cursor)} disabled={loading} data-testid="media-more">
                {loading ? "Reading…" : "Show more"}
              </Button>
            </div>
          ) : null}
        </ScrollArea>

        {chosen ? (
          <AssetDetail
            key={chosen.id}
            asset={chosen}
            thumb={thumbs[chosen.id]}
            editable={editable}
            trashed={filter === "deleted"}
            duplicates={(pairsFor.get(chosen.id) ?? []).map((pair) => ({ ...pair, asset: assets.find((one) => one.id === pair.other) }))}
            onClose={() => setSelected(null)}
            onChanged={replaced}
            onRemove={() => void remove(chosen)}
            onRestore={() => void restore(chosen)}
            onSelect={setSelected}
            onOpenDeck={onOpenDeck}
          />
        ) : null}
      </div>
    </main>
  );
}

function AssetDetail({
  asset,
  thumb,
  editable,
  trashed,
  duplicates,
  onClose,
  onChanged,
  onRemove,
  onRestore,
  onSelect,
  onOpenDeck,
}: {
  asset: AssistantAsset;
  thumb?: string;
  editable: boolean;
  trashed: boolean;
  duplicates: { other: string; kind: "exact" | "candidate"; asset?: AssistantAsset }[];
  onClose: () => void;
  onChanged: (asset: AssistantAsset) => void;
  onRemove: () => void;
  onRestore: () => void;
  onSelect: (id: string) => void;
  onOpenDeck: (presentationId: string) => void;
}) {
  const client = useWorkspaceClient();
  const assistant = client.assistant!;
  const [name, setName] = useState(asset.filename ?? "");
  const [description, setDescription] = useState(asset.description ?? "");
  const [tags, setTags] = useState(asset.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<string | null>(null);
  const [uses, setUses] = useState<AssetUses | null | "failed">(null);

  useEffect(() => {
    if (trashed || !assistant.assetUses) return;
    const controller = new AbortController();
    assistant
      .assetUses(asset.id, { signal: controller.signal, fresh: true })
      .then(setUses)
      .catch(() => {
        if (!controller.signal.aborted) setUses("failed");
      });
    return () => controller.abort();
  }, [assistant, asset.id, trashed]);

  const changed =
    name.trim() !== (asset.filename ?? "") ||
    description.trim() !== (asset.description ?? "") ||
    parseTags(tags).join("\n") !== asset.tags.join("\n");

  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const next = await assistant.assetUpdate(asset.id, {
        expected_metadata_version: asset.metadata_version,
        ...(name.trim() && name.trim() !== asset.filename ? { filename: name.trim() } : {}),
        ...(description.trim() !== (asset.description ?? "") ? { description: description.trim() } : {}),
        ...(parseTags(tags).join("\n") !== asset.tags.join("\n") ? { tags: parseTags(tags) } : {}),
      });
      onChanged(next);
      setLastChange(next.change_id ?? null);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : "The changes could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const undo = async () => {
    if (!lastChange) return;
    setSaving(true);
    try {
      const back = await assistant.assetRevert(asset.id, lastChange);
      onChanged(back);
      setName(back.filename ?? "");
      setDescription(back.description ?? "");
      setTags(back.tags.join(", "));
      setLastChange(null);
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : "That change could not be undone.");
    } finally {
      setSaving(false);
    }
  };

  const live = uses && uses !== "failed" ? uses.decks.filter((deck) => !deck.deleted) : [];
  const inTrashDecks = uses && uses !== "failed" ? uses.decks.filter((deck) => deck.deleted) : [];

  return (
    <aside className="dk-media__detail" aria-label={`${asset.filename ?? "File"} details`} data-testid="media-detail">
      <div className="dk-media__detail-head">
        <strong dir="auto">{asset.filename ?? "Untitled file"}</strong>
        <IconButton icon="close" label="Close details" size="sm" variant="ghost" onClick={onClose} />
      </div>
      <div className="dk-media__detail-preview">
        {thumb ? <img src={thumb} alt="" /> : <Icon name={KIND_WORDS[asset.kind ?? ""]?.icon ?? "list"} size={32} />}
      </div>
      <p className="dk-field__hint">
        {describeAsset(asset)}
        {asset.created_at ? ` · added ${new Date(asset.created_at).toLocaleDateString()}` : ""}
      </p>

      {trashed ? (
        <>
          <p className="dk-muted">This file is in Trash. Restore it to use it again; files left here are cleaned up after a while.</p>
          <Button variant="primary" onClick={onRestore} disabled={!editable} data-testid="media-restore">
            Restore
          </Button>
        </>
      ) : (
        <>
          <TextField label="Name" value={name} onChange={setName} maxLength={255} disabled={!editable} data-testid="media-name" />
          <label className="dk-field">
            <span className="dk-label">Description</span>
            <textarea
              className="dk-input"
              rows={2}
              maxLength={500}
              value={description}
              disabled={!editable}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What it shows. Agents read this when choosing a picture."
              data-testid="media-description"
            />
          </label>
          <TextField
            label="Tags"
            value={tags}
            onChange={setTags}
            disabled={!editable}
            placeholder="brand, product, team"
            hint="Separate tags with commas."
            data-testid="media-tags"
          />
          <div className="dk-media__detail-actions">
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={!editable || !changed || saving} data-testid="media-save">
              {saving ? "Saving…" : "Save"}
            </Button>
            {lastChange ? (
              <Button variant="ghost" size="sm" onClick={() => void undo()} disabled={saving} data-testid="media-undo-edit">
                Undo edit
              </Button>
            ) : null}
          </div>
          {problem ? <p className="dk-field__hint dk-field__hint--error" role="alert">{problem}</p> : null}

          <h3 className="dk-label dk-media__subhead">Used in</h3>
          {uses === null ? (
            <p className="dk-field__hint">Looking…</p>
          ) : uses === "failed" ? (
            <p className="dk-field__hint">Could not check which decks use this file.</p>
          ) : uses.decks.length === 0 ? (
            <p className="dk-field__hint" data-testid="media-unused">No deck shows this file now.</p>
          ) : (
            <ul className="dk-media__uses" data-testid="media-uses">
              {uses.decks.map((deck) => (
                <li key={deck.presentation_id}>
                  <button type="button" className="dk-media__use" onClick={() => onOpenDeck(deck.presentation_id)} disabled={deck.deleted}>
                    <span dir="auto">{deck.title}</span>
                    <span className="dk-field__hint">
                      {deck.deleted ? "in Trash" : `${deck.slide_ids.length || "no"} slide${deck.slide_ids.length === 1 ? "" : "s"}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {duplicates.length ? (
            <>
              <h3 className="dk-label dk-media__subhead">Duplicates</h3>
              <ul className="dk-media__uses">
                {duplicates.map((pair) => (
                  <li key={pair.other}>
                    <button type="button" className="dk-media__use" onClick={() => onSelect(pair.other)}>
                      <span dir="auto">{pair.asset?.filename ?? "Another file"}</span>
                      <span className="dk-field__hint">{pair.kind === "exact" ? "Exact copy" : "Looks alike"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <div className="dk-media__detail-danger">
            <Button
              variant="secondary"
              size="sm"
              icon="trash"
              onClick={onRemove}
              disabled={!editable || live.length > 0 || uses === null || !client.assets.remove}
              data-testid="media-remove"
            >
              Move to Trash
            </Button>
            <p className="dk-field__hint">
              {live.length > 0
                ? `Used in ${live.length} deck${live.length === 1 ? "" : "s"}. Remove it from those slides first.`
                : inTrashDecks.length > 0
                  ? "Only decks in Trash use it. Restoring those decks would show a gap where it was."
                  : "Removing it from a slide never deletes the file; only this does, and Trash can undo it."}
            </p>
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * Picture thumbnails, four at a time, kept for the life of the page so paging
 * or filtering back does not ask again. A failure is remembered as "no
 * thumbnail" rather than retried on every render.
 */
function useThumbnails(assets: AssistantAsset[]): Record<string, string> {
  const client = useWorkspaceClient();
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const pictures = assets.filter((asset) => asset.kind === "image" && !asset.deleted_at).map((asset) => asset.id).join(",");

  useEffect(() => {
    const assistant = client.assistant;
    if (!assistant || !pictures) return;
    let live = true;
    const queue = pictures.split(",").filter((id) => !asked.current.has(id));
    queue.forEach((id) => asked.current.add(id));
    const worker = async () => {
      while (live && queue.length) {
        const id = queue.shift()!;
        try {
          const view = await assistant.assetView(id, THUMB_PX);
          if (live) setThumbs((current) => ({ ...current, [id]: `data:${view.mime_type};base64,${view.base64}` }));
        } catch {
          /* No thumbnail: the card shows the file's kind instead. */
        }
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      live = false;
      // Unfinished ids are asked again next time.
      queue.forEach((id) => asked.current.delete(id));
    };
  }, [client, pictures]);

  return thumbs;
}
