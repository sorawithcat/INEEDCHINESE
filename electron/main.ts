import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWorker, type Worker } from 'tesseract.js'

type AiConfig = { baseUrl: string; apiKey: string; model: string; temperature: number }
type TranslateRequest = { targetPath: string; prompt: string; config: AiConfig }
type RuntimeRequest = TranslateRequest & { contextSize?: number }
type PatchManifest = { version: 1; engine: string; createdAt: string; files: { path: string; created: boolean; originalHash?: string; patchedHash: string }[] }
type Progress = { current: number; total: number; file: string; chunk: number; chunks: number; failed: string[] }
const supported = new Set(['.txt', '.json'])
const execFileAsync = promisify(execFile)
const jobs = new Map<number, AbortController>()
let overlay: BrowserWindow | undefined
let overlayDismissed = false
let runtimeTimer: NodeJS.Timeout | undefined
let runtimeController: AbortController | undefined
let unityServer: http.Server | undefined
let unityConfig: { prompt: string; config: AiConfig } | undefined
let unityConfigFile: string | undefined
let unityConfigCreated = false
const unityCache = new Map<string, string>()
let clipboardTimer: NodeJS.Timeout | undefined
let clipboardController: AbortController | undefined
const clipboardCache = new Map<string, string>()
let rpgServer: http.Server | undefined
let rpgConfig: { prompt: string; config: AiConfig; sender: Electron.WebContents } | undefined
const rpgCache = new Map<string, string>()
let tyranoServer: http.Server | undefined
let tyranoConfig: { prompt: string; config: AiConfig; sender: Electron.WebContents } | undefined
const tyranoCache = new Map<string, string>()
let ocrTimer: NodeJS.Timeout | undefined
let ocrWorker: Worker | undefined
let ocrController: AbortController | undefined
const ocrCache = new Map<string, string>()
let ocrCacheLoaded = false
let safeWaitTimer: NodeJS.Timeout | undefined
let autoController: AbortController | undefined
let autoMode: 'patch' | 'safe' | undefined

async function walk(root: string): Promise<string[]> {
  const stat = await fs.stat(root)
  if (stat.isFile()) return supported.has(path.extname(root).toLowerCase()) ? [root] : []
  const output: string[] = []
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    if (['node_modules', '.git', '.ineedchinese', 'INEEDCHINESE_zh-CN'].includes(item.name)) continue
    const full = path.join(root, item.name)
    if (item.isDirectory()) output.push(...await walk(full))
    else if (supported.has(path.extname(item.name).toLowerCase())) output.push(full)
  }
  return output
}

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
  const route = ['Godot', 'RPG Maker VX Ace', 'Wolf RPG', 'RPG Developer Bakin', 'Kirikiri/KAG'].includes(type) ? 'hook-or-ocr' : type.startsWith('Unity') ? 'unity' : type === 'Ren\'Py' ? 'renpy' : type === 'RPG Maker MV/MZ' ? 'rpgmaker' : type === 'TyranoBuilder' ? 'tyrano' : 'static'
  return { target, root, type, route, files: all.filter(file => supported.has(path.extname(file).toLowerCase())), totalFiles: all.length }
}

async function askAi(text: string, prompt: string, config: AiConfig, signal: AbortSignal) {
  const isDeepSeek = /api\.deepseek\.com/i.test(config.baseUrl)
  const body = JSON.stringify({ model: config.model, temperature: config.temperature, ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}), messages: [{ role: 'system', content: `${prompt}\n只返回译文，原样保留占位符和转义符。` }, { role: 'user', content: text }] })
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), 120000)
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body })
      if (!response.ok) {
        const details = await response.text()
        if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 700 * 2 ** attempt)); continue }
        throw new Error(`AI 请求失败：${response.status} ${details}`)
      }
      const data = await response.json() as { choices?: { message?: { content?: string } }[] }
      const result = data.choices?.[0]?.message?.content
      if (!result) throw new Error('AI 未返回译文')
      return result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    } catch (error) {
      if (signal.aborted) throw new Error('已取消')
      if (controller.signal.aborted && attempt === 2) throw new Error('AI 请求超时')
      if (attempt === 2) throw error
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }
  throw new Error('AI 请求失败')
}

function textChunks(source: string, limit = 6000) {
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

async function translate(event: Electron.IpcMainInvokeEvent, { targetPath, prompt, config }: TranslateRequest) {
  const controller = new AbortController()
  jobs.set(event.sender.id, controller)
  const info = await inspectTarget(targetPath)
  const output = path.join(info.root, 'INEEDCHINESE_zh-CN')
  const files = await walk(info.root)
  const failed: string[] = []
  let completed = 0
  const report = (data: Omit<Progress, 'failed'>) => event.sender.send('translate-progress', { ...data, failed: [...failed] })
  try {
    for (let index = 0; index < files.length; index++) {
      if (controller.signal.aborted) break
      const file = files[index]
      const relative = path.relative(info.root, file)
      try {
        const source = await fs.readFile(file, 'utf8')
        let translated: string
        if (path.extname(file).toLowerCase() === '.txt') {
          const chunks = textChunks(source)
          const results: string[] = []
          for (let chunk = 0; chunk < chunks.length; chunk++) {
            report({ current: index + 1, total: files.length, file: relative, chunk: chunk + 1, chunks: chunks.length })
            results.push(await askAi(chunks[chunk], prompt, config, controller.signal))
          }
          translated = results.join('')
        } else {
          const json = JSON.parse(source) as unknown
          const entries = jsonStrings(json)
          const batches: JsonEntry[][] = []
          for (const entry of entries) {
            const last = batches.at(-1)
            if (!last || JSON.stringify(last).length + entry.value.length > 6000) batches.push([entry])
            else last.push(entry)
          }
          for (let batch = 0; batch < batches.length; batch++) {
            report({ current: index + 1, total: files.length, file: relative, chunk: batch + 1, chunks: batches.length })
            const payload = batches[batch].map((entry, id) => ({ id, text: entry.value }))
            const instruction = `${prompt}\n返回严格 JSON 数组，保持 id 不变，格式为 [{"id":0,"text":"译文"}]。`
            const result = JSON.parse(await askAi(JSON.stringify(payload), instruction, config, controller.signal)) as { id: number; text: string }[]
            result.forEach(item => { const entry = batches[batch][item.id]; if (entry && typeof item.text === 'string') setJson(json, entry.path, item.text) })
          }
          translated = JSON.stringify(json, null, 2)
        }
        const destination = path.join(output, relative)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, translated, 'utf8')
        completed++
      } catch (error) {
        if (controller.signal.aborted) break
        failed.push(`${relative}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { completed, output, failed, cancelled: controller.signal.aborted }
  } finally { jobs.delete(event.sender.id) }
}

const adapterSource = `# Generated by INEEDCHINESE. Delete this file to remove the adapter.\ninit -999 python:\n    import os\n    _inc_previous_filter = getattr(config, "say_menu_text_filter", None)\n    _inc_last_text = ""\n    def _inc_capture(text):\n        global _inc_last_text\n        shown = _inc_previous_filter(text) if _inc_previous_filter else text\n        if shown and shown != _inc_last_text:\n            _inc_last_text = shown\n            try:\n                clean = shown.replace("\\r", " ").replace("\\n", " ")\n                with open(os.path.join(config.basedir, "ineedchinese_dialogue.txt"), "ab") as stream:\n                    stream.write((clean + "\\n").encode("utf-8"))\n            except Exception:\n                pass\n        return shown\n    config.say_menu_text_filter = _inc_capture\n`

async function findRenpyGame(target: string) {
  const root = (await fs.stat(target)).isFile() ? path.dirname(target) : target
  const game = path.join(root, 'game')
  const renpy = path.join(root, 'renpy')
  try { if ((await fs.stat(game)).isDirectory() && (await fs.stat(renpy)).isDirectory()) return { root, game } } catch { /* not Ren'Py */ }
  throw new Error('未检测到 Ren’Py 游戏目录（需要 game 和 renpy 文件夹）')
}

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

async function startRuntime(event: Electron.IpcMainInvokeEvent, request: RuntimeRequest) {
  overlayDismissed = false
  if (runtimeTimer) clearInterval(runtimeTimer)
  runtimeController?.abort()
  const { root, game } = await findRenpyGame(request.targetPath)
  const adapter = path.join(game, 'ineedchinese_runtime.rpy')
  const queue = path.join(root, 'ineedchinese_dialogue.txt')
  const cacheFile = path.join(root, 'ineedchinese_cache.json')
  await fs.writeFile(adapter, adapterSource, 'utf8')
  await fs.writeFile(queue, '', { encoding: 'utf8', flag: 'a' })
  let cache: Record<string, string> = {}
  try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as Record<string, string> } catch { /* new cache */ }
  let offset = (await fs.stat(queue)).size
  let pending = ''
  let processing = false
  const history: string[] = []
  runtimeController = new AbortController()
  const processQueue = async () => {
    if (processing || !pending) return
    processing = true
    const source = pending; pending = ''
    try {
      let translated = cache[source]
      if (!translated) {
        const context = history.slice(-(request.contextSize || 8)).join('\n')
        translated = await askAi(source, `${request.prompt}\n以下是此前对话，仅用于理解上下文：\n${context}`, request.config, runtimeController!.signal)
        cache[source] = translated
        await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), 'utf8')
      }
      history.push(source)
      showOverlay(source, translated)
      event.sender.send('runtime-status', { state: 'translated', source, translated, cached: Boolean(cache[source]) })
    } catch (error) {
      if (!runtimeController?.signal.aborted) event.sender.send('runtime-status', { state: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { processing = false; if (pending) void processQueue() }
  }
  runtimeTimer = setInterval(async () => {
    try {
      const size = (await fs.stat(queue)).size
      if (size <= offset) return
      const handle = await fs.open(queue, 'r')
      const buffer = Buffer.alloc(size - offset)
      await handle.read(buffer, 0, buffer.length, offset); await handle.close(); offset = size
      const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
      if (lines.length) { pending = lines.at(-1)!; void processQueue() }
    } catch { /* game may be writing */ }
  }, 350)
  return { adapter, queue }
}

async function stopRuntime(target?: string) {
  if (runtimeTimer) clearInterval(runtimeTimer)
  runtimeTimer = undefined
  runtimeController?.abort(); runtimeController = undefined
  overlay?.close(); overlay = undefined
  if (target) {
    try {
      const { game } = await findRenpyGame(target)
      await Promise.allSettled([fs.unlink(path.join(game, 'ineedchinese_runtime.rpy')), fs.unlink(path.join(game, 'ineedchinese_runtime.rpyc'))])
    } catch { /* already removed */ }
  }
}

function updateIni(source: string, section: string, key: string, value: string) {
  const lines = source.split(/\r?\n/)
  const header = `[${section}]`
  let start = lines.findIndex(line => line.trim().toLowerCase() === header.toLowerCase())
  if (start < 0) { lines.push('', header, `${key}=${value}`); return lines.join('\r\n') }
  let end = lines.findIndex((line, index) => index > start && /^\s*\[.+]\s*$/.test(line))
  if (end < 0) end = lines.length
  const existing = lines.findIndex((line, index) => index > start && index < end && line.trimStart().toLowerCase().startsWith(`${key.toLowerCase()}=`))
  if (existing >= 0) lines[existing] = `${key}=${value}`
  else lines.splice(end, 0, `${key}=${value}`)
  return lines.join('\r\n')
}

async function startUnity(event: Electron.IpcMainInvokeEvent, request: RuntimeRequest) {
  overlayDismissed = false
  const root = (await fs.stat(request.targetPath)).isFile() ? path.dirname(request.targetPath) : request.targetPath
  const plugin = path.join(root, 'BepInEx', 'plugins', 'XUnity.AutoTranslator')
  const il2cpp = await fs.stat(path.join(root, 'GameAssembly.dll')).then(() => true).catch(() => false)
  try { if (!(await fs.stat(plugin)).isDirectory()) throw new Error() } catch { throw new Error(`未检测到 XUnity.AutoTranslator。请先安装对应的 ${il2cpp ? 'BepInEx IL2CPP' : 'BepInEx Mono'} 官方版本。`) }
  unityConfig = { prompt: request.prompt, config: request.config }
  if (!unityServer) {
    unityServer = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/translate') { res.writeHead(404).end(); return }
      let body = ''
      req.setEncoding('utf8'); req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body) as { texts?: string[] }
          if (!Array.isArray(payload.texts) || !unityConfig) throw new Error('请求格式无效')
          const output: string[] = []
          for (const text of payload.texts) {
            let translated = unityCache.get(text)
            if (!translated) {
              translated = await askAi(text, unityConfig.prompt, unityConfig.config, new AbortController().signal)
              unityCache.set(text, translated)
            }
            output.push(translated)
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(output))
          event.sender.send('runtime-status', { state: 'translated', source: payload.texts.at(-1), translated: output.at(-1), cached: false })
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })
    })
    await new Promise<void>((resolve, reject) => unityServer!.listen(18765, '127.0.0.1', resolve).once('error', reject))
  }
  const configPath = path.join(root, 'BepInEx', 'config', 'AutoTranslatorConfig.ini')
  unityConfigFile = configPath
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  let ini = ''
  unityConfigCreated = !await fs.stat(configPath).then(() => true).catch(() => false)
  try { ini = await fs.readFile(configPath, 'utf8'); await fs.copyFile(configPath, `${configPath}.ineedchinese.bak`, fs.constants.COPYFILE_EXCL).catch(() => undefined) } catch { /* first configuration */ }
  ini = updateIni(ini, 'Service', 'Endpoint', 'CustomTranslateV2')
  ini = updateIni(ini, 'Service', 'FallbackEndpoint', '')
  ini = updateIni(ini, 'General', 'Language', 'zh-CN')
  ini = updateIni(ini, 'CustomTranslateV2', 'Url', 'http://127.0.0.1:18765/api/translate')
  ini = updateIni(ini, 'CustomTranslateV2', 'EnableBatching', 'True')
  await fs.writeFile(configPath, ini, 'utf8')
  return { configPath, port: 18765, backend: il2cpp ? 'IL2CPP' : 'Mono' }
}

async function stopUnity() {
  unityConfig = undefined
  if (unityServer) await new Promise<void>(resolve => unityServer!.close(() => resolve()))
  unityServer = undefined
  if (unityConfigFile) {
    const backup = `${unityConfigFile}.ineedchinese.bak`
    if (await fs.stat(backup).then(() => true).catch(() => false)) await fs.copyFile(backup, unityConfigFile).catch(() => undefined)
    else if (unityConfigCreated) await fs.unlink(unityConfigFile).catch(() => undefined)
  }
  unityConfigFile = undefined; unityConfigCreated = false
}

async function startClipboard(event: Electron.IpcMainInvokeEvent, request: RuntimeRequest) {
  overlayDismissed = false
  if (clipboardTimer) clearInterval(clipboardTimer)
  clipboardController?.abort()
  clipboardController = new AbortController()
  const history: string[] = []
  let previous = clipboard.readText().trim()
  let processing = false
  let pending = ''
  const translateLatest = async () => {
    if (processing || !pending) return
    processing = true
    const source = pending; pending = ''
    try {
      let translated = clipboardCache.get(source)
      const cached = Boolean(translated)
      if (!translated) {
        const context = history.slice(-(request.contextSize || 8)).join('\n')
        translated = await askAi(source, `${request.prompt}\n以下是此前对话，仅用于理解上下文：\n${context}`, request.config, clipboardController!.signal)
        clipboardCache.set(source, translated)
      }
      history.push(source)
      showOverlay(source, translated)
      event.sender.send('runtime-status', { state: 'translated', source, translated, cached })
    } catch (error) {
      if (!clipboardController?.signal.aborted) event.sender.send('runtime-status', { state: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { processing = false; if (pending) void translateLatest() }
  }
  clipboardTimer = setInterval(() => {
    const text = clipboard.readText().trim()
    if (!text || text === previous || text.length > 12000) return
    previous = text
    pending = text
    void translateLatest()
  }, 300)
  return { state: 'listening' }
}

async function stopClipboard() {
  if (clipboardTimer) clearInterval(clipboardTimer)
  clipboardTimer = undefined
  clipboardController?.abort(); clipboardController = undefined
  overlay?.close(); overlay = undefined
}

const rpgCapturePlugin = `/* INEEDCHINESE runtime capture */\n(function(){\n  var previous = '';\n  function capture(text) {\n    if (!text || text === previous) return; previous = text;\n    fetch('http://127.0.0.1:18766/api/capture', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:text}) }).catch(function(){});\n  }\n  var original = Window_Message.prototype.startMessage;\n  Window_Message.prototype.startMessage = function() {\n    try { capture($gameMessage.allText()); } catch (_) {}\n    return original.apply(this, arguments);\n  };\n})();\n`

async function findRpgMaker(target: string) {
  const root = (await fs.stat(target)).isFile() ? path.dirname(target) : target
  for (const webRoot of [path.join(root, 'www'), root]) {
    const index = path.join(webRoot, 'index.html')
    try {
      const html = await fs.readFile(index, 'utf8')
      if (/rpg_(core|managers)|js\/rmmz_core/i.test(html) || await fs.stat(path.join(webRoot, 'js')).then(() => true).catch(() => false)) return { root, webRoot, index, html }
    } catch { /* try next layout */ }
  }
  throw new Error('未检测到 RPG Maker MV/MZ 的 index.html 与 js 目录')
}

async function startRpgMaker(event: Electron.IpcMainInvokeEvent, request: RuntimeRequest) {
  overlayDismissed = false
  const game = await findRpgMaker(request.targetPath)
  const pluginPath = path.join(game.webRoot, 'js', 'plugins', 'INEEDCHINESE_Capture.js')
  const marker = '<script src="js/plugins/INEEDCHINESE_Capture.js"></script>'
  await fs.mkdir(path.dirname(pluginPath), { recursive: true })
  await fs.writeFile(pluginPath, rpgCapturePlugin, 'utf8')
  await fs.copyFile(game.index, `${game.index}.ineedchinese.bak`, fs.constants.COPYFILE_EXCL).catch(() => undefined)
  if (!game.html.includes(marker)) await fs.writeFile(game.index, game.html.replace(/<\/body>/i, `  ${marker}\r\n</body>`), 'utf8')
  rpgConfig = { prompt: request.prompt, config: request.config, sender: event.sender }
  if (!rpgServer) {
    rpgServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
      if (req.method !== 'POST' || req.url !== '/api/capture') { res.writeHead(404).end(); return }
      let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const source = String((JSON.parse(body) as { text?: string }).text || '').trim()
          if (!source || !rpgConfig) throw new Error('捕获文本为空')
          let translated = rpgCache.get(source); const cached = Boolean(translated)
          if (!translated) { translated = await askAi(source, rpgConfig.prompt, rpgConfig.config, new AbortController().signal); rpgCache.set(source, translated) }
          showOverlay(source, translated)
          rpgConfig.sender.send('runtime-status', { state: 'translated', source, translated, cached })
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ translated }))
        } catch (error) { res.writeHead(500).end(error instanceof Error ? error.message : String(error)) }
      })
    })
    await new Promise<void>((resolve, reject) => rpgServer!.listen(18766, '127.0.0.1', resolve).once('error', reject))
  }
  return { pluginPath, index: game.index }
}

async function stopRpgMaker(target?: string) {
  rpgConfig = undefined
  if (rpgServer) await new Promise<void>(resolve => rpgServer!.close(() => resolve()))
  rpgServer = undefined
  overlay?.close(); overlay = undefined
  if (!target) return
  try {
    const game = await findRpgMaker(target)
    const markerPattern = /\s*<script src=["']js\/plugins\/INEEDCHINESE_Capture\.js["']><\/script>\s*/i
    const html = (await fs.readFile(game.index, 'utf8')).replace(markerPattern, '\r\n')
    await fs.writeFile(game.index, html, 'utf8')
    await fs.unlink(path.join(game.webRoot, 'js', 'plugins', 'INEEDCHINESE_Capture.js')).catch(() => undefined)
  } catch { /* already removed */ }
}

const tyranoCaptureScript = `/* INEEDCHINESE Tyrano runtime capture */\n(function(){\n+  var previous='';\n+  function install(){\n+    try {\n+      var tag=window.TYRANO.kag.ftag.master_tag.text;\n+      if(tag.__ineedchinese) return true;\n+      var original=tag.start;\n+      tag.start=function(pm){\n+        var text=pm&&pm.val?String(pm.val).trim():'';\n+        if(text&&text!==previous){ previous=text; fetch('http://127.0.0.1:18767/api/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text})}).catch(function(){}); }\n+        return original.apply(this,arguments);\n+      };\n+      tag.__ineedchinese=true; return true;\n+    } catch(_){ return false; }\n+  }\n+  var timer=setInterval(function(){if(install())clearInterval(timer);},300);\n+})();\n`

async function findTyrano(target: string) {
  const root = (await fs.stat(target)).isFile() ? path.dirname(target) : target
  const index = path.join(root, 'index.html')
  try {
    const html = await fs.readFile(index, 'utf8')
    if (!/tyrano/i.test(html) && !await fs.stat(path.join(root, 'tyrano')).then(() => true).catch(() => false)) throw new Error()
    return { root, index, html }
  } catch { throw new Error('未检测到 TyranoBuilder/TyranoScript 项目结构') }
}

async function startTyrano(event: Electron.IpcMainInvokeEvent, request: RuntimeRequest) {
  overlayDismissed = false
  const game = await findTyrano(request.targetPath)
  const script = path.join(game.root, 'ineedchinese_tyrano.js')
  const marker = '<script src="ineedchinese_tyrano.js"></script>'
  await fs.writeFile(script, tyranoCaptureScript, 'utf8')
  await fs.copyFile(game.index, `${game.index}.ineedchinese.bak`, fs.constants.COPYFILE_EXCL).catch(() => undefined)
  if (!game.html.includes(marker)) await fs.writeFile(game.index, game.html.replace(/<\/body>/i, `  ${marker}\r\n</body>`), 'utf8')
  tyranoConfig = { prompt: request.prompt, config: request.config, sender: event.sender }
  if (!tyranoServer) {
    tyranoServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
      if (req.method !== 'POST' || req.url !== '/api/capture') { res.writeHead(404).end(); return }
      let body=''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const source=String((JSON.parse(body) as {text?:string}).text||'').trim()
          if(!source||!tyranoConfig) throw new Error('捕获文本为空')
          let translated=tyranoCache.get(source); const cached=Boolean(translated)
          if(!translated){translated=await askAi(source,tyranoConfig.prompt,tyranoConfig.config,new AbortController().signal);tyranoCache.set(source,translated)}
          showOverlay(source,translated); tyranoConfig.sender.send('runtime-status',{state:'translated',source,translated,cached})
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({translated}))
        } catch(error){res.writeHead(500).end(error instanceof Error?error.message:String(error))}
      })
    })
    await new Promise<void>((resolve,reject)=>tyranoServer!.listen(18767,'127.0.0.1',resolve).once('error',reject))
  }
  return { script, index: game.index }
}

async function stopTyrano(target?: string) {
  tyranoConfig=undefined
  if(tyranoServer) await new Promise<void>(resolve=>tyranoServer!.close(()=>resolve()))
  tyranoServer=undefined; overlay?.close(); overlay=undefined
  if(!target)return
  try{
    const game=await findTyrano(target)
    const html=(await fs.readFile(game.index,'utf8')).replace(/\s*<script src=["']ineedchinese_tyrano\.js["']><\/script>\s*/i,'\r\n')
    await fs.writeFile(game.index,html,'utf8'); await fs.unlink(path.join(game.root,'ineedchinese_tyrano.js')).catch(()=>undefined)
  }catch{/* already removed */}
}

async function listCaptureSources() {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
  return sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }))
}

async function startOcr(event: Electron.IpcMainInvokeEvent, request: RuntimeRequest & { sourceId: string; sourceMatch?: string }) {
  overlayDismissed = false
  if (ocrTimer) clearInterval(ocrTimer)
  ocrController?.abort(); ocrController = new AbortController()
  if (!ocrWorker) {
    event.sender.send('runtime-status', { state: 'loading', message: '首次加载日文/英文 OCR 模型…' })
    ocrWorker = await createWorker(['jpn', 'eng'])
  }
  const cacheFile = path.join(app.getPath('userData'), 'ocr-translation-cache.json')
  if (!ocrCacheLoaded) {
    try { const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as Record<string, string>; Object.entries(saved).forEach(([key, value]) => ocrCache.set(key, value)) } catch { /* first run */ }
    ocrCacheLoaded = true
  }
  let previous = ''
  let previousFrame = ''
  let sourceId = request.sourceId
  let processing = false
  const history: string[] = []
  const tick = async () => {
    if (processing || ocrController?.signal.aborted) return
    processing = true
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1280, height: 720 } })
      const source = sources.find(item => item.id === sourceId) || sources.find(item => {
        const name = item.name.toLowerCase().replace(/\W/g, '')
        return Boolean(request.sourceMatch && name && (name.includes(request.sourceMatch) || request.sourceMatch.includes(name)))
      })
      if (!source) { event.sender.send('runtime-status', { state: 'waiting', message: '游戏窗口已关闭，正在等待重新打开…' }); return }
      sourceId = source.id
      const image = source.thumbnail.toPNG()
      const frameHash = sha256(image)
      if (frameHash === previousFrame) return
      previousFrame = frameHash
      const result = await ocrWorker!.recognize(image)
      const text = result.data.text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 2).join('\n').trim()
      if (!text || text === previous) return
      previous = text
      const cacheKey = sha256(JSON.stringify([request.config.baseUrl, request.config.model, request.prompt, text]))
      let translated = ocrCache.get(cacheKey); const cached = Boolean(translated)
      if (!translated) {
        const context = history.slice(-(request.contextSize || 5)).join('\n')
        translated = await askAi(text, `${request.prompt}\n以下为此前识别文本，仅用于理解上下文：\n${context}`, request.config, ocrController!.signal)
        ocrCache.set(cacheKey, translated)
        await fs.mkdir(path.dirname(cacheFile), { recursive: true })
        await fs.writeFile(cacheFile, JSON.stringify(Object.fromEntries(ocrCache), null, 2), 'utf8')
      }
      history.push(text); showOverlay(text, translated)
      event.sender.send('runtime-status', { state: 'translated', source: text, translated, cached })
    } catch (error) {
      if (!ocrController?.signal.aborted) event.sender.send('runtime-status', { state: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { processing = false }
  }
  ocrTimer = setInterval(() => void tick(), 1800)
  void tick()
  return { state: 'watching' }
}

async function stopOcr() {
  if (ocrTimer) clearInterval(ocrTimer)
  ocrTimer = undefined; ocrController?.abort(); ocrController = undefined
  overlay?.close(); overlay = undefined
}

function shouldTranslate(text: string) {
  const value = text.trim()
  if (value.length < 2 || /^[-+]?\d+(?:\.\d+)?$/.test(value)) return false
  if (/^[\w./\\:-]+\.(?:png|jpe?g|webp|ogg|mp3|wav|json|js|dll|exe)$/i.test(value)) return false
  return /[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(value)
}

function placeholders(text: string): string[] {
  return text.match(/(?:\{[^{}]+\}|%\d*\$?[a-zA-Z]|\\[A-Za-z]+(?:\[[^\]]*])?|\[[^\]]+]|<\/?[^>]+>|&[A-Za-z_]\w*)/g) || []
}

function placeholdersPreserved(source: string, translated: string) {
  const expected = placeholders(source)
  const actual = placeholders(translated)
  return expected.every(token => actual.includes(token))
}

async function translateTextSet(texts: string[], prompt: string, config: AiConfig, signal: AbortSignal, cache: Record<string, string>, onBatch?: (current: number, total: number) => void) {
  const keyFor = (text: string) => sha256(JSON.stringify([config.baseUrl, config.model, prompt, text]))
  const unique = [...new Set(texts.filter(shouldTranslate))].filter(text => !cache[keyFor(text)])
  const batches: string[][] = []
  for (const text of unique) {
    const last = batches.at(-1)
    if (!last || JSON.stringify(last).length + text.length > 14000) batches.push([text])
    else last.push(text)
  }
  for (let cursor = 0; cursor < batches.length; cursor += 2) {
    const pair = batches.slice(cursor, cursor + 2)
    await Promise.all(pair.map(async (batch, pairIndex) => {
      if (signal.aborted) throw new Error('已取消')
      const payload = batch.map((text, id) => ({ id, text }))
      const instruction = `${prompt}\n将输入数组中的 text 翻译为简体中文。返回严格 JSON 数组 [{"id":0,"text":"译文"}]，不得改变 id、占位符、转义符、方括号标签和控制代码。`
      const parsed = JSON.parse(await askAi(JSON.stringify(payload), instruction, config, signal)) as { id: number; text: string }[]
      if (!Array.isArray(parsed)) throw new Error('AI 返回格式不是翻译数组')
      const accepted = new Set<number>()
      for (const item of parsed) {
        const source = batch[item.id]
        if (source && typeof item.text === 'string' && placeholdersPreserved(source, item.text)) { cache[keyFor(source)] = item.text; accepted.add(item.id) }
      }
      if (accepted.size !== batch.length) throw new Error('部分译文缺失或占位符校验失败，补丁未安装')
      onBatch?.(cursor + pairIndex + 1, batches.length)
    }))
  }
  return texts.map(text => cache[keyFor(text)] || text)
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

function sha256(data: Buffer | string) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function safeRelativePath(root: string, relative: string) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`补丁路径越界：${relative}`)
  return resolved
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

async function stagePatchFile(root: string, file: string, content: string | Buffer, manifest: PatchManifest, internal: string) {
  const relative = path.relative(root, file)
  const staged = path.join(internal, 'staging', relative)
  await fs.mkdir(path.dirname(staged), { recursive: true })
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  await fs.writeFile(staged, data)
  const exists = await fs.stat(file).then(() => true).catch(() => false)
  manifest.files.push({ path: relative, created: !exists, originalHash: exists ? sha256(await fs.readFile(file)) : undefined, patchedHash: sha256(data) })
}

async function createPatch(event: Electron.IpcMainInvokeEvent, request: RuntimeRequest) {
  await stopAutoMode(); autoController = new AbortController(); autoMode = 'patch'
  const signal = autoController.signal
  const info = await inspectTarget(request.targetPath)
  if (info.type.startsWith('Unity')) {
    const unity = await startUnity(event, request)
    return { engine: info.type, files: 0, runtime: true, message: `已启用 Unity ${unity.backend} 游戏内文本替换` }
  }
  if (['Kirikiri/KAG', 'Godot', 'RPG Maker VX Ace', 'Wolf RPG', 'RPG Developer Bakin'].includes(info.type)) throw new Error(`${info.type} 的资源封包无法安全自动回写，请使用“无注入字幕”模式`)
  const internal = path.join(info.root, '.ineedchinese')
  const backup = path.join(internal, 'backup')
  const manifestPath = path.join(internal, 'patch-manifest.json')
  if (await fs.stat(manifestPath).then(() => true).catch(() => false)) throw new Error('检测到已安装的中文补丁，请先恢复原始文件后再重新生成')
  await fs.rm(path.join(internal, 'staging'), { recursive: true, force: true })
  const manifest: PatchManifest = { version: 1, engine: info.type, createdAt: new Date().toISOString(), files: [] }
  let cache: Record<string, string> = {}
  const cacheFile = path.join(internal, 'translation-cache.json')
  try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as Record<string, string> } catch { /* first patch */ }
  const report = (file: string, current: number, total: number, chunk = 1, chunks = 1) => event.sender.send('translate-progress', { current, total, file, chunk, chunks, failed: [] })

  if (info.type === 'Ren\'Py') {
    const game = path.join(info.root, 'game')
    const scripts = await collectFiles(game, '.rpy')
    const originals: string[] = []
    for (const file of scripts) {
      if (/ineedchinese_|[\\/]tl[\\/]/i.test(file)) continue
      for (const line of (await readTextStrict(file)).text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:[A-Za-z_]\w*\s+)?("(?:\\.|[^"\\])*")\s*(?:#.*)?$/)
        if (match) { try { const text = JSON.parse(match[1]) as string; if (shouldTranslate(text)) originals.push(text) } catch { /* invalid literal */ } }
      }
    }
    if (!originals.length) throw new Error('未找到可读取的 Ren’Py 源脚本；仅含 RPYc 的游戏不能安全生成补丁')
    const unique = [...new Set(originals)]
    const translated = await translateTextSet(unique, request.prompt, request.config, signal, cache, (current, total) => report('Ren’Py 对话', 1, 1, current, total))
    const mapping = Object.fromEntries(unique.map((text, index) => [text, translated[index]]))
    const patchFile = path.join(game, 'ineedchinese_patch.rpy')
    const pythonMap = JSON.stringify(mapping, null, 4).replace(/\n/g, '\n    ')
    const content = `# Generated by INEEDCHINESE. Remove this file to uninstall.\ninit -1000 python:\n    _inc_patch_map = ${pythonMap}\n    _inc_patch_previous = getattr(config, "say_menu_text_filter", None)\n    def _inc_patch_filter(text):\n        shown = _inc_patch_previous(text) if _inc_patch_previous else text\n        return _inc_patch_map.get(shown, shown)\n    config.say_menu_text_filter = _inc_patch_filter\n`
    await stagePatchFile(info.root, patchFile, content, manifest, internal)
  } else if (info.type === 'RPG Maker MV/MZ') {
    const data = await fs.stat(path.join(info.root, 'www', 'data')).then(() => path.join(info.root, 'www', 'data')).catch(() => path.join(info.root, 'data'))
    const files = await collectFiles(data, '.json')
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; const decoded = await readTextStrict(file); const json = JSON.parse(decoded.text) as unknown
      const entries = collectRpgStrings(json); const values = entries.map(entry => entry.value)
      if (!entries.length) continue
      const translated = await translateTextSet(values, request.prompt, request.config, signal, cache, (chunk, chunks) => report(path.relative(info.root, file), index + 1, files.length, chunk, chunks))
      entries.forEach((entry, entryIndex) => setJson(json, entry.path, translated[entryIndex]))
      await stagePatchFile(info.root, file, encodeText(JSON.stringify(json, null, 2), decoded.encoding), manifest, internal)
    }
  } else if (info.type === 'TyranoBuilder') {
    const scenarioRoot = await fs.stat(path.join(info.root, 'data', 'scenario')).then(() => path.join(info.root, 'data', 'scenario')).catch(() => info.root)
    const files = await collectFiles(scenarioRoot, '.ks')
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; const decoded = await readTextStrict(file); const newline = decoded.text.includes('\r\n') ? '\r\n' : '\n'; const lines = decoded.text.split(/\r?\n/)
      const indexes = lines.map((line, lineIndex) => ({ line, lineIndex })).filter(({ line }) => { const value = line.trim(); return value && !/^[;*@#\[]/.test(value) && shouldTranslate(value) })
      if (!indexes.length) continue
      const translated = await translateTextSet(indexes.map(item => item.line.trim()), `${request.prompt}\n原样保留 Tyrano 方括号标签。`, request.config, signal, cache, (chunk, chunks) => report(path.relative(info.root, file), index + 1, files.length, chunk, chunks))
      indexes.forEach((item, itemIndex) => { const indent = item.line.match(/^\s*/)?.[0] || ''; lines[item.lineIndex] = indent + translated[itemIndex] })
      await stagePatchFile(info.root, file, encodeText(lines.join(newline), decoded.encoding), manifest, internal)
    }
  } else {
    const files = (await fs.stat(request.targetPath)).isFile() && supported.has(path.extname(request.targetPath).toLowerCase()) ? [request.targetPath] : await walk(info.root)
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; const decoded = await readTextStrict(file); const source = decoded.text; const relative = path.relative(info.root, file)
      if (path.extname(file).toLowerCase() === '.json') {
        const json = JSON.parse(source) as unknown; const entries = jsonStrings(json); const translated = await translateTextSet(entries.map(entry => entry.value), request.prompt, request.config, signal, cache, (chunk, chunks) => report(relative, index + 1, files.length, chunk, chunks)); entries.forEach((entry, i) => setJson(json, entry.path, translated[i])); await stagePatchFile(info.root, file, encodeText(JSON.stringify(json, null, 2), decoded.encoding), manifest, internal)
      } else {
        const chunks = textChunks(source, 14000); const translated = await translateTextSet(chunks, request.prompt, request.config, signal, cache, (chunk, chunksTotal) => report(relative, index + 1, files.length, chunk, chunksTotal)); await stagePatchFile(info.root, file, encodeText(translated.join(''), decoded.encoding), manifest, internal)
      }
    }
  }

  if (!manifest.files.length) throw new Error('没有找到可安全生成补丁的文本资源')
  await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), 'utf8')
  if (signal.aborted) throw new Error('已取消，游戏文件未被修改')
  for (const entry of manifest.files) {
    const original = safeRelativePath(info.root, entry.path)
    if (!entry.created && sha256(await fs.readFile(original)) !== entry.originalHash) throw new Error(`安装前文件发生变化，已停止：${entry.path}`)
  }
  const applied: typeof manifest.files = []
  try {
    for (const entry of manifest.files) {
      const original = safeRelativePath(info.root, entry.path); const staged = safeRelativePath(path.join(internal, 'staging'), entry.path)
      if (!entry.created) {
        const saved = path.join(backup, entry.path)
        if (!await fs.stat(saved).then(() => true).catch(() => false)) { await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.copyFile(original, saved) }
      }
      await fs.mkdir(path.dirname(original), { recursive: true }); await fs.copyFile(staged, original)
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
  return { engine: info.type, files: manifest.files.length, runtime: false, message: `中文补丁已安装，可随时恢复原文` }
}

async function restorePatch(target: string) {
  const info = await inspectTarget(target); const internal = path.join(info.root, '.ineedchinese'); const manifestPath = path.join(internal, 'patch-manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PatchManifest
  for (const entry of manifest.files) {
    const destination = safeRelativePath(info.root, entry.path)
    if (await fs.stat(destination).then(() => true).catch(() => false)) {
      const currentHash = sha256(await fs.readFile(destination))
      if (currentHash !== entry.patchedHash) throw new Error(`文件在安装补丁后被修改，拒绝覆盖：${entry.path}`)
    }
    if (entry.created) await fs.unlink(destination).catch(() => undefined)
    else await fs.copyFile(safeRelativePath(path.join(internal, 'backup'), entry.path), destination)
  }
  await fs.unlink(manifestPath)
  return { restored: manifest.files.length }
}

async function patchStatus(target: string) {
  const info = await inspectTarget(target)
  try { const manifest = JSON.parse(await fs.readFile(path.join(info.root, '.ineedchinese', 'patch-manifest.json'), 'utf8')) as PatchManifest; return { installed: true, engine: manifest.engine, files: manifest.files.length } }
  catch { return { installed: false, engine: info.type, files: 0 } }
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

async function startSafeMode(event: Electron.IpcMainInvokeEvent, request: RuntimeRequest) {
  await stopAutoMode()
  autoMode = 'safe'; const executable = await findLaunchTarget(request.targetPath)
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
  if (existing) { await startOcr(event, { ...request, sourceId: existing.id, sourceMatch: existing.name.toLowerCase().replace(/\W/g, '') || expected }); return { state: 'active', engine: 'OCR' } }
  if (executable) {
    const error = await shell.openPath(executable)
    if (error) throw new Error(`无法启动游戏：${error}`)
  }
  event.sender.send('runtime-status', { state: 'waiting', message: '正在等待游戏窗口出现…' })
  safeWaitTimer = setInterval(async () => {
    const source = await findMatch().catch(() => undefined)
    if (!source) return
    if (safeWaitTimer) clearInterval(safeWaitTimer); safeWaitTimer = undefined
    void startOcr(event, { ...request, sourceId: source.id, sourceMatch: source.name.toLowerCase().replace(/\W/g, '') || expected })
  }, 700)
  return { state: 'waiting', engine: 'OCR' }
}

async function stopAutoMode() {
  autoController?.abort(); autoController = undefined
  if (safeWaitTimer) clearInterval(safeWaitTimer); safeWaitTimer = undefined
  await Promise.allSettled([stopOcr(), stopUnity(), stopClipboard()])
  autoMode = undefined
}

function createWindow() {
  const win = new BrowserWindow({ width: 1180, height: 780, minWidth: 900, minHeight: 620, backgroundColor: '#0d1117', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } })
  if (!app.isPackaged) win.loadURL('http://localhost:5173')
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
}

app.whenReady().then(() => {
  ipcMain.handle('choose-target', async () => (await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory'], filters: [{ name: '应用程序', extensions: ['exe', 'txt', 'json'] }] })).filePaths[0])
  ipcMain.handle('inspect-target', (_event, target) => inspectTarget(target))
  ipcMain.handle('translate', (event, request) => translate(event, request))
  ipcMain.handle('cancel-translate', event => jobs.get(event.sender.id)?.abort())
  ipcMain.handle('start-runtime', (event, request) => startRuntime(event, request))
  ipcMain.handle('stop-runtime', (_event, target) => stopRuntime(target))
  ipcMain.handle('start-unity', (event, request) => startUnity(event, request))
  ipcMain.handle('stop-unity', () => stopUnity())
  ipcMain.handle('start-clipboard', (event, request) => startClipboard(event, request))
  ipcMain.handle('stop-clipboard', () => stopClipboard())
  ipcMain.handle('start-rpgmaker', (event, request) => startRpgMaker(event, request))
  ipcMain.handle('stop-rpgmaker', (_event, target) => stopRpgMaker(target))
  ipcMain.handle('start-tyrano', (event, request) => startTyrano(event, request))
  ipcMain.handle('stop-tyrano', (_event, target) => stopTyrano(target))
  ipcMain.handle('capture-sources', () => listCaptureSources())
  ipcMain.handle('start-ocr', (event, request) => startOcr(event, request))
  ipcMain.handle('stop-ocr', () => stopOcr())
  ipcMain.handle('close-overlay', async () => {
    overlayDismissed = true; await stopAutoMode(); overlay?.close(); overlay = undefined
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('runtime-status', { state: 'stopped', message: '字幕已关闭，翻译会话已停止' })
  })
  ipcMain.handle('create-patch', (event, request) => createPatch(event, request))
  ipcMain.handle('restore-patch', (_event, target) => restorePatch(target))
  ipcMain.handle('patch-status', (_event, target) => patchStatus(target))
  ipcMain.handle('start-safe-mode', (event, request) => startSafeMode(event, request))
  ipcMain.handle('stop-auto-mode', () => stopAutoMode())
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
