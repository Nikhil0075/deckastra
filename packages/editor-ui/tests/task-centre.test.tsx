// @vitest-environment jsdom
/**
 * The task centre (UI audit Unit 9): an export outlives the panel that started
 * it. These drive the real ExportPanel and the real HTTP client over a stubbed
 * transport, so what is asserted is what reached the service.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import type { ExportJob } from "@deckastra/workspace-contracts";

import { ExportPanel } from "../src/components/ExportPanel";
import { TaskCentre } from "../src/components/shell/TaskCentre";
import {
  clearFinishedTasks,
  followExport,
  reportExport,
  resetTasksForTests,
  statusOf,
  taskTitle,
  useTasks,
} from "../src/lib/tasks";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function job(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    id: "exp_1",
    kind: "pdf",
    status: "running",
    progress: 0.4,
    stage: "Drawing slides",
    message: null,
    filename: "deck.pdf",
    bytes: 0,
    report: null,
    error: null,
    ...overrides,
  };
}

let statusAnswers: ExportJob[];
let statusCalls: number;

beforeEach(() => {
  resetTasksForTests();
  statusAnswers = [];
  statusCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url);
      if (path.endsWith("/v1/presentations/prs_1/exports")) return json(job());
      if (path.endsWith("/v1/exports/exp_1")) {
        statusCalls += 1;
        return json(statusAnswers.shift() ?? job({ status: "completed", progress: 1, stage: null }));
      }
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  resetTasksForTests();
  vi.unstubAllGlobals();
});

describe("the task store", () => {
  it("lists one task per job, however often a panel reports it", () => {
    reportExport("prs_1", "Quarterly review", job());
    reportExport("prs_1", "Quarterly review", job({ progress: 0.7 }));
    let seen: readonly unknown[] = [];
    function Probe() {
      seen = useTasks();
      return null;
    }
    render(<Probe />);
    expect(seen).toHaveLength(1);
    expect(taskTitle({ job: job(), deckTitle: "Quarterly review" })).toBe("PDF of Quarterly review");
    expect(taskTitle({ job: job({ kind: "pptx" }), deckTitle: null })).toBe("PowerPoint export");
  });

  it("reads a job's state in the four words the centre shows", () => {
    expect(statusOf(job({ status: "queued" }))).toBe("running");
    expect(statusOf(job({ status: "completed" }))).toBe("ready");
    expect(statusOf(job({ status: "cancelled" }))).toBe("cancelled");
    expect(statusOf(job({ status: "failed" }))).toBe("failed");
  });

  it("follows a handed-over job until it ends, and only once", async () => {
    const status = vi.fn(async () => job({ status: "completed", progress: 1 }));
    followExport({ status }, "prs_1", null, job(), { intervalMs: 5 });
    followExport({ status }, "prs_1", null, job(), { intervalMs: 5 });
    render(<TaskCentre />);
    await waitFor(() => expect(screen.getByTestId("task-centre").textContent).toBe("Done"));
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("clears what has ended and keeps what is still working", () => {
    reportExport("prs_1", null, job({ id: "exp_a", status: "completed" }));
    reportExport("prs_1", null, job({ id: "exp_b" }));
    render(<TaskCentre />, { wrapper: withWorkspaceClient() });
    act(() => clearFinishedTasks());
    fireEvent.click(screen.getByTestId("task-centre"));
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-task-id"))).toEqual(["exp_b"]);
  });
});

describe("an export after its panel has gone", () => {
  it("is taken over by the task centre and lands there as ready", async () => {
    const wrapper = withWorkspaceClient();
    // Two answers still "running" while the panel watches; after that, done.
    statusAnswers = [job({ progress: 0.5 })];
    const panel = render(<ExportPanel presentationId="prs_1" deckTitle="Quarterly review" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    render(<TaskCentre />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("task-centre").getAttribute("data-running")).toBe("1"));

    // The drawer closes: the panel unmounts with the job still running.
    panel.unmount();
    await waitFor(() => expect(screen.getByTestId("task-centre").textContent).toBe("Done"), { timeout: 5000 });
    expect(statusCalls).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByTestId("task-centre"));
    const row = screen.getByRole("listitem");
    expect(row.getAttribute("data-task-status")).toBe("ready");
    expect(within(row).getByText("PDF of Quarterly review")).toBeTruthy();
    // Said in words, not only by the chip's colour.
    expect(within(row).getByText("Ready")).toBeTruthy();
    expect(within(row).getByTestId("task-download")).toBeTruthy();
  });

  it("shows progress as a progress bar a screen reader can read", () => {
    reportExport("prs_1", "Quarterly review", job({ progress: 0.42 }));
    render(<TaskCentre />, { wrapper: withWorkspaceClient() });
    fireEvent.click(screen.getByTestId("task-centre"));
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("Working")).toBeTruthy();
  });

  it("is absent while there is nothing to show", () => {
    const { container } = render(<TaskCentre />);
    expect(container.textContent).toBe("");
  });
});
