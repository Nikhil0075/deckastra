import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { hoverTooltip } from "@codemirror/view";

interface SchemaProperty {
  name: string;
  detail: string;
  info: string;
}

/**
 * Lightweight CodeMirror help driven directly by the emitted JSON Schema.
 * Validation remains authoritative in presentation-schema; these extensions
 * only make hand-authoring discoverable.
 */
export function jsonSchemaAssist(schema: Record<string, unknown>) {
  const properties = collectProperties(schema);
  const byName = new Map(properties.map((property) => [property.name, property]));
  return [
    autocompletion({
      override: [(context: CompletionContext) => {
        const linePrefix = context.state.doc.sliceString(context.state.doc.lineAt(context.pos).from, context.pos);
        const input = schemaKeyInput(linePrefix);
        if (!input || (!context.explicit && input.prefix.length === 0)) return null;
        const options: Completion[] = properties.map((property) => ({
          label: property.name,
          displayLabel: property.name,
          detail: property.detail,
          info: property.info,
          type: "property",
          apply(view, _completion, from, to) {
            // closeBrackets normally inserted the quote after the cursor. Eat it
            // when present so accepting a property never produces `"name""`.
            const closingQuote = input.quoted && view.state.doc.sliceString(to, to + 1) === "\"";
            const insert = input.quoted ? `${property.name}\": ` : `${JSON.stringify(property.name)}: `;
            view.dispatch({
              changes: { from, to: closingQuote ? to + 1 : to, insert },
              selection: { anchor: from + insert.length },
            });
          },
        }));
        return {
          // Keep an opening quote already typed by the person. Filtering must
          // see `ele`, not `"ele`, or CodeMirror hides every matching label.
          from: context.pos - input.prefix.length,
          options,
          validFor: /^[A-Za-z0-9_$-]*$/,
        };
      }],
    }),
    hoverTooltip((view, pos) => {
      const line = view.state.doc.lineAt(pos);
      const relative = pos - line.from;
      const text = line.text;
      const matches = [...text.matchAll(/"([^"\\]+)"\s*:/g)];
      const match = matches.find((item) => {
        const start = item.index ?? 0;
        return relative >= start && relative <= start + item[0].length;
      });
      const property = match?.[1] ? byName.get(match[1]) : undefined;
      if (!property || match?.index === undefined) return null;
      return {
        pos: line.from + match.index,
        end: line.from + match.index + match[0].length,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "dk-code-schema-help";
          const title = document.createElement("strong");
          title.textContent = property.name;
          const body = document.createElement("span");
          body.textContent = `${property.detail} · ${property.info}`;
          dom.append(title, body);
          return { dom };
        },
      };
    }),
  ];
}

export function schemaKeyInput(linePrefix: string): { prefix: string; quoted: boolean } | null {
  const raw = linePrefix.match(/(?:^|[{,])\s*("?[A-Za-z0-9_$-]*)$/)?.[1];
  if (raw === undefined) return null;
  return raw.startsWith("\"")
    ? { prefix: raw.slice(1), quoted: true }
    : { prefix: raw, quoted: false };
}

function collectProperties(schema: Record<string, unknown>): SchemaProperty[] {
  const found = new Map<string, SchemaProperty>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    if (isRecord(value.properties)) {
      for (const [name, definition] of Object.entries(value.properties)) {
        if (!found.has(name)) {
          const resolved = resolveSchema(definition, schema);
          const detail = describeType(resolved);
          const description = typeof resolved.description === "string" ? resolved.description : `JSON Schema field (${detail}).`;
          found.set(name, { name, detail, info: description });
        }
        visit(definition);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(schema);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function resolveSchema(value: unknown, root: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/") ) return value;
  let at: unknown = root;
  for (const raw of value.$ref.slice(2).split("/")) {
    if (!isRecord(at)) return value;
    at = at[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isRecord(at) ? { ...at, ...value, $ref: undefined } : value;
}

function describeType(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((part) => describeType(isRecord(part) ? part : {})).join(" | ");
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((part) => describeType(isRecord(part) ? part : {})).join(" | ");
  return "value";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
