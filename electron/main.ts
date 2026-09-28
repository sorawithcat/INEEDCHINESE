import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWorker, type Worker } from 'tesseract.js'
import { translateBatch, translateOne, type ProviderSettings } from './provider'
import { HookSession, exeArch } from './hook'

type StartRequest = { targetPath: string; provider: ProviderSettings; preferHook?: boolean }
type PatchManifest = { version: 1; engine: string; createdAt: string; files: { path: string; created: boolean; originalHash?: string; patchedHash: string }[] }

const storyPrompt = '将游戏文本翻译为自然的简体中文。保留人物语气、世界观术语和情绪，不擅自增删内容。'
const uiPrompt = '将界面文本翻译为简洁准确的简体中文，按钮文字简短，术语前后一致。'

const supported = new Set(['.txt', '.json'])
const execFileAsync = promisify(execFile)

let overlay: BrowserWindow | undefined
let overlayDismissed = false
let session: AbortController | undefined
let ocrTimer: NodeJS.Timeout | undefined
let ocrWorker: Worker | undefined
let safeWaitTimer: NodeJS.Timeout | undefined
let hook: HookSession | undefined
let hookFallbackTimer: NodeJS.Timeout | undefined
let hookThreads = new Map<string, { lastText: string; score: number }>()
let hookActiveHandle: string | undefined
let hookLastForwarded = ''
let hookContext: { event: Electron.IpcMainInvokeEvent; request: StartRequest; signal: AbortSignal } | undefined
let hookTriedLaunch = false
let hookGotText = false

function sha256(data: Buffer | string) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function shouldTranslate(text: string) {
  const value = text.trim()
  if (value.length < 2 || /^[-+]?\d+(?:\.\d+)?$/.test(value)) return false
  if (/^[\w./\\:-]+\.(?:png|jpe?g|webp|ogg|mp3|wav|json|js|dll|exe)$/i.test(value)) return false
  return /[A-Za-z぀-ヿ㐀-鿿가-힯]/.test(value)
}

// ---------- 引擎识别 ----------

function detect(files: string[], target: string) {
  const names = files.map(file => file.toLowerCase())
  if (names.some(file => file.endsWith('.rpy') || file.endsWith('.rpyc')) || names.some(file => /[\\/]renpy[\\/]/.test(file))) return 'Ren\'Py'
  if (names.some(file => file.endsWith('gameassembly.dll')) && names.some(file => file.endsWith('global-metadata.dat'))) return 'Unity IL2CPP'
  if (names.some(file => file.includes('unityplayer.dll')) || names.some(file => file.includes('_data'))) return 'Unity Mono'
  if (names.some(file => file.endsWith('.xp3')) || names.some(file => file.endsWith('krkrsteam.dll'))) return 'Kirikiri/KAG'
  if (names.some(file => file.endsWith('tyrano.js')) || names.some(file => /[\\/]tyrano[\\/]/.test(file))) return 'TyranoBuilder'
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
  async function scan(dir: string) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.ineedchinese', 'INEEDCHINESE_zh-CN'].includes(item.name)) continue
      const full = path.join(dir, item.name)
      if (item.isDirectory() && all.length < 5000) await scan(full)
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
async function readTextStrict(file: string): Promise<{ text: string; encoding: TextEncoding }> {
  const data = await fs.readFile(file)
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return { text: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(3)), encoding: 'utf8bom' }
  if (data[0] === 0xff && data[1] === 0xfe) return { text: new TextDecoder('utf-16le', { fatal: true }).decode(data.subarray(2)), encoding: 'utf16le' }
  if (data[0] === 0xfe && data[1] === 0xff) return { text: new TextDecoder('utf-16be', { fatal: true }).decode(data.subarray(2)), encoding: 'utf16be' }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'utf8' } }
  catch { throw new Error(`不支持的文本编码，已拒绝修改：${file}`) }
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

async function createPatch(event: Electron.IpcMainInvokeEvent, info: Awaited<ReturnType<typeof inspectTarget>>, provider: ProviderSettings, signal: AbortSignal) {
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
  const run = (texts: string[], onProgress?: (done: number, total: number) => void) =>
    translateBatch(texts, provider, { prompt, signal }, onProgress)

  if (info.type === 'Ren\'Py') {
    const game = path.join(info.root, 'game')
    const scripts = (await collectFiles(game, '.rpy')).filter(file => !/ineedchinese_|[\\/]tl[\\/]/i.test(file))
    if (!scripts.length) throw new Error('NO_PATCHABLE_TEXT')
    const originals: string[] = []
    for (const file of scripts) {
      for (const line of (await readTextStrict(file)).text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:[A-Za-z_]\w*\s+)?("(?:\\.|[^"\\])*")\s*(?:#.*)?$/)
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
      await fs.copyFile(staged, original)
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
  for (const entry of manifest.files) {
    const destination = safeRelativePath(info.root, entry.path)
    if (await fs.stat(destination).then(() => true).catch(() => false)) {
      if (sha256(await fs.readFile(destination)) !== entry.patchedHash) throw new Error(`文件在安装补丁后被修改，拒绝覆盖：${entry.path}`)
    }
    if (entry.created) await fs.unlink(destination).catch(() => undefined)
    else await fs.copyFile(safeRelativePath(path.join(internal, 'backup'), entry.path), destination)
  }
  await fs.unlink(manifestPath)
  return { restored: manifest.files.length }
}

async function readManifest(root: string): Promise<PatchManifest | undefined> {
  try { return JSON.parse(await fs.readFile(path.join(root, '.ineedchinese', 'patch-manifest.json'), 'utf8')) as PatchManifest }
  catch { return undefined }
}

// ---------- 字幕窗 ----------

function showOverlay(source: string, translated: string) {
  if (overlayDismissed) return
  if (!overlay || overlay.isDestroyed()) {
    overlay = new BrowserWindow({ width: 1000, height: 220, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: true, resizable: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } })
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<style>*{box-sizing:border-box}body{margin:0;background:rgba(8,12,18,.9);color:white;font-family:"Microsoft YaHei";border-radius:14px;overflow:hidden}.bar{height:34px;display:flex;align-items:center;padding-left:14px;color:#94a3b8;font-size:12px;-webkit-app-region:drag}.close{margin-left:auto;width:42px;height:34px;border:0;background:transparent;color:#cbd5e1;font-size:22px;cursor:pointer;-webkit-app-region:no-drag}.close:hover{background:#be123c;color:white}.content{height:calc(100vh - 34px);overflow:auto;padding:4px 20px 18px}.content::-webkit-scrollbar{width:8px}.content::-webkit-scrollbar-thumb{background:#475569;border-radius:4px}#zh{font-size:24px;line-height:1.55}#src{font-size:13px;color:#9ca3af;margin-top:10px}</style><div class="bar">INEEDCHINESE 字幕<button class="close" title="关闭字幕" onclick="window.translator.closeOverlay()">×</button></div><div class="content"><div id="zh"></div><div id="src"></div></div>')}`)
    overlay.once('ready-to-show', () => showOverlay(source, translated))
    overlay.showInactive()
    return
  }
  overlay.webContents.executeJavaScript(`document.getElementById('zh').textContent=${JSON.stringify(translated)};document.getElementById('src').textContent=${JSON.stringify(source)}`)
  overlay.showInactive()
}

// ---------- OCR 实时字幕 ----------

async function startOcr(event: Electron.IpcMainInvokeEvent, request: StartRequest & { sourceId: string; sourceMatch?: string }, signal: AbortSignal) {
  if (ocrTimer) clearInterval(ocrTimer)
  if (!ocrWorker) {
    event.sender.send('status', { phase: 'ocr-waiting', message: '首次加载 OCR 模型…' })
    ocrWorker = await createWorker(['jpn', 'eng'])
  }
  let previous = ''
  let previousFrame = ''
  let sourceId = request.sourceId
  let processing = false
  const history: string[] = []
  const tick = async () => {
    if (processing || signal.aborted) return
    processing = true
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1280, height: 720 } })
      const source = sources.find(item => item.id === sourceId) || sources.find(item => {
        const name = item.name.toLowerCase().replace(/\W/g, '')
        return Boolean(request.sourceMatch && name && (name.includes(request.sourceMatch) || request.sourceMatch.includes(name)))
      })
      if (!source) { event.sender.send('status', { phase: 'ocr-waiting', message: '游戏窗口已关闭，正在等待重新打开…' }); return }
      sourceId = source.id
      const image = source.thumbnail.toPNG()
      const frameHash = sha256(image)
      if (frameHash === previousFrame) return
      previousFrame = frameHash
      const result = await ocrWorker!.recognize(image)
      const text = result.data.text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 2).join('\n').trim()
      if (!text || text === previous) return
      previous = text
      const context = history.slice(-5).join('\n')
      const prompt = `${storyPrompt}\n以下为此前识别文本，仅用于理解上下文：\n${context}`
      const { translated, cached } = await translateOne(text, request.provider, { prompt, signal })
      history.push(text)
      showOverlay(text, translated)
      event.sender.send('status', { phase: 'ocr', source: text, translated, cached })
    } catch (error) {
      if (!signal.aborted) event.sender.send('status', { phase: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { processing = false }
  }
  ocrTimer = setInterval(() => void tick(), 1800)
  void tick()
}

async function findLaunchTarget(target: string) {
  const stat = await fs.stat(target)
  if (stat.isFile() && path.extname(target).toLowerCase() === '.exe') return target
  const root = stat.isFile() ? path.dirname(target) : target
  const candidates = (await fs.readdir(root)).filter(name => name.toLowerCase().endsWith('.exe') && !/(unins|uninstall|crash|config|setup)/i.test(name))
  return candidates.length ? path.join(root, candidates[0]) : undefined
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
  const executable = await findLaunchTarget(request.targetPath)
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
  if (existing) {
    await startOcr(event, { ...request, sourceId: existing.id, sourceMatch: existing.name.toLowerCase().replace(/\W/g, '') || expected }, signal)
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
    void startOcr(event, { ...request, sourceId: source.id, sourceMatch: source.name.toLowerCase().replace(/\W/g, '') || expected }, signal)
  }, 700)
}

// ---------- 文本 Hook（Textractor） ----------

function cjkScore(text: string) {
  return (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length
}

async function forwardHookText(text: string, cached = false) {
  const context = hookContext
  if (!context || context.signal.aborted) return
  hookLastForwarded = text
  const { event, request, signal } = context
  try {
    const prompt = `${storyPrompt}\n只翻译台词/界面文本，忽略乱码与控制符。`
    const result = await translateOne(text, request.provider, { prompt, signal })
    showOverlay(text, result.translated)
    event.sender.send('status', { phase: 'hook', source: text, translated: result.translated, cached: cached || result.cached })
  } catch (error) {
    if (!signal.aborted) event.sender.send('status', { phase: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

function switchToOcr(message: string) {
  const context = hookContext
  if (!context || context.signal.aborted) return
  hook?.kill(); hook = undefined
  if (hookFallbackTimer) clearTimeout(hookFallbackTimer); hookFallbackTimer = undefined
  context.event.sender.send('status', { phase: 'ocr-waiting', message })
  void startOcrMode(context.event, context.request, context.signal)
}

/** Hook 优先的实时翻译：attach 已运行游戏 → 失败则启动游戏 → 45 秒无文本回退 OCR */
async function startHookMode(event: Electron.IpcMainInvokeEvent, request: StartRequest, signal: AbortSignal) {
  const executable = await findLaunchTarget(request.targetPath)
  if (!executable) { startOcrMode(event, request, signal); return }
  let arch: 'x86' | 'x64'
  try { arch = await exeArch(executable) } catch { arch = 'x64' }
  hookContext = { event, request, signal }
  hookThreads = new Map()
  hookActiveHandle = undefined
  hookLastForwarded = ''
  hookTriedLaunch = false
  hookGotText = false
  event.sender.send('status', { phase: 'hook-waiting', message: '正在注入文本 Hook…' })

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
    if (!hookGotText) {
      hookGotText = true
      if (hookFallbackTimer) clearTimeout(hookFallbackTimer); hookFallbackTimer = undefined
      event.sender.send('status', { phase: 'hook-waiting', message: 'Hook 已连接，等待游戏文本…' })
    }
    void forwardHookText(line.text)
  }

  const onExit = () => {
    if (signal.aborted || hookGotText) return
    hook?.kill(); hook = undefined
    if (!hookTriedLaunch) {
      // 游戏未在运行，启动它
      hookTriedLaunch = true
      event.sender.send('status', { phase: 'hook-waiting', message: '正在启动游戏并注入 Hook…' })
      hook = new HookSession(arch)
      hook.launch(executable, onText, onExit)
    } else {
      switchToOcr('文本 Hook 注入失败，已切换 OCR 字幕')
    }
  }

  hook = new HookSession(arch)
  hook.attach(path.basename(executable), onText, onExit)
  hookFallbackTimer = setTimeout(() => { if (!hookGotText) switchToOcr('Hook 未捕获到文本，已切换 OCR 字幕') }, 45000)
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

// ---------- 会话管理 ----------

async function stopSession() {
  session?.abort()
  session = undefined
  if (ocrTimer) clearInterval(ocrTimer)
  ocrTimer = undefined
  if (safeWaitTimer) clearInterval(safeWaitTimer)
  safeWaitTimer = undefined
  if (hookFallbackTimer) clearTimeout(hookFallbackTimer)
  hookFallbackTimer = undefined
  hook?.kill()
  hook = undefined
  hookContext = undefined
  hookThreads = new Map()
  hookActiveHandle = undefined
  overlay?.close()
  overlay = undefined
}

/** 拖入目标后的唯一入口：识别 → 已装补丁则报告 → 能补丁则补丁，否则 OCR 字幕。 */
async function start(event: Electron.IpcMainInvokeEvent, request: StartRequest) {
  await stopSession()
  session = new AbortController()
  const signal = session.signal
  overlayDismissed = false
  const send = (data: Record<string, unknown>) => { if (!event.sender.isDestroyed()) event.sender.send('status', data) }
  try {
    send({ phase: 'inspect' })
    const info = await inspectTarget(request.targetPath)
    send({ phase: 'inspect', engine: info.type })

    const targetStat = await fs.stat(request.targetPath)
    const isSingleTextFile = targetStat.isFile() && supported.has(path.extname(request.targetPath).toLowerCase())
    const manifest = await readManifest(info.root)
    let covered = false
    if (manifest) {
      if (isSingleTextFile) covered = manifest.files.some(entry => path.resolve(info.root, entry.path) === path.resolve(request.targetPath))
      else if (info.type === '通用文本项目' || info.type === 'Windows 应用') {
        const textFiles = info.files.filter(file => supported.has(path.extname(file).toLowerCase()))
        covered = textFiles.length > 0 && textFiles.every(file => manifest.files.some(entry => path.resolve(info.root, entry.path) === path.resolve(file)))
      } else covered = true
    }
    if (covered && manifest) {
      if (isSingleTextFile) void shell.openPath(path.resolve(request.targetPath))
      send({ phase: 'done', engine: info.type, patched: true, alreadyInstalled: true, files: manifest.files.length, message: isSingleTextFile ? '该文件已翻译，已打开译文' : `已安装中文补丁（${manifest.files.length} 个文件），直接启动游戏即可` })
      return
    }

    const patchEngines = ["Ren'Py", 'RPG Maker MV/MZ', 'TyranoBuilder']
    const isTextProject = info.type === '通用文本项目' || isSingleTextFile
    // 通用文本项目没有游戏进程可 hook，始终走补丁；补丁引擎在「优先 Hook」时跳过补丁
    if (isTextProject || (patchEngines.includes(info.type) && !request.preferHook)) {
      try {
        const result = await createPatch(event, info, request.provider, signal)
        if (isSingleTextFile) void shell.openPath(path.resolve(request.targetPath))
        send({ phase: 'done', engine: info.type, patched: true, files: result.files, message: isSingleTextFile ? '翻译完成，已打开译文' : `中文补丁已安装（${result.files} 个文件），直接启动游戏即可` })
        return
      } catch (error) {
        if (signal.aborted) throw error
        if (!(error instanceof Error && error.message === 'NO_PATCHABLE_TEXT')) throw error
        // 提取不到可补丁文本，回退到 OCR 字幕
      }
    }

    if (signal.aborted) throw new Error('已取消')
    send({ phase: 'hook-waiting', engine: info.type, message: '正在定位游戏进程…' })
    await startHookMode(event, request, signal)
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.message === '已取消')) send({ phase: 'stopped', message: '已停止' })
    else send({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

// ---------- 窗口与 IPC ----------

function createWindow() {
  const win = new BrowserWindow({ width: 720, height: 540, minWidth: 560, minHeight: 440, backgroundColor: '#101418', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } })
  win.setMenuBarVisibility(false)
  if (!app.isPackaged) win.loadURL('http://localhost:5173')
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
}

app.whenReady().then(() => {
  ipcMain.handle('choose-target', async () => (await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory'], filters: [{ name: '应用程序', extensions: ['exe', 'txt', 'json'] }] })).filePaths[0])
  ipcMain.handle('start', (event, request: StartRequest) => start(event, request))
  ipcMain.handle('stop', async event => { await stopSession(); if (!event.sender.isDestroyed()) event.sender.send('status', { phase: 'stopped', message: '已停止' }) })
  ipcMain.handle('restore', async (_event, target: string) => restorePatch(target))
  ipcMain.handle('switch-thread', event => {
    const index = switchThread()
    if (index) event.sender.send('status', { phase: 'hook-waiting', message: `已切换到文本源 ${index}` })
    return index
  })
  ipcMain.handle('use-ocr', () => switchToOcr('已手动切换 OCR 字幕'))
  ipcMain.handle('close-overlay', async () => {
    overlayDismissed = true
    await stopSession()
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('status', { phase: 'stopped', message: '字幕已关闭' })
  })
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
