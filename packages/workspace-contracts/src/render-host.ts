/**
 * The exporter's private line to Electron's own Chromium.
 *
 * A packaged desktop app ships a browser — the one it runs in — and the exporter
 * used to need a second one: Playwright's, a ~290MB download the installer never
 * carried, so every packaged export failed with "this build cannot render". The
 * exporter now asks the app's own binary to render instead, over Node's IPC
 * channel.
 *
 * Deliberately **not** over a debugging port. The obvious tool, Playwright's
 * Electron driver, starts Electron with `--inspect=0` and
 * `--remote-debugging-port=0`: an unauthenticated Node inspector on loopback for
 * the length of every export, which is code execution for anything on the
 * machine that finds the port. The desktop's whole D1 posture is that nothing
 * else on the machine can reach the service; a render path that reopened that
 * door would undo it. An IPC channel belongs to the two processes that share it.
 *
 * Types only, like everything in this package: the worker and the desktop shell
 * agree on these shapes at compile time and neither owns the other's runtime.
 * Binary results travel as base64, because the channel is JSON.
 */

export interface RenderHostClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RenderHostRequest =
  | { id: number; method: "newPage"; params: { scale: number } }
  | { id: number; method: "setContent"; params: { pageId: number; html: string } }
  | { id: number; method: "addScriptTag"; params: { pageId: number; content: string } }
  | {
      id: number;
      method: "evaluate";
      /** A function's source and its JSON argument. The page has no other way in. */
      params: { pageId: number; source: string; arg?: unknown };
    }
  | {
      id: number;
      method: "screenshot";
      params: { pageId: number; type: "png" | "jpeg"; clip: RenderHostClip };
    }
  | {
      id: number;
      method: "pdf";
      params: {
        pageId: number;
        widthIn: number;
        heightIn: number;
        printBackground: boolean;
        preferCSSPageSize: boolean;
      };
    }
  | { id: number; method: "closePage"; params: { pageId: number } };

export type RenderHostMethod = RenderHostRequest["method"];

export type RenderHostMessage =
  /**
   * Sent once the host can render. `profile` is the throwaway Chromium profile
   * it made, so the parent can delete it after the host exits — the host cannot
   * delete a directory its own browser still has open.
   */
  | { type: "ready"; profile: string }
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; error: string };
