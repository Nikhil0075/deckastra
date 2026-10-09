import type { AccountContext, PresentationSummary, RequestOptions, WorkspaceClient } from "@deckastra/workspace-contracts";

import { parseServerTime } from "./deck-list";

/**
 * The home sidebar's views (roadmap 08 §1.3, concept 08-home.png): every deck,
 * the recent ones, one project, and the trash.
 *
 * The service lists one project at a time, so "every deck" is one request per
 * project, merged. That costs a request per project rather than a new route,
 * and it inherits each project's own access rule exactly: a project the person
 * cannot read is simply not listed by `/v1/account`.
 */
export type DeckView = { kind: "project"; projectId: string } | { kind: "all" } | { kind: "recent" } | { kind: "trash" };

/** A deck, with where it lives: the cross-project views say which project. */
export interface ListedDeck extends PresentationSummary {
  projectId: string;
  projectName: string;
  /** False where the person may only view the project. */
  editable: boolean;
}

/** How many decks Recent shows. A view of what someone was just doing, not a second list of everything. */
export const RECENT_LIMIT = 12;

export function viewKey(view: DeckView): string {
  return view.kind === "project" ? `project:${view.projectId}` : view.kind;
}

export function viewTitle(view: DeckView, account: AccountContext | null): string {
  switch (view.kind) {
    case "all":
      return "All decks";
    case "recent":
      return "Recent";
    case "trash":
      return "Trash";
    case "project":
      for (const workspace of account?.workspaces ?? []) {
        const found = workspace.projects.find((project) => project.id === view.projectId);
        if (found) return found.name;
      }
      return "Decks";
  }
}

interface Located {
  projectId: string;
  projectName: string;
  editable: boolean;
}

function projectsOf(account: AccountContext): Located[] {
  return account.workspaces.flatMap((workspace) =>
    workspace.projects.map((project) => ({ projectId: project.id, projectName: project.name, editable: workspace.role !== "viewer" })),
  );
}

const newest = (field: "updated_at" | "deleted_at") => (a: ListedDeck, b: ListedDeck) => {
  const at = (deck: ListedDeck) => {
    const value = deck[field];
    const time = value ? parseServerTime(value) : Number.NaN;
    return Number.isFinite(time) ? time : 0;
  };
  return at(b) - at(a) || a.title.localeCompare(b.title);
};

/**
 * The decks a view shows. A project that cannot be read fails the whole view
 * rather than quietly leaving its decks out: "All decks" missing a project's
 * worth of work, with nothing said, reads as the work being gone.
 */
export async function loadView(
  client: WorkspaceClient,
  account: AccountContext,
  view: DeckView,
  options: RequestOptions = {},
): Promise<ListedDeck[]> {
  const all = projectsOf(account);
  const wanted = view.kind === "project" ? all.filter((project) => project.projectId === view.projectId) : all;
  const read = (project: Located) =>
    (view.kind === "trash" ? client.documents.trash(project.projectId, options) : client.documents.list(project.projectId, options)).then(
      (decks) => decks.map((deck) => ({ ...deck, ...project })),
    );
  const decks = (await Promise.all(wanted.map(read))).flat();
  switch (view.kind) {
    case "trash":
      return decks.sort(newest("deleted_at"));
    case "recent":
      return decks.sort(newest("updated_at")).slice(0, RECENT_LIMIT);
    case "all":
      return decks.sort(newest("updated_at"));
    case "project":
      // Already in the service's order: most recently changed first.
      return decks;
  }
}
