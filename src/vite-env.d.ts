/// <reference types="vite/client" />

type Inspection = { target: string; root: string; type: string; route: 'renpy' | 'unity' | 'rpgmaker' | 'tyrano' | 'hook-or-ocr' | 'static'; files: string[]; totalFiles: number }
type TranslationProgress = { current: number; total: number; file: string; chunk: number; chunks: number; failed: string[] }
type RuntimeStatus = { state: 'translated' | 'error' | 'loading' | 'waiting' | 'stopped'; source?: string; translated?: string; cached?: boolean; message?: string }
type CaptureSource = { id: string; name: string; thumbnail: string }
interface Window {
  translator: {
    chooseTarget(): Promise<string | undefined>
    pathForFile(file: File): string
    inspectTarget(path: string): Promise<Inspection>
    onProgress(callback: (progress: TranslationProgress) => void): () => void
    onRuntimeStatus(callback: (status: RuntimeStatus) => void): () => void
    closeOverlay(): Promise<void>
    createPatch(request: unknown): Promise<{ engine: string; files: number; runtime: boolean; message: string }>
    restorePatch(target: string): Promise<{ restored: number }>
    patchStatus(target: string): Promise<{ installed: boolean; engine: string; files: number }>
    startSafeMode(request: unknown): Promise<{ state: string; engine: string }>
    stopAutoMode(): Promise<void>
  }
}
