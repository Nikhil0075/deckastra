import { newId, type DiagramElement, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";

/**
 * Diagram structure as operations (manual-authoring review MA-19).
 *
 * A diagram is structure, not SVG (doc 02 §18): nodes, edges and groups, laid
 * out by the renderer. So editing one is editing that structure — a node's
 * label, a new node, a connection, a reroute — and never nudging nine shapes.
 * Every id stays put: an animation that draws "the edges out of the
 * orchestrator" names edge ids, and a relabel that minted new ones would
 * silently unhook it.
 *
 * Each function returns one patch over the whole `nodes` / `edges` array. The
 * arrays are small, a whole-array replace has one obvious inverse, and it
 * cannot land on the wrong index the way a positional edit can.
 */

type Node = DiagramElement["nodes"][number];
type Edge = DiagramElement["edges"][number];

export function setNodeLabelOperations(
  document: PresentationDocument,
  diagram: DiagramElement,
  nodeId: string,
  label: string,
): PatchOperation[] {
  const node = diagram.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.label === label) return [];
  return nodes(document, diagram, diagram.nodes.map((n) => (n.id === nodeId ? { ...n, label } : n)));
}

export function setEdgeLabelOperations(
  document: PresentationDocument,
  diagram: DiagramElement,
  edgeId: string,
  label: string,
): PatchOperation[] {
  const edge = diagram.edges.find((candidate) => candidate.id === edgeId);
  if (!edge || (edge.label ?? "") === label) return [];
  return edges(
    document,
    diagram,
    diagram.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const next: Edge = { ...e };
      if (label === "") delete next.label;
      else next.label = label;
      return next;
    }),
  );
}

/**
 * Add a node, optionally connected from an existing one — the common gesture
 * ("and then…") in one step. In a manually laid-out diagram the new node is
 * placed to the right of the one it follows, since nothing else will place it.
 */
export function addNodeOperations(
  document: PresentationDocument,
  diagram: DiagramElement,
  input: { label: string; connectFrom?: string },
): { operations: PatchOperation[]; nodeId: string } {
  const nodeId = newId("el");
  const from = input.connectFrom ? diagram.nodes.find((n) => n.id === input.connectFrom) : undefined;
  const node: Node = { id: nodeId, label: input.label };
  if (from?.role) node.role = from.role;
  if (diagram.layoutHint?.mode === "manual" || diagram.layoutHint?.algorithm === "manual") {
    const anchor = from ?? diagram.nodes.at(-1);
    const position = anchor?.position ?? { x: 0, y: 0 };
    node.position = { x: position.x + 200, y: position.y };
  }
  const operations = nodes(document, diagram, [...diagram.nodes, node]);
  if (from) {
    operations.push(...edges(document, diagram, [...diagram.edges, { id: newId("el"), from: from.id, to: nodeId, direction: "forward" }]));
  }
  return { operations, nodeId };
}

/** Remove a node and every connection and group membership that named it. */
export function removeNodeOperations(document: PresentationDocument, diagram: DiagramElement, nodeId: string): PatchOperation[] {
  if (!diagram.nodes.some((n) => n.id === nodeId)) return [];
  const operations = nodes(document, diagram, diagram.nodes.filter((n) => n.id !== nodeId));
  const keptEdges = diagram.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  if (keptEdges.length !== diagram.edges.length) operations.push(...edges(document, diagram, keptEdges));
  if (diagram.groups?.some((group) => group.nodeIds.includes(nodeId))) {
    operations.push(
      ...setPropertyDeep(
        document,
        diagram.id,
        "groups",
        diagram.groups.map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) })),
      ),
    );
  }
  return operations;
}

/** Connect two nodes. A connection that already exists, or a node to itself, is refused by name. */
export function addEdgeOperations(
  document: PresentationDocument,
  diagram: DiagramElement,
  from: string,
  to: string,
): { operations: PatchOperation[]; edgeId?: string; refusal?: string } {
  if (from === to) return { operations: [], refusal: "A connection needs two different boxes." };
  const ids = new Set(diagram.nodes.map((n) => n.id));
  if (!ids.has(from) || !ids.has(to)) return { operations: [], refusal: "Both ends must be boxes in this diagram." };
  if (diagram.edges.some((e) => e.from === from && e.to === to)) {
    return { operations: [], refusal: "Those two boxes are already connected that way." };
  }
  const edgeId = newId("el");
  return {
    operations: edges(document, diagram, [...diagram.edges, { id: edgeId, from, to, direction: "forward" }]),
    edgeId,
  };
}

export function removeEdgeOperations(document: PresentationDocument, diagram: DiagramElement, edgeId: string): PatchOperation[] {
  if (!diagram.edges.some((e) => e.id === edgeId)) return [];
  return edges(document, diagram, diagram.edges.filter((e) => e.id !== edgeId));
}

/**
 * Point a connection somewhere else. The edge keeps its id, label and style —
 * it is the same arrow, rerouted — which is what keeps an animation drawing it.
 */
export function rerouteEdgeOperations(
  document: PresentationDocument,
  diagram: DiagramElement,
  edgeId: string,
  endpoints: { from?: string; to?: string },
): { operations: PatchOperation[]; refusal?: string } {
  const edge = diagram.edges.find((e) => e.id === edgeId);
  if (!edge) return { operations: [] };
  const from = endpoints.from ?? edge.from;
  const to = endpoints.to ?? edge.to;
  if (from === to) return { operations: [], refusal: "A connection needs two different boxes." };
  if (from === edge.from && to === edge.to) return { operations: [] };
  return { operations: edges(document, diagram, diagram.edges.map((e) => (e.id === edgeId ? { ...e, from, to } : e))) };
}

function nodes(document: PresentationDocument, diagram: DiagramElement, value: Node[]): PatchOperation[] {
  return setPropertyDeep(document, diagram.id, "nodes", value);
}

function edges(document: PresentationDocument, diagram: DiagramElement, value: Edge[]): PatchOperation[] {
  return setPropertyDeep(document, diagram.id, "edges", value);
}
