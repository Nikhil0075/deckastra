import { useEffect, useRef, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AssistantCapabilities, AssistantEvent, AssistantRun, AssistantTask, AssistantAsset } from "@deckastra/workspace-contracts";
import type { EditorApi } from "../lib/useEditor";
import { sourceLocale } from "@deckastra/presentation-schema";
import { Button } from "../ui";

const TASKS: [AssistantTask, string][] = [
  ["tidy", "Fix design findings"], ["alt_text", "Write missing alt text"], ["consistency", "Improve consistency"],
  ["edit", "Edit presentation"], ["generate", "Generate slide content"], ["research", "Research topic"],
  ["translation", "Translate"], ["narration", "Write narration scripts"], ["speech", "Create spoken narration"],
  ["motion", "Improve motion"], ["organise", "Organise assets"], ["image", "Create an image"], ["export", "Export"],
];
const active = (run?: AssistantRun | null) => run?.status === "queued" || run?.status === "running";

export function AssistantPanel({ editor, presentationId, onCompleted }: { editor: EditorApi; presentationId: string; onCompleted: () => void }) {
  const api = useWorkspaceClient().assistant;
  const [capabilities, setCapabilities] = useState<AssistantCapabilities>();
  const [task, setTask] = useState<AssistantTask>("tidy");
  const [scope, setScope] = useState<"slide" | "deck" | "elements">("slide");
  const [instruction, setInstruction] = useState("");
  const [replaceMotion, setReplaceMotion] = useState(false);
  const [locale, setLocale] = useState("en");
  const [voice, setVoice] = useState("default");
  const [format, setFormat] = useState<"pdf" | "pptx">("pdf");
  const [web, setWeb] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [generationMode, setGenerationMode] = useState<"append" | "replace">("append");
  const [researchRunId, setResearchRunId] = useState<string>();
  const [assets, setAssets] = useState<AssistantAsset[]>([]);
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [history, setHistory] = useState<AssistantRun[]>([]);
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const handled = useRef(new Set<string>());
  const callbacks = useRef({ editor, onCompleted });
  callbacks.current = { editor, onCompleted };
  const runId = run?.id;
  const polling = active(run);
  const slideId = scope === "deck" ? undefined : editor.sourceDocument.slides[editor.slideIndex]?.id;

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    Promise.all([api.list(presentationId, { signal: controller.signal }), api.assetList({ limit: 100 }, { signal: controller.signal })])
      .then(([past, library]) => {
        if (controller.signal.aborted) return;
        setHistory(past.runs); setAssets(library.assets.filter((asset) => ["application/pdf", "text/plain", "text/csv"].includes(asset.content_type ?? "")));
        setRun(past.runs.find(active) ?? null);
      }).catch((e) => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => controller.abort();
  }, [api, presentationId]);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api.capabilities({ signal: controller.signal, presentationId, slideId, locale }).then((value) => {
      if (!controller.signal.aborted) setCapabilities(value);
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [api, presentationId, slideId, locale]);

  useEffect(() => {
    if (!api || !runId || !polling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    async function poll() {
      try {
        const [current, progress] = await Promise.all([api!.get(runId!, { signal: controller.signal }), api!.events(runId!, cursor, { signal: controller.signal })]);
        if (controller.signal.aborted) return;
        setError("");
        if (progress.events.length) {
          cursor = progress.events[progress.events.length - 1]!.sequence;
          setEvents((previous) => [...previous.filter((e) => e.sequence > cursor - 100), ...progress.events.filter((e) => !previous.some((p) => p.sequence === e.sequence))].slice(-100));
        }
        if (active(current)) { setRun(current); timer = setTimeout(poll, 700); }
        else {
          setHistory((previous) => [current, ...previous.filter((p) => p.id !== current.id)]);
          if (!handled.current.has(current.id)) {
            handled.current.add(current.id);
            callbacks.current.onCompleted();
            const output = current.result;
            if (output?.document && output.version_id) {
              const editor = callbacks.current.editor;
              if (!(await editor.saveNow()) || !editor.adoptDocument(output.document, output.version_id)) {
                if (!controller.signal.aborted) setError("The assistant applied a change, but newer local edits need reconciliation. Your edits are retained.");
              }
            }
          }
          const updatedCapabilities = await api!.capabilities({ signal: controller.signal, presentationId, slideId, locale });
          if (!controller.signal.aborted) { setCapabilities(updatedCapabilities); setRun(current); }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          timer = setTimeout(poll, 2500);
        }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, runId, polling]);

  if (!api) return <p className="dk-muted">This workspace service does not support the assistant yet.</p>;
  const availability = capabilities?.tasks[task];
  async function start() {
    if (!api) return;
    setError(""); setStarting(true);
    try {
      if (!(await editor.saveNow())) throw new Error("Save your latest edits before starting the assistant.");
      const slideId = editor.sourceDocument.slides[editor.slideIndex]?.id;
      const chosenScope = task === "generate" ? "deck" : scope;
      const chosenLocale = task === "export" ? editor.locale ?? sourceLocale(editor.sourceDocument) : locale;
      const next = await api.start({ task, presentation_id: presentationId, expected_version_id: editor.currentVersionId(), operation_key: crypto.randomUUID(), instruction, locale: chosenLocale, voice, export_kind: format, source_asset_ids: sources, web_search: web, generation_mode: generationMode, research_run_id: task === "generate" ? researchRunId : undefined, motion_replace: task === "motion" ? replaceMotion : undefined,
        scope: { kind: chosenScope, slide_ids: chosenScope === "deck" ? [] : slideId ? [slideId] : [], element_ids: chosenScope === "elements" ? editor.selection.selectedIds : [] } });
      setEvents([]); setRun(next);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(false); }
  }
  async function control(action: "cancel" | "resume", id: string) {
    try { setEvents([]); setRun(await api![action](id)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function viewHistory(id: string) {
    try {
      const [past, progress] = await Promise.all([api!.get(id), api!.events(id, 0)]);
      setEvents(progress.events); setRun(past); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const latest = events[events.length - 1];
  return <div className="dk-assistant" data-testid="assistant-panel">
    <p className="dk-muted">Cleanup and motion use the editor's engines. Model tasks require representative qualification; local-only mode allows experimental Gemma runs.</p>
    {capabilities?.spend && <p className="dk-muted">Cloud budget: US${capabilities.spend.remaining_usd.toFixed(4)} remaining of US${capabilities.spend.ceiling_usd.toFixed(2)}. {capabilities.spend.reserved_usd > 0 && `US$${capabilities.spend.reserved_usd.toFixed(4)} reserved for pending or uncertain requests.`}</p>}
    <div aria-label="Assistant shortcuts" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Button size="sm" disabled={polling || !capabilities?.tasks.tidy?.available} onClick={() => { setTask("tidy"); setScope("slide"); }}>Clean up slide</Button>
      <Button size="sm" disabled={polling || !capabilities?.tasks.narration?.available} onClick={() => { setTask("narration"); setScope("slide"); }}>Write script</Button>
    </div>
    <label>Task<select aria-label="Assistant task" value={task} onChange={(e) => setTask(e.target.value as AssistantTask)}>{TASKS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>Scope<select aria-label="Assistant scope" value={task === "generate" ? "deck" : scope} disabled={task === "generate"} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="slide">Current slide</option><option value="deck">Entire deck</option><option value="elements" disabled={!editor.selection.selectedIds.length}>Selected objects</option></select></label>
    {task === "tidy" || task === "motion"
      ? <p className="dk-muted">{task === "tidy" ? "Cleanup applies the editor's Design Check fixes. It does not read written instructions." : "Motion uses the editor's motion planner. It does not read written instructions."}</p>
      : <label>Instructions<textarea aria-label="Assistant instructions" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Describe the result you want" maxLength={4000} /></label>}
    {task === "motion" && <><label><input type="checkbox" aria-label="Replace existing animation" checked={replaceMotion} onChange={(e) => setReplaceMotion(e.target.checked)} /> Replace existing animation</label>
      <p className="dk-muted">{replaceMotion ? "Slides with animation are re-planned with the same number of clicks; a slide whose clicks cannot be rebuilt keeps its own. The change waits for your review in Proposals." : "Slides that already have animation are left as they are."}</p></>}
    {task === "generate" && <><label>Generate<select aria-label="Generation mode" value={generationMode} onChange={(e) => setGenerationMode(e.target.value as typeof generationMode)}><option value="append">Add slides to this deck</option><option value="replace">Replace all existing slides</option></select></label>{generationMode === "replace" && <p role="alert">This proposes removing all {editor.sourceDocument.slides.length} existing slides. Review the replacement in Proposals before applying.</p>}{researchRunId && <p className="dk-muted">Using the selected completed research run as an attached source.</p>}</>}
    {(task === "translation" || task === "speech") && <label>Language<input aria-label="Assistant language" value={locale} onChange={(e) => setLocale(e.target.value)} /></label>}
    {task === "speech" && <label>Voice<input aria-label="Assistant voice" value={voice} onChange={(e) => setVoice(e.target.value)} /></label>}
    {task === "export" && <label>Format<select aria-label="Assistant export format" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}><option value="pdf">PDF</option><option value="pptx">PowerPoint</option></select></label>}
    {(task === "research" || task === "generate") && <fieldset><legend>Research sources</legend><label><input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> Search the web through Vertex</label>{assets.map((asset) => <label key={asset.id}><input type="checkbox" checked={sources.includes(asset.id)} onChange={(e) => setSources((previous) => e.target.checked ? [...previous, asset.id] : previous.filter((id) => id !== asset.id))} />{asset.filename ?? "Untitled asset"}</label>)}</fieldset>}
    {availability?.reason && <p className="dk-muted">{availability.reason}</p>}
    {availability?.available && <p className="dk-muted">{availability.provider === "local" ? "Gemma E2B" : availability.provider === "vertex" ? "Vertex AI" : availability.provider === "engine" ? "Editor engine" : availability.provider}{availability.model ? ` · ${availability.model}` : ""}</p>}
    <Button variant="primary" disabled={starting || polling || !availability?.available} onClick={() => void start()}>{starting ? "Starting…" : "Run assistant"}</Button>
    {polling && run && <Button disabled={run.cancel_requested} onClick={() => void control("cancel", run.id)}>{run.cancel_requested ? "Cancelling…" : "Cancel"}</Button>}
    <div role="status" aria-live="polite">{latest?.provider ? `${latest.provider === "local" ? "Gemma E2B" : latest.provider === "vertex" ? "Vertex AI" : latest.provider === "engine" ? "Editor engine" : latest.provider}: ${latest.reason ?? latest.message ?? "Working"}` : latest?.message ?? run?.status ?? "Ready"}</div>
    {(error || run?.error) && <p role="alert">{error || run?.error}</p>}
    {run?.result?.summary && <p>{run.result.summary}</p>}
    {run?.result?.warnings?.map((warning, i) => <p key={i} className="dk-muted">{warning}</p>)}
    {run?.result?.research && <p style={{ whiteSpace: "pre-wrap" }}>{run.result.research}</p>}
    {run?.result?.research && <Button size="sm" onClick={() => { setResearchRunId(run.id); setTask("generate"); }}>Use research to generate slides</Button>}
    {run?.result?.clarification && <p role="status">{run.result.clarification}</p>}
    {run?.result?.status === "pending_metadata" && <><p className="dk-muted">Review proposed asset descriptions and tags before saving.</p>{run.result.metadata_proposal?.map((item) => <p key={item.asset_id}>{item.asset_id}: {item.description} · {item.tags.join(", ")}</p>)}<Button onClick={() => void api.approveMetadata(run.id).then(setRun).catch((e) => setError(e.message))}>Approve asset metadata</Button></>}
    {run?.result?.status === "pending" && <p className="dk-muted">Review this change in Proposals before applying it.</p>}
    {run?.result?.export && <p className="dk-muted">Export queued. Open Export to see its progress and download the file.</p>}
    {run?.result?.sources?.map((source, i) => source.url?.startsWith("https://") ? <a key={i} href={source.url} target="_blank" rel="noreferrer">{source.title || "Source"}</a> : <p key={i}>{source.title ?? source.id}</p>)}
    {run?.result?.assets?.map((asset) => <p key={asset.id}>{asset.filename}{asset.change_id && <Button size="sm" onClick={() => void api.assetRevert(asset.id, asset.change_id!).catch((e) => setError(e.message))}>Undo metadata change</Button>}</p>)}
    {run?.budget && <p className="dk-muted">Spent ${Number(run.budget.used_cost_usd ?? 0).toFixed(4)} · Reserved ${Number(run.budget.reserved_cost_usd ?? 0).toFixed(4)}</p>}
    <details><summary>Run history</summary>{history.map((past) => <div key={past.id}><Button size="sm" disabled={polling && past.id !== runId} onClick={() => void viewHistory(past.id)}>{past.task}: {past.status}</Button>{past.status === "interrupted" && <Button size="sm" disabled={polling} onClick={() => void control("resume", past.id)}>Resume saved work</Button>}</div>)}</details>
  </div>;
}
