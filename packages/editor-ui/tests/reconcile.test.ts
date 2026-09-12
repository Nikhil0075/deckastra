import { expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { reconcileDocuments } from "../src/lib/reconcile";

const fixture = () => structuredClone(loadFixture("technical"));
it("preserves independent changes on the same slide and future properties", () => {
  const base = fixture(), local = structuredClone(base), server = structuredClone(base);
  local.slides[0]!.elements[0]!.name = "Local heading";
  server.slides[0]!.elements[1]!.name = "Server subtitle";
  local.extensions = { future: { preserved: true } };
  const result = reconcileDocuments(base, local, server);
  expect(result.conflicts).toEqual([]);
  expect(result.document.slides[0]!.elements[0]!.name).toBe("Local heading");
  expect(result.document.slides[0]!.elements[1]!.name).toBe("Server subtitle");
  expect(result.document.extensions).toEqual(local.extensions);
  expect(result.errors).toEqual([]);
});

it("requires an explicit choice for competing edits, with no mutation of inputs", () => {
  const base = fixture(), local = structuredClone(base), server = structuredClone(base);
  local.metadata.title = "Mine"; server.metadata.title = "Theirs";
  const review = reconcileDocuments(base, local, server);
  expect(review.conflicts).toEqual([{ path: "/metadata/title", local: "Mine", server: "Theirs" }]);
  expect(reconcileDocuments(base, local, server, { "/metadata/title": "local" }).document.metadata.title).toBe("Mine");
  expect(server.metadata.title).toBe("Theirs");
});

it("treats deleting an edited element as a conflict and keeps unrelated edits", () => {
  const base = fixture(), local = structuredClone(base), server = structuredClone(base);
  const id = base.slides[0]!.elements[0]!.id;
  local.slides[0]!.elements.shift(); server.slides[0]!.elements[0]!.name = "Changed remotely";
  server.metadata.title = "Remote title";
  const review = reconcileDocuments(base, local, server);
  const conflict = review.conflicts.find(c => c.path.endsWith(`id:${id}`))!;
  expect(conflict).toBeTruthy();
  const merged = reconcileDocuments(base, local, server, { [conflict.path]: "local" });
  expect(merged.document.slides[0]!.elements.some(e => e.id === id)).toBe(false);
  expect(merged.document.metadata.title).toBe("Remote title");
});

it("combines independent inserts and detects competing slide order changes", () => {
  const base = fixture(), local = structuredClone(base), server = structuredClone(base);
  local.slides = [local.slides[1]!, local.slides[0]!, ...local.slides.slice(2)];
  server.slides = [server.slides[2]!, ...server.slides.slice(0, 2), ...server.slides.slice(3)];
  server.slides[0]!.name = "Remote renamed slide";
  const review = reconcileDocuments(base, local, server);
  expect(review.conflicts.map(c => c.path)).toContain("/slides/@order");
  const merged = reconcileDocuments(base, local, server, { "/slides/@order": "local" });
  expect(merged.document.slides.map(s => s.id)).toEqual(local.slides.map(s => s.id));
  expect(merged.document.slides.find(s => s.id === server.slides[0]!.id)!.name).toBe("Remote renamed slide");
});

it("keeps simultaneous additions with distinct identities", () => {
  const base = fixture(), local = structuredClone(base), server = structuredClone(base);
  const a = structuredClone(base.slides[0]!.elements[0]!); a.id = "el_00000000000000000000000001";
  const b = structuredClone(a); b.id = "el_00000000000000000000000002";
  local.slides[0]!.elements.splice(1, 0, a); server.slides[0]!.elements.splice(1, 0, b);
  const result = reconcileDocuments(base, local, server);
  expect(result.conflicts).toEqual([]);
  const ids = result.document.slides[0]!.elements.map(e => e.id);
  expect(ids).toContain(a.id); expect(ids).toContain(b.id);
  expect(new Set(ids).size).toBe(ids.length);
});
