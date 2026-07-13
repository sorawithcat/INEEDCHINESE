import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('translator', {
  chooseTarget: () => ipcRenderer.invoke('choose-target'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  inspectTarget: (path: string) => ipcRenderer.invoke('inspect-target', path),
  createPatch: (request: unknown) => ipcRenderer.invoke('create-patch', request),
  restorePatch: (target: string) => ipcRenderer.invoke('restore-patch', target),
  patchStatus: (target: string) => ipcRenderer.invoke('patch-status', target),
  startSafeMode: (request: unknown) => ipcRenderer.invoke('start-safe-mode', request),
  stopAutoMode: () => ipcRenderer.invoke('stop-auto-mode'),
  closeOverlay: () => ipcRenderer.invoke('close-overlay'),
  onProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('translate-progress', listener)
    return () => ipcRenderer.removeListener('translate-progress', listener)
  },
  onRuntimeStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('runtime-status', listener)
    return () => ipcRenderer.removeListener('runtime-status', listener)
  },
})
