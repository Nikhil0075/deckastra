"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { Share } from "@deckastra/workspace-contracts";
import { Button, StatusChip } from "../ui";

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
      <section className="dk-share">
        <h3 className="dk-label dk-export__heading">Share</h3>
        <p className="dk-muted">
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
      <section className="dk-share">
        <h3 className="dk-label dk-export__heading">Share</h3>
        <p role="alert" className="dk-export__error">
          Sharing could not be checked just now. Try again when you are connected.
        </p>
      </section>
    );
  }

  return (
    <section className="dk-share">
      <h3 className="dk-label dk-export__heading">Share</h3>

      <div className="dk-export__formats">
        <Button
          size="sm"
          variant="primary"
          // Off until the deployment has said it supports this, so the button is
          // never live against a server that will refuse it.
          disabled={sharing !== "yes"}
          onClick={() => void create()}
        >
          Create view link
        </Button>
      </div>

      <label className="dk-export__option">
        <input
          type="checkbox"
          checked={expires}
          onChange={(event) => setExpires(event.target.checked)}
        />
        Expire after 30 days
      </label>

      {error ? (
        <p role="alert" className="dk-export__error">
          {error}
        </p>
      ) : null}

      {fresh?.token ? (
        <div className="dk-share__fresh">
          {/* Not a nudge — the server stores only a hash, so this is the last
              time this link exists anywhere but the holder's hands. */}
          <p className="dk-share__warn">
            Copy this now. It cannot be shown again.
          </p>
          <code className="dk-share__link">{linkFor(fresh)}</code>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(linkFor(fresh));
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      ) : null}

      {shares === null ? (
        <p className="dk-muted">Loading…</p>
      ) : shares.length === 0 ? (
        <p className="dk-muted">
          No links yet. A link lets someone open this deck without an account.
        </p>
      ) : (
        <ul className="dk-share__list">
          {shares.map((share) => (
            <li key={share.id} className="dk-share__row">
              <div className="dk-share__who">
                <div>
                  {share.label ?? (share.role === "editor" ? "Can edit" : "Can view")}
                </div>
                <div className="dk-muted">
                  {share.view_count === 0
                    ? "Not opened yet"
                    : `Opened ${share.view_count} time${share.view_count === 1 ? "" : "s"}`}
                  {share.expires_at ? ` · expires ${short(share.expires_at)}` : ""}
                </div>
              </div>

              <StatusChip tone={share.status === "active" ? "action" : "neutral"}>{share.status}</StatusChip>

              {share.status === "active" ? (
                <Button size="sm" variant="secondary" onClick={() => void revoke(share.id)}>
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function short(iso: string): string {
  // Deliberately not `toLocaleDateString`: ICU data varies by runtime, and this
  // project's determinism rule applies to anything a snapshot might capture.
  const date = new Date(iso);
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

