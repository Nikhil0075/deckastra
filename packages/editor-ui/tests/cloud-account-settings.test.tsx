// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRequestError } from "@deckastra/workspace-client";

import { AccountDeletionSettings, AiTaskSettings, deletionProblem } from "../src/components/CloudAccountSettings";

const session = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@deckastra/workspace-client/react", () => ({ useWorkspaceClient: () => ({ session }) }));
afterEach(() => {
  cleanup();
  for (const key of Object.keys(session)) delete session[key];
});

describe("deleting the online account", () => {
  it("does nothing until DELETE is typed, then hands the receipt to the host", async () => {
    session.deleteAccount = vi.fn().mockResolvedValue({ id: "del_1", status: "queued" });
    const onDeleted = vi.fn();
    render(<AccountDeletionSettings onDeleted={onDeleted} />);
    fireEvent.click(screen.getByTestId("delete-account"));
    const confirm = screen.getByTestId("delete-account-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("delete-account-confirm-text"), { target: { value: "delete" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("delete-account-confirm-text"), { target: { value: "DELETE" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ id: "del_1", status: "queued" }));
  });

  it("says what to do when the person still owns a shared workspace, and keeps them signed in", async () => {
    session.deleteAccount = vi
      .fn()
      .mockRejectedValue(new WorkspaceRequestError(409, undefined, "Transfer ownership of shared workspaces before deleting your account."));
    const onDeleted = vi.fn();
    render(<AccountDeletionSettings onDeleted={onDeleted} />);
    fireEvent.click(screen.getByTestId("delete-account"));
    fireEvent.change(screen.getByTestId("delete-account-confirm-text"), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));
    expect((await screen.findByTestId("delete-account-problem")).textContent).toMatch(/other people use/);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("is absent where there is no online account to delete", () => {
    const { container } = render(<AccountDeletionSettings onDeleted={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("never shows a service sentence carrying a setting name", () => {
    expect(deletionProblem(new WorkspaceRequestError(409, undefined, "DECKASTRA_ACCOUNT_DELETION_ENABLED unset"))).toMatch(/Contact support/);
    expect(deletionProblem(new WorkspaceRequestError(503, undefined, "Cloud account deletion is not configured."))).toMatch(/not available/);
  });
});

describe("what AI help can do", () => {
  it("says plainly that AI help is off when no task is available", async () => {
    session.capabilities = vi.fn().mockResolvedValue({
      provider: "vertex",
      tasks: { image: { available: false, model: null, reason: "Image generation is not configured." } },
    });
    render(<AiTaskSettings />);
    expect((await screen.findByTestId("ai-tasks-off")).textContent).toMatch(/not switched on yet/);
    expect(document.body.textContent).not.toMatch(/Vertex/);
  });

  it("lists each task once some are available", async () => {
    session.capabilities = vi.fn().mockResolvedValue({
      provider: "vertex",
      tasks: {
        image: { available: true, model: "image-model", reason: null, minimum_reservation_usd: 0.01 },
      },
    });
    render(<AiTaskSettings />);
    expect(await screen.findByText("Making pictures")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
  });
});
