import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { translateFree } from './free-engines'

export type ProviderSettings =
  | { kind: 'google' }
  | { kind: 'llm'; baseUrl: string; apiKey: string; model: string; temperature: number }

export type TranslateContext = { prompt: string; signal: AbortSignal }

const cache = new Map<string, string>()
let cacheLoaded = false

function cacheFile() {
  return path.join(app.getPath('userData'), 'translation-cache.json')
}

async function loadCache() {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const saved = JSON.parse(await fs.readFile(cacheFile(), 'utf8')) as Record<string, string>
    for (const [key, value] of Object.entries(saved)) cache.set(key, value)
  } catch {
    // 首次运行没有缓存文件
  }
}

let saveTimer: NodeJS.Timeout | undefined
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = undefined
    await flushCache()
  }, 800)
}

/** 立即落盘缓存（退出前调用，防止防抖窗口内丢译文） */
export async function flushCache() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined }
  if (!cacheLoaded) return
  try {
    await fs.mkdir(path.dirname(cacheFile()), { recursive: true })
    await fs.writeFile(cacheFile(), JSON.stringify(Object.fromEntries(cache)), 'utf8')
  } catch {
    // 缓存写失败不影响退出
  }
}

function cacheKey(settings: ProviderSettings, text: string, prompt: string) {
  const id = settings.kind === 'google' ? 'free' : `llm:${settings.baseUrl}:${settings.model}`
  const promptHash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12)
  return crypto.createHash('sha256').update(JSON.stringify([id, promptHash, text])).digest('hex')
}

export function placeholdersOf(text: string): string[] {
  return text.match(/(?:\{[^{}]+\}|%\d*\$?[a-zA-Z]|\\[A-Za-z]+(?:\[[^\]]*])?|\[[A-Za-z][^\]]*]|<\/?[^>]+>|&[A-Za-z_]\w*)/g) || []
}

export function placeholdersPreserved(source: string, translated: string) {
  const actual = placeholdersOf(translated)
  return placeholdersOf(source).every(token => actual.includes(token))
}

async function request<T>(fn: () => Promise<T>, signal: AbortSignal, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) throw new Error('已取消')
    try {
      return await fn()
    } catch (error) {
      if (signal.aborted) throw new Error('已取消')
      lastError = error
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 700 * 2 ** attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function googleBatch(texts: string[], signal: AbortSignal, onItem?: () => void, onTranslated?: (index: number, translated: string) => void): Promise<string[]> {
  const output: string[] = new Array(texts.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(3, texts.length) }, async () => {
    while (cursor < texts.length) {
      if (signal.aborted) throw new Error('已取消')
      const index = cursor++
      // 随机间隔降低限流概率
      await sleep(80 + Math.random() * 170)
      output[index] = await translateFree(texts[index], signal)
      onTranslated?.(index, output[index])
      onItem?.()
    }
  })
  await Promise.all(workers)
  return output
}

async function askLlm(text: string, prompt: string, settings: Extract<ProviderSettings, { kind: 'llm' }>, signal: AbortSignal): Promise<string> {
  const isDeepSeek = /api\.deepseek\.com/i.test(settings.baseUrl)
  const body = JSON.stringify({
    model: settings.model,
    temperature: settings.temperature,
    ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      { role: 'system', content: `${prompt}\n只返回译文，原样保留占位符和转义符。` },
      { role: 'user', content: text },
    ],
  })
  return request(async () => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), 120000)
    try {
      const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body,
      })
      if (!response.ok) throw new Error(`AI 请求失败：${response.status} ${await response.text()}`)
      const data = await response.json() as { choices?: { message?: { content?: string } }[] }
      const result = data.choices?.[0]?.message?.content
      if (!result) throw new Error('AI 未返回译文')
      return result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }, signal)
}

async function llmBatch(texts: string[], ctx: TranslateContext, settings: Extract<ProviderSettings, { kind: 'llm' }>, onItem?: (done: number, total: number) => void, onTranslated?: (index: number, translated: string) => void): Promise<string[]> {
  const batches: { index: number; text: string }[][] = []
  for (const [index, text] of texts.entries()) {
    const last = batches.at(-1)
    if (!last || JSON.stringify(last).length + text.length > 14000) batches.push([{ index, text }])
    else last.push({ index, text })
  }
  const output: string[] = new Array(texts.length)
  let done = 0
  for (let cursor = 0; cursor < batches.length; cursor += 2) {
    await Promise.all(batches.slice(cursor, cursor + 2).map(async batch => {
      if (ctx.signal.aborted) throw new Error('已取消')
      const payload = batch.map((item, id) => ({ id, text: item.text }))
      const instruction = `${ctx.prompt}\n将输入数组中的 text 翻译为简体中文。返回严格 JSON 数组 [{"id":0,"text":"译文"}]，不得改变 id、占位符、转义符、方括号标签和控制代码。`
      const parsed = JSON.parse(await askLlm(JSON.stringify(payload), instruction, settings, ctx.signal)) as { id: number; text: string }[]
      if (!Array.isArray(parsed)) throw new Error('AI 返回格式不是翻译数组')
      for (const item of parsed) {
        const source = batch[item.id]
        if (!source || typeof item.text !== 'string') throw new Error('AI 返回缺少部分译文')
        if (!placeholdersPreserved(source.text, item.text)) throw new Error('译文占位符校验失败')
        output[source.index] = item.text
        onTranslated?.(source.index, item.text)
      }
      done += batch.length
      onItem?.(done, texts.length)
    }))
  }
  return output
}

/** 批量翻译，带持久缓存。返回与输入等长的译文字典（未通过过滤的文本原样返回由调用方控制）。 */
export async function translateBatch(
  texts: string[],
  settings: ProviderSettings,
  ctx: TranslateContext,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  await loadCache()
  const keyOf = (text: string) => cacheKey(settings, text, ctx.prompt)
  const keys = texts.map(keyOf)
  // 空 / 纯空白直接当作自身译文：送进翻译通道只会让整批报「全部通道失败」
  texts.forEach((text, position) => { if (!text.trim()) cache.set(keys[position], text) })
  const missing: { position: number; text: string }[] = []
  const seen = new Map<string, number>()
  texts.forEach((text, position) => {
    if (cache.has(keys[position])) return
    const existing = seen.get(keys[position])
    if (existing === undefined) { seen.set(keys[position], missing.length); missing.push({ position, text }) }
  })
  if (missing.length) {
    let done = 0
    const tick = () => { done++; onProgress?.(done, missing.length) }
    // 逐条/逐批落缓存：中途失败不丢已译结果
    const writeThrough = (index: number, translated: string) => {
      cache.set(keyOf(missing[index].text), translated)
      scheduleSave()
    }
    const translated = settings.kind === 'google'
      ? await googleBatch(missing.map(item => item.text), ctx.signal, tick, writeThrough)
      : await llmBatch(missing.map(item => item.text), ctx, settings, (d, t) => onProgress?.(d, t), writeThrough)
    missing.forEach((item, index) => {
      cache.set(keyOf(item.text), translated[index])
    })
    scheduleSave()
  }
  return keys.map(key => cache.get(key)!)
}

/** 单条实时翻译（OCR 字幕用），先查缓存。 */
export async function translateOne(text: string, settings: ProviderSettings, ctx: TranslateContext): Promise<{ translated: string; cached: boolean }> {
  await loadCache()
  const key = cacheKey(settings, text, ctx.prompt)
  const hit = cache.get(key)
  if (hit) return { translated: hit, cached: true }
  const translated = settings.kind === 'google'
    ? await translateFree(text, ctx.signal)
    : await askLlm(text, ctx.prompt, settings, ctx.signal)
  cache.set(key, translated)
  scheduleSave()
  return { translated, cached: false }
}
