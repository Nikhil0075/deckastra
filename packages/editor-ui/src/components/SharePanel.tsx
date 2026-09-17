"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { Share } from "@deckastra/workspace-contracts";

/**
 * Share links (gap register doc 01 S2).
 *
 * The one thing this component has to get across, and the reason it is written
 * the way it is: **the link is shown once and cannot be shown again.** The server
 * stores only a hash, exactly like an API key, so "copy it now" is not a nudge —
 * it is the literal truth, and a user who closes the panel without copying has to
 * make another link.
 *
 * The rest is a list of who can get in and a way to close each door. Revoked
 * links stay on the list rather than disappearing, because "who could see this,
 * and when did that stop" is the question asked after something leaks.
 *
 * **Sharing can be absent, and absent is not broken.** A local install refuses it
 * wholesale — a link that machine mints leads nowhere — and this panel used to
 * discover that by calling the route and rendering its 404 as "Not found.", which
 * reads as a failure in a feature that was never there. It now asks the
 * deployment what it supports and says so plainly.
 *
 * The capability is asked for explicitly rather than inferred from a 404, and
 * that distinction is the whole fix: a missing deck and a deck you may not see
 * answer 404 too, *by design* (a 403 on something you cannot see confirms it
 * exists). Reading any of those as "sharing is unavailable here" would tell
 * someone their workspace cannot share when what actually happened is that their
 * access was revoked.
 */

export function SharePanel({ presentationId }: { presentationId: string }) {
  const client = useWorkspaceClient();
  const [shares, setShares] = useState<Share[] | null>(null);
  const [fresh, setFresh] = useState<Share | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expires, setExpires] = useState(false);
  const [copied, setCopied] = useState(false);
  // Four states, not two. "Supported", "not supported" and "could not tell" are
  // different facts and only one of them is about this workspace — saying "this
  // workspace is local" because the account read failed would tell someone whose
  // access was just revoked that their workspace cannot share.
  const [sharing, setSharing] = useState<"asking" | "yes" | "no" | "unknown">("asking");

  const refresh = useCallback(async () => {
    try {
      setShares(await client.shares.list(presentationId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    }
  }, [client, presentationId]);

  useEffect(() => {
    let live = true;

    void (async () => {
      let answer: "yes" | "no" | "unknown";
      try {
        answer = (await client.session.account()).capabilities.sharing ? "yes" : "no";
      } catch {
        // An account that could not be read says nothing about sharing. The
        // controls stay off — offering a button against a server nobody could
        // reach is worse than not offering one — but nothing is claimed about
        // this workspace, because a 404 here is just as likely to mean the deck
        // is gone or the access was revoked.
        answer = "unknown";
      }
      if (!live) return;
      setSharing(answer);
      // Only ask for links where links exist. On an install that refuses
      // sharing, listing them is a request whose only possible answer is the
      // 404 this panel used to show people.
      if (answer === "yes") await refresh();
    })();

    return () => {
      live = false;
    };
  }, [client, refresh]);

  async function create() {
    setError(null);
    setCopied(false);

    try {
      // The plaintext token comes back on this response and never again: the
      // authority stores only a hash, so "copy it now" is the literal truth.
      setFresh(await client.shares.create(presentationId, {
        role: "viewer",
        expires_in_days: expires ? 30 : null,
      }));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a link.");
    }
  }

  async function revoke(id: string) {
    try {
      await client.shares.revoke(id);
      if (fresh?.id === id) setFresh(null);
    } catch (caught) {
      // A door that looks closed and is not is worse than one that says it would
      // not shut, so a failure is reported rather than swallowed.
      setError(caught instanceof Error ? caught.message : "Could not revoke that link.");
    }
    await refresh();
  }

  const linkFor = (share: Share): string =>
    `${window.location.origin}/shared/${share.token ?? ""}`;

  if (sharing === "no") {
    return (
      <section style={{ padding: "0 16px 16px" }}>
        <h3 style={heading}>Share</h3>
        <p style={muted}>
          This workspace is local. Online sharing isn&rsquo;t available here. You can
          export a copy to share.
        </p>
      </section>
    );
  }

  if (sharing === "unknown") {
    // Deliberately says nothing about what this workspace supports. It could not
    // be asked, which is a different fact from the answer being no.
    return (
      <section style={{ padding: "0 16px 16px" }}>
        <h3 style={heading}>Share</h3>
        <p role="alert" style={{ ...muted, color: "var(--danger)" }}>
          Sharing could not be checked just now. Try again when you are connected.
        </p>
      </section>
    );
  }

  return (
    <section style={{ padding: "0 16px 16px" }}>
      <h3 style={heading}>Share</h3>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <button
          style={control}
          // Off until the deployment has said it supports this, so the button is
          // never live against a server that will refuse it.
          disabled={sharing !== "yes"}
          onClick={() => void create()}
        >
          Create view link
        </button>
      </div>

      <label style={option}>
        <input
          type="checkbox"
          checked={expires}
          onChange={(event) => setExpires(event.target.checked)}
        />
        Expire after 30 days
      </label>

      {error ? (
        <p role="alert" style={{ ...muted, color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      {fresh?.token ? (
        <div style={freshBox}>
          {/* Not a nudge — the server stores only a hash, so this is the last
              time this link exists anywhere but the holder's hands. */}
          <p style={{ ...muted, color: "var(--fg)", margin: "0 0 6px" }}>
            Copy this now. It cannot be shown again.
          </p>
          <code style={linkText}>{linkFor(fresh)}</code>
          <button
            style={{ ...control, marginTop: 8 }}
            onClick={() => {
              void navigator.clipboard.writeText(linkFor(fresh));
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}

      {shares === null ? (
        <p style={muted}>Loading…</p>
      ) : shares.length === 0 ? (
        <p style={muted}>
          No links yet. A link lets someone open this deck without an account.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
          {shares.map((share) => (
            <li key={share.id} style={row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12 }}>
                  {share.label ?? (share.role === "editor" ? "Can edit" : "Can view")}
                </div>
                <div style={{ ...muted, fontSize: 11 }}>
                  {share.view_count === 0
                    ? "Not opened yet"
                    : `Opened ${share.view_count} time${share.view_count === 1 ? "" : "s"}`}
                  {share.expires_at ? ` · expires ${short(share.expires_at)}` : ""}
                </div>
              </div>

              <span style={{ ...pill, color: colourFor(share.status) }}>{share.status}</span>

              {share.status === "active" ? (
                <button style={smallButton} onClick={() => void revoke(share.id)}>
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function colourFor(status: Share["status"]): string {
  return status === "active" ? "var(--accent)" : "var(--fg-subtle)";
}

function short(iso: string): string {
  // Deliberately not `toLocaleDateString`: ICU data varies by runtime, and this
  // project's determinism rule applies to anything a snapshot might capture.
  const date = new Date(iso);
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

const heading: CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.4,
  textTransform: "uppercase",
  color: "var(--fg-subtle)",
  margin: "0 0 10px",
};

const control: CSSProperties = {
  background: "var(--surface-alt)",
  border: "1px solid var(--border)",
  color: "var(--fg)",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 12,
};

const smallButton: CSSProperties = {
  ...control,
  color: "var(--fg-muted)",
  padding: "4px 9px",
  fontSize: 11,
};

const option: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 12,
  color: "var(--fg-muted)",
  marginBottom: 6,
};

const freshBox: CSSProperties = {
  border: "1px solid var(--accent)",
  borderRadius: 8,
  padding: 10,
  margin: "8px 0",
  background: "var(--surface-alt)",
};

const linkText: CSSProperties = {
  display: "block",
  fontSize: 11,
  wordBreak: "break-all",
  color: "var(--fg-muted)",
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 0",
  borderTop: "1px solid var(--border)",
};

const pill: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "1px 7px",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const muted: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-subtle)",
  margin: 0,
};
