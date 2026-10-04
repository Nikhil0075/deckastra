interface DesktopClipboardBridge {
  writeClipboardText?: (text: string) => Promise<void>;
}

/** Use the privileged desktop bridge when present; browsers keep their native API. */
export async function writeTextToClipboard(text: string): Promise<void> {
  const desktop = typeof window === "undefined"
    ? undefined
    : (window as unknown as { deckastra?: DesktopClipboardBridge }).deckastra;
  if (desktop?.writeClipboardText) {
    await desktop.writeClipboardText(text);
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
  await navigator.clipboard.writeText(text);
}
