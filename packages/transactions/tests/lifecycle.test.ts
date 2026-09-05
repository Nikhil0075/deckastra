import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId, serializeDocument, type PresentationDocument } from "@deckastra/presentation-schema";

import {
  History,
  PENDING_TTL_MS,
  PatchError,
  RevalidationError,
  TransactionStateError,
  applyPatch,
  approve,
  assessRisk,
  canTransition,
  createTransaction,
  disturbs,
  isExpired,
  reject,
  revert,
  touchedIds,
  transition,
  type EditCommand,
} from "../src/index";

const doc: PresentationDocument = loadFixture("technical");
const slideId = doc.slides[0]!.id;
const elementId = doc.slides[0]!.elements[0]!.id;

const edit = (value: string) => [
  { op: "replace" as const, path: `/slides/id:${slideId}/keyMessage`, value },
];

describe("insert-index guard (regression)", () => {
  it("refuses to insert past the end rather than silently clamping", () => {
    // splice() clamps an out-of-range index to the end, so the operation appears
    // to succeed while the index recorded for the inverse points at a position
    // that never existed. The undo then fails later, on a different document,
    // far from the patch that caused it. Found by the property test.
    expect(() =>
      applyPatch(doc, [{ op: "add", path: "/slides/99", value: { id: newId("sld"), elements: [] } }]),
    ).toThrow(PatchError);

    expect(() =>
      applyPatch(doc, [{ op: "move", from: `/slides/id:${slideId}`, path: "/slides/99" }]),
    ).toThrow(/Cannot insert at index 99/);

    expect(() =>
      applyPatch(doc, [{ op: "copy", from: `/slides/id:${slideId}`, path: "/slides/99" }]),
    ).toThrow(/Cannot insert at index 99/);
  });

  it("still allows index === length, which is an append", () => {
    const at = doc.slides.length;
    const { document: after } = applyPatch(doc, [
      { op: "add", path: `/slides/${at}`, value: { id: newId("sld"), elements: [] } },
    ]);
    expect(after.slides).toHaveLength(at + 1);
  });
});

describe("creating transactions", () => {
  it("captures the inverse without committing the document", () => {
    const before = serializeDocument(doc);
    const { transaction, result } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("changed"),
      intent: "Sharpen the key message",
      source: "user",
      createdBy: "usr_1",
    });

    expect(transaction.inverseOperations).toHaveLength(1);
    expect(result.document.slides[0]!.keyMessage).toBe("changed");
    // The caller decides whether to commit; that separation is what lets a
    // proposal be previewed without being applied.
    expect(serializeDocument(doc)).toBe(before);
  });

  it("defaults an agent edit to pending and a user edit to applied", () => {
    const base = {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("x"),
      intent: "i",
      createdBy: "usr_1",
    };

    expect(createTransaction(doc, { ...base, source: "agent" }).transaction.status).toBe("pending");
    // A user's own edit is already their decision and does not need approving.
    expect(createTransaction(doc, { ...base, source: "user" }).transaction.status).toBe("applied");
  });

  it("records agent attribution so a change can be explained later", () => {
    const { transaction } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("x"),
      intent: "Shorten the headline",
      source: "agent",
      agentId: "layout",
      createdBy: "usr_1",
      reason: "Shortened the headline so it fits at the theme's display size without shrinking",
      confidence: 0.82,
    });

    expect(transaction.agentId).toBe("layout");
    expect(transaction.confidence).toBe(0.82);
    // A sentence, not a label: "Optimized text" tells the user nothing.
    expect(transaction.reason!.length).toBeGreaterThan(30);
  });
});

describe("risk assessment", () => {
  it("auto-applies a small single-slide edit", () => {
    const risk = assessRisk(edit("x"));
    expect(risk.tier).toBe("low");
    expect(risk.requiresApproval).toBe(false);
  });

  it("requires explicit approval to delete a slide or change the theme", () => {
    expect(assessRisk([{ op: "remove", path: `/slides/id:${slideId}` }]).tier).toBe("high");
    expect(assessRisk([{ op: "replace", path: "/theme/colors/accent", value: "#f00" }]).tier).toBe("high");
  });

  it("always explains its reasoning", () => {
    // The user is asked to approve it, so it has to be able to say why.
    expect(assessRisk([{ op: "remove", path: `/slides/id:${slideId}` }]).reasons).not.toHaveLength(0);
  });
});

describe("status lifecycle", () => {
  it("allows only the transitions the spec defines", () => {
    expect(canTransition("pending", "applied")).toBe(true);
    expect(canTransition("pending", "rejected")).toBe(true);
    expect(canTransition("pending", "expired")).toBe(true);
    expect(canTransition("applied", "reverted")).toBe(true);

    expect(canTransition("applied", "pending")).toBe(false);
    expect(canTransition("rejected", "applied")).toBe(false);
    expect(canTransition("reverted", "applied")).toBe(false);
  });

  it("throws on an illegal transition rather than silently allowing it", () => {
    const { transaction } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("x"),
      intent: "i",
      source: "user",
      createdBy: "usr_1",
    });
    expect(() => transition(transaction, "pending")).toThrow(TransactionStateError);
  });

  it("expires a proposal after 24 hours", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const { transaction } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("x"),
      intent: "i",
      source: "agent",
      createdBy: "usr_1",
      now: () => created,
    });

    expect(isExpired(transaction, new Date(created.getTime() + PENDING_TTL_MS - 1000))).toBe(false);
    expect(isExpired(transaction, new Date(created.getTime() + PENDING_TTL_MS + 1000))).toBe(true);
  });
});

describe("approving a proposal", () => {
  it("recomputes the inverse against the current document", () => {
    // The stored inverse was computed against the document as it stood when the
    // proposal was made. If anything changed since, applying blind would produce
    // an edit that cannot be undone correctly.
    const { transaction } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("proposed"),
      intent: "i",
      source: "agent",
      createdBy: "usr_1",
    });

    // A user edits the same field in between.
    const { document: moved } = applyPatch(doc, edit("user typed this"));

    const approved = approve(moved, transaction, { resultVersionId: "v2" });
    expect(approved.transaction.status).toBe("applied");
    expect(approved.transaction.resultVersionId).toBe("v2");
    expect(approved.document.slides[0]!.keyMessage).toBe("proposed");

    // The refreshed inverse restores what the user typed, not what was there when
    // the proposal was made.
    const undone = applyPatch(approved.document, approved.transaction.inverseOperations);
    expect(undone.document.slides[0]!.keyMessage).toBe("user typed this");
  });

  it("refuses a proposal whose target no longer exists, with a reason", () => {
    const { transaction } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: [
        { op: "replace", path: `/slides/id:${slideId}/elements/id:${elementId}/transform/x`, value: 5 },
      ],
      intent: "Nudge",
      source: "agent",
      createdBy: "usr_1",
    });

    const { document: withoutElement } = applyPatch(doc, [
      { op: "remove", path: `/slides/id:${slideId}/elements/id:${elementId}` },
    ]);

    expect(() => approve(withoutElement, transaction)).toThrow(RevalidationError);
    try {
      approve(withoutElement, transaction);
    } catch (error) {
      // Expired with an explanation, rather than half-landing.
      expect((error as RevalidationError).transaction.status).toBe("expired");
      expect((error as RevalidationError).message).toMatch(/moved after the proposal/);
    }
  });

  it("refuses an expired proposal", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const { transaction } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("x"),
      intent: "i",
      source: "agent",
      createdBy: "usr_1",
      now: () => created,
    });

    expect(() =>
      approve(doc, transaction, { now: new Date(created.getTime() + PENDING_TTL_MS + 1) }),
    ).toThrow(/older than 24 hours/);
  });

  it("rejects without touching the document", () => {
    const { transaction } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("x"),
      intent: "i",
      source: "agent",
      createdBy: "usr_1",
    });
    expect(reject(transaction).status).toBe("rejected");
  });
});

describe("reverting", () => {
  it("produces a new transaction rather than deleting the original", () => {
    const { transaction, result } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("changed"),
      intent: "Sharpen the key message",
      source: "user",
      createdBy: "usr_1",
    });

    const undo = revert(result.document, transaction, { createdBy: "usr_1" });

    // History is append-only: "this was undone" is a fact worth keeping, and a
    // version lineage with holes cannot be replayed.
    expect(undo.reverted.status).toBe("reverted");
    expect(undo.transaction.status).toBe("applied");
    expect(undo.transaction.intent).toBe("Undo: Sharpen the key message");
    expect(serializeDocument(undo.document)).toBe(serializeDocument(doc));
  });

  it("refuses to revert something that was never applied", () => {
    const { transaction } = createTransaction(doc, {
      presentationId: doc.id,
      parentVersionId: "v1",
      operations: edit("x"),
      intent: "i",
      source: "agent",
      createdBy: "usr_1",
    });
    expect(() => revert(doc, transaction, { createdBy: "usr_1" })).toThrow(TransactionStateError);
  });
});

// ------------------------------------------------------------------- history

function command(
  source: EditCommand["source"],
  operations: EditCommand["operations"],
  base: PresentationDocument,
  label = "edit",
): EditCommand {
  const { inverse } = applyPatch(base, operations);
  return {
    id: newId("txn"),
    source,
    label,
    operations,
    inverseOperations: inverse,
    selectionBefore: [],
    selectionAfter: [],
    timestamp: new Date().toISOString(),
  };
}

describe("history", () => {
  it("undoes and redoes", () => {
    const history = new History();
    const cmd = command("user", edit("one"), doc);
    const { document: after } = applyPatch(doc, cmd.operations);
    history.push(cmd);

    const undone = history.undo(after);
    expect(undone.ok).toBe(true);
    expect(serializeDocument((undone as { document: PresentationDocument }).document)).toBe(
      serializeDocument(doc),
    );

    const redone = history.redo((undone as { document: PresentationDocument }).document);
    expect(redone.ok).toBe(true);
    expect(serializeDocument((redone as { document: PresentationDocument }).document)).toBe(
      serializeDocument(after),
    );
  });

  it("coalesces one gesture into one entry", () => {
    // A drag emits ~300 pointermove events and must produce a single undo entry,
    // or undo becomes useless (doc 04 §29.2).
    const history = new History();
    let current = doc;
    const start = Date.now();

    for (let i = 0; i < 20; i += 1) {
      const operations = [
        {
          op: "replace" as const,
          path: `/slides/id:${slideId}/elements/id:${elementId}/transform/x`,
          value: 100 + i,
        },
      ];
      history.push(command("user", operations, current), {
        coalesceKey: `drag:${elementId}`,
        now: start + i * 10,
      });
      current = applyPatch(current, operations).document;
    }

    expect(history.depth).toBe(1);

    const undone = history.undo(current);
    expect(undone.ok).toBe(true);
    // One undo returns to the position before the gesture started, not to the
    // penultimate frame of it.
    expect(serializeDocument((undone as { document: PresentationDocument }).document)).toBe(
      serializeDocument(doc),
    );
  });

  it("stops coalescing after the idle threshold", () => {
    const history = new History();
    const start = Date.now();
    history.push(command("user", edit("a"), doc), { coalesceKey: "typing", now: start });
    history.push(command("user", edit("b"), doc), { coalesceKey: "typing", now: start + 5000 });
    expect(history.depth).toBe(2);
  });

  it("drops the redo branch once a new edit diverges", () => {
    // Redoing after diverging would replay operations against a document that no
    // longer matches the state they were computed from.
    const history = new History();
    const first = command("user", edit("one"), doc);
    const afterFirst = applyPatch(doc, first.operations).document;
    history.push(first);

    const undone = history.undo(afterFirst) as { document: PresentationDocument };
    expect(history.canRedo).toBe(true);

    history.push(command("user", edit("different"), undone.document));
    expect(history.canRedo).toBe(false);
  });

  it("caps its depth and drops the oldest entries", () => {
    const history = new History(5);
    for (let i = 0; i < 20; i += 1) history.push(command("user", edit(`v${i}`), doc));
    expect(history.depth).toBe(5);
  });

  it("undoes the last AI change specifically", () => {
    const history = new History();
    let current = doc;

    const agentOps = [
      {
        op: "replace" as const,
        path: `/slides/id:${slideId}/elements/id:${elementId}/transform/x`,
        value: 400,
      },
    ];
    history.push(command("agent", agentOps, current, "AI: reposition headline"));
    current = applyPatch(current, agentOps).document;

    // A later user edit that touches a *different* element must not block it.
    const otherElement = doc.slides[0]!.elements[1]!.id;
    const userOps = [
      {
        op: "replace" as const,
        path: `/slides/id:${slideId}/elements/id:${otherElement}/transform/y`,
        value: 700,
      },
    ];
    history.push(command("user", userOps, current));
    current = applyPatch(current, userOps).document;

    const result = history.undoLastAgentChange(current);
    expect(result.ok).toBe(true);

    const after = (result as { document: PresentationDocument }).document;
    // The AI change is reverted; the user's later edit survives.
    expect(after.slides[0]!.elements[0]!.transform.x).toBe(doc.slides[0]!.elements[0]!.transform.x);
    expect(after.slides[0]!.elements[1]!.transform.y).toBe(700);
  });

  it("refuses to undo an AI change a later edit overlaps, and says which", () => {
    // Silently reverting an element the user has since edited by hand destroys
    // their work to satisfy a convenience feature (doc 04 §29.3).
    const history = new History();
    let current = doc;

    const path = `/slides/id:${slideId}/elements/id:${elementId}/transform/x`;
    const agentOps = [{ op: "replace" as const, path, value: 400 }];
    history.push(command("agent", agentOps, current, "AI: reposition"));
    current = applyPatch(current, agentOps).document;

    const userOps = [{ op: "replace" as const, path, value: 500 }];
    history.push(command("user", userOps, current));
    current = applyPatch(current, userOps).document;

    const result = history.undoLastAgentChange(current);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("overlapping-later-edit");
    expect((result as { conflictingIds?: string[] }).conflictingIds).toContain(elementId);
  });

  it("reports empty rather than throwing", () => {
    const history = new History();
    expect(history.undo(doc)).toEqual({ ok: false, reason: "empty" });
    expect(history.redo(doc)).toEqual({ ok: false, reason: "empty" });
    expect(history.undoLastAgentChange(doc)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("touchedIds", () => {
  it("extracts every id-addressed segment, including a move's source", () => {
    const ids = touchedIds([
      { op: "replace", path: `/slides/id:${slideId}/elements/id:${elementId}/opacity`, value: 0.5 },
      { op: "move", from: `/slides/id:${slideId}/elements/id:el_01JB8Z9K2QW4RN7F3XG5HTMD6A`, path: "/slides/0/elements/0" },
    ]);

    expect(ids.has(slideId)).toBe(true);
    expect(ids.has(elementId)).toBe(true);
    expect(ids.has("el_01JB8Z9K2QW4RN7F3XG5HTMD6A")).toBe(true);
  });
});

describe("disturbs (deferred-undo safety)", () => {
  const slideA = "sld_01JB8Z9K2QW4RN7F3XG5HTMD61";
  const slideB = "sld_01JB8Z9K2QW4RN7F3XG5HTMD62";
  const el1 = "el_01JB8Z9K2QW4RN7F3XG5HTMD71";
  const el2 = "el_01JB8Z9K2QW4RN7F3XG5HTMD72";

  const editElement = (slide: string, element: string) => [
    { op: "replace" as const, path: `/slides/id:${slide}/elements/id:${element}/transform/x`, value: 1 },
  ];

  it("flags a later deletion of the container an earlier edit lived in", () => {
    // The case that made a deferred revert silently edit the wrong slide: the
    // inverse is index-addressed, so after the slide is gone `/slides/1` resolves
    // to whatever moved into that position.
    const earlier = editElement(slideA, el1);
    const later = [{ op: "remove" as const, path: `/slides/id:${slideA}` }];

    expect([...disturbs(earlier, later)]).toContain(slideA);
  });

  it("does not flag edits to different elements on the same slide", () => {
    // Comparing every mentioned id on both sides would make these conflict —
    // because both paths name the slide — and turn undo off in practice.
    expect(disturbs(editElement(slideA, el1), editElement(slideA, el2)).size).toBe(0);
  });

  it("does not flag edits on unrelated slides", () => {
    expect(disturbs(editElement(slideA, el1), editElement(slideB, el2)).size).toBe(0);
  });

  it("flags a later edit reaching into what the earlier one changed", () => {
    expect([...disturbs(editElement(slideA, el1), editElement(slideA, el1))]).toContain(el1);
  });

  it("is symmetric for the same target", () => {
    const a = editElement(slideA, el1);
    expect(disturbs(a, a)).toEqual(disturbs(a, a));
  });
});
