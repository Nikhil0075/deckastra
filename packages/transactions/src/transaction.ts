import {
  computeRiskTier,
  newId,
  type PatchOperation,
  type PresentationDocument,
  type Transaction,
  type TransactionStatus,
} from "@deckastra/presentation-schema";

import { applyPatch, type ApplyResult } from "./apply";

/**
 * Transaction lifecycle (doc 02 §31.5, §31.6).
 *
 *     pending ──approve──> applied ──undo──> reverted
 *        │
 *        ├──reject──> rejected
 *        └──24h────> expired
 *
 * A pending transaction exists because doc 01 §11.2 requires proposal-before-apply
 * and there was previously nowhere for "preview this AI edit" to live. It is
 * validated when created and *re-validated* when approved, because the document
 * may have moved underneath it in between.
 */

/** How long a proposal stays actionable before it is presumed stale (doc 02 §31.6). */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateTransactionInput {
  presentationId: string;
  parentVersionId: string;
  operations: PatchOperation[];
  intent: string;
  source: Transaction["source"];
  createdBy: string;
  agentId?: string;
  clientId?: string;
  userInstruction?: string;
  reason?: string;
  confidence?: number;
  sourceIds?: string[];
  /** Defaults to "applied" for user edits and "pending" for agent proposals. */
  status?: TransactionStatus;
  now?: () => Date;
}

/**
 * Build a transaction from a patch, computing its inverse by applying it to the
 * given document.
 *
 * The document is not returned mutated — the caller decides whether to commit.
 * That separation is what lets a proposal be previewed without being applied.
 */
export function createTransaction(
  document: PresentationDocument,
  input: CreateTransactionInput,
): { transaction: Transaction; result: ApplyResult<PresentationDocument> } {
  const now = (input.now ?? (() => new Date()))();
  const result = applyPatch(document, input.operations);

  // Agent proposals default to pending; a user's own edit is already their
  // decision and does not need approving.
  const status: TransactionStatus =
    input.status ?? (input.source === "agent" ? "pending" : "applied");

  const transaction: Transaction = {
    id: newId("txn"),
    presentationId: input.presentationId,
    parentVersionId: input.parentVersionId,
    source: input.source,
    intent: input.intent,
    operations: input.operations,
    inverseOperations: result.inverse,
    status,
    createdAt: now.toISOString(),
    createdBy: input.createdBy,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.userInstruction ? { userInstruction: input.userInstruction } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    ...(status === "applied" ? { appliedAt: now.toISOString() } : {}),
  };

  return { transaction, result };
}

export interface RiskAssessment {
  tier: "low" | "medium" | "high";
  reasons: string[];
  /** What should happen by default at this tier. */
  behavior: "autoApply" | "pendingPreview" | "explicitApproval";
  requiresApproval: boolean;
}

/**
 * Assess a patch's risk.
 *
 * Computed from the operations, server-side, and never taken from the caller — a
 * caller-declared tier is a caller-controlled security boundary, which is no
 * boundary at all (doc 02 §31.7).
 */
export function assessRisk(operations: readonly PatchOperation[]): RiskAssessment {
  const { tier, reasons, defaultBehavior } = computeRiskTier(operations);
  return {
    tier,
    reasons,
    behavior: defaultBehavior,
    requiresApproval: defaultBehavior !== "autoApply",
  };
}

export class TransactionStateError extends Error {
  readonly from: TransactionStatus;
  readonly to: TransactionStatus;

  constructor(from: TransactionStatus, to: TransactionStatus) {
    super(`A transaction cannot move from "${from}" to "${to}".`);
    this.name = "TransactionStateError";
    this.from = from;
    this.to = to;
  }
}

const ALLOWED_TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  pending: ["applied", "rejected", "expired"],
  applied: ["reverted"],
  // Terminal. A rejected proposal is not resurrected — the caller proposes again,
  // which produces a fresh inverse against the current state rather than reusing
  // one computed against a document that has since moved.
  rejected: [],
  expired: [],
  reverted: [],
};

export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transition(
  transaction: Transaction,
  to: TransactionStatus,
  now: Date = new Date(),
): Transaction {
  if (!canTransition(transaction.status, to)) {
    throw new TransactionStateError(transaction.status, to);
  }

  return {
    ...transaction,
    status: to,
    ...(to === "applied" ? { appliedAt: now.toISOString() } : {}),
  };
}

export function isExpired(transaction: Transaction, now: Date = new Date()): boolean {
  if (transaction.status !== "pending") return false;
  return now.getTime() - Date.parse(transaction.createdAt) > PENDING_TTL_MS;
}

export interface ApprovalResult {
  transaction: Transaction;
  document: PresentationDocument;
}

export class RevalidationError extends Error {
  readonly transaction: Transaction;
  readonly detail: string;

  constructor(transaction: Transaction, detail: string) {
    super(
      `This change can no longer be applied: ${detail} ` +
        `The document moved after the proposal was made.`,
    );
    this.name = "RevalidationError";
    this.transaction = transaction;
    this.detail = detail;
  }
}

/**
 * Approve a pending transaction against the *current* document.
 *
 * Re-application is deliberate. The stored inverse was computed against the
 * document as it stood when the proposal was made; if anything changed since,
 * that inverse is wrong and applying the operations blind would produce an
 * un-undoable edit. So the patch is re-applied here and a fresh inverse replaces
 * the stale one. If it no longer applies, the transaction expires with a reason
 * rather than half-landing.
 */
export function approve(
  document: PresentationDocument,
  transaction: Transaction,
  options: { now?: Date; resultVersionId?: string } = {},
): ApprovalResult {
  const now = options.now ?? new Date();

  if (isExpired(transaction, now)) {
    throw new RevalidationError(
      { ...transaction, status: "expired" },
      "the proposal is older than 24 hours.",
    );
  }

  let result: ApplyResult<PresentationDocument>;
  try {
    result = applyPatch(document, transaction.operations);
  } catch (error) {
    throw new RevalidationError(
      { ...transaction, status: "expired" },
      error instanceof Error ? error.message : "the patch no longer resolves.",
    );
  }

  return {
    transaction: {
      ...transition(transaction, "applied", now),
      inverseOperations: result.inverse,
      ...(options.resultVersionId ? { resultVersionId: options.resultVersionId } : {}),
    },
    document: result.document,
  };
}

export function reject(transaction: Transaction, now: Date = new Date()): Transaction {
  return transition(transaction, "rejected", now);
}

/**
 * Revert an applied transaction by running its inverse.
 *
 * Reverting produces a *new* transaction rather than deleting the original.
 * History is append-only: "this was undone" is a fact worth keeping, and a
 * version lineage with holes in it cannot be replayed.
 */
export function revert(
  document: PresentationDocument,
  transaction: Transaction,
  options: { createdBy: string; now?: Date } = { createdBy: "system" },
): { transaction: Transaction; reverted: Transaction; document: PresentationDocument } {
  if (transaction.status !== "applied") {
    throw new TransactionStateError(transaction.status, "reverted");
  }

  const now = options.now ?? new Date();
  const result = applyPatch(document, transaction.inverseOperations);

  const undo: Transaction = {
    id: newId("txn"),
    presentationId: transaction.presentationId,
    parentVersionId: transaction.resultVersionId ?? transaction.parentVersionId,
    source: "user",
    intent: `Undo: ${transaction.intent}`,
    operations: transaction.inverseOperations,
    inverseOperations: result.inverse,
    status: "applied",
    createdAt: now.toISOString(),
    appliedAt: now.toISOString(),
    createdBy: options.createdBy,
  };

  return {
    transaction: undo,
    reverted: { ...transition(transaction, "reverted", now) },
    document: result.document,
  };
}
