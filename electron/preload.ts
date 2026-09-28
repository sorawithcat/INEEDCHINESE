import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('translator', {
  chooseTarget: () => ipcRenderer.invoke('choose-target'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  start: (request: unknown) => ipcRenderer.invoke('start', request),
  stop: () => ipcRenderer.invoke('stop'),
  restore: (target: string) => ipcRenderer.invoke('restore', target),
  switchThread: () => ipcRenderer.invoke('switch-thread'),
  useOcr: () => ipcRenderer.invoke('use-ocr'),
  closeOverlay: () => ipcRenderer.invoke('close-overlay'),
  onStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('status', listener)
    return () => ipcRenderer.removeListener('status', listener)
  },
})
