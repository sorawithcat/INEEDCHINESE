import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('translator', {
  chooseTarget: (mode?: string) => ipcRenderer.invoke('choose-target', mode),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  start: (request: unknown) => ipcRenderer.invoke('start', request),
  stop: () => ipcRenderer.invoke('stop'),
  restore: (target: string) => ipcRenderer.invoke('restore', target),
  switchThread: () => ipcRenderer.invoke('switch-thread'),
  useOcr: () => ipcRenderer.invoke('use-ocr'),
  translateText: (request: unknown) => ipcRenderer.invoke('translate-text', request),
  setOverlayPrefs: (prefs: unknown) => ipcRenderer.invoke('set-overlay-prefs', prefs),
  saveLlmConfig: (config: unknown) => ipcRenderer.invoke('save-llm-config', config),
  getLlmConfig: () => ipcRenderer.invoke('get-llm-config'),
  closeOverlay: () => ipcRenderer.invoke('close-overlay'),
  onStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('status', listener)
    return () => ipcRenderer.removeListener('status', listener)
  },
})
