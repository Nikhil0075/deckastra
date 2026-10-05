import { useEffect, useRef, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type {
  AgentEditResult,
  AssistantCapabilities,
  AssistantEvent,
  AssistantRun,
  GenerationStatus,
} from "@deckastra/workspace-contracts";

import {
  QUICK_ACTIONS,
  TASK_NAMES,
  actionState,
  defaultScope,
  plain,
  progressWords,
  promptDisclosure,
  scopeOptions,
  type AssistantScope,
  type QuickAction,
} from "../lib/assistant-words";
import type { EditorApi } from "../lib/useEditor";
import { MAX_SOURCES, attachSource, type AttachedSource } from "../lib/assistant-sources";
import { Button, IconButton, Section, Select, StatusChip } from "../ui";
import { Icon } from "../ui/icons";
import { CreditsMeter } from "./CreditsMeter";
import { CriticIssues } from "./CriticIssues";
import { LanguagesPanel } from "./LanguagesPanel";
import { ProposalsPanel } from "./ProposalsPanel";
import { SourcesPanel } from "./SourcesPanel";

const running = (run?: AssistantRun | null) => run?.status === "queued" || run?.status === "running";

type AskPhase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "waiting" }
  | { kind: "done"; message: string; transactionId?: string }
  | { kind: "error"; message: string };

export interface AssistantPanelProps {
  editor: EditorApi;
  presentationId: string;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** Controlled by the shell, so the bar's language menu can open it. */
  languagesOpen?: boolean;
  onLanguagesOpen?: (open: boolean) => void;
  onClose?: () => void;
  /** Bumped each time the panel is asked for, to put the caret in the prompt. */
  focusToken?: number;
  /** Words handed over with that request (the command palette's "Ask the assistant"). Never sent by itself. */
  initialPrompt?: string;
}

/**
 * The one assistant (roadmap 08 §1.2 rule 2, concept `08-assistant.png`).
 *
 * Ask, the task form and AI mode were three ways to the same thing. This is
 * one: a prompt box with a scope, quick actions for the jobs people repeat,
 * what is waiting for a decision as Before and After pictures, and the deck's
 * review issues, sources, languages and history below.
 *
 * The prompt box keeps Ask's contract exactly. It sends words and a scope and
 * never applies anything itself: the server decides from the operations whether
 * the change is small enough to apply now (it comes back applied, with Undo) or
 * has to wait for a person (it appears under "Waiting for you"). Quick actions
 * run the existing assistant tasks unchanged. Everything this panel says about
 * them goes through `lib/assistant-words.ts`, so no provider, model or dollar
 * figure reaches the screen (rule 4), and what leaves the computer is said at
 * the button (rule 6).
 */
export function AssistantPanel({
  editor,
  presentationId,
  resolveAssetUrl,
  languagesOpen,
  onLanguagesOpen,
  onClose,
  focusToken = 0,
  initialPrompt,
}: AssistantPanelProps) {
  const client = useWorkspaceClient();
  const api = client.assistant;
  const selected = editor.selection.selectedIds.length;
  const slide = editor.sourceDocument.slides[editor.slideIndex];

  const [prompt, setPrompt] = useState("");
  const [scope, setScope] = useState<AssistantScope>(() => defaultScope(selected));
  const [ask, setAsk] = useState<AskPhase>({ kind: "idle" });
  const [generation, setGeneration] = useState<GenerationStatus>();
  const [capabilities, setCapabilities] = useState<AssistantCapabilities>();
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [history, setHistory] = useState<AssistantRun[]>([]);
  // Whether the history has been read: "Nothing yet" is a claim, and before the
  // answer arrives it would be a guess (roadmap 08 rule 5).
  const [historyState, setHistoryState] = useState<"reading" | "read" | "failed">("reading");
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState<string | null>(null);
  const [replaceMotion, setReplaceMotion] = useState(false);
  // Files the assistant reads: Research and Add slides name them on the request.
  const [sources, setSources] = useState<AttachedSource[]>([]);
  const [attaching, setAttaching] = useState(false);
  const sourceInput = useRef<HTMLInputElement | null>(null);
  const [generationMode, setGenerationMode] = useState<"append" | "replace">("append");
  const [pending, setPending] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const languages = useRef<HTMLDivElement | null>(null);
  const handled = useRef(new Set<string>());
  const callbacks = useRef({ editor });
  callbacks.current = { editor };

  // A selection made or cleared while the panel is open moves the scope with
  // it, but only between "the selection" and "this slide": a person who chose
  // the whole deck keeps it.
  useEffect(() => {
    setScope((current) => (current === "deck" ? current : defaultScope(selected)));
  }, [selected]);

  // Languages asked for by name (the bar's language menu, Translate) is brought
  // to the top: below the prompt and the quick actions it opened out of sight.
  useEffect(() => {
    if (languagesOpen) languages.current?.scrollIntoView?.({ block: "start" });
  }, [languagesOpen]);

  useEffect(() => {
    if (!focusToken) return;
    if (initialPrompt) setPrompt(initialPrompt);
    input.current?.focus();
    // Read when the panel is asked for, not on every change to the words.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  useEffect(() => {
    const controller = new AbortController();
    client.session
      .account({ signal: controller.signal })
      .then((account) => {
        if (!controller.signal.aborted) setGeneration(account.capabilities?.generation);
      })
      .catch(() => {
        /* An older server says nothing; the disclosure then claims nothing specific. */
      });
    return () => controller.abort();
  }, [client]);

  const runId = run?.id;
  const polling = running(run);
  const slideId = scope === "deck" ? undefined : slide?.id;

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api
      .list(presentationId, { signal: controller.signal })
      .then((past) => {
        if (controller.signal.aborted) return;
        setHistory(past.runs);
        setHistoryState("read");
        setRun(past.runs.find(running) ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryState("failed");
      });
    return () => controller.abort();
  }, [api, presentationId]);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api
      .capabilities({ signal: controller.signal, presentationId, slideId })
      .then((value) => {
        if (!controller.signal.aborted) setCapabilities(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [api, presentationId, slideId]);

  useEffect(() => {
    if (!api || !runId || !polling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    async function poll() {
      try {
        const [current, progress] = await Promise.all([
          api!.get(runId!, { signal: controller.signal }),
          api!.events(runId!, cursor, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setError("");
        if (progress.events.length) {
          cursor = progress.events[progress.events.length - 1]!.sequence;
          setEvents((previous) => [...previous, ...progress.events].slice(-50));
        }
        if (running(current)) {
          setRun(current);
          timer = setTimeout(poll, 700);
          return;
        }
        setHistory((previous) => [current, ...previous.filter((p) => p.id !== current.id)]);
        if (!handled.current.has(current.id)) {
          handled.current.add(current.id);
          setRefreshToken((count) => count + 1);
          const output = current.result;
          if (output?.document && output.version_id) {
            const latest = callbacks.current.editor;
            if (!(await latest.saveNow()) || !latest.adoptDocument(output.document, output.version_id)) {
              if (!controller.signal.aborted) {
                setError("The assistant made its change, but you have newer edits here. Your edits are kept.");
              }
            }
          }
        }
        if (!controller.signal.aborted) setRun(current);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(message(e));
          timer = setTimeout(poll, 2500);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, runId, polling]);

  // ------------------------------------------------------------------ prompt

  const disclosure = promptDisclosure(generation, scope, selected);
  const canAsk = prompt.trim() !== "" && ask.kind !== "working" && disclosure.available;

  async function savedFirst(fail: (text: string) => void): Promise<boolean> {
    if (await editor.saveNow()) return true;
    fail("Your latest edits are not saved yet. Save them, then try again.");
    return false;
  }

  function adopt(document: PresentationDocument, versionId: string) {
    if (!editor.adoptDocument(document, versionId)) {
      throw new Error("The change was made, but you have newer edits here. Your edits are kept.");
    }
  }

  async function sendPrompt() {
    setAsk({ kind: "working" });
    if (!(await savedFirst((text) => setAsk({ kind: "error", message: text })))) return;
    try {
      const result: AgentEditResult = await client.agent.edit(presentationId, {
        instruction: prompt,
        scope: {
          kind: scope,
          slide_ids: scope !== "deck" && slide ? [slide.id] : [],
          element_ids: scope === "elements" ? editor.selection.selectedIds : [],
          sources: [],
        },
      });
      if (result.outcome === "none") {
        setAsk({ kind: "error", message: result.refusal ?? "No change was suggested." });
        return;
      }
      if (result.outcome === "applied" && result.document && result.version_id) {
        adopt(result.document as PresentationDocument, result.version_id);
        setPrompt("");
        setAsk({
          kind: "done",
          message: `Done. ${result.changes[0]?.reason ?? ""}`.trim(),
          transactionId: result.transaction_id ?? undefined,
        });
        return;
      }
      // Too large to apply without a look: it waits below, with pictures.
      setPrompt("");
      setAsk({ kind: "waiting" });
      setRefreshToken((count) => count + 1);
    } catch (e) {
      setAsk({ kind: "error", message: message(e) });
    }
  }

  async function undoAsk(transactionId: string) {
    setAsk({ kind: "working" });
    if (!(await savedFirst((text) => setAsk({ kind: "error", message: text })))) return;
    try {
      const reverted = await client.agent.revert(presentationId, transactionId);
      adopt(reverted.document as PresentationDocument, reverted.version_id);
      setAsk({ kind: "done", message: "Undone." });
    } catch (e) {
      // Usually a later edit moved what the undo depends on; the server says so.
      setAsk({ kind: "error", message: message(e) });
    }
  }

  // ----------------------------------------------------------- quick actions

  async function quick(action: QuickAction) {
    if (action.opens === "languages") {
      onLanguagesOpen?.(true);
      languages.current?.scrollIntoView?.({ block: "start" });
      return;
    }
    if (!api || !action.task) return;
    if (action.needsSources && sources.length === 0) {
      setError("Attach a PDF, CSV or text file under Sources first, then press Research files.");
      return;
    }
    if (action.needsPrompt && !prompt.trim()) {
      setError("Say what the new slides should cover in the box above, then press Add slides.");
      input.current?.focus();
      return;
    }
    setError("");
    setAsk({ kind: "idle" });
    setStarting(action.id);
    try {
      if (!(await editor.saveNow())) throw new Error("Your latest edits are not saved yet. Save them, then try again.");
      const kind: AssistantScope =
        action.task === "generate" ? "deck" : action.slidesOnly && scope === "elements" ? "slide" : scope;
      const next = await api.start({
        task: action.task,
        presentation_id: presentationId,
        expected_version_id: editor.currentVersionId(),
        operation_key: crypto.randomUUID(),
        instruction: action.needsPrompt ? prompt : "",
        scope: {
          kind,
          slide_ids: kind === "deck" || !slide ? [] : [slide.id],
          element_ids: kind === "elements" ? editor.selection.selectedIds : [],
        },
        ...(action.task === "motion" ? { motion_replace: replaceMotion } : {}),
        ...(action.task === "generate" ? { generation_mode: generationMode } : {}),
        ...((action.needsSources || action.usesSources) && sources.length ? { source_asset_ids: sources.map((source) => source.id) } : {}),
      });
      if (action.needsPrompt) setPrompt("");
      setEvents([]);
      setRun(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setStarting(null);
    }
  }

  async function control(action: "cancel" | "resume", id: string) {
    try {
      setEvents([]);
      setRun(await api![action](id));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }

  const latest = events[events.length - 1];
  const progress = progressWords(run, latest);
  const issues = editor.document.extensions?.["deckastra.unresolvedIssues"];
  const languageCount = 1 + Object.keys(editor.sourceDocument.locales ?? {}).length;

  return (
    <div className="dk-modepanel dk-assistant" data-testid="assistant-panel">
      <header className="dk-assistant__head">
        <h2 className="dk-assistant__title">Assistant</h2>
        {/* What AI costs is shown where it is spent (rule 6). */}
        <CreditsMeter refreshToken={refreshToken} />
        {onClose ? <IconButton icon="close" label="Close the assistant" size="sm" onClick={onClose} data-testid="close-assistant" /> : null}
      </header>

      <div className="dk-assistant__prompt">
        <textarea
          ref={input}
          className="dk-assistant__input"
          aria-label="Ask the assistant"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl+K goes on to the shell, which opens the command palette.
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") return;
            // Enter sends; Shift+Enter is a new line. Kept from the canvas,
            // where every key is a shortcut.
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey && canAsk) {
              event.preventDefault();
              void sendPrompt();
            }
          }}
          rows={3}
          maxLength={4000}
          placeholder="Ask for a change to this slide or the whole deck…"
          data-testid="assistant-input"
        />
        <div className="dk-assistant__row">
          <Select
            label="Works on"
            hideLabel
            value={scope}
            options={scopeOptions(selected)}
            onChange={setScope}
            data-testid="assistant-scope"
          />
          <Button variant="primary" size="sm" disabled={!canAsk} onClick={() => void sendPrompt()} data-testid="assistant-run">
            {ask.kind === "working" ? "Working…" : "Run"}
          </Button>
        </div>
      </div>

      {ask.kind === "error" ? (
        <p className="dk-assistant__error" role="alert">
          {ask.message}
        </p>
      ) : null}
      {ask.kind === "waiting" ? (
        <p className="dk-muted" role="status">
          This change is large enough to look at first. It is waiting for you below.
        </p>
      ) : null}
      {ask.kind === "done" ? (
        <div className="dk-assistant__done" role="status">
          <span>{ask.message}</span>
          {ask.transactionId ? (
            <Button size="sm" variant="ghost" onClick={() => void undoAsk(ask.transactionId!)} data-testid="assistant-undo">
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="dk-assistant__actions" role="group" aria-label="Quick actions">
        {QUICK_ACTIONS.map((action) => {
          const state = actionState(action, capabilities);
          const offered = action.opens ? Boolean(onLanguagesOpen) : Boolean(api);
          if (!offered) return null;
          return (
            <button
              key={action.id}
              type="button"
              className="dk-assistant__action"
              disabled={!state.available || polling || starting !== null}
              title={state.reason ?? undefined}
              onClick={() => void quick(action)}
              data-testid={`assistant-action-${action.id}`}
            >
              <Icon name={action.icon} size={16} />
              <span className="dk-assistant__action-label">{starting === action.id ? "Starting…" : action.label}</span>
              {state.where || state.reason ? (
                <span className="dk-assistant__action-meta">
                  {state.reason ?? (state.cost ? `${state.where} · ${state.cost}` : state.where)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {api ? (
        <details className="dk-assistant__options">
          <summary>Options</summary>
          <label className="dk-check">
            <input type="checkbox" checked={replaceMotion} onChange={(event) => setReplaceMotion(event.target.checked)} />
            Plan motion replaces animation that is already there
          </label>
          <Select
            label="Add slides"
            value={generationMode}
            options={[
              { value: "append", label: "After the slides already here" },
              { value: "replace", label: "Instead of the slides already here" },
            ]}
            onChange={setGenerationMode}
          />
          {generationMode === "replace" ? (
            <p role="alert" className="dk-assistant__error">
              This suggests removing all {editor.sourceDocument.slides.length} slides. Nothing changes until you apply it.
            </p>
          ) : null}
        </details>
      ) : null}

      {run && progress ? (
        <div className="dk-assistant__run" data-testid="assistant-progress">
          <span role="status" aria-live="polite">
            <strong>{TASK_NAMES[run.task] ?? "Assistant"}:</strong> {progress}
          </span>
          {polling ? (
            <Button size="sm" variant="ghost" disabled={run.cancel_requested} onClick={() => void control("cancel", run.id)}>
              {run.cancel_requested ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {run && !polling ? <RunResult run={run} onApproveMetadata={() => void api!.approveMetadata(run.id).then(setRun).catch((e) => setError(message(e)))} /> : null}
      {error || run?.error ? (
        <p className="dk-assistant__error" role="alert">
          {error || plain(run?.error) || "It did not finish."}
        </p>
      ) : null}

      <p className="dk-assistant__sent" data-testid="assistant-disclosure">
        {disclosure.text}
      </p>

      <Section
        title="Waiting for you"
        defaultOpen
        meta={pending ? <StatusChip tone="waiting">{pending} waiting</StatusChip> : undefined}
        data-testid="ai-pending"
      >
        <ProposalsPanel
          presentationId={presentationId}
          // The saved deck, drawn in the language on screen.
          document={editor.sourceDocument}
          locale={editor.locale}
          refreshToken={refreshToken}
          onApplied={editor.adoptDocument}
          saveNow={editor.saveNow}
          currentVersionId={editor.currentVersionId}
          onCount={setPending}
        />
      </Section>
      <div ref={languages}>
        <Section
          title="Languages"
          meta={`${languageCount} language${languageCount === 1 ? "" : "s"}`}
          {...(languagesOpen === undefined ? {} : { open: languagesOpen, onOpenChange: onLanguagesOpen })}
          data-testid="ai-languages"
        >
          <LanguagesPanel
            editor={editor}
            presentationId={presentationId}
            resolveAssetUrl={resolveAssetUrl}
            onProposed={() => setRefreshToken((count) => count + 1)}
          />
        </Section>
      </div>
      <Section title="Review issues">
        <CriticIssues value={issues} slideId={slide?.id} />
        {issues ? null : <p className="dk-muted">Nothing open on this deck.</p>}
      </Section>
      <Section title="Sources" meta={sources.length ? `${sources.length} attached` : slide ? `Slide ${editor.slideIndex + 1}` : undefined} data-testid="assistant-sources">
        {api ? (
          <div className="dk-assistant__sources">
            <p className="dk-muted">
              Files for the assistant to read: Research files and Add slides use them. Code repositories ground a new deck from the home.
            </p>
            {sources.length ? (
              <ul className="dk-assistant__source-list">
                {sources.map((source) => (
                  <li key={source.id} data-testid="assistant-source">
                    <span>{source.name}</span>
                    <IconButton
                      icon="close"
                      label={`Remove ${source.name}`}
                      size="sm"
                      onClick={() => setSources((current) => current.filter((item) => item.id !== source.id))}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              icon="upload"
              disabled={attaching || sources.length >= MAX_SOURCES}
              onClick={() => sourceInput.current?.click()}
              data-testid="assistant-attach"
            >
              {attaching ? "Attaching…" : "Attach PDF, CSV or text"}
            </Button>
            <input
              ref={sourceInput}
              type="file"
              accept=".pdf,.csv,.txt"
              multiple
              hidden
              data-testid="assistant-attach-input"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                void (async () => {
                  setAttaching(true);
                  let held = sources;
                  for (const file of files) {
                    const outcome = await attachSource(client, file, held);
                    if (!outcome.ok) {
                      setError(outcome.message);
                      break;
                    }
                    held = [...held, outcome.source];
                    setSources(held);
                  }
                  setAttaching(false);
                })();
              }}
            />
          </div>
        ) : null}
        {slide ? <SourcesPanel key={slide.id} presentationId={presentationId} slideId={slide.id} /> : null}
      </Section>
      {api ? (
        <Section title="History" meta={history.length ? `${history.length}` : undefined} data-testid="assistant-history">
          {historyState === "reading" ? (
            <p className="dk-muted" role="status">
              Reading…
            </p>
          ) : historyState === "failed" && history.length === 0 ? (
            <p className="dk-assistant__error" role="alert">
              The history could not be read. It will be tried again when this panel opens.
            </p>
          ) : history.length === 0 ? (
            <p className="dk-muted">Nothing yet.</p>
          ) : null}
          <ul className="dk-assistant__history">
            {history.map((past) => (
              <li key={past.id}>
                <span>{TASK_NAMES[past.task] ?? past.task}</span>
                <span className="dk-muted">{progressWords(past, undefined)}</span>
                {past.status === "interrupted" ? (
                  <Button size="sm" variant="ghost" disabled={polling} onClick={() => void control("resume", past.id)}>
                    Resume
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** What a finished run left: notes, a question, sources, and anything waiting for a decision. */
function RunResult({ run, onApproveMetadata }: { run: AssistantRun; onApproveMetadata: () => void }) {
  const result = run.result;
  if (!result) return null;
  return (
    <div className="dk-assistant__result">
      {result.warnings?.map((warning, i) => (
        <p key={i} className="dk-muted">
          {plain(warning)}
        </p>
      ))}
      {result.clarification ? <p role="status">{result.clarification}</p> : null}
      {result.status === "pending" ? <p className="dk-muted">Waiting for you below.</p> : null}
      {result.export ? <p className="dk-muted">Export started. Open Share to follow it and download the file.</p> : null}
      {result.research ? <p className="dk-assistant__research">{result.research}</p> : null}
      {result.sources?.map((source, i) =>
        source.url?.startsWith("https://") ? (
          <a key={i} href={source.url} target="_blank" rel="noreferrer">
            {source.title || "Source"}
          </a>
        ) : (
          <p key={i}>{source.title ?? source.id}</p>
        ),
      )}
      {result.status === "pending_metadata" ? (
        <>
          <p className="dk-muted">Check the suggested descriptions and tags before they are saved.</p>
          {result.metadata_proposal?.map((item) => (
            <p key={item.asset_id}>
              {item.description} · {item.tags.join(", ")}
            </p>
          ))}
          <Button size="sm" onClick={onApproveMetadata}>
            Save descriptions and tags
          </Button>
        </>
      ) : null}
    </div>
  );
}

function message(error: unknown): string {
  return plain(error instanceof Error ? error.message : String(error)) ?? "Something went wrong.";
}
