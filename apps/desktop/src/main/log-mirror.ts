import type { Writable } from "node:stream";

/** The durable profile log is authoritative. A launcher may close its stderr
 * pipe while the desktop app keeps running; mirroring must not crash the app.
 */
export function logMirror(stream: Writable, onError: (error: Error) => void): (chunk: Uint8Array) => void {
  let available = true;
  stream.on("error", (error: Error) => {
    available = false;
    onError(error);
  });
  return (chunk) => {
    if (!available || stream.destroyed || !stream.writable) return;
    try {
      stream.write(chunk);
    } catch (error) {
      available = false;
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
