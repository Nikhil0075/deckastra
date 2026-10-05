"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { DeckList, SETTINGS_SECTIONS, type DeckListCommand, type SettingsSectionId } from "@deckastra/editor-ui";

import { useAccountMenu } from "../lib/use-account-menu";
import { WebSettings } from "./WebSettings";

/**
 * The web home: the same home the desktop has (roadmap 08 §1.3, concept
 * 08-home.png). Projects on the left, the "Describe a deck…" prompt bar with
 * Create and Blank deck, and the decks as cards.
 *
 * It used to be a page of its own on the pre-rewrite tokens, with a generation
 * form, an account picker and a preview, which made the web and the desktop two
 * different products at the front door. Everything it did is in the shared home
 * now: generation and its outline review, grounding in a repository, a blank
 * deck, and opening one. The route only decides what opening means.
 *
 * `?start=new-deck` or `?start=generate-deck` carries New deck and Generate
 * chosen from inside a deck: the editor leaves first, then the home does it.
 * `?settings=<section>` does the same for Settings.
 */
export default function Home() {
  const router = useRouter();
  const [startWith, setStartWith] = useState<DeckListCommand | null>(null);
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSectionId }>({ open: false, section: "account" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const start = params.get("start");
    if (start === "new-deck" || start === "generate-deck") setStartWith(start);
    const section = params.get("settings");
    const known = SETTINGS_SECTIONS.find(({ id }) => id === section);
    if (known) setSettings({ open: true, section: known.id });
  }, []);

  const accountMenu = useAccountMenu();
  const openSettings = () => setSettings((current) => ({ ...current, open: true }));

  return (
    <>
      <DeckList
        onOpen={(id) => router.push(`/edit/${encodeURIComponent(id)}`)}
        startWith={startWith}
        onOpenSettings={openSettings}
        accountMenu={accountMenu}
      />
      <WebSettings
        open={settings.open}
        onClose={() => setSettings((current) => ({ ...current, open: false }))}
        section={settings.section}
        onSection={(section) => setSettings({ open: true, section })}
      />
    </>
  );
}
