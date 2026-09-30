import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, screen, shell, Tray } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWorker, type Worker } from 'tesseract.js'
import { exportCache, flushCache, importCache, translateBatch, translateOne, type ProviderSettings } from './provider'
import { HookSession, exeArch, hookExitReason, type HookHandlers } from './hook'

type OverlayBounds = { x: number; y: number; width: number; height: number }
type OverlayPrefs = {
  fontSize: number
  opacity: number
  /** 字幕保留几行（1-5） */
  lines?: number
  /** 多少秒没有新译文就把字幕压暗，0 = 不淡出 */
  idleSeconds?: number
  bounds?: OverlayBounds
}

type StartRequest = {
  targetPath: string
  provider: ProviderSettings
  preferHook?: boolean
  ocrLangs?: string[]
  /** OCR 识别区域：默认只认窗口下半屏，避免把桌面和其它 UI 文字也送去识别 */
  ocrRegion?: 'lower' | 'full'
  overlayPrefs?: OverlayPrefs
  /** 可选的 Textractor 特殊码，自动 hook 不上时手动指定 */
  hookCode?: string
  /** 术语表：命中的词按指定译文输出，不再交给翻译通道 */
  glossary?: GlossaryEntry[]
}
type PatchManifest = { version: 1; engine: string; createdAt: string; files: { path: string; created: boolean; originalHash?: string; patchedHash: string }[] }
type GlossaryEntry = { from: string; to: string }

// ---------- 术语表 ----------

/**
 * 术语表用占位符实现：翻前把术语换成 {T0} 这类标记，翻完再还原成指定译文。
 * 直接把译文塞进原文再翻译是行不通的——整句以中文为主时，自动检测语种会把整句判成中文而不翻。
 */
function buildGlossary(entries?: GlossaryEntry[]) {
  const list = (entries || [])
    .map((item, index) => ({ from: (item.from || '').trim(), to: item.to ?? '', token: `{T${index}}` }))
    .filter(item => item.from)
  if (!list.length) return undefined
  // 长词优先替换，避免「阿斯特拉」被「阿斯特」抢先切掉
  const byLength = [...list].sort((a, b) => b.from.length - a.from.length)
  return {
    size: list.length,
    // 术语表变了就得让缓存失效，所以把内容摘要带去缓存键
    id: crypto.createHash('sha256').update(JSON.stringify(list.map(item => [item.from, item.to]))).digest('hex').slice(0, 8),
    mask: (text: string) => {
      let output = text
      for (const item of byLength) if (output.includes(item.from)) output = output.split(item.from).join(item.token)
      return output
    },
    restore: (text: string) => {
      let output = text
      for (const item of list) if (output.includes(item.token)) output = output.split(item.token).join(item.to)
      return output
    },
  }
}

const storyPrompt = '将游戏文本翻译为自然的简体中文。保留人物语气、世界观术语和情绪，不擅自增删内容。'
const uiPrompt = '将界面文本翻译为简洁准确的简体中文，按钮文字简短，术语前后一致。'

const supported = new Set(['.txt', '.json'])
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const execFileAsync = promisify(execFile)

let overlay: BrowserWindow | undefined
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
/** 从托盘退出时不要再被「有会话就隐藏窗口」拦下来 */
let forceClose = false
let overlayDismissed = false
let session: AbortController | undefined
let ocrTimer: NodeJS.Timeout | undefined
let ocrWorker: Worker | undefined
let safeWaitTimer: NodeJS.Timeout | undefined
let hook: HookSession | undefined
let hookFallbackTimer: NodeJS.Timeout | undefined
let hookCountdownTimer: NodeJS.Timeout | undefined
let hookThreads = new Map<string, { lastText: string; score: number }>()
let hookActiveHandle: string | undefined
let hookLastForwarded = ''
let hookContext: { event: Electron.IpcMainInvokeEvent; request: StartRequest; signal: AbortSignal } | undefined
let hookTriedLaunch = false
let hookGotText = false
/** Hook 无文本自动回退 OCR 的等待秒数 */
const HOOK_FALLBACK_SECONDS = 20

function sha256(data: Buffer | string) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** 值得翻译的字符：拉丁、日文假名、CJK（含扩展 B）、谚文、全角符号 */
const readable = /[A-Za-z\u00C0-\u024F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uFF01-\uFF60\u{20000}-\u{2FA1F}]/u

function shouldTranslate(text: string) {
  const value = text.trim()
  if (value.length < 2 || /^[-+]?\d+(?:\.\d+)?$/.test(value)) return false
  if (/^[\w./\\:-]+\.(?:png|jpe?g|webp|ogg|mp3|wav|json|js|dll|exe)$/i.test(value)) return false
  return readable.test(value)
}

// ---------- 引擎识别 ----------

function detect(files: string[], target: string) {
  const names = files.map(file => file.toLowerCase())
  if (names.some(file => file.endsWith('.rpy') || file.endsWith('.rpyc')) || names.some(file => /[\\/]renpy[\\/]/.test(file))) return 'Ren\'Py'
  if (names.some(file => file.endsWith('gameassembly.dll')) && names.some(file => file.endsWith('global-metadata.dat'))) return 'Unity IL2CPP'
  // 只认 Unity 自己的标志物：早先用 `includes('_data')` 会把 save_data/ 这类普通目录误判成 Unity 游戏，
  // 结果纯文本项目被当成游戏拖进 Hook / OCR 流程。
  if (names.some(file => file.endsWith('unityplayer.dll')) || names.some(file => /[\\/][^\\/]+_data[\\/]globalgamemanagers/.test(file))) return 'Unity Mono'
  if (names.some(file => file.endsWith('.xp3')) || names.some(file => file.endsWith('krkrsteam.dll'))) return 'Kirikiri/KAG'
  if (names.some(file => file.endsWith('tyrano.js')) || names.some(file => /[\\/]tyrano[\\/]/.test(file))) return 'TyranoBuilder'
  // 散装的 .tjs / .ks 说明脚本没封进 xp3，这时可以像普通文本项目一样直接打补丁
  if (names.some(file => file.endsWith('.tjs')) || names.some(file => file.endsWith('.ks'))) return 'Kirikiri/KAG'
  if (names.some(file => /(?:rpg_|rmmz_)(?:core|managers)/.test(file))) return 'RPG Maker MV/MZ'
  if (names.some(file => file.endsWith('.pck')) || names.some(file => file.endsWith('godot.dll'))) return 'Godot'
  if (names.some(file => file.endsWith('game.rgss3a')) || names.some(file => file.endsWith('rgss301.dll'))) return 'RPG Maker VX Ace'
  if (names.some(file => file.endsWith('data.wolf')) || names.some(file => /[\\/]data[\\/].*\.wolf$/.test(file))) return 'Wolf RPG'
  if (names.some(file => file.endsWith('.bakin'))) return 'RPG Developer Bakin'
  return path.extname(target).toLowerCase() === '.exe' ? 'Windows 应用' : '通用文本项目'
}

async function inspectTarget(target: string) {
  const root = (await fs.stat(target)).isFile() ? path.dirname(target) : target
  const all: string[] = []
  // 全局截断标记：原来只 return 当前目录，递归会继续，上限形同虚设导致大目录扫描很久
  let capped = false
  async function scan(dir: string) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (capped) return
      if (all.length >= 5000) { capped = true; return }
      if (['node_modules', '.git', '.ineedchinese', 'INEEDCHINESE_zh-CN'].includes(item.name)) continue
      const full = path.join(dir, item.name)
      if (item.isDirectory()) await scan(full)
      else all.push(full)
    }
  }
  await scan(root)
  const type = detect(all, target)
  return { target, root, type, files: all, totalFiles: all.length }
}

// ---------- 文本工具 ----------

function textChunks(source: string, limit = 14000) {
  const paragraphs = source.split(/(\r?\n\s*\r?\n)/)
  const chunks: string[] = []
  let current = ''
  for (const part of paragraphs) {
    if (current && current.length + part.length > limit) { chunks.push(current); current = '' }
    if (part.length <= limit) current += part
    else for (let i = 0; i < part.length; i += limit) chunks.push(part.slice(i, i + limit))
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : ['']
}

type JsonEntry = { path: (string | number)[]; value: string }
function jsonStrings(value: unknown, current: (string | number)[] = [], output: JsonEntry[] = []): JsonEntry[] {
  if (typeof value === 'string' && value.trim()) output.push({ path: current, value })
  else if (Array.isArray(value)) value.forEach((item, index) => jsonStrings(item, [...current, index], output))
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => jsonStrings(item, [...current, key], output))
  return output
}
function setJson(root: unknown, keys: (string | number)[], value: string) {
  let node = root as Record<string | number, unknown>
  for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]] as Record<string | number, unknown>
  node[keys.at(-1)!] = value
}

function collectRpgStrings(root: unknown) {
  const output: JsonEntry[] = []
  const visibleKeys = new Set(['name', 'nickname', 'profile', 'description', 'message1', 'message2', 'message3', 'message4', 'gametitle', 'currencyunit', 'displayname'])
  function visit(value: unknown, current: (string | number)[], inTerms = false) {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, [...current, index], inTerms)); return }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (typeof object.code === 'number' && Array.isArray(object.parameters)) {
      const code = object.code
      object.parameters.forEach((item, index) => {
        if ((code === 401 || code === 405 || (code === 101 && index === 4)) && typeof item === 'string' && shouldTranslate(item)) output.push({ path: [...current, 'parameters', index], value: item })
        if (code === 102 && index === 0 && Array.isArray(item)) item.forEach((choice, choiceIndex) => { if (typeof choice === 'string' && shouldTranslate(choice)) output.push({ path: [...current, 'parameters', index, choiceIndex], value: choice }) })
      })
    }
    for (const [key, item] of Object.entries(object)) {
      const nextTerms = inTerms || key.toLowerCase() === 'terms'
      if (typeof item === 'string' && shouldTranslate(item) && (nextTerms || visibleKeys.has(key.toLowerCase()))) output.push({ path: [...current, key], value: item })
      else if (typeof item === 'object') visit(item, [...current, key], nextTerms)
    }
  }
  visit(root, [])
  const seen = new Set<string>()
  return output.filter(entry => { const key = JSON.stringify(entry.path); if (seen.has(key)) return false; seen.add(key); return true })
}

type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be'

/**
 * 猜一下非 Unicode 文本到底是什么编码，只用来把报错写具体。
 * 绝不能用它做自动转换：同一段字节在 GBK / Big5 / EUC-KR 下往往都能"合法"解码，
 * 猜错就会把整份原文按错编码写回，直接毁掉游戏文本。
 */
function sniffLegacyEncoding(data: Buffer) {
  const sample = data.subarray(0, 65536)
  const decode = (label: string) => {
    try {
      const text = new TextDecoder(label).decode(sample)
      if (!text || text.includes('\uFFFD')) return undefined
      const ratio = (text.match(/[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/gu) || []).length / text.length
      return ratio >= 0.2 ? text : undefined
    } catch { return undefined }
  }
  const sjis = decode('shift_jis')
  const gbk = decode('gb18030')
  const big5 = decode('big5')
  // 能解出全角假名基本可以断定是日文旧编码（GBK/Big5 的字节不会解出假名）
  if (sjis && /[\u3040-\u30FF]/.test(sjis)) return 'Shift-JIS（日文）'
  // Big5 能解、GBK 解不出，是繁体文本的典型特征
  if (big5 && !gbk) return 'Big5（繁体）'
  if (gbk) return 'GBK / GB18030'
  if (sjis) return 'Shift-JIS'
  return undefined
}

async function readTextStrict(file: string): Promise<{ text: string; encoding: TextEncoding }> {
  const data = await fs.readFile(file)
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return { text: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(3)), encoding: 'utf8bom' }
  if (data[0] === 0xff && data[1] === 0xfe) return { text: new TextDecoder('utf-16le', { fatal: true }).decode(data.subarray(2)), encoding: 'utf16le' }
  if (data[0] === 0xfe && data[1] === 0xff) return { text: new TextDecoder('utf-16be', { fatal: true }).decode(data.subarray(2)), encoding: 'utf16be' }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'utf8' } }
  catch {
    const guess = sniffLegacyEncoding(data)
    throw new Error(guess
      ? `该文件不是 UTF-8/UTF-16 文本，看起来是 ${guess} 编码。译文是简体中文，写回旧编码会破坏原文，已跳过：${file}`
      : `不支持的文本编码，已拒绝修改：${file}`)
  }
}

function encodeText(text: string, encoding: TextEncoding) {
  if (encoding === 'utf8') return Buffer.from(text, 'utf8')
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
  const little = Buffer.from(text, 'utf16le')
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), little])
  const big = Buffer.from(little)
  for (let index = 0; index < big.length; index += 2) { const byte = big[index]; big[index] = big[index + 1]; big[index + 1] = byte }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), big])
}

function safeRelativePath(root: string, relative: string) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`补丁路径越界：${relative}`)
  return resolved
}

async function collectFiles(root: string, extension: string, output: string[] = []) {
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    if (['.git', '.ineedchinese', 'INEEDCHINESE_zh-CN', 'node_modules'].includes(item.name)) continue
    const full = path.join(root, item.name)
    if (item.isDirectory()) await collectFiles(full, extension, output)
    else if (path.extname(item.name).toLowerCase() === extension) output.push(full)
  }
  return output
}

async function stagePatchFile(root: string, file: string, content: string | Buffer, manifest: PatchManifest, internal: string) {
  const relative = path.relative(root, file)
  const staged = path.join(internal, 'staging', relative)
  await fs.mkdir(path.dirname(staged), { recursive: true })
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  await fs.writeFile(staged, data)
  const exists = await fs.stat(file).then(() => true).catch(() => false)
  manifest.files.push({ path: relative, created: !exists, originalHash: exists ? sha256(await fs.readFile(file)) : undefined, patchedHash: sha256(data) })
}

// ---------- 补丁模式 ----------

async function createPatch(event: Electron.IpcMainInvokeEvent, info: Awaited<ReturnType<typeof inspectTarget>>, provider: ProviderSettings, signal: AbortSignal, glossary?: ReturnType<typeof buildGlossary>) {
  const prompt = ["Ren'Py", 'TyranoBuilder', 'RPG Maker MV/MZ'].includes(info.type) ? storyPrompt : uiPrompt
  const internal = path.join(info.root, '.ineedchinese')
  const backup = path.join(internal, 'backup')
  const manifestPath = path.join(internal, 'patch-manifest.json')
  await fs.rm(path.join(internal, 'staging'), { recursive: true, force: true })
  const manifest: PatchManifest = { version: 1, engine: info.type, createdAt: new Date().toISOString(), files: [] }
  // 增量：已补丁且未被改动的文件直接沿用旧译文，不重复翻译（生成的文件如 .rpy 补丁除外，始终重建）
  const carried: PatchManifest['files'] = []
  const previous = await readManifest(info.root)
  if (previous) {
    for (const entry of previous.files) {
      if (entry.created) continue
      const abs = safeRelativePath(info.root, entry.path)
      if (await fs.stat(abs).then(() => true).catch(() => false) && sha256(await fs.readFile(abs)) === entry.patchedHash) carried.push(entry)
    }
  }
  const carriedPaths = new Set(carried.map(entry => entry.path))
  const report = (file: string, current: number, total: number, done = 0, pending = 0) =>
    event.sender.send('status', { phase: 'patch', engine: info.type, file, current, total, done, pending })
  const run = (texts: string[], onProgress?: (done: number, total: number) => void) => {
    if (!glossary) return translateBatch(texts, provider, { prompt, signal }, onProgress)
    // 术语先换成占位符，翻完再还原；占位符也进缓存键，术语表变了缓存自然失效
    return translateBatch(texts.map(glossary.mask), provider, { prompt, signal, cachePrompt: `${prompt}\n#glossary:${glossary.id}` }, onProgress)
      .then(result => result.map(glossary.restore))
  }

  if (info.type === 'Ren\'Py') {
    const game = path.join(info.root, 'game')
    const scripts = (await collectFiles(game, '.rpy')).filter(file => !/ineedchinese_|[\\/]tl[\\/]/i.test(file))
    if (!scripts.length) throw new Error('NO_PATCHABLE_TEXT')
    const originals: string[] = []
    for (const file of scripts) {
      for (const line of (await readTextStrict(file)).text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:[A-Za-z_]\w*\s+)?("(?:\\.|[^"\\])*")\s*(?:if\s+.+?)?\s*(?:#.*)?$/)
        if (match) { try { const text = JSON.parse(match[1]) as string; if (shouldTranslate(text)) originals.push(text) } catch { /* 非法字符串字面量 */ } }
      }
    }
    if (!originals.length) throw new Error('NO_PATCHABLE_TEXT')
    const unique = [...new Set(originals)]
    const translated = await run(unique, (done, total) => report('Ren’Py 对话', 1, 1, done, total))
    const mapping = Object.fromEntries(unique.map((text, index) => [text, translated[index]]))
    const pythonMap = JSON.stringify(mapping, null, 4).replace(/\n/g, '\n    ')
    const content = `# Generated by INEEDCHINESE. Remove this file to uninstall.\ninit -1000 python:\n    _inc_patch_map = ${pythonMap}\n    _inc_patch_previous = getattr(config, "say_menu_text_filter", None)\n    def _inc_patch_filter(text):\n        shown = _inc_patch_previous(text) if _inc_patch_previous else text\n        return _inc_patch_map.get(shown, shown)\n    config.say_menu_text_filter = _inc_patch_filter\n`
    await stagePatchFile(info.root, path.join(game, 'ineedchinese_patch.rpy'), content, manifest, internal)
  } else if (info.type === 'RPG Maker MV/MZ') {
    const data = await fs.stat(path.join(info.root, 'www', 'data')).then(() => path.join(info.root, 'www', 'data')).catch(() => path.join(info.root, 'data'))
    const files = await collectFiles(data, '.json')
    for (let index = 0; index < files.length; index++) {
      if (signal.aborted) throw new Error('已取消')
      const file = files[index]
      if (carriedPaths.has(path.relative(info.root, file))) continue
      const decoded = await readTextStrict(file)
      const json = JSON.parse(decoded.text) as unknown
      const entries = collectRpgStrings(json)
      if (!entries.length) continue
      const translated = await run(entries.map(entry => entry.value), (done, total) => report(path.relative(info.root, file), index + 1, files.length, done, total))
      entries.forEach((entry, entryIndex) => setJson(json, entry.path, translated[entryIndex]))
      await stagePatchFile(info.root, file, encodeText(JSON.stringify(json, null, 2), decoded.encoding), manifest, internal)
    }
  } else if (info.type === 'TyranoBuilder') {
    const scenarioRoot = await fs.stat(path.join(info.root, 'data', 'scenario')).then(() => path.join(info.root, 'data', 'scenario')).catch(() => info.root)
    const files = await collectFiles(scenarioRoot, '.ks')
    for (let index = 0; index < files.length; index++) {
      if (signal.aborted) throw new Error('已取消')
      const file = files[index]
      if (carriedPaths.has(path.relative(info.root, file))) continue
      const decoded = await readTextStrict(file)
      const newline = decoded.text.includes('\r\n') ? '\r\n' : '\n'
      const lines = decoded.text.split(/\r?\n/)
      const indexes = lines.map((line, lineIndex) => ({ line, lineIndex })).filter(({ line }) => { const value = line.trim(); return value && !/^[;*@#\[]/.test(value) && shouldTranslate(value) })
      if (!indexes.length) continue
      const translated = await run(indexes.map(item => item.line.trim()), (done, total) => report(path.relative(info.root, file), index + 1, files.length, done, total))
      indexes.forEach((item, itemIndex) => { const indent = item.line.match(/^\s*/)?.[0] || ''; lines[item.lineIndex] = indent + translated[itemIndex] })
      await stagePatchFile(info.root, file, encodeText(lines.join(newline), decoded.encoding), manifest, internal)
    }
  } else if (info.type === 'Kirikiri/KAG') {
    // 只支持散装 .ks；脚本封在 .xp3 里时这里找不到文件，会自动退回 Hook 字幕
    const files = await collectFiles(info.root, '.ks')
    if (!files.length) throw new Error('NO_PATCHABLE_TEXT')
    // KiriKiri 的 .ks 常是 Shift-JIS，而译文是简体中文根本写不回去。
    // 只要有一个脚本不是 Unicode 就整体放弃，免得打出半中半日的补丁。
    const decodedAll: { file: string; text: string; encoding: TextEncoding }[] = []
    for (const file of files) {
      try {
        const decoded = await readTextStrict(file)
        decodedAll.push({ file, text: decoded.text, encoding: decoded.encoding })
      } catch { throw new Error('NO_PATCHABLE_TEXT') }
    }
    for (let index = 0; index < decodedAll.length; index++) {
      if (signal.aborted) throw new Error('已取消')
      const { file, text, encoding } = decodedAll[index]
      if (carriedPaths.has(path.relative(info.root, file))) continue
      const newline = text.includes('\r\n') ? '\r\n' : '\n'
      const lines = text.split(/\r?\n/)
      const targets = lines.map((line, lineIndex) => ({ line, lineIndex })).filter(({ line }) => { const value = line.trim(); return Boolean(value) && !/^[;*@#\[]/.test(value) && shouldTranslate(value) })
      if (!targets.length) continue
      const translated = await run(targets.map(item => item.line.trim()), (done, total) => report(path.relative(info.root, file), index + 1, decodedAll.length, done, total))
      targets.forEach((item, itemIndex) => { const indent = item.line.match(/^\s*/)?.[0] || ''; lines[item.lineIndex] = indent + translated[itemIndex] })
      await stagePatchFile(info.root, file, encodeText(lines.join(newline), encoding), manifest, internal)
    }
  } else {
    const files = (await fs.stat(info.target)).isFile() && supported.has(path.extname(info.target).toLowerCase())
      ? [info.target]
      : info.files.filter(file => supported.has(path.extname(file).toLowerCase()))
    for (let index = 0; index < files.length; index++) {
      if (signal.aborted) throw new Error('已取消')
      const file = files[index]
      if (carriedPaths.has(path.relative(info.root, file))) continue
      const decoded = await readTextStrict(file)
      const relative = path.relative(info.root, file)
      if (!decoded.text.trim()) continue
      if (path.extname(file).toLowerCase() === '.json') {
        const json = JSON.parse(decoded.text) as unknown
        const entries = jsonStrings(json).filter(entry => shouldTranslate(entry.value))
        if (!entries.length) continue
        const translated = await run(entries.map(entry => entry.value), (done, total) => report(relative, index + 1, files.length, done, total))
        entries.forEach((entry, i) => setJson(json, entry.path, translated[i]))
        await stagePatchFile(info.root, file, encodeText(JSON.stringify(json, null, 2), decoded.encoding), manifest, internal)
      } else {
        const chunks = textChunks(decoded.text)
        const translated = await run(chunks, (done, total) => report(relative, index + 1, files.length, done, total))
        await stagePatchFile(info.root, file, encodeText(translated.join(''), decoded.encoding), manifest, internal)
      }
    }
  }

  manifest.files.push(...carried)
  if (!manifest.files.length) throw new Error('NO_PATCHABLE_TEXT')
  if (signal.aborted) throw new Error('已取消')
  for (const entry of manifest.files) {
    if (carriedPaths.has(entry.path)) continue
    const original = safeRelativePath(info.root, entry.path)
    if (!entry.created && sha256(await fs.readFile(original)) !== entry.originalHash) throw new Error(`安装前文件发生变化，已停止：${entry.path}`)
  }
  const applied: typeof manifest.files = []
  try {
    for (const entry of manifest.files) {
      if (carriedPaths.has(entry.path)) continue
      const original = safeRelativePath(info.root, entry.path)
      const staged = safeRelativePath(path.join(internal, 'staging'), entry.path)
      if (!entry.created) {
        const saved = path.join(backup, entry.path)
        if (!await fs.stat(saved).then(() => true).catch(() => false)) { await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.copyFile(original, saved) }
      }
      await fs.mkdir(path.dirname(original), { recursive: true })
      // staging 与目标同盘，rename 是原子替换，省掉整份再拷一遍
      await fs.rename(staged, original)
      if (sha256(await fs.readFile(original)) !== entry.patchedHash) throw new Error(`补丁写入校验失败：${entry.path}`)
      applied.push(entry)
    }
  } catch (error) {
    for (const entry of applied.reverse()) {
      const original = safeRelativePath(info.root, entry.path)
      if (entry.created) await fs.unlink(original).catch(() => undefined)
      else await fs.copyFile(safeRelativePath(backup, entry.path), original).catch(() => undefined)
    }
    throw error
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  return { files: manifest.files.length }
}

async function restorePatch(target: string) {
  const info = await inspectTarget(target)
  const internal = path.join(info.root, '.ineedchinese')
  const manifestPath = path.join(internal, 'patch-manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PatchManifest
  // 先全量校验，全部通过才动手，杜绝半恢复
  for (const entry of manifest.files) {
    const destination = safeRelativePath(info.root, entry.path)
    const exists = await fs.stat(destination).then(() => true).catch(() => false)
    if (exists && sha256(await fs.readFile(destination)) !== entry.patchedHash) throw new Error(`文件在安装补丁后被修改，拒绝覆盖：${entry.path}`)
    if (!exists && !entry.created) throw new Error(`文件缺失，无法恢复：${entry.path}`)
  }
  for (const entry of manifest.files) {
    const destination = safeRelativePath(info.root, entry.path)
    if (entry.created) await fs.unlink(destination).catch(() => undefined)
    else await fs.copyFile(safeRelativePath(path.join(internal, 'backup'), entry.path), destination)
  }
  await fs.unlink(manifestPath)
  // staging 与 backup 都归 .ineedchinese 所有，清干净，不留残骸
  await fs.rm(internal, { recursive: true, force: true }).catch(() => undefined)
  return { restored: manifest.files.length }
}

async function readManifest(root: string): Promise<PatchManifest | undefined> {
  try { return JSON.parse(await fs.readFile(path.join(root, '.ineedchinese', 'patch-manifest.json'), 'utf8')) as PatchManifest }
  catch { return undefined }
}

/**
 * 逐个校验清单里的文件是否还是补丁版（绝对路径 → 是否完好）。
 * 有清单不等于补丁还在：文件被删、被改、或游戏更新覆盖过，都必须重新处理。
 */
async function verifyManifest(root: string, manifest: PatchManifest) {
  const intact = new Map<string, boolean>()
  for (const entry of manifest.files) {
    let ok = false
    try {
      const abs = safeRelativePath(root, entry.path)
      if (await fs.stat(abs).then(() => true).catch(() => false)) ok = sha256(await fs.readFile(abs)) === entry.patchedHash
    } catch { ok = false }
    intact.set(path.resolve(root, entry.path), ok)
  }
  return intact
}

// ---------- 字幕窗 ----------

const OVERLAY_WIDTH = 1000
const OVERLAY_HEIGHT = 200
/** 顶部工具栏高度，也是「鼠标移进来就临时解除穿透」的判定区 */
const OVERLAY_BAR_HEIGHT = 32

let overlayPrefs: OverlayPrefs = { fontSize: 24, opacity: 0.9 }
let overlayWatchTimer: NodeJS.Timeout | undefined
let overlayLockTimer: NodeJS.Timeout | undefined
let overlayIdleTimer: NodeJS.Timeout | undefined
let overlayUnlocked = false
/** 手动锁定（想框选复制时）就不再因鼠标移开而恢复穿透 */
let overlayPinned = false
/** 最近几条字幕，关闭字幕窗后重新显示也用它 */
let overlayLines: { source: string; translated: string; error?: boolean }[] = []
/** 还没有任何译文时显示的占位文案 */
let overlayStatus = ''
const OVERLAY_MAX_LINES = 5
/** 游戏窗口所在的显示器矩形，字幕默认落在这块屏上 */
let lastGameRect: Electron.Rectangle | undefined

/** 字幕窗页面（data URL）：顶部工具栏 + 多行字幕。译文用 textContent 写入，不拼 HTML。 */
const overlayHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Microsoft YaHei",sans-serif;color:#fff;font-size:24px;border-radius:14px;overflow:hidden;background:rgba(8,12,18,.9);-webkit-user-select:none}
.bar{height:${OVERLAY_BAR_HEIGHT}px;display:flex;align-items:center;gap:6px;padding:0 10px;opacity:.2;transition:opacity .15s}
body.hot .bar,body.pinned .bar{opacity:1}
.grip{flex:1;height:100%;display:flex;align-items:center;gap:8px;font-size:11px;color:#8b95a3;cursor:move;-webkit-app-region:drag}
.grip::before{content:"";width:46px;height:4px;border-radius:2px;background:#5a6675}
.bar button{-webkit-app-region:no-drag;width:26px;height:20px;border:0;border-radius:5px;background:#233043;color:#c9d3e0;font-size:12px;line-height:1;cursor:pointer}
.bar button:hover{background:#31435c}
.bar button.on{background:#3b6ea5;color:#fff}
.lines{padding:0 18px 14px;max-height:${OVERLAY_HEIGHT - OVERLAY_BAR_HEIGHT}px;overflow:hidden;display:flex;flex-direction:column;gap:6px}
.line:not(:last-child){opacity:.45}
.zh{line-height:1.45;word-break:break-word}
.src{font-size:12px;color:#9ca3af;margin-top:2px;word-break:break-word}
.line.err .zh{color:#fca5a5}
body.pinned .lines{-webkit-user-select:text;cursor:text}
</style></head><body>
<div class="bar">
<div class="grip">字幕</div>
<button id="pin" title="锁定后可框选复制">⧉</button>
<button id="fontDown" title="减小字号">A-</button>
<button id="fontUp" title="放大字号">A+</button>
<button id="opacity" title="切换背景不透明度">◐</button>
<button id="thread" title="切换文本源">⇄</button>
<button id="close" title="关闭字幕">✕</button>
</div>
<div class="lines" id="lines"></div>
<script>
var prefs={fontSize:24,opacity:0.9,lines:3};
var pinned=false;
function paint(){
  document.body.style.fontSize=prefs.fontSize+'px';
  document.body.style.background='rgba(8,12,18,'+prefs.opacity+')';
  document.body.classList.toggle('pinned',pinned);
  document.getElementById('pin').classList.toggle('on',pinned);
}
window.__incSetPrefs=function(p){if(p)prefs=p;paint()};
window.__incSetPinned=function(v){pinned=!!v;paint()};
window.__incRender=function(list){
  var box=document.getElementById('lines');
  box.innerHTML='';
  (list||[]).slice(-prefs.lines).forEach(function(item){
    var wrap=document.createElement('div');
    wrap.className='line'+(item.error?' err':'');
    var zh=document.createElement('div');zh.className='zh';zh.textContent=item.translated||'';
    wrap.appendChild(zh);
    if(item.source){var src=document.createElement('div');src.className='src';src.textContent=item.source;wrap.appendChild(src)}
    box.appendChild(wrap);
  });
};
document.getElementById('pin').onclick=function(){window.translator.setOverlayPinned(!pinned)};
document.getElementById('fontUp').onclick=function(){window.translator.setOverlayPrefs({fontSize:prefs.fontSize+2,opacity:prefs.opacity,lines:prefs.lines})};
document.getElementById('fontDown').onclick=function(){window.translator.setOverlayPrefs({fontSize:prefs.fontSize-2,opacity:prefs.opacity,lines:prefs.lines})};
document.getElementById('opacity').onclick=function(){window.translator.setOverlayPrefs({fontSize:prefs.fontSize,opacity:prefs.opacity>=1?0.5:Math.round((prefs.opacity+0.15)*20)/20,lines:prefs.lines})};
document.getElementById('thread').onclick=function(){window.translator.switchThread()};
document.getElementById('close').onclick=function(){window.translator.closeOverlay()};
paint();
</script></body></html>`

/** anchor 是游戏窗口矩形：字幕默认落到游戏所在那块屏，避免多显示器时跑错屏 */
function defaultOverlayBounds(anchor?: Electron.Rectangle): OverlayBounds {
  const area = (anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()).workArea
  return { x: area.x + Math.round((area.width - OVERLAY_WIDTH) / 2), y: area.y + area.height - 260, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }
}

/** 存下来的位置可能来自另一套显示器布局；完全落在屏幕外就退回默认位置，否则用户再也拖不回来 */
function sanitizeOverlayBounds(bounds?: OverlayBounds): OverlayBounds {
  if (!bounds) return defaultOverlayBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const visibleWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const visibleHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  return visibleWidth > 240 && visibleHeight >= OVERLAY_BAR_HEIGHT ? bounds : defaultOverlayBounds()
}

/** 光标是否落在字幕窗顶部工具栏判定区 */
function cursorOnOverlayBar() {
  if (!overlay || overlay.isDestroyed()) return false
  const point = screen.getCursorScreenPoint()
  const bounds = overlay.getBounds()
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + OVERLAY_BAR_HEIGHT
}

function pushOverlayPrefs() {
  if (!overlay || overlay.isDestroyed()) return
  const payload = { fontSize: overlayPrefs.fontSize, opacity: overlayPrefs.opacity, lines: overlayPrefs.lines ?? 3 }
  overlay.webContents.executeJavaScript(`window.__incSetPrefs && window.__incSetPrefs(${JSON.stringify(payload)})`).catch(() => undefined)
}

function renderOverlay() {
  if (!overlay || overlay.isDestroyed()) return
  const kept = overlayLines.slice(-(overlayPrefs.lines ?? 3))
  const payload = kept.length ? kept : (overlayStatus ? [{ source: '', translated: overlayStatus }] : [])
  overlay.webContents.executeJavaScript(`window.__incRender && window.__incRender(${JSON.stringify(payload)})`).catch(() => undefined)
}

/** 穿透 / 可交互 切换：解锁后工具栏可拖可点，锁定后点击重新穿透到游戏 */
function setOverlayUnlocked(unlocked: boolean) {
  if (!overlay || overlay.isDestroyed()) return
  overlayUnlocked = unlocked
  overlay.setIgnoreMouseEvents(!unlocked, { forward: true })
  // 无边框窗口拖动依赖窗口能收鼠标事件与获得焦点；showInactive 保证不夺走游戏键盘焦点
  overlay.setFocusable(unlocked)
  overlay.webContents.executeJavaScript(`document.body.classList.toggle('hot', ${unlocked})`).catch(() => undefined)
  if (unlocked) {
    // 用户正在看/操作，结束淡出
    if (overlayIdleTimer) { clearTimeout(overlayIdleTimer); overlayIdleTimer = undefined }
    overlay.setOpacity(1)
  }
}

/** 手动锁定：不因鼠标移开而恢复穿透，此时可以框选复制译文 */
function setOverlayPinned(pinned: boolean) {
  overlayPinned = pinned
  if (!overlay || overlay.isDestroyed()) return
  overlay.webContents.executeJavaScript(`window.__incSetPinned && window.__incSetPinned(${pinned})`).catch(() => undefined)
  if (pinned && overlayLockTimer) { clearTimeout(overlayLockTimer); overlayLockTimer = undefined }
  setOverlayUnlocked(pinned || overlayUnlocked)
}

/** 一段时间没有新译文就把整窗压暗，别一直糊在画面上；有新内容或鼠标进来立刻恢复 */
function scheduleOverlayIdle() {
  if (overlayIdleTimer) clearTimeout(overlayIdleTimer)
  overlayIdleTimer = undefined
  if (!overlay || overlay.isDestroyed()) return
  overlay.setOpacity(1)
  const seconds = overlayPrefs.idleSeconds ?? 10
  if (!seconds) return
  overlayIdleTimer = setTimeout(() => {
    overlayIdleTimer = undefined
    if (overlay && !overlay.isDestroyed() && !overlayUnlocked) overlay.setOpacity(0.25)
  }, seconds * 1000)
}

/**
 * 轮询光标位置：进入顶部工具栏区临时解除穿透，移出后恢复。
 * 用轮询而不是转发 mousemove，是因为穿透窗口本身收不到 mousedown，轮询行为更确定。
 */
function startOverlayWatch() {
  if (overlayWatchTimer) return
  overlayWatchTimer = setInterval(() => {
    if (!overlay || overlay.isDestroyed() || overlayPinned) return
    if (cursorOnOverlayBar()) {
      if (overlayLockTimer) { clearTimeout(overlayLockTimer); overlayLockTimer = undefined }
      if (!overlayUnlocked) setOverlayUnlocked(true)
    } else if (overlayUnlocked && !overlayLockTimer) {
      // 延迟锁定，避免贴着边界移动时反复切换
      overlayLockTimer = setTimeout(() => {
        overlayLockTimer = undefined
        if (!overlayPinned && !cursorOnOverlayBar()) setOverlayUnlocked(false)
      }, 150)
    }
  }, 60)
}

function stopOverlayWatch() {
  if (overlayWatchTimer) clearInterval(overlayWatchTimer)
  overlayWatchTimer = undefined
  if (overlayLockTimer) clearTimeout(overlayLockTimer)
  overlayLockTimer = undefined
  if (overlayIdleTimer) clearTimeout(overlayIdleTimer)
  overlayIdleTimer = undefined
  overlayUnlocked = false
  overlayPinned = false
}

/** 建窗；已存在返回 true（调用方直接渲染即可） */
function ensureOverlay(anchor?: Electron.Rectangle) {
  if (overlay && !overlay.isDestroyed()) return true
  const bounds = sanitizeOverlayBounds(overlayPrefs.bounds ?? (anchor ? defaultOverlayBounds(anchor) : undefined))
  overlay = new BrowserWindow({
    ...bounds,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, resizable: false, movable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  // 默认点击穿透，不抢游戏焦点；鼠标移到顶部工具栏时由 startOverlayWatch 临时解锁
  overlay.setIgnoreMouseEvents(true, { forward: true })
  // 默认层级会被别的置顶窗口压住，抬到最高一层
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml)}`)
  overlay.on('moved', () => {
    if (!overlay || overlay.isDestroyed()) return
    const { x, y, width, height } = overlay.getBounds()
    overlayPrefs.bounds = { x, y, width, height }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay-bounds', overlayPrefs.bounds)
  })
  overlay.on('closed', () => { stopOverlayWatch(); overlay = undefined })
  overlay.once('ready-to-show', () => {
    pushOverlayPrefs()
    renderOverlay()
    scheduleOverlayIdle()
    overlay?.showInactive()
  })
  startOverlayWatch()
  return false
}

function showOverlay(source: string, translated: string, error = false, anchor?: Electron.Rectangle) {
  overlayStatus = ''
  overlayLines.push({ source, translated, error })
  if (overlayLines.length > OVERLAY_MAX_LINES) overlayLines.splice(0, overlayLines.length - OVERLAY_MAX_LINES)
  if (overlayDismissed) return
  if (ensureOverlay(anchor)) {
    pushOverlayPrefs()
    renderOverlay()
    scheduleOverlayIdle()
    overlay?.showInactive()
  }
}

/** 还没有译文时先把字幕窗摆出来，让用户知道它在哪、正在等什么 */
function showOverlayStatus(text: string, anchor?: Electron.Rectangle) {
  overlayStatus = text
  if (overlayDismissed) return
  if (ensureOverlay(anchor)) {
    // 窗口已存在：若之前只是用主屏兜底摆着、用户也还没自己拖过，就挪到游戏那块屏
    if (anchor && !overlayPrefs.bounds && overlay && !overlay.isDestroyed()) {
      const target = defaultOverlayBounds(anchor)
      const now = overlay.getBounds()
      if (now.x !== target.x || now.y !== target.y) overlay.setBounds({ ...now, x: target.x, y: target.y })
    }
    pushOverlayPrefs()
    renderOverlay()
    return
  }
  pushOverlayPrefs()
  renderOverlay()
  scheduleOverlayIdle()
  overlay?.showInactive()
}

// ---------- OCR 实时字幕 ----------

let ocrWorkerLangs: string[] = []

/** 帧指纹：缩到 960 宽再哈希，比整帧 PNG 编码便宜一个量级，细微改动依然能看出差别 */
function frameFingerprint(image: Electron.NativeImage) {
  const probe = image.getSize().width > 960 ? image.resize({ width: 960 }) : image
  return sha256(probe.toBitmap())
}

async function getOcrWorker(langs: string[]) {
  if (ocrWorker && ocrWorkerLangs.join('+') !== langs.join('+')) {
    await ocrWorker.terminate()
    ocrWorker = undefined
  }
  if (!ocrWorker) {
    ocrWorker = await createWorker(langs)
    ocrWorkerLangs = [...langs]
  }
  return ocrWorker
}

/** 游戏窗口所在显示器的矩形；拿不到返回 undefined，退回主屏默认位置 */
function displayBoundsOf(displayId?: string): Electron.Rectangle | undefined {
  if (!displayId) return undefined
  return screen.getAllDisplays().find(item => String(item.id) === String(displayId))?.bounds
}

/**
 * 多显示器时字幕常常跑到主屏去。这里用窗口标题 + 进程路径定位游戏窗口，
 * 再经 desktopCapturer 的 display_id 拿到它所在的显示器。
 */
async function gameDisplayAnchor(executable?: string): Promise<Electron.Rectangle | undefined> {
  if (!executable) return undefined
  const expected = path.basename(executable, '.exe').toLowerCase().replace(/\W/g, '')
  if (!expected) return undefined
  try {
    const titles = (await windowTitlesForExecutable(executable)).map(title => title.toLowerCase())
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 64, height: 64 } })
    const source = sources.find(item => {
      const name = item.name.toLowerCase().replace(/\W/g, '')
      if (!name || name === 'ineedchinese') return false
      if (name.includes(expected) || expected.includes(name)) return true
      return titles.some(title => Boolean(title) && (item.name.toLowerCase() === title || item.name.toLowerCase().includes(title)))
    })
    return displayBoundsOf(source?.display_id)
  } catch { return undefined }
}

async function startOcr(event: Electron.IpcMainInvokeEvent, request: StartRequest & { sourceId: string; sourceMatch?: string; anchor?: Electron.Rectangle }, signal: AbortSignal) {
  if (ocrTimer) clearInterval(ocrTimer)
  if (!ocrWorker || ocrWorkerLangs.join('+') !== (request.ocrLangs || ['jpn', 'eng']).join('+')) {
    event.sender.send('status', { phase: 'ocr-waiting', message: '正在加载 OCR 模型…' })
  }
  await getOcrWorker(request.ocrLangs || ['jpn', 'eng'])
  if (request.anchor) lastGameRect = request.anchor
  // 先把字幕窗摆到游戏那块屏上，等待期也能看到它
  showOverlayStatus('正在等待画面文字…', lastGameRect)
  let previous = ''
  let previousFrame = ''
  let sourceId = request.sourceId
  let processing = false
  const history: string[] = []
  const tick = async () => {
    if (processing || signal.aborted) return
    processing = true
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1920, height: 1080 } })
      const source = sources.find(item => item.id === sourceId) || sources.find(item => {
        const name = item.name.toLowerCase().replace(/\W/g, '')
        return Boolean(request.sourceMatch && name && (name.includes(request.sourceMatch) || request.sourceMatch.includes(name)))
      })
      if (!source) { event.sender.send('status', { phase: 'ocr-waiting', message: '游戏窗口已关闭，正在等待重新打开…' }); return }
      sourceId = source.id
      const frame = source.thumbnail
      const size = frame.getSize()
      if (!size.width || !size.height) return
      // 台词基本都在窗口下方；整屏 OCR 会把桌面和别的 UI 文字也喂给识别器
      const top = request.ocrRegion === 'full' ? 0 : Math.round(size.height * 0.55)
      const cropped = top ? frame.crop({ x: 0, y: top, width: size.width, height: size.height - top }) : frame
      // 帧指纹走缩放后的位图：比整帧编码 PNG 便宜一个量级，细微改动依然看得出来
      const frameHash = frameFingerprint(cropped)
      if (frameHash === previousFrame) return
      previousFrame = frameHash
      const result = await ocrWorker!.recognize(cropped.toPNG())
      // 低置信度帧多为乱字，忽略防止误翻
      if ((result.data.confidence ?? 100) < 55) return
      const text = result.data.text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 2).join('\n').trim()
      if (!text || text === previous) return
      previous = text
      const glossary = buildGlossary(request.glossary)
      const base = `${storyPrompt}\n只翻译画面中的台词，保留原文换行，忽略识别噪声。`
      const context = history.slice(-5).join('\n')
      const prompt = context ? `${base}\n以下为此前识别文本，仅用于理解上下文：\n${context}` : base
      const outcome = await translateOne(glossary ? glossary.mask(text) : text, request.provider, {
        prompt,
        cachePrompt: glossary ? `${base}\n#glossary:${glossary.id}` : base,
        signal,
      })
      const translated = glossary ? glossary.restore(outcome.translated) : outcome.translated
      remember(history, text)
      showOverlay(text, translated, false, lastGameRect)
      event.sender.send('status', { phase: 'ocr', source: text, translated, cached: outcome.cached })
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        // 与 Hook 模式一致：翻译失败要在字幕上看得见，而不是静默不动
        if (previous) showOverlay(previous, `翻译失败：${message}`, true, lastGameRect)
        event.sender.send('status', { phase: 'error', message })
      }
    } finally { processing = false }
  }
  ocrTimer = setInterval(() => void tick(), 1800)
  void tick()
}

/** 目录里有多个 exe 时别盲取第一个：优先与目录同名的，其次体积最大的（launcher/工具一般很小） */
async function findLaunchTarget(target: string) {
  const stat = await fs.stat(target)
  if (stat.isFile() && path.extname(target).toLowerCase() === '.exe') return target
  const root = stat.isFile() ? path.dirname(target) : target
  const names = (await fs.readdir(root)).filter(name => name.toLowerCase().endsWith('.exe') && !/(unins|uninstall|crash|config|setup|redist|vcredist|dotnet)/i.test(name))
  if (!names.length) return undefined
  const folder = path.basename(root).toLowerCase().replace(/\W/g, '')
  const scored: { file: string; score: number }[] = []
  for (const name of names) {
    const full = path.join(root, name)
    const base = path.basename(name, '.exe').toLowerCase().replace(/\W/g, '')
    const sameName = base && folder && (base === folder || folder.includes(base) || base.includes(folder))
    const size = await fs.stat(full).then(item => item.size).catch(() => 0)
    scored.push({ file: full, score: (sameName ? 1e9 : 0) + size })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored[0].file
}

async function windowTitlesForExecutable(executable?: string) {
  if (!executable) return []
  const script = "$target=[Environment]::GetEnvironmentVariable('INC_TARGET_EXE'); @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target -and $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }) | ConvertTo-Json -Compress"
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, INC_TARGET_EXE: executable } })
    const parsed = JSON.parse(stdout.trim() || '[]') as string | string[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch { return [] }
}

async function startOcrMode(event: Electron.IpcMainInvokeEvent, request: StartRequest, signal: AbortSignal) {
  // 连点「改用 OCR」会重复进入这里；不复用旧定时器就会叠加多个轮询、重复截图与重复请求
  if (safeWaitTimer) { clearInterval(safeWaitTimer); safeWaitTimer = undefined }
  if (signal.aborted) return
  const executable = await findLaunchTarget(request.targetPath)
  if (signal.aborted) return
  const expected = executable ? path.basename(executable, '.exe').toLowerCase().replace(/\W/g, '') : ''
  const baseline = new Set((await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 64, height: 64 } })).map(source => source.id))
  let processTitles: string[] = []
  let lastTitleCheck = 0
  const findMatch = async () => {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 720 } })
    if (Date.now() - lastTitleCheck > 2000) { processTitles = (await windowTitlesForExecutable(executable)).map(title => title.toLowerCase()); lastTitleCheck = Date.now() }
    return sources.find(source => {
      const name = source.name.toLowerCase().replace(/\W/g, '')
      const titleMatch = processTitles.some(title => source.name.toLowerCase() === title || source.name.toLowerCase().includes(title) || title.includes(source.name.toLowerCase()))
      return name && name !== 'ineedchinese' && (titleMatch || (expected && (name.includes(expected) || expected.includes(name))) || !baseline.has(source.id))
    })
  }
  const existing = await findMatch()
  if (signal.aborted) return
  if (existing) {
    await startOcr(event, { ...request, sourceId: existing.id, sourceMatch: existing.name.toLowerCase().replace(/\W/g, '') || expected, anchor: displayBoundsOf(existing.display_id) }, signal)
    return
  }
  if (executable) {
    const error = await shell.openPath(executable)
    if (error) throw new Error(`无法启动游戏：${error}`)
  }
  event.sender.send('status', { phase: 'ocr-waiting', message: '正在等待游戏窗口出现…' })
  safeWaitTimer = setInterval(async () => {
    if (signal.aborted) { if (safeWaitTimer) clearInterval(safeWaitTimer); safeWaitTimer = undefined; return }
    const source = await findMatch().catch(() => undefined)
    if (!source) return
    if (safeWaitTimer) clearInterval(safeWaitTimer)
    safeWaitTimer = undefined
    void startOcr(event, { ...request, sourceId: source.id, sourceMatch: source.name.toLowerCase().replace(/\W/g, '') || expected, anchor: displayBoundsOf(source.display_id) }, signal)
  }, 700)
}

// ---------- 文本 Hook（Textractor） ----------

function cjkScore(text: string) {
  return (text.match(/[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u{20000}-\u{2FA1F}]/gu) || []).length
}

let hookQueue: Promise<void> = Promise.resolve()
const hookHistory: string[] = []
/** 上下文只取最近 5 条，但历史上限放宽一些，避免长会话无限增长 */
const HISTORY_LIMIT = 50

function remember(arr: string[], text: string) {
  arr.push(text)
  if (arr.length > HISTORY_LIMIT) arr.splice(0, arr.length - HISTORY_LIMIT)
}

function forwardHookText(text: string, cached = false) {
  // 串行队列：防止并发请求乱序上字幕、触发限流
  hookQueue = hookQueue.then(() => doForwardHookText(text, cached)).catch(() => undefined)
}

async function doForwardHookText(text: string, cached: boolean) {
  const context = hookContext
  if (!context || context.signal.aborted) return
  const { event, request, signal } = context
  try {
    const glossary = buildGlossary(request.glossary)
    const base = `${storyPrompt}\n只翻译台词/界面文本，忽略乱码与控制符。`
    const history = hookHistory.slice(-5).join('\n')
    const prompt = history ? `${base}\n以下为此前文本，仅用于理解上下文：\n${history}` : base
    const result = await translateOne(glossary ? glossary.mask(text) : text, request.provider, {
      prompt,
      cachePrompt: glossary ? `${base}\n#glossary:${glossary.id}` : base,
      signal,
    })
    const translated = glossary ? glossary.restore(result.translated) : result.translated
    remember(hookHistory, text)
    showOverlay(text, translated)
    event.sender.send('status', { phase: 'hook', source: text, translated, cached: cached || result.cached })
  } catch (error) {
    if (signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    // 字幕窗上明示失败原因，否则用户只会觉得「字幕根本没翻译」
    showOverlay(text, `翻译失败：${message}`, true)
    event.sender.send('status', { phase: 'error', message, detail: message })
  }
}

function clearHookTimers() {
  if (hookFallbackTimer) clearTimeout(hookFallbackTimer)
  hookFallbackTimer = undefined
  if (hookCountdownTimer) clearInterval(hookCountdownTimer)
  hookCountdownTimer = undefined
}

function switchToOcr(message: string) {
  const context = hookContext
  if (!context || context.signal.aborted) return
  void hook?.kill()
  hook = undefined
  clearHookTimers()
  context.event.sender.send('status', { phase: 'ocr-waiting', message })
  void startOcrMode(context.event, context.request, context.signal)
}

/** Hook 优先的实时翻译：attach 已运行游戏 → 进程未运行则启动游戏 → 20 秒无文本回退 OCR */
async function startHookMode(event: Electron.IpcMainInvokeEvent, request: StartRequest, signal: AbortSignal, engine: string) {
  const executable = await findLaunchTarget(request.targetPath)
  if (!executable) { await startOcrMode(event, request, signal); return }
  let arch: 'x86' | 'x64'
  try { arch = await exeArch(executable) } catch { arch = 'x64' }
  hookContext = { event, request, signal }
  hookThreads = new Map()
  hookActiveHandle = undefined
  hookLastForwarded = ''
  hookTriedLaunch = false
  hookGotText = false
  hookQueue = Promise.resolve()
  hookHistory.length = 0
  const send = (data: Record<string, unknown>) => { if (!event.sender.isDestroyed()) event.sender.send('status', { phase: 'hook-waiting', engine, ...data }) }
  send({ message: '正在注入文本 Hook…' })

  // CLI 的诊断只写 stderr，之前完全没读：既看不到失败原因，管道写满还会把子进程卡死
  let lastLog = ''
  let lastError = ''
  const waiting = () => (hookGotText ? 'Hook 已连接，等待游戏文本…' : '正在注入文本 Hook…')

  /** 重新计时回退：启动游戏那一路要额外等游戏把引擎 DLL 加载完，给更长的窗口 */
  const armFallback = (seconds: number) => {
    clearHookTimers()
    let remaining = seconds
    hookCountdownTimer = setInterval(() => {
      if (hookGotText || signal.aborted) return
      remaining -= 1
      if (remaining <= 0) return
      send({ message: `${waiting()} 仍无文本，${remaining} 秒后自动切换 OCR` })
    }, 1000)
    hookFallbackTimer = setTimeout(() => { if (!hookGotText) switchToOcr('Hook 未捕获到文本，已切换 OCR 字幕') }, seconds * 1000)
  }

  const onText = (line: { handle: string; text: string }) => {
    const record = hookThreads.get(line.handle)
    hookThreads.set(line.handle, { lastText: line.text, score: (record?.score || 0) + cjkScore(line.text) })
    // 自动选择：首个出文本的线程；其余线程累计 CJK 分数明显更高才切换，避免抖动
    if (!hookActiveHandle) hookActiveHandle = line.handle
    else if (line.handle !== hookActiveHandle) {
      const challenger = hookThreads.get(line.handle)!.score
      const current = hookThreads.get(hookActiveHandle)?.score || 0
      if (challenger > Math.max(current * 1.5, current + 30)) hookActiveHandle = line.handle
    }
    if (line.handle !== hookActiveHandle || line.text === hookLastForwarded) return
    // 立刻记录：去重必须在入队前完成，否则队列积压时同一句会被重复入队
    hookLastForwarded = line.text
    if (!hookGotText) {
      hookGotText = true
      clearHookTimers()
      send({ message: 'Hook 已连接，等待游戏文本…' })
    }
    void forwardHookText(line.text)
  }

  const handlers: HookHandlers = {
    onText,
    onLog: line => {
      lastLog = line.replace(/^(?:\[info\]|error:)\s*/i, '')
      // -i 启动时的 banner 也是 stderr，不能把它当成失败原因引用
      if (/^error:/i.test(line)) lastError = lastLog
      send({ message: waiting(), detail: lastError || lastLog })
    },
    onExit: code => {
      if (signal.aborted || hookGotText) return
      void hook?.kill()
      hook = undefined
      // 仅「未找到进程」才由 CLI 启动游戏，避免注入失败（架构不符/被拦截）时又拉起第二个实例
      if (code === 3 && !hookTriedLaunch) {
        hookTriedLaunch = true
        send({ message: '游戏未运行，正在启动并注入 Hook…', detail: lastError || lastLog || undefined })
        hook = new HookSession(arch)
        hook.launch(executable, handlers, request.hookCode)
        armFallback(HOOK_FALLBACK_SECONDS + 15)
        return
      }
      switchToOcr(`${hookExitReason(code)}${lastError ? `：${lastError}` : ''}，已切换 OCR 字幕`)
    },
  }

  hook = new HookSession(arch)
  hook.attach(path.basename(executable), handlers, request.hookCode)
  armFallback(HOOK_FALLBACK_SECONDS)
  // 注入已经发出去了，先把字幕窗摆出来，再补上它该落在哪块屏
  showOverlayStatus('正在等待游戏文本…', lastGameRect)
  void gameDisplayAnchor(executable).then(anchor => {
    if (signal.aborted) return
    if (anchor) lastGameRect = anchor
    showOverlayStatus('正在等待游戏文本…', lastGameRect)
  })
}

/** 循环切换有文本的线程 */
function switchThread() {
  const handles = [...hookThreads.keys()]
  if (handles.length < 2) return 0
  const index = handles.indexOf(hookActiveHandle || '')
  hookActiveHandle = handles[(index + 1) % handles.length]
  const record = hookThreads.get(hookActiveHandle)
  if (record) void forwardHookText(record.lastText, true)
  return handles.indexOf(hookActiveHandle) + 1
}

// ---------- 配置存储（API Key 用 safeStorage 加密） ----------

type LlmStored = { baseUrl: string; model: string; temperature: number; apiKey: string }

function configFile() {
  return path.join(app.getPath('userData'), 'config.json')
}

async function readLlmConfig(): Promise<LlmStored | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(configFile(), 'utf8')) as { baseUrl?: string; model?: string; temperature?: number; apiKeyEnc?: string }
    let apiKey = ''
    if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'))
    return { baseUrl: raw.baseUrl || '', model: raw.model || '', temperature: raw.temperature ?? 0.2, apiKey }
  } catch { return undefined }
}

async function writeLlmConfig(config: LlmStored) {
  // apiKey 留空时保留已保存的 Key，防止误清空
  let apiKeyEnc = ''
  if (config.apiKey && safeStorage.isEncryptionAvailable()) apiKeyEnc = safeStorage.encryptString(config.apiKey).toString('base64')
  else {
    try { apiKeyEnc = (JSON.parse(await fs.readFile(configFile(), 'utf8')) as { apiKeyEnc?: string }).apiKeyEnc || '' } catch { /* 无旧配置 */ }
  }
  await fs.mkdir(path.dirname(configFile()), { recursive: true })
  await fs.writeFile(configFile(), JSON.stringify({ baseUrl: config.baseUrl, model: config.model, temperature: config.temperature, apiKeyEnc }), 'utf8')
}

// ---------- 会话管理 ----------

async function stopSession() {
  session?.abort()
  session = undefined
  if (ocrTimer) clearInterval(ocrTimer)
  ocrTimer = undefined
  if (safeWaitTimer) clearInterval(safeWaitTimer)
  safeWaitTimer = undefined
  clearHookTimers()
  // 等 CLI 自己 detach 完再往下走，否则 will-quit 里的 app.exit 会把优雅流程掐断
  const activeHook = hook
  hook = undefined
  await activeHook?.kill()
  hookContext = undefined
  hookThreads = new Map()
  hookActiveHandle = undefined
  stopOverlayWatch()
  overlay?.close()
  overlay = undefined
  overlayLines = []
  overlayStatus = ''
  lastGameRect = undefined
}

/** 拖入目标后的唯一入口：识别 → 已装补丁则报告 → 能补丁则补丁，否则 OCR 字幕。 */
async function start(event: Electron.IpcMainInvokeEvent, request: StartRequest) {
  await stopSession()
  session = new AbortController()
  const signal = session.signal
  overlayDismissed = false
  if (request.overlayPrefs) overlayPrefs = request.overlayPrefs
  // LLM 的 Key 由主进程加密保存，渲染进程不持久化明文
  if (request.provider.kind === 'llm' && !request.provider.apiKey) {
    const stored = await readLlmConfig()
    if (stored?.apiKey) request = { ...request, provider: { ...request.provider, apiKey: stored.apiKey } }
  }
  const send = (data: Record<string, unknown>) => { if (!event.sender.isDestroyed()) event.sender.send('status', data) }
  const glossary = buildGlossary(request.glossary)
  try {
    send({ phase: 'inspect' })
    const info = await inspectTarget(request.targetPath)
    send({ phase: 'inspect', engine: info.type })

    const targetStat = await fs.stat(request.targetPath)
    const isSingleTextFile = targetStat.isFile() && supported.has(path.extname(request.targetPath).toLowerCase())

    // 图片：OCR 识别图中文字 → 翻译 → 直接展示结果
    if (targetStat.isFile() && imageExts.has(path.extname(request.targetPath).toLowerCase())) {
      send({ phase: 'ocr-waiting', message: '正在识别图片文字…' })
      const worker = await getOcrWorker(request.ocrLangs || ['jpn', 'eng'])
      const result = await worker.recognize(request.targetPath)
      const text = result.data.text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 2).join('\n').trim()
      if (!text) { send({ phase: 'done', engine: '图片', message: '未在图片中识别到文字' }); return }
      if (signal.aborted) throw new Error('已取消')
      const chunks = textChunks(text, 2000)
      const imagePrompt = '将图片中识别出的文字翻译为自然的简体中文，保留换行。'
      const translatedChunks = await translateBatch(
        glossary ? chunks.map(glossary.mask) : chunks,
        request.provider,
        { prompt: imagePrompt, cachePrompt: glossary ? `${imagePrompt}\n#glossary:${glossary.id}` : imagePrompt, signal },
      )
      send({ phase: 'done', engine: '图片', ocrImage: true, source: text, translated: translatedChunks.map(value => (glossary ? glossary.restore(value) : value)).join(''), message: '图片识别翻译完成' })
      return
    }
    const manifest = await readManifest(info.root)
    let covered = false
    if (manifest) {
      const intact = await verifyManifest(info.root, manifest)
      const patched = (file: string) => intact.get(path.resolve(file)) === true
      if (isSingleTextFile) covered = patched(request.targetPath)
      else if (info.type === '通用文本项目' || info.type === 'Windows 应用') {
        const textFiles = info.files.filter(file => supported.has(path.extname(file).toLowerCase()))
        covered = textFiles.length > 0 && textFiles.every(patched)
      } else covered = manifest.files.length > 0 && [...intact.values()].every(Boolean)
    }
    if (covered && manifest) {
      if (isSingleTextFile) void shell.openPath(path.resolve(request.targetPath))
      send({ phase: 'done', engine: info.type, patched: true, alreadyInstalled: true, files: manifest.files.length, message: isSingleTextFile ? '该文件已翻译，已打开译文' : `已安装中文补丁（${manifest.files.length} 个文件），直接启动游戏即可` })
      return
    }

    const patchEngines = ["Ren'Py", 'RPG Maker MV/MZ', 'TyranoBuilder', 'Kirikiri/KAG']
    const isTextProject = info.type === '通用文本项目' || isSingleTextFile
    // 通用文本项目没有游戏进程可 hook，始终走补丁；补丁引擎在「优先 Hook」时跳过补丁
    if (isTextProject || (patchEngines.includes(info.type) && !request.preferHook)) {
      try {
        const result = await createPatch(event, info, request.provider, signal, glossary)
        if (isSingleTextFile) void shell.openPath(path.resolve(request.targetPath))
        send({ phase: 'done', engine: info.type, patched: true, files: result.files, message: isSingleTextFile ? '翻译完成，已打开译文' : `中文补丁已安装（${result.files} 个文件），直接启动游戏即可` })
        return
      } catch (error) {
        if (signal.aborted) throw error
        if (!(error instanceof Error && error.message === 'NO_PATCHABLE_TEXT')) throw error
        // 目录里还有 exe 就说明是游戏，回退去 Hook；真的没有可执行文件才给个明确结果，
        // 否则纯文本项目会一直卡在「等待游戏窗口出现」
        const hasExecutable = info.files.some(file => file.toLowerCase().endsWith('.exe'))
        if (isTextProject && !hasExecutable) { send({ phase: 'done', engine: info.type, message: '没有找到可翻译的文本' }); return }
        // 提取不到可补丁文本，回退到 OCR 字幕
      }
    }

    if (signal.aborted) throw new Error('已取消')
    send({ phase: 'hook-waiting', engine: info.type, message: '正在定位游戏进程…' })
    await startHookMode(event, request, signal, info.type)
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.message === '已取消')) send({ phase: 'stopped', message: '已停止' })
    else send({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

// ---------- 窗口与 IPC ----------

// 单实例：重复启动时聚焦已有窗口
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
})

function createWindow() {
  const win = new BrowserWindow({ width: 720, height: 540, minWidth: 560, minHeight: 440, backgroundColor: '#101418', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } })
  win.setMenuBarVisibility(false)
  mainWindow = win
  win.on('close', event => {
    // 翻译还在跑时关窗口只是收进托盘，别把正在进行的会话一起带走
    if (forceClose || !session) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = undefined })
  if (!app.isPackaged) win.loadURL('http://localhost:5173')
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
}

// ---------- 托盘与全局快捷键 ----------

function notifyMain(data: Record<string, unknown>) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', data)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function stopFromAnywhere() {
  await stopSession()
  notifyMain({ phase: 'stopped', message: '已停止' })
}

function switchThreadFromAnywhere() {
  const index = switchThread()
  if (!hookGotText) notifyMain({ phase: 'hook-waiting', message: index ? `已切换到文本源 ${index}` : '没有其他文本源可切换' })
}

function showOverlayFromAnywhere() {
  overlayDismissed = false
  const last = overlayLines[overlayLines.length - 1]
  if (last) showOverlay(last.source, last.translated, last.error, lastGameRect)
  else if (overlayStatus) showOverlayStatus(overlayStatus, lastGameRect)
}

function createTray() {
  if (tray) return
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('INEEDCHINESE')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '停止翻译', click: () => void stopFromAnywhere() },
    { label: '切换文本源', click: switchThreadFromAnywhere },
    { label: '改用 OCR 字幕', click: () => switchToOcr('已手动切换 OCR 字幕') },
    { label: '显示字幕', click: showOverlayFromAnywhere },
    { type: 'separator' },
    { label: '退出', click: () => { forceClose = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)
}

/** 全屏游戏里不用切出来就能停/切源 */
function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+S', () => void stopFromAnywhere())
  globalShortcut.register('CommandOrControl+Alt+D', switchThreadFromAnywhere)
  globalShortcut.register('CommandOrControl+Alt+O', () => switchToOcr('已手动切换 OCR 字幕'))
}

app.whenReady().then(() => {
  // 没抢到单实例锁时 app.quit() 未必立刻生效，这里再拦一次，避免闪出一个窗口
  if (!singleInstance) return
  ipcMain.handle('choose-target', async (_event, mode?: string) => {
    const options: Electron.OpenDialogOptions = mode === 'folder'
      ? { properties: ['openDirectory'] }
      : { properties: ['openFile'], filters: [{ name: '支持的文件', extensions: ['exe', 'txt', 'json', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] }] }
    return (await dialog.showOpenDialog(options)).filePaths[0]
  })
  ipcMain.handle('start', (event, request: StartRequest) => start(event, request))
  ipcMain.handle('stop', async event => { await stopSession(); if (!event.sender.isDestroyed()) event.sender.send('status', { phase: 'stopped', message: '已停止' }) })
  ipcMain.handle('restore', async (_event, target: string) => restorePatch(target))
  ipcMain.handle('switch-thread', event => {
    const index = switchThread()
    // 已经有译文时不再重置主窗口卡片（正在播放的字幕本身就是反馈）
    if (!hookGotText) {
      const target = event.sender === mainWindow?.webContents ? event.sender : mainWindow?.webContents
      if (target && !target.isDestroyed()) target.send('status', { phase: 'hook-waiting', message: index ? `已切换到文本源 ${index}` : '没有其他文本源可切换' })
    }
    return index
  })
  ipcMain.handle('use-ocr', () => switchToOcr('已手动切换 OCR 字幕'))
  ipcMain.handle('translate-text', async (_event, request: { text: string; provider: ProviderSettings }) => {
    if (request.provider.kind === 'llm' && !request.provider.apiKey) {
      const stored = await readLlmConfig()
      if (stored?.apiKey) request = { ...request, provider: { ...request.provider, apiKey: stored.apiKey } }
    }
    const chunks = textChunks(request.text, 2000)
    const translated = await translateBatch(chunks, request.provider, { prompt: '将文本翻译为自然的简体中文，保留原文格式、换行与段落。', signal: new AbortController().signal })
    return { translated: translated.join('') }
  })
  ipcMain.handle('close-overlay', async () => {
    // 只关字幕窗，翻译会话继续（停止走主窗口按钮）
    overlayDismissed = true
    stopOverlayWatch()
    overlay?.close()
    overlay = undefined
  })
  ipcMain.handle('show-overlay', async () => {
    // 字幕窗被 ✕ 关掉后翻译还在跑，需要一个入口把它叫回来（否则会话期间再也看不到字幕）
    overlayDismissed = false
    if (overlayLines.length) {
      const last = overlayLines[overlayLines.length - 1]
      showOverlay(last.source, last.translated, last.error)
    } else if (overlayStatus) showOverlayStatus(overlayStatus, lastGameRect)
  })
  ipcMain.handle('set-overlay-prefs', (_event, prefs: Partial<OverlayPrefs>) => {
    const next: OverlayPrefs = {
      ...overlayPrefs,
      fontSize: Math.min(34, Math.max(18, Math.round(prefs.fontSize ?? overlayPrefs.fontSize))),
      opacity: Math.min(1, Math.max(0.3, prefs.opacity ?? overlayPrefs.opacity)),
      lines: Math.min(OVERLAY_MAX_LINES, Math.max(1, Math.round(prefs.lines ?? overlayPrefs.lines ?? 3))),
      idleSeconds: Math.min(120, Math.max(0, Math.round(prefs.idleSeconds ?? overlayPrefs.idleSeconds ?? 10))),
    }
    const changed = next.fontSize !== overlayPrefs.fontSize || next.opacity !== overlayPrefs.opacity || next.lines !== overlayPrefs.lines || next.idleSeconds !== overlayPrefs.idleSeconds
    overlayPrefs = next
    pushOverlayPrefs()
    renderOverlay()
    // 从字幕工具栏改的样式同步回主窗口，让 localStorage 也跟着记住
    if (changed && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay-prefs', { fontSize: next.fontSize, opacity: next.opacity, lines: next.lines, idleSeconds: next.idleSeconds })
  })
  ipcMain.handle('set-overlay-pinned', (_event, pinned: boolean) => setOverlayPinned(Boolean(pinned)))
  ipcMain.handle('export-cache', async () => {
    const data = await exportCache()
    const picked = await dialog.showSaveDialog({ defaultPath: 'ineedchinese-翻译记忆.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePath) return { saved: 0 }
    await fs.writeFile(picked.filePath, JSON.stringify(data), 'utf8')
    return { saved: Object.keys(data).length }
  })
  ipcMain.handle('import-cache', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePaths[0]) return { added: 0, total: 0 }
    try {
      return await importCache(JSON.parse(await fs.readFile(picked.filePaths[0], 'utf8')) as unknown)
    } catch (error) {
      throw new Error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ipcMain.handle('save-llm-config', async (_event, config: LlmStored) => { await writeLlmConfig(config); return { hasKey: Boolean(config.apiKey) } })
  ipcMain.handle('get-llm-config', async () => {
    const stored = await readLlmConfig()
    return stored ? { baseUrl: stored.baseUrl, model: stored.model, temperature: stored.temperature, hasKey: Boolean(stored.apiKey) } : undefined
  })
  createWindow()
  createTray()
  registerShortcuts()
})

// 退出前统一清理：停会话、终止 OCR worker、缓存落盘
let quitting = false
app.on('will-quit', event => {
  if (quitting) return
  quitting = true
  forceClose = true
  event.preventDefault()
  globalShortcut.unregisterAll()
  void (async () => {
    await stopSession()
    if (ocrWorker) await ocrWorker.terminate().catch(() => undefined)
    ocrWorker = undefined
    await flushCache()
    tray?.destroy()
    tray = undefined
    app.exit(0)
  })()
})
app.on('window-all-closed', () => {
  // 会话还在跑时窗口只是收进了托盘，等会话结束再退
  if (process.platform !== 'darwin' && !session) app.quit()
})
