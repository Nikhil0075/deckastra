import type { EditorApi } from "../../lib/useEditor";
import { deckLanguages, languageCode } from "../../lib/languages";
import { Button, Menu, type MenuItem } from "../../ui";

/**
 * The language switcher (integration plan 01 §3.2): which of the deck's
 * languages is on the canvas. Editor state, never saved — two people may be
 * reviewing the Hindi and the Arabic of one deck at the same time.
 *
 * Each overlay shows how much of it is translated and current, because
 * "switch to Hindi" on a deck that is 20% Hindi shows mostly English, and the
 * person should know that before they look.
 */
export function LanguageMenu({ editor, onManage }: { editor: EditorApi; onManage: () => void }) {
  const languages = deckLanguages(editor.sourceDocument);
  const showing = editor.locale ?? languages[0]!.tag;
  const items: MenuItem[] = [
    ...languages.map((language) => ({
      id: `language-${language.tag}`,
      label: language.source
        ? `${language.label} (original)`
        : `${language.label} — ${Math.round(language.done * 100)}%${language.outdated ? `, ${language.outdated} outdated` : ""}`,
      checked: language.tag === showing,
      onSelect: () => editor.setLocale(language.source ? null : language.tag),
    })),
    { id: "manage-languages", label: "Add or manage languages…", icon: "plus", onSelect: onManage },
  ];
  return (
    <Menu
      label="Deck language"
      align="end"
      items={items}
      trigger={(props) => (
        <Button
          size="sm"
          variant={editor.locale ? "secondary" : "ghost"}
          icon="language"
          title={`Showing ${languages.find((language) => language.tag === showing)?.label ?? showing}`}
          className="dk-language-chip"
          data-testid="language-menu"
          data-language={showing}
          {...props}
        >
          {languageCode(showing)}
        </Button>
      )}
    />
  );
}
