import { contextBridge, ipcRenderer } from 'electron';

export interface StoredScript {
  id: string;
  name: string;
  code: string;
}

/**
 * The only surface the renderer gets. Everything is a narrow, named channel -
 * no `ipcRenderer` and no Node in the page itself.
 */
const api = {
  platform: 'electron' as const,
  scripts: {
    list: (): Promise<StoredScript[]> => ipcRenderer.invoke('scripts:list'),
    write: (id: string, code: string): Promise<void> => ipcRenderer.invoke('scripts:write', id, code),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('scripts:remove', id),
    directory: (): Promise<string> => ipcRenderer.invoke('scripts:dir'),
  },
};

contextBridge.exposeInMainWorld('dfh', api);

export type DfhHostApi = typeof api;
