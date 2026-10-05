"use client";

import { useEffect, useState } from "react";
import {
  AccountDeletionSettings,
  AccountSettings,
  AiTaskSettings,
  CreditsMeter,
  SettingsShell,
  type SettingsSectionId,
} from "@deckastra/editor-ui";
import { Button } from "@deckastra/editor-ui/ui";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";

import type { AuthState } from "../lib/auth";
import { webCloudAuth } from "../lib/client";
import { rememberDeletion } from "../lib/deletion";

/**
 * The web app's Settings: the shared shell, with what a browser can offer.
 * Account (who is signed in, signing out, deleting the account), Plans and
 * billing (the credits; never a purchase before track 3), and AI help. A build
 * using the development sign-in has no hosted account, so the sections that
 * need one are absent there rather than broken.
 */
export function WebSettings({
  open,
  onClose,
  section,
  onSection,
}: {
  open: boolean;
  onClose: () => void;
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
}) {
  const auth = webCloudAuth();
  return (
    <SettingsShell
      open={open}
      onClose={onClose}
      section={section}
      onSection={onSection}
      content={{
        account: (
          <>
            {auth ? <SignedIn /> : null}
            <AccountSettings online />
            {auth ? (
              <AccountDeletionSettings
                onDeleted={async (receipt) => {
                  // The service now refuses this account's token. Keep the
                  // receipt so the signed-out page can say how it is going.
                  rememberDeletion(receipt.id);
                  await auth.signOut();
                }}
              />
            ) : null}
          </>
        ),
        plans: auth ? (
          <div className="dk-settings__section" data-testid="settings-plans">
            <h3 className="dk-settings__heading">AI credits</h3>
            <CreditsMeter variant="card" />
            <p className="dk-muted">Credits pay for AI help only. Editing, checks and exports never use them.</p>
          </div>
        ) : null,
        ai: auth ? <AiTaskSettings /> : null,
      }}
    />
  );
}

function SignedIn() {
  const auth = webCloudAuth();
  const client = useWorkspaceClient();
  const [state, setState] = useState<AuthState>(() => auth?.state() ?? { status: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => auth?.subscribe(setState), [auth]);
  if (!auth || state.status !== "signed-in") return null;

  return (
    <div className="dk-settings__section" data-testid="settings-sign-in">
      <h3 className="dk-settings__heading">Signed in</h3>
      <p data-testid="settings-signed-in">Signed in as {state.user.email ?? state.user.name ?? "your account"}.</p>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          client.session.clear();
          void auth.signOut().finally(() => setBusy(false));
        }}
        data-testid="settings-sign-out"
      >
        {busy ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
