import { useState } from "react";
import type { DiagramElement, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { resolveElementById, setPropertyDeep } from "@deckastra/presentation-core";

import {
  addEdgeOperations,
  addNodeOperations,
  removeEdgeOperations,
  removeNodeOperations,
  rerouteEdgeOperations,
  setEdgeLabelOperations,
  setNodeLabelOperations,
} from "../../lib/diagram-data";
import { Button, IconButton, Section, Select } from "../../ui";
import { CellInput, ColorField, Hint } from "./controls";
import { setAtOperations } from "../../lib/nested";

/**
 * A diagram's boxes and connections, edited by hand (manual-authoring review
 * MA-19). The layout stays the renderer's: adding a box or a connection
 * re-lays the diagram, which is the point of a diagram being structure rather
 * than nine positioned shapes.
 */

type Edit = (operations: PatchOperation[], label: string, coalesceKey?: string) => void;

export function DiagramSection({
  document,
  element,
  edit,
  disabled,
}: {
  document: PresentationDocument;
  element: DiagramElement;
  edit: Edit;
  disabled: boolean;
}) {
  const [message, setMessage] = useState<string | undefined>();
  const [from, setFrom] = useState(element.nodes[0]?.id ?? "");
  const [to, setTo] = useState(element.nodes[1]?.id ?? "");
  const nodeOptions = element.nodes.map((node, index) => ({ value: node.id, label: node.label || `Box ${index + 1}` }));
  const nameOf = (id: string) => element.nodes.find((node) => node.id === id)?.label || "a removed box";
  const direction = element.layoutHint?.direction ?? "LR";

  return (
    <Section title="Diagram" defaultOpen meta={`${element.nodes.length} boxes · ${element.edges.length} links`}>
      <span className="dk-label">Boxes</span>
      <ul className="dk-datalist" data-testid="diagram-nodes">
        {element.nodes.map((node, index) => (
          <li key={node.id} className="dk-datalist__row">
            <CellInput
              label={`Box ${index + 1} label`}
              value={node.label}
              disabled={disabled}
              onCommit={(text) => edit(setNodeLabelOperations(document, element, node.id, text), "Edit diagram label")}
            />
            <IconButton
              icon="plus"
              label={`Add a box after ${node.label || `box ${index + 1}`}`}
              size="sm"
              disabled={disabled}
              onClick={() => edit(addNodeOperations(document, element, { label: "New step", connectFrom: node.id }).operations, "Add diagram box")}
            />
            {element.nodes.length > 1 ? (
              <IconButton
                icon="close"
                label={`Remove ${node.label || `box ${index + 1}`}`}
                size="sm"
                disabled={disabled}
                onClick={() => edit(removeNodeOperations(document, element, node.id), "Remove diagram box")}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        data-testid="diagram-add-node"
        onClick={() => edit(addNodeOperations(document, element, { label: "New box" }).operations, "Add diagram box")}
      >
        Add box
      </Button>

      <span className="dk-label">Connections</span>
      <ul className="dk-datalist" data-testid="diagram-edges">
        {element.edges.map((edge, index) => (
          <li key={edge.id} className="dk-datalist__row dk-datalist__row--edge">
            <Select
              label={`Connection ${index + 1} from`}
              hideLabel
              value={edge.from}
              options={nodeOptions}
              disabled={disabled}
              onChange={(value) => {
                const result = rerouteEdgeOperations(document, element, edge.id, { from: value });
                setMessage(result.refusal);
                if (result.operations.length) edit(result.operations, "Reroute connection");
              }}
            />
            <span aria-hidden="true">→</span>
            <Select
              label={`Connection ${index + 1} to`}
              hideLabel
              value={edge.to}
              options={nodeOptions}
              disabled={disabled}
              onChange={(value) => {
                const result = rerouteEdgeOperations(document, element, edge.id, { to: value });
                setMessage(result.refusal);
                if (result.operations.length) edit(result.operations, "Reroute connection");
              }}
            />
            <CellInput
              label={`Label on the connection from ${nameOf(edge.from)} to ${nameOf(edge.to)}`}
              value={edge.label ?? ""}
              disabled={disabled}
              onCommit={(text) => edit(setEdgeLabelOperations(document, element, edge.id, text), "Edit connection label")}
            />
            <IconButton
              icon="close"
              label={`Remove the connection from ${nameOf(edge.from)} to ${nameOf(edge.to)}`}
              size="sm"
              disabled={disabled}
              onClick={() => edit(removeEdgeOperations(document, element, edge.id), "Remove connection")}
            />
          </li>
        ))}
      </ul>
      {element.nodes.length >= 2 ? (
        <div className="dk-datalist__row dk-datalist__row--edge" data-testid="diagram-connect">
          <Select label="Connect from" hideLabel value={from} options={nodeOptions} disabled={disabled} onChange={setFrom} />
          <span aria-hidden="true">→</span>
          <Select label="Connect to" hideLabel value={to} options={nodeOptions} disabled={disabled} onChange={setTo} />
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              const result = addEdgeOperations(document, element, from, to);
              setMessage(result.refusal);
              if (result.operations.length) edit(result.operations, "Add connection");
            }}
          >
            Connect
          </Button>
        </div>
      ) : null}
      {message ? (
        <p className="dk-field__hint dk-field__hint--error" role="alert">
          {message}
        </p>
      ) : null}

      <Select
        label="Direction"
        value={direction}
        options={[
          { value: "LR", label: "Left to right" },
          { value: "TB", label: "Top to bottom" },
          { value: "RL", label: "Right to left" },
          { value: "BT", label: "Bottom to top" },
        ]}
        disabled={disabled}
        onChange={(v) => edit(setPropertyDeep(document, element.id, "layoutHint.direction", v), "Change diagram direction")}
      />
      <Hint>
        {element.layoutHint?.mode === "manual" || element.layoutHint?.algorithm === "manual"
          ? "This diagram is placed by hand, so a new box goes to the right of the one it follows."
          : "The diagram lays itself out again after each change."}
      </Hint>
      <DiagramColors document={document} element={element} edit={edit} disabled={disabled} />
    </Section>
  );
}

const ALL = "__all";

function solidOf(paint: unknown): string | undefined {
  const value = paint as { type?: string; color?: string } | undefined;
  return value?.type === "solid" ? value.color : undefined;
}

/**
 * A diagram's colours (colour wizard, 2026-09-26): a box's fill and border, or
 * every box's at once, and a connection's colour. The layout is untouched, and
 * a box given a dark fill gets a label colour it can be read on (the renderer
 * picks it). Clearing a colour hands the box back to its role's style or the
 * theme.
 */
function DiagramColors({ document, element, edit, disabled }: { document: PresentationDocument; element: DiagramElement; edit: Edit; disabled: boolean }) {
  const [box, setBox] = useState<string>(element.nodes[0]?.id ?? ALL);
  const [link, setLink] = useState<string>(element.edges[0]?.id ?? "");
  const path = resolveElementById(document, element.id)?.path;
  const targets = box === ALL ? element.nodes : element.nodes.filter((node) => node.id === box);
  const shared = (read: (node: DiagramElement["nodes"][number]) => string | undefined) => {
    const values = targets.map(read);
    return values.every((value) => value === values[0]) ? values[0] : undefined;
  };

  const paintNodes = (property: "fill" | "stroke", color: string | undefined, label: string) => {
    if (!path) return;
    const operations = targets.flatMap((node) => {
      const index = element.nodes.indexOf(node);
      if (property === "fill") {
        return setAtOperations(element, path, ["nodes", { at: index }, "style", "fill"], color ? { type: "solid", color } : undefined);
      }
      const width = node.style?.stroke?.width ?? 2;
      return setAtOperations(element, path, ["nodes", { at: index }, "style", "stroke"], color ? { paint: { type: "solid", color }, width } : undefined);
    });
    edit(operations, label);
  };

  const edgeIndex = element.edges.findIndex((edge) => edge.id === link);
  const edge = element.edges[edgeIndex];

  return (
    <>
      <span className="dk-label">Colours</span>
      <Select
        label="Colour a box"
        value={box}
        disabled={disabled || element.nodes.length === 0}
        options={[
          { value: ALL, label: "Every box" },
          ...element.nodes.map((node, index) => ({ value: node.id, label: node.label || `Box ${index + 1}` })),
        ]}
        onChange={setBox}
      />
      <ColorField
        label="Box fill"
        value={shared((node) => solidOf(node.style?.fill))}
        theme={document.theme}
        allowNone
        disabled={disabled || targets.length === 0}
        data-testid="diagram-node-fill"
        onChange={(color) => paintNodes("fill", color, box === ALL ? "Colour every box" : "Colour a box")}
      />
      <ColorField
        label="Box border"
        value={shared((node) => solidOf(node.style?.stroke?.paint))}
        theme={document.theme}
        allowNone
        disabled={disabled || targets.length === 0}
        data-testid="diagram-node-border"
        onChange={(color) => paintNodes("stroke", color, box === ALL ? "Colour every border" : "Colour a border")}
      />
      {element.edges.length ? (
        <>
          <Select
            label="Colour a connection"
            value={link}
            disabled={disabled}
            options={element.edges.map((candidate, index) => ({
              value: candidate.id,
              label: `${element.nodes.find((node) => node.id === candidate.from)?.label ?? "?"} → ${element.nodes.find((node) => node.id === candidate.to)?.label ?? "?"}` || `Connection ${index + 1}`,
            }))}
            onChange={setLink}
          />
          <ColorField
            label="Connection colour"
            value={solidOf(edge?.style?.stroke?.paint)}
            theme={document.theme}
            allowNone
            disabled={disabled || !edge}
            data-testid="diagram-edge-color"
            onChange={(color) => {
              if (!path || !edge) return;
              edit(
                setAtOperations(element, path, ["edges", { at: edgeIndex }, "style", "stroke"], color ? { paint: { type: "solid", color }, width: edge.style?.stroke?.width ?? 2 } : undefined),
                "Colour a connection",
              );
            }}
          />
        </>
      ) : null}
    </>
  );
}
