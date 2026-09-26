import { describe, expect, it } from "vitest";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

import type { Attached } from "../src/attach";
import { withdrawAuthored } from "../src/tools";

/**
 * Withdrawing names the proposal and the client, and nothing else: the server
 * decides whether this client may withdraw it (`proposals.withdraw`).
 */
describe("withdrawing a proposal", () => {
  const client = { clientId: "mcp:claude-code" } as unknown as WorkspaceClient;
  const attached = { baseUrl: "http://127.0.0.1:1234", attachment: { grant: "grant-x" } } as unknown as Attached;

  it("asks the withdraw route, as this client, with the grant", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "txn_1", status: "rejected" }), { status: 200 });
    }) as unknown as typeof fetch;

    const answer = await withdrawAuthored(client, attached, "doc_1", "txn_1", fetchImpl);

    expect(answer.status).toBe("rejected");
    expect(calls[0]!.url).toBe("http://127.0.0.1:1234/v1/presentations/doc_1/proposals/txn_1/withdraw");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ client_label: "claude-code" });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer grant-x");
  });

  it("passes a refusal on in the server's words", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: { message: "This proposal was made by a different agent." } }), {
        status: 403,
      })) as unknown as typeof fetch;
    await expect(withdrawAuthored(client, attached, "doc_1", "txn_1", fetchImpl)).rejects.toThrow(/different agent/);
  });
});
