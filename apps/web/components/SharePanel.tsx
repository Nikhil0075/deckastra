"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

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
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Share {
  id: string;
  role: "viewer" | "editor";
  label: string | null;
  created_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  status: "active" | "expired" | "revoked";
  token?: string;
}

export function SharePanel({
  presentationId,
  token,
}: {
  presentationId: string;
  token: string;
}) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [fresh, setFresh] = useState<Share | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [expires, setExpires] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${API}/v1/presentations/${presentationId}/shares`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Could not load the links for this deck.");
      setShares((await response.json()).shares);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    }
  }, [presentationId, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create() {
    setError(null);
    setCopied(false);

    try {
      const response = await fetch(`${API}/v1/presentations/${presentationId}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role, expires_in_days: expires ? 30 : null }),
      });

      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? "Could not create a link.");

      setFresh(body as Share);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a link.");
    }
  }

  async function revoke(id: string) {
    await fetch(`${API}/v1/shares/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (fresh?.id === id) setFresh(null);
    await refresh();
  }

  const linkFor = (share: Share): string =>
    `${window.location.origin}/shared/${share.token ?? ""}`;

  return (
    <section style={{ padding: "0 16px 16px" }}>
      <h3 style={heading}>Share</h3>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <label style={visuallyHidden} htmlFor="share-role">
          What the link allows
        </label>
        <select
          id="share-role"
          value={role}
          onChange={(event) => setRole(event.target.value as "viewer" | "editor")}
          style={control}
        >
          <option value="viewer">Can view</option>
          <option value="editor">Can edit</option>
        </select>

        <button style={control} onClick={() => void create()}>
          Create link
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

/** Off-screen but readable by a screen reader (WCAG 2.1 AA, 1.3.1 / 3.3.2). */
const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};
