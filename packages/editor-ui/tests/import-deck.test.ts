import { describe, expect, it, vi } from "vitest";
import type { DeckImport, WorkspaceClient } from "@deckastra/workspace-contracts";

import { IMPORT_GIVE_UP_MS, importDeckFile } from "../src/lib/import-deck";

const job = (status: DeckImport["status"], extra: Partial<DeckImport> = {}): DeckImport => ({
  id: "imp_1",
  status,
  presentation_id: null,
  error: null,
  warnings: [],
  ...extra,
});

function clientWith(upload: () => Promise<DeckImport>, statuses: DeckImport[]) {
  const status = vi.fn(async () => statuses.shift() ?? job("running"));
  return { client: { imports: { upload: vi.fn(upload), status } } as unknown as WorkspaceClient, status };
}

const deck = (name = "Quarterly.mydeck", size = 10) => ({ name, size }) as File;
const instant = { wait: async () => {} };

describe("opening a .mydeck file in the browser", () => {
  it("waits for the service, then names the deck it made", async () => {
    const { client, status } = clientWith(async () => job("queued"), [job("running"), job("completed", { presentation_id: "doc_new" })]);
    await expect(importDeckFile(client, "prj_1", deck(), instant)).resolves.toEqual({
      kind: "opened",
      presentationId: "doc_new",
      existing: false,
      warnings: [],
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("opens the deck the person already has when the file came from them", async () => {
    const { client } = clientWith(async () => job("queued"), [job("existing", { presentation_id: "doc_mine" })]);
    await expect(importDeckFile(client, "prj_1", deck(), instant)).resolves.toMatchObject({ presentationId: "doc_mine", existing: true });
  });

  it("says what the service said when it could not read the file", async () => {
    const { client } = clientWith(async () => job("queued"), [job("failed", { error: "This file is damaged." })]);
    await expect(importDeckFile(client, "prj_1", deck(), instant)).resolves.toEqual({ kind: "failed", message: "This file is damaged." });
  });

  it("refuses what is not a deck file, or is too large, before uploading", async () => {
    const { client } = clientWith(async () => job("queued"), []);
    expect(await importDeckFile(client, "prj_1", deck("slides.pptx"), instant)).toMatchObject({ kind: "failed" });
    expect(await importDeckFile(client, "prj_1", deck("big.mydeck", 200 * 1024 * 1024), instant)).toMatchObject({ kind: "failed" });
    expect(client.imports!.upload).not.toHaveBeenCalled();
  });

  it("explains the hold on unfinished uploads rather than asking the person to finish them", async () => {
    const client = {
      imports: { upload: async () => Promise.reject(Object.assign(new Error("Finish your pending file imports before uploading another."), { status: 429 })), status: vi.fn() },
    } as unknown as WorkspaceClient;
    const outcome = await importDeckFile(client, "prj_1", deck(), instant);
    expect(outcome).toMatchObject({ kind: "failed", message: expect.stringMatching(/cleared within a day/) });
  });

  it("keeps waiting through one unanswered poll", async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(job("completed", { presentation_id: "doc_new" }));
    const client = { imports: { upload: async () => job("queued"), status } } as unknown as WorkspaceClient;
    await expect(importDeckFile(client, "prj_1", deck(), instant)).resolves.toMatchObject({ presentationId: "doc_new" });
  });

  it("gives up with a sentence rather than spinning forever", async () => {
    let clock = 0;
    const { client } = clientWith(async () => job("queued"), []);
    const outcome = await importDeckFile(client, "prj_1", deck(), {
      wait: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(clock).toBeGreaterThan(IMPORT_GIVE_UP_MS);
  });
});
