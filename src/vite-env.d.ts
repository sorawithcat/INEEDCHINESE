/// <reference types="vite/client" />

type ProviderSettings =
  | { kind: 'google' }
  | { kind: 'llm'; baseUrl: string; apiKey: string; model: string; temperature: number }

type OverlayBounds = { x: number; y: number; width: number; height: number }

type OverlayPrefs = { fontSize: number; opacity: number; lines: number; idleSeconds: number }

type GlossaryEntry = { from: string; to: string }

type Status = {
  phase: 'inspect' | 'patch' | 'hook-waiting' | 'hook' | 'ocr-waiting' | 'ocr' | 'done' | 'error' | 'stopped'
  engine?: string
  message?: string
  /** 来自 TextractorCLI stderr 的诊断原文 */
  detail?: string
  file?: string
  current?: number
  total?: number
  done?: number
  pending?: number
  source?: string
  translated?: string
  cached?: boolean
  patched?: boolean
  alreadyInstalled?: boolean
  ocrImage?: boolean
  files?: number
}

interface Window {
  translator: {
    chooseTarget(mode?: 'folder'): Promise<string | undefined>
    pathForFile(file: File): string
    start(request: {
      targetPath: string
      provider: ProviderSettings
      preferHook?: boolean
      ocrLangs?: string[]
      ocrRegion?: 'lower' | 'full'
      overlayPrefs?: OverlayPrefs & { bounds?: OverlayBounds }
      hookCode?: string
      glossary?: GlossaryEntry[]
    }): Promise<void>
    stop(): Promise<void>
    restore(target: string): Promise<{ restored: number }>
    switchThread(): Promise<number>
    useOcr(): Promise<void>
    translateText(request: { text: string; provider: ProviderSettings }): Promise<{ translated: string }>
    closeOverlay(): Promise<void>
    showOverlay(): Promise<void>
    setOverlayPinned(pinned: boolean): Promise<void>
    exportCache(): Promise<{ saved: number }>
    importCache(): Promise<{ added: number; total: number }>
    setOverlayPrefs(prefs: OverlayPrefs): Promise<void>
    saveLlmConfig(config: { baseUrl: string; model: string; temperature: number; apiKey: string }): Promise<{ hasKey: boolean }>
    getLlmConfig(): Promise<{ baseUrl: string; model: string; temperature: number; hasKey: boolean } | undefined>
    onStatus(callback: (status: Status) => void): () => void
    onOverlayBounds(callback: (bounds: OverlayBounds) => void): () => void
    onOverlayPrefs(callback: (prefs: OverlayPrefs) => void): () => void
  }
}

declare const __APP_VERSION__: string
