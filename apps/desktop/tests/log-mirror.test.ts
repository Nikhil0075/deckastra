import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { logMirror } from "../src/main/log-mirror";

describe("service stderr mirror", () => {
  it("survives a launcher closing its pipe and stops mirroring", async () => {
    let writes = 0;
    const errors: Error[] = [];
    const stream = new Writable({ write(_chunk, _encoding, done) {
      writes++;
      done(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    } });
    const mirror = logMirror(stream, (error) => errors.push(error));
    mirror(Buffer.from("migration progress"));
    await new Promise<void>(resolve => setImmediate(resolve));
    mirror(Buffer.from("ready"));
    expect(writes).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("broken pipe");
  });

  it("mirrors normally while the pipe is open", () => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); } });
    logMirror(stream, () => { throw new Error("unexpected error"); })(Buffer.from("ready"));
    expect(chunks).toEqual(["ready"]);
  });
});
