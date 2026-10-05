// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreditsMeter } from "../src/components/CreditsMeter";
import { creditCostWords, creditsLine, creditsUnavailable, planLabel, remainingShare, resetLine, wholeCredits } from "../src/lib/credits";

const session = vi.hoisted(() => ({ credits: vi.fn() as ReturnType<typeof vi.fn> | undefined }));
const client = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@deckastra/workspace-client/react", () => ({
  useWorkspaceClient: () => Object.assign(client, { session }),
}));
afterEach(() => {
  cleanup();
  session.credits = vi.fn();
});

const balance = {
  plan: "free",
  monthly_allowance: 60,
  remaining_credits: 41.6,
  period_start: "2026-10-01T00:00:00+00:00",
  period_end: "2026-11-01T00:00:00+00:00",
};

describe("credits, in words", () => {
  it("rounds down, never promising a credit that is not there", () => {
    expect(wholeCredits(41.999)).toBe(41);
    expect(wholeCredits(-2)).toBe(0);
    expect(creditsLine(balance)).toBe("41 of 60 credits this month");
  });

  it("turns a dollar hold into credits, rounding up", () => {
    expect(creditCostWords(0.005)).toBe("Up to 1 credit");
    expect(creditCostWords(0.0051)).toBe("Up to 2 credits");
    expect(creditCostWords(0.001)).toBe("Up to 1 credit");
    expect(creditCostWords(0)).toBeNull();
    expect(creditCostWords(null)).toBeNull();
  });

  it("names the plan and the reset day in UTC", () => {
    expect(planLabel("free")).toBe("Free plan");
    expect(planLabel("enterprise-trial")).toBe("enterprise-trial");
    expect(resetLine(balance)).toBe("Resets on 1 Nov");
    expect(resetLine({ ...balance, period_end: "not a date" })).toBeNull();
    expect(remainingShare(balance)).toBeCloseTo(0.693, 2);
    expect(remainingShare({ ...balance, monthly_allowance: 0 })).toBe(0);
  });

  it("turns a signed-out answer into an action and anything else into a plain sentence", () => {
    expect(creditsUnavailable(new Error("Sign in to use Deckastra AI credits."))).toEqual({ signIn: true, text: "Sign in to use AI credits." });
    expect(creditsUnavailable(new Error("upstream 502 from vertex"))).toEqual({ signIn: false, text: "Your credits could not be read just now." });
  });
});

describe("the meter", () => {
  it("shows the balance the service gave, and the plan card around it", async () => {
    session.credits = vi.fn().mockResolvedValue(balance);
    render(<CreditsMeter variant="card" />);
    expect(await screen.findByText("41 of 60 credits this month")).toBeTruthy();
    expect(screen.getByText("Free plan")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("41");
  });

  it("asks a signed-out person to sign in, where they can", async () => {
    session.credits = vi.fn().mockRejectedValue(new Error("Sign in to use Deckastra AI credits."));
    const onOpenSettings = vi.fn();
    render(<CreditsMeter variant="card" onOpenSettings={onOpenSettings} />);
    fireEvent.click(await screen.findByTestId("credits-sign-in"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("reads again when the window comes back into focus", async () => {
    session.credits = vi.fn().mockResolvedValueOnce(balance).mockResolvedValueOnce({ ...balance, remaining_credits: 30 });
    render(<CreditsMeter />);
    await screen.findByText("41 of 60 credits this month");
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("30 of 60 credits this month")).toBeTruthy();
  });

  it("is absent where the service has no account to read", () => {
    session.credits = undefined;
    const { container } = render(<CreditsMeter variant="card" />);
    expect(container.innerHTML).toBe("");
  });
});
