import type { DocumentScene, SceneNode, SlideScene } from "./scene";

/**
 * Render digests — the visual-regression harness (doc 04 §34).
 *
 * A digest is taken over the **scene**, not over a screenshot. That is a
 * deliberate trade and worth stating plainly:
 *
 * - What it catches: every change to resolved geometry, colour, text, chart
 *   marks, diagram layout, paint order and font resolution. In practice that is
 *   nearly every regression, because the React layer computes nothing — it emits
 *   the numbers in the scene.
 * - What it cannot catch: a bug that lives purely in the emit step or in the
 *   browser's painting of it. Catching those needs real pixels, which needs the
 *   headless render service (Phase 8). Until then this is the gate, and its
 *   limits are written here rather than assumed away.
 *
 * The output is deliberately readable. A hex hash tells you something changed;
 * these lines tell you *which node* changed and how, which is the difference
 * between a two-minute fix and an afternoon.
 */

function n(value: number | undefined): string {
  if (value === undefined) return "-";
  // Three decimals, matching the rounding the geometry already went through.
  // Trailing zeros are trimmed so 12 and 12.000 do not read as different.
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded === 0 ? 0 : rounded);
}

function summarisePayload(node: SceneNode): string {
  const payload = node.renderPayload;

  switch (payload.kind) {
    case "text":
      return [
        "text",
        `size=${n(payload.metrics.appliedFontSize)}`,
        `lines=${payload.metrics.lineCount}`,
        payload.metrics.overflow ? "overflow" : "",
        `chars=${payload.blocks.reduce(
          (sum, block) => sum + block.spans.reduce((s, span) => s + span.text.length, 0),
          0,
        )}`,
      ]
        .filter(Boolean)
        .join(" ");

    case "shape": {
      const base = `shape d=${payload.pathData.length} rect=${payload.preferRect} r=${n(payload.radius)}`;
      if (!payload.label?.length || !payload.labelTypography) return base;
      // A label is part of what the shape looks like: its colour, size and
      // alignment are exactly what went wrong unnoticed when none of them
      // were recorded here.
      const align = payload.label[0]?.align ?? "left";
      return `${base} label size=${n(payload.labelTypography.fontSize)} color=${String(payload.labelTypography.color ?? "inherit")} align=${align} v=${payload.labelVerticalAlign ?? "middle"}`;
    }

    case "line":
      return `line ${n(payload.x1)},${n(payload.y1)}->${n(payload.x2)},${n(payload.y2)}`;

    case "image":
      return `image ${payload.assetId} fit=${payload.objectFit} at=${payload.objectPosition}`;

    case "code":
      return `code ${payload.language} lines=${payload.lines.length} tokens=${payload.lines.reduce(
        (sum, line) => sum + line.tokens.length,
        0,
      )}`;

    case "table":
      return `table ${payload.columns.length}x${payload.rows.length} borders=${payload.borders} banding=${payload.banding}`;

    case "chart":
      return [
        `chart ${payload.chartType}`,
        `plot=${n(payload.plot.x)},${n(payload.plot.y)},${n(payload.plot.width)},${n(payload.plot.height)}`,
        `rects=${payload.rects.length}`,
        `paths=${payload.paths.length}`,
        `points=${payload.points.length}`,
        `texts=${payload.texts.length}`,
        `legend=${payload.legend.length}`,
        payload.notice ? `notice=${payload.notice}` : "",
        // Geometry, not just counts: a bar that moves must change the digest.
        `marks=${payload.rects
          .map((r) => `${n(r.x)},${n(r.y)},${n(r.width)},${n(r.height)}`)
          .join(";")}`,
        `d=${payload.paths.map((p) => p.d).join(";")}`,
      ]
        .filter(Boolean)
        .join(" ");

    case "diagram":
      return [
        `diagram ${payload.diagramType}/${payload.algorithm}`,
        `nodes=${payload.nodes
          .map((node_) => `${node_.id.slice(-6)}@${n(node_.x)},${n(node_.y)},${n(node_.width)},${n(node_.height)}`)
          .join(";")}`,
        `edges=${payload.edges.map((edge) => `${edge.id.slice(-6)}:${edge.d}`).join(";")}`,
        `edgeLabels=${payload.edges.filter(edge => edge.label).map(edge => {
          const label = edge.label!;
          return `${edge.id.slice(-6)}:${JSON.stringify(label.text)}@${n(label.x)},${n(label.y)},${n(label.size)}`;
        }).join(";")}`,
        `groups=${payload.groups
          .map((group) => `${n(group.x)},${n(group.y)},${n(group.width)},${n(group.height)}`)
          .join(";")}`,
      ].join(" ");

    case "icon":
      return `icon ${payload.set}/${payload.name}${payload.missing ? " missing" : ""} paths=${payload.paths.length}`;

    case "group":
      return "group";

    case "placeholder":
      return `placeholder ${payload.label}`;

    default:
      return "unknown";
  }
}

function nodeLine(node: SceneNode): string {
  const style = node.resolvedStyle;
  return [
    node.id,
    node.type,
    node.semanticRole ?? "-",
    `z=${node.zPath.join(".")}`,
    `b=${n(node.bounds.x)},${n(node.bounds.y)},${n(node.bounds.width)},${n(node.bounds.height)}`,
    `m=${node.worldTransform.a},${node.worldTransform.b},${node.worldTransform.c},${node.worldTransform.d},${n(node.worldTransform.e)},${n(node.worldTransform.f)}`,
    `fill=${style.fill ?? "-"}`,
    `stroke=${style.stroke ? `${style.stroke.color}/${n(style.stroke.width)}` : "-"}`,
    `opacity=${n(style.opacity)}`,
    // Only when present, so a digest line for an element without them is the
    // line it has always been.
    ...(style.gradient
      ? [`grad=${style.gradient.kind}/${n(style.gradient.angle)}/${style.gradient.stops.map((s) => `${s.color}@${n(s.offset)}`).join(",")}`]
      : []),
    ...(style.backdropFilter ? [`backdrop=${style.backdropFilter}`] : []),
    `a11y=${node.a11y.role}/${node.a11y.order}`,
    summarisePayload(node),
  ].join(" | ");
}

function flatten(nodes: SceneNode[], out: SceneNode[]): SceneNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

/** A readable, line-per-node digest of one slide. */
export function slideDigest(scene: SlideScene): string {
  const nodes = flatten(scene.nodes, []);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return [
    `slide ${scene.slideId} ${scene.width}x${scene.height}`,
    `background ${scene.background?.color ?? scene.background?.gradient ?? "-"}`,
    `transition ${scene.transition?.type ?? "-"}`,
    // Paint order, not document order: a z-order regression must fail this.
    ...scene.paintOrder.map((id) => nodeLine(byId.get(id)!)),
  ].join("\n");
}

export function documentDigest(scene: DocumentScene): string {
  return [
    `document ${scene.documentId} ${scene.viewport.width}x${scene.viewport.height}`,
    `theme ${scene.theme.id} ${scene.theme.mode}`,
    // Font resolution belongs in the digest: the same document renders
    // differently when a face is missing, and a diff that does not say so sends
    // someone hunting a code regression that is not there (doc 04 §18.4).
    `fonts ${scene.fontDigest}`,
    ...scene.slides.map(slideDigest),
  ].join("\n");
}

/**
 * FNV-1a over the digest text.
 *
 * For the cases where a short identifier is wanted — a cache key, a log line —
 * never as the thing a test asserts against. Asserting on a hash gives the
 * reader "expected a4f2, got 91bc" and nothing to act on.
 */
export function digestHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
