import { createContext, useContext, type ReactNode } from "react";
import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

/**
 * What a colour field can reach beyond its own value (colour wizard, 2026-09-26).
 *
 * A field is given a value and an `onChange`, which is enough to recolour one
 * thing. Naming a colour, or opening the Colours panel from inside a picker,
 * reaches the deck: the named colour lives in the theme, and saving one converts
 * every use of that value at once. Provided by the editor shell; a field outside
 * one (a test, a preview) simply offers less.
 */
export interface ColorStudio {
  document: PresentationDocument;
  apply: (operations: PatchOperation[], label: string) => void;
  /** Open the Colours panel, optionally at a named colour or theme role. */
  open: (focus?: string) => void;
}

const Context = createContext<ColorStudio | null>(null);

export function ColorStudioProvider({ value, children }: { value: ColorStudio; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useColorStudio(): ColorStudio | null {
  return useContext(Context);
}
