/**
 * What the Assistant says (roadmap 08 §1.2, rules 2, 4 and 6).
 *
 * One assistant, in words a person uses: what an action does, what it works
 * on, and what leaves the computer when it runs. Never which model answered,
 * never a qualification gate, never a budget in dollars. The services report
 * all of that and this file is where it stops; the panel draws only what these
 * functions return. Pure, so the wording is testable without a panel.
 */
import type { IconName } from "../ui/icons";
import { creditCostWords } from "./credits";
import type { AssistantCapabilities, AssistantEvent, AssistantRun, AssistantTask, GenerationStatus } from "@deckastra/workspace-contracts";

export type AssistantScope = "elements" | "slide" | "deck";

export function scopeOptions(selected: number): Array<{ value: AssistantScope; label: string }> {
  return [
    ...(selected > 0 ? [{ value: "elements" as const, label: selected === 1 ? "The selected object" : `${selected} selected objects` }] : []),
    { value: "slide", label: "This slide" },
    { value: "deck", label: "The whole deck" },
  ];
}

/** The scope a fresh prompt starts on: what is selected, else the slide on screen. */
export function defaultScope(selected: number): AssistantScope {
  return selected > 0 ? "elements" : "slide";
}

/** "this slide", for the middle of a sentence. */
export function scopeWords(scope: AssistantScope, selected: number): string {
  if (scope === "elements") return selected === 1 ? "the selected object" : "the selected objects";
  return scope === "slide" ? "this slide" : "the whole deck";
}

/**
 * A quick action. `task` runs an assistant task; `languages` opens the deck's
 * languages, where a translation is chosen and reviewed (plan 01 §3.2).
 */
export interface QuickAction {
  id: string;
  label: string;
  icon: IconName;
  task?: AssistantTask;
  opens?: "languages";
  /** Needs the words in the prompt box (Add slides says what to add). */
  needsPrompt?: boolean;
  /** Works on a slide or the deck, never on a selection. */
  slidesOnly?: boolean;
  /** Reads the files attached under Sources, and needs at least one. */
  needsSources?: boolean;
  /** Also reads the attached files when there are any. */
  usesSources?: boolean;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: "fix-layout", label: "Fix layout", icon: "fit", task: "tidy", slidesOnly: true },
  { id: "alt-text", label: "Write alt text", icon: "image", task: "alt_text" },
  { id: "translate", label: "Translate", icon: "language", opens: "languages" },
  { id: "narration", label: "Write narration", icon: "mic", task: "narration", slidesOnly: true },
  { id: "motion", label: "Plan motion", icon: "motion", task: "motion", slidesOnly: true },
  { id: "add-slides", label: "Add slides", icon: "plus", task: "generate", needsPrompt: true, usesSources: true },
  { id: "research", label: "Research files", icon: "search", task: "research", needsSources: true },
];

/** Where a task's work happens, as a person would say it. */
export function whereItRuns(provider: string | undefined): "here" | "online" | "template" {
  if (provider === "engine" || provider === "local" || provider === "export") return "here";
  if (provider === "stub") return "template";
  return "online";
}

export interface ActionState {
  available: boolean;
  /** Why not, in a sentence a person can act on. */
  reason: string | null;
  /** "On this computer", "Online". Absent while capabilities are unknown. */
  where: string | null;
  /** What it holds in credits before it runs ("Up to 3 credits"), when it is paid (rule 6). */
  cost: string | null;
}

export function actionState(action: QuickAction, capabilities: AssistantCapabilities | undefined): ActionState {
  if (action.opens) return { available: true, reason: null, where: null, cost: null };
  const task = action.task ? capabilities?.tasks?.[action.task] : undefined;
  if (!capabilities) return { available: false, reason: null, where: null, cost: null };
  if (!task) return { available: false, reason: "Not available in this version.", where: null, cost: null };
  const where = whereItRuns(task.provider);
  return {
    available: task.available,
    reason: task.available ? null : plain(task.reason) ?? "Not available yet.",
    where: where === "here" ? "On this computer" : where === "template" ? "Demo" : "Online",
    cost: task.available && where === "online" ? creditCostWords(task.minimum_reservation_usd) : null,
  };
}

/**
 * The prompt box's disclosure: what is sent, to whom, when Run is pressed.
 * Named at the button (rule 6), never left to a policy page.
 */
export function promptDisclosure(
  generation: GenerationStatus | undefined,
  scope: AssistantScope,
  selected: number,
): { available: boolean; text: string } {
  const what = scopeWords(scope, selected);
  if (!generation) return { available: true, text: `Your request and ${what} are sent to the assistant when you press Run.` };
  if (!generation.available) {
    return { available: false, text: plain(generation.reason) ?? "The assistant is not set up on this computer yet." };
  }
  switch (generation.provider) {
    case "vertex":
      return { available: true, text: `Only your request and ${what} are sent to Google Cloud, when you press Run.` };
    case "local":
      return { available: true, text: "Nothing leaves this computer." };
    case "stub":
      return { available: true, text: "Demo mode: changes come from a template and nothing is sent." };
    default:
      return { available: true, text: `Only your request and ${what} are sent online, when you press Run.` };
  }
}

/** One line of progress. The service's provider and model names stay out of it. */
export function progressWords(run: AssistantRun | null, latest: AssistantEvent | undefined): string {
  if (!run) return "";
  if (run.cancel_requested && (run.status === "queued" || run.status === "running")) return "Stopping…";
  switch (run.status) {
    case "queued":
      return "Starting…";
    case "running": {
      // The service's own line only when it is in plain words; otherwise the
      // run is simply working, which is all a person needs to know.
      const said = latest?.message;
      return said && plain(said) === said ? said : "Working…";
    }
    case "completed": {
      const said = run.result?.summary;
      return said && plain(said) === said ? said : "Done.";
    }
    case "failed":
      return "It did not finish.";
    case "cancelled":
      return "Stopped.";
    case "interrupted":
      return "Interrupted. Its saved work can be resumed from History.";
    default:
      return "";
  }
}

export const TASK_NAMES: Record<AssistantTask, string> = {
  generate: "Add slides",
  edit: "Change",
  tidy: "Fix layout",
  alt_text: "Alt text",
  consistency: "Consistency",
  translation: "Translate",
  narration: "Narration",
  motion: "Motion",
  organise: "Organise pictures",
  research: "Research",
  image: "Picture",
  speech: "Voice",
  export: "Export",
};

/**
 * A service sentence with engineering words in it says nothing a person can
 * act on, so it is replaced rather than shown. A sentence without them is kept,
 * because it is usually the useful part ("Select a slide with pictures").
 */
// No word boundary in front: "DECKASTRA_VERTEX_PROJECT" hides a vendor name
// behind an underscore, which is a word character.
const ENGINEERING = /(model|qualif|provider|token|reservation|local-only|gemma|anthropic|vertex|gguf|llama|credential|determinis)/i;
// A setting name of any kind is engineering by itself. Case-sensitive, so an
// ordinary snake_case word in a sentence is not read as one.
const SETTING = /[A-Z]{3,}_[A-Z0-9_]{3,}/;

export function plain(sentence: string | null | undefined): string | null {
  if (!sentence) return null;
  return ENGINEERING.test(sentence) || SETTING.test(sentence) ? "Not set up yet." : sentence;
}

/**
 * The service's sentence when it is in plain words, else `fallback`: a
 * sentence written for the place it is shown, rather than "Not set up yet."
 * where that would be false (a provider that is working, named in engineering
 * words).
 */
export function serviceWords(sentence: string | null | undefined, fallback: string): string {
  return sentence && plain(sentence) === sentence ? sentence : fallback;
}
