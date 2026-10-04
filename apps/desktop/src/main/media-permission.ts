/**
 * The one permission this app grants (integration plan 01 §3.5): the
 * microphone, to record narration, in an editor window's main frame.
 *
 * Everything else stays refused, as it always was — camera, geolocation,
 * notifications, and the microphone for anything that is not the person's own
 * editor: a presenter window has no reason to listen, an embedded frame is
 * where somebody else's content would be, and a page on any origin but ours is
 * not this app. A pure decision so it is tested without Electron.
 */

export interface MediaRequest {
  permission: string;
  /** `details.mediaTypes` for a "media" request. */
  mediaTypes?: readonly string[];
  /** `details.requestingUrl`, or the frame's URL for a check. */
  requestingUrl?: string;
  isMainFrame?: boolean;
  /** Whether the asking contents belong to an editor window this app opened. */
  fromEditorWindow: boolean;
}

export function allowsMedia(request: MediaRequest, appOrigin: string): boolean {
  if (request.permission !== "media") return false;
  if (!request.fromEditorWindow) return false;
  if (request.isMainFrame === false) return false;
  const url = request.requestingUrl ?? "";
  if (url !== appOrigin && !url.startsWith(`${appOrigin}/`)) return false;
  // Audio only. A request that also asks for the camera is refused whole.
  const types = request.mediaTypes ?? [];
  return types.length > 0 && types.every((type) => type === "audio");
}
