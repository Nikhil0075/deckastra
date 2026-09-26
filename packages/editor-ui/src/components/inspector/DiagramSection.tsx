import { useState } from "react";
import type { DiagramElement, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";

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
import { CellInput, Hint } from "./controls";

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
    </Section>
  );
}
