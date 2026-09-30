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
  showOverlay: () => ipcRenderer.invoke('show-overlay'),
  onStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('status', listener)
    return () => ipcRenderer.removeListener('status', listener)
  },
  // 字幕窗被拖动后把新位置回传，主窗口据此持久化
  onOverlayBounds: (callback: (bounds: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, bounds: unknown) => callback(bounds)
    ipcRenderer.on('overlay-bounds', listener)
    return () => ipcRenderer.removeListener('overlay-bounds', listener)
  },
  // 字幕工具栏改了字号/不透明度后回传，保持主窗口设置同步
  onOverlayPrefs: (callback: (prefs: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, prefs: unknown) => callback(prefs)
    ipcRenderer.on('overlay-prefs', listener)
    return () => ipcRenderer.removeListener('overlay-prefs', listener)
  },
})
