/**
 * How AI credits are said (roadmap 08 §1.2 rules 4 and 6, §3.3).
 *
 * The server's ledger is the only authority on a balance; this module only
 * turns its answer into words. It never adds, subtracts or estimates, because a
 * number a client computed is a number that can disagree with what the person
 * is charged. Pure, so the wording is testable without a meter.
 */
import type { CreditBalance } from "@deckastra/workspace-contracts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Whole credits, rounded down: showing 41.6 as 42 promises a credit that is not there. */
export function wholeCredits(value: number): number {
  return Math.max(0, Math.floor(value + 1e-9));
}

/** "Free plan". A plan name the product does not know is shown as it was given. */
export function planLabel(plan: string): string {
  if (!plan) return "Plan";
  const known: Record<string, string> = { free: "Free plan", plus: "Plus", pro: "Pro", business: "Business" };
  return known[plan.toLowerCase()] ?? plan;
}

/** "42 of 60 credits this month". */
export function creditsLine(balance: CreditBalance): string {
  return `${wholeCredits(balance.remaining_credits)} of ${wholeCredits(balance.monthly_allowance)} credits this month`;
}

/** "Resets on 1 Nov". Read in UTC: the ledger's period is a UTC calendar boundary. */
export function resetLine(balance: CreditBalance): string | null {
  const end = new Date(balance.period_end);
  if (Number.isNaN(end.getTime())) return null;
  return `Resets on ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]}`;
}

/** 0 to 1, for the bar. */
export function remainingShare(balance: CreditBalance): number {
  if (!(balance.monthly_allowance > 0)) return 0;
  return Math.min(1, Math.max(0, balance.remaining_credits / balance.monthly_allowance));
}

/**
 * Why there is no balance to show. A signed-out desktop is the common case and
 * is said as an action, not an error; anything else is said without the
 * service's engineering words.
 */
export function creditsUnavailable(error: unknown): { signIn: boolean; text: string } {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/sign in/i.test(message)) return { signIn: true, text: "Sign in to use AI credits." };
  return { signIn: false, text: "Your credits could not be read just now." };
}

/**
 * One credit is US$0.005 of model cost (BACKEND_CLOUD.md, "Credits"). The
 * service reports what a task holds before it runs in dollars; a person reads
 * it in credits.
 */
export const USD_PER_CREDIT = 0.005;

/**
 * "Up to 3 credits": what a paid task holds before it runs, rounded up so the
 * button never promises less than will be held. Unused credits come back when
 * the task finishes, so it is a ceiling, not a price. Null when there is
 * nothing to say (a task that runs on this device, or no estimate).
 */
export function creditCostWords(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) return null;
  const credits = Math.max(1, Math.ceil(usd / USD_PER_CREDIT - 1e-9));
  return `Up to ${credits} credit${credits === 1 ? "" : "s"}`;
}
