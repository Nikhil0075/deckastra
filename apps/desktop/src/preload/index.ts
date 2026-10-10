import { contextBridge, ipcRenderer } from "electron";
import { ACCOUNT_IPC, type AccountBridge } from "../shared/account";

const accountBridge: AccountBridge = {
  state: () => ipcRenderer.invoke(ACCOUNT_IPC.state),
  signIn: () => ipcRenderer.invoke(ACCOUNT_IPC.signIn),
  signOut: () => ipcRenderer.invoke(ACCOUNT_IPC.signOut),
};
contextBridge.exposeInMainWorld("deckastraAccount", accountBridge);

import {
  IPC,
  isMenuCommand,
  type CloudKeyRequest,
  type CloudKeyState,
  type ClipboardTextRequest,
  type MenuCommand,
  type HostAction,
  type HostActionRequest,
  type AgentAccess,
  type AgentAccessRequest,
  type AgentSetupLauncher,
  type CurrentPresentation,
  type DesktopBridge,
  type DesktopInfo,
  type OpenPresentationRequest,
  type OpenPresenterRequest,
  type SaveFileRequest,
  type SaveFileResult,
  type ServiceStatus,
} from "../shared/ipc";

/**
 * The bridge, and nothing else.
 *
 * Every function here is a one-line forward to a named channel. That is the
 * point: a preload that computes something is a preload with privileges the page
 * can be tricked into using, and the whole reason `contextIsolation` exists is to
 * keep this world separate from the page's. Nothing is exposed that is not in
 * `IPC`, and `ipcRenderer` itself is never handed over — exposing it would let
 * page script call any channel the main process happens to register, now or in a
 * year.
 *
 * `contextBridge` structured-clones across the boundary, so what the page gets
 * are copies. It cannot reach the closure, mutate the exposed object for another
 * script, or pass a function through to main.
 */

const bridge: DesktopBridge = {
  info: () => ipcRenderer.invoke(IPC.info) as Promise<DesktopInfo>,

  currentPresentation: () =>
    ipcRenderer.invoke(IPC.currentPresentation) as Promise<CurrentPresentation>,

  openPresentation: (request: OpenPresentationRequest) =>
    ipcRenderer.invoke(IPC.openPresentation, request) as Promise<CurrentPresentation>,

  openDeckFile: () => ipcRenderer.invoke(IPC.openDeckFile) as Promise<void>,

  hostAction: (action: HostAction) =>
    ipcRenderer.invoke(IPC.hostAction, { action } satisfies HostActionRequest) as Promise<void>,

  saveFile: (request: SaveFileRequest) =>
    ipcRenderer.invoke(IPC.saveFile, request) as Promise<SaveFileResult>,

  writeClipboardText: (text: string) =>
    ipcRenderer.invoke(IPC.clipboardWriteText, { text } satisfies ClipboardTextRequest) as Promise<void>,

  // `send`, not `invoke`: the call has to complete inside the task that handled
  // the click, or the synchronous contract `HostBridge` states is a lie.
  openPresenter: (request: OpenPresenterRequest) => {
    ipcRenderer.send(IPC.openPresenter, request);
  },

  closePresenter: (id: string) => {
    ipcRenderer.send(IPC.closePresenter, id);
  },

  onPresenterClosed: (listener: (id: string) => void) => {
    // The main process's `event` is deliberately dropped rather than forwarded:
    // it carries a `sender` that would hand the page an IPC surface.
    const wrapped = (_event: unknown, id: string): void => listener(id);
    ipcRenderer.on(IPC.presenterClosed, wrapped);
    return () => ipcRenderer.off(IPC.presenterClosed, wrapped);
  },

  agentAccess: () => ipcRenderer.invoke(IPC.agentAccess) as Promise<AgentAccess>,

  agentSetup: () => ipcRenderer.invoke(IPC.agentSetup) as Promise<AgentSetupLauncher>,

  setAgentAccess: (request: AgentAccessRequest) =>
    ipcRenderer.invoke(IPC.agentAccessSet, request) as Promise<AgentAccess>,

  onAgentAccess: (listener: (access: AgentAccess) => void) => {
    const wrapped = (_event: unknown, access: AgentAccess): void => listener(access);
    ipcRenderer.on(IPC.agentAccessChanged, wrapped);
    // Ask for the current decision too, so a window that opened later does not
    // sit on a default that was never true.
    ipcRenderer.send(IPC.agentAccessChanged);
    return () => ipcRenderer.off(IPC.agentAccessChanged, wrapped);
  },

  onServiceStatus: (listener: (status: ServiceStatus) => void) => {
    const wrapped = (_event: unknown, status: ServiceStatus): void => listener(status);
    ipcRenderer.on(IPC.serviceStatus, wrapped);
    // Ask for the current state as well as future ones. A window that opened
    // after the service was already up would otherwise sit on "starting" forever.
    ipcRenderer.send(IPC.serviceStatus);
    return () => ipcRenderer.off(IPC.serviceStatus, wrapped);
  },

  onMenuCommand: (listener: (command: MenuCommand) => void) => {
    // Only the listed names get through: the channel is a menu, not a message bus.
    const wrapped = (_event: unknown, command: unknown): void => {
      if (isMenuCommand(command)) listener(command);
    };
    ipcRenderer.on(IPC.menuCommand, wrapped);
    return () => ipcRenderer.off(IPC.menuCommand, wrapped);
  },

  restartService: () => ipcRenderer.invoke(IPC.restartService) as Promise<ServiceStatus>,

  cloudKey: () => ipcRenderer.invoke(IPC.cloudKey) as Promise<CloudKeyState>,

  setCloudKey: (request: CloudKeyRequest) => ipcRenderer.invoke(IPC.cloudKeySet, request) as Promise<CloudKeyState>,

  onPrepareToClose: (prepare: () => Promise<"clean" | "journalled">) => {
    const wrapped = (_event: unknown, id: unknown): void => {
      if (typeof id !== "string") return;
      // A preparation that throws is still an answer: the page wrote its journal
      // first, so closing is safe, and silence would only make main wait.
      void prepare()
        .catch(() => "journalled" as const)
        .then((readiness) => ipcRenderer.send(IPC.closeReady, { id, readiness }));
    };
    ipcRenderer.on(IPC.prepareToClose, wrapped);
    return () => ipcRenderer.off(IPC.prepareToClose, wrapped);
  },

  onCollectJournals: (collect: () => Promise<{ key: string; value: string }[]>) => {
    const wrapped = (_event: unknown, id: unknown): void => {
      if (typeof id !== "string") return;
      // Storage that refuses to be read, or work that will not settle, costs
      // this window's unsaved edits and not the backup: an empty answer is
      // still an answer, and silence would make main wait out its timeout.
      void collect()
        .catch(() => [])
        .then((entries) => ipcRenderer.send(IPC.journalsCollected, { id, entries }));
    };
    ipcRenderer.on(IPC.journalsCollect, wrapped);
    return () => ipcRenderer.off(IPC.journalsCollect, wrapped);
  },

  onRestoreJournals: (apply: (entries: { key: string; value: string }[]) => void) => {
    const wrapped = (_event: unknown, entries: unknown): void => {
      if (!Array.isArray(entries)) return;
      // Checked here as well as in main, because this is the boundary that
      // decides what reaches the page's own storage.
      apply(
        entries.filter(
          (entry): entry is { key: string; value: string } =>
            !!entry && typeof entry.key === "string" && typeof entry.value === "string",
        ),
      );
    };
    ipcRenderer.on(IPC.journalsRestore, wrapped);
    return () => ipcRenderer.off(IPC.journalsRestore, wrapped);
  },
};

contextBridge.exposeInMainWorld("deckastra", bridge);
