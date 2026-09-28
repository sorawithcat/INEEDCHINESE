// 免费翻译引擎链：Bing → Google clients5 → Google gtx → Lingva
// 每个引擎独立冷却（连续失败/429 → 冷却 5 分钟），优先使用最近成功的引擎。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const COOLDOWN_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000

function timeoutSignal(parent: AbortSignal, ms: number) {
  return AbortSignal.any([parent, AbortSignal.timeout(ms)])
}

// ---------- Bing ----------

type BingSession = { ig: string; iid: string; token: string; key: string; cookies: string; fetchedAt: number }
let bingSession: BingSession | undefined

async function fetchBingSession(signal: AbortSignal): Promise<BingSession> {
  const response = await fetch('https://cn.bing.com/translator', { headers: { 'User-Agent': UA }, signal: timeoutSignal(signal, 15000) })
  if (!response.ok) throw new Error(`Bing 页面获取失败：${response.status}`)
  const html = await response.text()
  const ig = html.match(/IG:"([A-F0-9]+)"/)?.[1]
  const iid = html.match(/data-iid="(translator\.\d+)"/)?.[1]
  const abuse = html.match(/params_AbusePreventionHelper = \[(\d+),"([^"]+)"/)
  if (!ig || !iid || !abuse) throw new Error('Bing 会话参数解析失败')
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
  return { ig, iid, token: abuse[2], key: abuse[1], cookies, fetchedAt: Date.now() }
}

async function bingTranslate(text: string, signal: AbortSignal): Promise<string> {
  for (let refresh = 0; refresh < 2; refresh++) {
    if (!bingSession || Date.now() - bingSession.fetchedAt > SESSION_TTL_MS) bingSession = await fetchBingSession(signal)
    const session = bingSession
    const body = new URLSearchParams({
      fromLang: 'auto-detect',
      to: 'zh-Hans',
      text,
      token: session.token,
      key: session.key,
      tryFetchingGenderDebiasedTranslations: 'true',
    })
    const response = await fetch(`https://cn.bing.com/ttranslatev3?IG=${session.ig}&IID=${session.iid}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: session.cookies, Referer: 'https://cn.bing.com/translator' },
      body,
      signal: timeoutSignal(signal, 15000),
    })
    if (response.status === 429) throw new RateLimitError('Bing 429')
    if (!response.ok) throw new Error(`Bing 请求失败：${response.status}`)
    const data = await response.json() as { ShowCaptcha?: boolean; translations?: { text: string }[] }[] | { ShowCaptcha: boolean }
    if (!Array.isArray(data) || 'ShowCaptcha' in data) {
      // 会话失效，强制刷新后重试一次
      bingSession = undefined
      if (refresh === 0) continue
      throw new Error('Bing 需要人机验证')
    }
    const translated = data[0]?.translations?.[0]?.text
    if (!translated) throw new Error('Bing 未返回译文')
    return translated
  }
  throw new Error('Bing 请求失败')
}

// ---------- Google ----------

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, output))
  return output
}

async function googleClients5(text: string, signal: AbortSignal): Promise<string> {
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=zh-CN&q=${encodeURIComponent(text)}`
  const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeoutSignal(signal, 15000) })
  if (response.status === 429) throw new RateLimitError('clients5 429')
  if (!response.ok) throw new Error(`clients5 请求失败：${response.status}`)
  const translated = collectStrings(await response.json()).join('')
  if (!translated) throw new Error('clients5 未返回译文')
  return translated
}

async function googleGtx(text: string, signal: AbortSignal): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`
  const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeoutSignal(signal, 15000) })
  if (response.status === 429) throw new RateLimitError('gtx 429')
  if (!response.ok) throw new Error(`gtx 请求失败：${response.status}`)
  const data = await response.json() as [[string, string][]?]
  const translated = (data[0] || []).map(segment => segment[0]).join('')
  if (!translated) throw new Error('gtx 未返回译文')
  return translated
}

// ---------- Lingva ----------

const lingvaInstances = ['https://lingva.ml', 'https://lingva.lunar.icu', 'https://translate.plausibility.cloud']

async function lingvaTranslate(text: string, signal: AbortSignal): Promise<string> {
  let lastError: unknown
  for (const instance of lingvaInstances) {
    try {
      const response = await fetch(`${instance}/api/v1/auto/zh/${encodeURIComponent(text)}`, { headers: { 'User-Agent': UA }, signal: timeoutSignal(signal, 12000) })
      if (!response.ok) { lastError = new Error(`Lingva ${response.status}`); continue }
      const data = await response.json() as { translation?: string }
      if (data.translation) return data.translation
      lastError = new Error('Lingva 未返回译文')
    } catch (error) { lastError = error }
  }
  throw lastError instanceof Error ? lastError : new Error('Lingva 全部实例不可用')
}

// ---------- 轮换链 ----------

class RateLimitError extends Error {}

type Engine = { name: string; run: (text: string, signal: AbortSignal) => Promise<string>; failures: number; cooldownUntil: number }
const engines: Engine[] = [
  { name: 'Bing', run: bingTranslate, failures: 0, cooldownUntil: 0 },
  { name: 'Google-clients5', run: googleClients5, failures: 0, cooldownUntil: 0 },
  { name: 'Google-gtx', run: googleGtx, failures: 0, cooldownUntil: 0 },
  { name: 'Lingva', run: lingvaTranslate, failures: 0, cooldownUntil: 0 },
]
let lastGood = 0

/** 免费链单条翻译：从最近成功的引擎开始，失败自动轮换。 */
export async function translateFree(text: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('已取消')
  const now = Date.now()
  const order = engines.map((_, index) => (lastGood + index) % engines.length)
  const errors: string[] = []
  for (const index of order) {
    const engine = engines[index]
    if (engine.cooldownUntil > now) { errors.push(`${engine.name}: 冷却中`); continue }
    try {
      const translated = await engine.run(text, signal)
      engine.failures = 0
      lastGood = index
      return translated
    } catch (error) {
      if (signal.aborted) throw new Error('已取消')
      engine.failures++
      if (error instanceof RateLimitError || engine.failures >= 2) {
        engine.cooldownUntil = Date.now() + COOLDOWN_MS
        engine.failures = 0
      }
      errors.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`免费翻译全部通道失败（${errors.join('；')}）`)
}

/** 当前各通道状态（诊断用） */
export function freeEngineStatus() {
  return engines.map(engine => ({ name: engine.name, cooldownUntil: engine.cooldownUntil }))
}
