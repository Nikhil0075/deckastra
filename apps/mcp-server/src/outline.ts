import type { PresentationDocument } from "@deckastra/presentation-schema";

/**
 * A deck, small enough to read (milestone D2.2).
 *
 * The rule from the plan: **tool results are bounded summaries and resource
 * references, never a whole workspace.** A `.mydeck` document is the wrong thing
 * to hand a language model by default — the animation fixture alone is tens of
 * thousands of tokens, most of it transforms, token references and ids that carry
 * no meaning to a reader. An agent that spends its whole context reading a deck
 * has none left to change it.
 *
 * So the default answer is an outline: what each slide is for, what it says, and
 * the ids needed to address a change at it. Full geometry is available, but it is
 * asked for one slide at a time and the caller has to mean it.
 *
 * The ids are the load-bearing part. Every operation this product accepts is
 * id-addressed (`/slides/id:sld_x/elements/id:el_y/...`), so an outline that
 * summarised the content without naming the elements would be a description an
 * agent could read and not act on.
 */

/** Longest run of text kept per element. Enough to recognise, not to reproduce. */
const TEXT_LIMIT = 240;

export interface ElementOutline {
  id: string;
  type: string;
  role?: string;
  /** Present only for elements that carry words. */
  text?: string;
  /** Present only when the element holds more text than was shown. */
  truncated?: boolean;
  /** Children are named but not descended into; ask for the slide to see them. */
  childCount?: number;
}

export interface SlideOutline {
  id: string;
  index: number;
  name?: string;
  intent?: string;
  keyMessage?: string;
  elements: ElementOutline[];
  animationTrackCount: number;
}

export interface DocumentOutline {
  presentationId: string;
  versionId: string;
  title?: string;
  slideCount: number;
  themeId?: string;
  slides: SlideOutline[];
  /**
   * What the Critic could not resolve, if a generation run left any.
   *
   * Surfaced because it is the most actionable thing in a generated deck and it
   * lives in an extension key no reader would think to look in.
   */
  unresolvedIssues?: unknown;
}

/** Flatten a text element's blocks and spans into one readable string. */
function textOf(element: Record<string, any>): { text: string; truncated: boolean } | undefined {
  const blocks = element.content?.blocks;
  if (!Array.isArray(blocks)) return undefined;

  const whole = blocks
    .map((block: any) =>
      Array.isArray(block?.spans) ? block.spans.map((span: any) => String(span?.text ?? "")).join("") : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!whole) return undefined;
  return whole.length > TEXT_LIMIT
    ? { text: `${whole.slice(0, TEXT_LIMIT)}…`, truncated: true }
    : { text: whole, truncated: false };
}

function outlineElement(element: Record<string, any>): ElementOutline {
  const summary: ElementOutline = { id: String(element.id), type: String(element.type) };
  if (element.semanticRole) summary.role = String(element.semanticRole);

  // An equation's content is its source, and an agent asked to fix a formula
  // has to be able to read the one it is fixing.
  const text =
    element.type === "equation" && typeof element.latex === "string"
      ? element.latex.length > TEXT_LIMIT
        ? { text: `${element.latex.slice(0, TEXT_LIMIT)}…`, truncated: true }
        : { text: element.latex, truncated: false }
      : textOf(element);
  if (text) {
    summary.text = text.text;
    if (text.truncated) summary.truncated = true;
  }

  // Named, not descended into. A group's children are addressable by asking for
  // the slide, and recursing here would put the deep structure back into the
  // summary that exists to leave it out.
  if (Array.isArray(element.children)) summary.childCount = element.children.length;

  // A chart or diagram's data is its content, and an agent asked to fix a chart
  // needs to know it is one. The numbers stay behind `document_read_slide`.
  if (element.type === "chart" && element.chart?.type) summary.role ??= String(element.chart.type);

  return summary;
}

export function outlineDocument(
  document: PresentationDocument,
  context: { presentationId: string; versionId: string },
): DocumentOutline {
  const raw = document as unknown as Record<string, any>;
  const slides: any[] = Array.isArray(raw.slides) ? raw.slides : [];

  const outline: DocumentOutline = {
    presentationId: context.presentationId,
    versionId: context.versionId,
    slideCount: slides.length,
    slides: slides.map((slide, index) => {
      const summary: SlideOutline = {
        id: String(slide.id),
        index,
        elements: (Array.isArray(slide.elements) ? slide.elements : []).map(outlineElement),
        animationTrackCount: Array.isArray(slide.animations) ? slide.animations.length : 0,
      };
      if (slide.name) summary.name = String(slide.name);
      if (slide.semanticIntent) summary.intent = String(slide.semanticIntent);
      if (slide.keyMessage) summary.keyMessage = String(slide.keyMessage);
      return summary;
    }),
  };

  if (raw.metadata?.title) outline.title = String(raw.metadata.title);
  if (raw.theme?.id) outline.themeId = String(raw.theme.id);

  const issues = raw.extensions?.["deckastra.unresolvedIssues"];
  if (issues) outline.unresolvedIssues = issues;

  return outline;
}

/** One slide in full, for when an agent is about to change it. */
export function slideOf(document: PresentationDocument, slideId: string): unknown {
  const slides: any[] = Array.isArray((document as any).slides) ? (document as any).slides : [];
  const found = slides.find((slide) => String(slide.id) === slideId);
  if (!found) {
    throw new Error(
      `No slide ${slideId} in this deck. Read the outline first — slide ids change when a deck is regenerated.`,
    );
  }
  return found;
}
