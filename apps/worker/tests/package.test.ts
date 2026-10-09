import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { packageDeck, MYDECK_MIME } from "../src/package";

function entries(bytes: Uint8Array): Record<string, Buffer> {
  const result: Record<string, Buffer> = {}, buffer = Buffer.from(bytes);
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18);
    const length = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + length).toString();
    const raw = buffer.subarray(offset + 30 + length + extra, offset + 30 + length + extra + size);
    result[name] = method === 8 ? inflateRawSync(raw) : raw;
    offset += 30 + length + extra + size;
  }
  return result;
}

describe("exchange packages", () => {
  it("is deterministic, stores its first mimetype and excludes private run history", () => {
    const doc = structuredClone(loadFixture("animation"));
    doc.assets = [];
    doc.provenance = [];
    const first = packageDeck(doc, [], { "extras/future.bin": Buffer.from("opaque").toString("base64") });
    expect(first.bytes).toEqual(packageDeck(doc, [], { "extras/future.bin": Buffer.from("opaque").toString("base64") }).bytes);
    expect(Buffer.from(first.bytes).readUInt16LE(8)).toBe(0);
    const parts = entries(first.bytes);
    expect(Object.keys(parts)[0]).toBe("mimetype");
    expect(parts.mimetype!.toString()).toBe(MYDECK_MIME);
    expect(JSON.parse(parts["document.json"]!.toString())).not.toHaveProperty("provenance");
    expect(parts["extras/future.bin"]!.toString()).toBe("opaque");
  });
  it("refuses a package that would lose a cited asset", () => {
    expect(() => packageDeck(loadFixture("technical"), [])).toThrow("M010");
  });
});
