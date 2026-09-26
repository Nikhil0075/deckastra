import type { ReactNode } from "react";
import type { RichTextDocument, TextBlock, TextSpan } from "@deckastra/presentation-schema";

/**
 * Rich speaker notes drawn for reading — the presenter view (audit P2).
 *
 * React elements from the document, never markup: notes are content someone
 * wrote, possibly pasted, and nothing here is parsed as HTML. A link is shown as
 * underlined text rather than an anchor, because a click in the presenter view
 * during a talk should never leave it.
 */
export function RichNotes({ notes }: { notes: RichTextDocument }) {
  const out: ReactNode[] = [];
  let list: { type: string; items: ReactNode[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.type === "numbered" ? "ol" : "ul";
    out.push(<Tag key={`list-${out.length}`}>{list.items}</Tag>);
    list = null;
  };

  notes.blocks.forEach((block, index) => {
    const content = spans(block);
    if (block.type === "bullet" || block.type === "numbered") {
      if (!list || list.type !== block.type) {
        flush();
        list = { type: block.type, items: [] };
      }
      list.items.push(<li key={block.id ?? index}>{content}</li>);
      return;
    }
    flush();
    if (block.type === "heading") out.push(<h4 key={block.id ?? index}>{content}</h4>);
    else if (block.type === "quote") out.push(<blockquote key={block.id ?? index}>{content}</blockquote>);
    else out.push(<p key={block.id ?? index}>{content}</p>);
  });
  flush();
  return <div className="dk-richnotes">{out}</div>;
}

function spans(block: TextBlock): ReactNode {
  if (block.spans.every((span) => span.text === "")) return <br />;
  return block.spans.map((span, index) => <Span key={index} span={span} />);
}

function Span({ span }: { span: TextSpan }) {
  let node: ReactNode = span.text;
  if (span.code) node = <code>{node}</code>;
  if (span.strike) node = <s>{node}</s>;
  if (span.underline || span.link) node = <u>{node}</u>;
  if (span.italic) node = <em>{node}</em>;
  if (span.bold) node = <strong>{node}</strong>;
  return <>{node}</>;
}
