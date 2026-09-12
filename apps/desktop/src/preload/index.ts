import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  type CurrentPresentation,
  type DesktopBridge,
  type DesktopInfo,
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

  saveFile: (request: SaveFileRequest) =>
    ipcRenderer.invoke(IPC.saveFile, request) as Promise<SaveFileResult>,

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

  onServiceStatus: (listener: (status: ServiceStatus) => void) => {
    const wrapped = (_event: unknown, status: ServiceStatus): void => listener(status);
    ipcRenderer.on(IPC.serviceStatus, wrapped);
    // Ask for the current state as well as future ones. A window that opened
    // after the service was already up would otherwise sit on "starting" forever.
    ipcRenderer.send(IPC.serviceStatus);
    return () => ipcRenderer.off(IPC.serviceStatus, wrapped);
  },
};

contextBridge.exposeInMainWorld("deckastra", bridge);
