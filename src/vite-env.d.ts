/// <reference types="vite/client" />

type ProviderSettings =
  | { kind: 'google' }
  | { kind: 'llm'; baseUrl: string; apiKey: string; model: string; temperature: number }

type Status = {
  phase: 'inspect' | 'patch' | 'hook-waiting' | 'hook' | 'ocr-waiting' | 'ocr' | 'done' | 'error' | 'stopped'
  engine?: string
  message?: string
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
  files?: number
}

interface Window {
  translator: {
    chooseTarget(): Promise<string | undefined>
    pathForFile(file: File): string
    start(request: { targetPath: string; provider: ProviderSettings; preferHook?: boolean }): Promise<void>
    stop(): Promise<void>
    restore(target: string): Promise<{ restored: number }>
    switchThread(): Promise<number>
    useOcr(): Promise<void>
    closeOverlay(): Promise<void>
    onStatus(callback: (status: Status) => void): () => void
  }
}
