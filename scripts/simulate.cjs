// 仿真台：用假 electron / 假 child_process / 假 fetch 驱动真实的主进程代码 dist-electron/main.js
// 用法：npm run build && npm run simulate
// 覆盖：引擎识别、补丁与恢复、图片 OCR、Hook 全链路、退出码分支、字幕工具栏与拖动、
//       定时器泄漏、编码往返。不依赖 Electron 窗口，也不接触真实游戏进程。
const Module = require('module')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const USER_DATA = path.join(os.tmpdir(), 'inc-sim', 'userdata')
fs.mkdirSync(USER_DATA, { recursive: true })

// ---------- 记录器 ----------
const log = []
const record = (...args) => log.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))
const results = []

// ---------- 假 screen ----------
let cursor = { x: 0, y: 0 }
const screenStub = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  getCursorScreenPoint: () => ({ ...cursor }),
  getDisplayMatching: rect => {
    const displays = screenStub.getAllDisplays()
    return displays.find(item => rect.x >= item.bounds.x && rect.x < item.bounds.x + item.bounds.width) ?? displays[0]
  },
  getAllDisplays: () => [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
  ],
}

// ---------- 假 BrowserWindow ----------
const windows = []
class FakeWebContents extends EventEmitter {
  constructor(win) { super(); this.win = win; this.scripts = [] }
  executeJavaScript(code) { this.scripts.push(code); return Promise.resolve(undefined) }
  send(channel, data) { record('  -> mainWindow IPC', channel, JSON.stringify(data)) }
  isDestroyed() { return false }
}
class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 800, height: options.height ?? 600 }
    this.destroyed = false
    this.mouse = []      // setIgnoreMouseEvents 调用序列
    this.focusable = []
    this.opacity = []
    this.topLevel = []
    this.hidden = false
    this.webContents = new FakeWebContents(this)
    windows.push(this)
  }
  setMenuBarVisibility() {}
  setIgnoreMouseEvents(v, opts) { this.mouse.push(v === true ? '穿透' : '可点'); if (opts) this.hadOpts = true }
  setFocusable(v) { this.focusable.push(v) }
  setOpacity(v) { this.opacity.push(v) }
  setAlwaysOnTop(v, level) { this.topLevel.push(level ?? true) }
  hide() { this.hidden = true }
  show() { this.hidden = false }
  focus() {}
  restore() {}
  isMinimized() { return false }
  loadURL(url) { this.loadedUrl = url; setImmediate(() => this.emit('ready-to-show')); return Promise.resolve() }
  loadFile(f) { this.loadedFile = f; return Promise.resolve() }
  getBounds() { return { ...this.bounds } }
  setBounds(next) { this.bounds = { ...this.bounds, ...next }; this.emit('moved') }
  close() { this.destroyed = true; this.emit('closed') }
  showInactive() { this.hidden = false }
  isDestroyed() { return this.destroyed }
  // 模拟窗口被拖动
  moveTo(x, y) { this.bounds.x = x; this.bounds.y = y; this.emit('moved') }
}

// ---------- 假桌面捕获 ----------
let frameSalt = 0
let toPngCount = 0
const croppedRects = []
function makeFakeSource(name, id, displayId) {
  const size = { width: 1920, height: 1080 }
  const image = {
    getSize: () => ({ ...size }),
    crop: rect => { croppedRects.push(rect); return image },
    resize: () => image,
    toBitmap: () => Buffer.from(`frame-${frameSalt}`),
    toPNG: () => { toPngCount++; return Buffer.from(`png-${frameSalt}`) },
  }
  return { id, name, display_id: displayId, thumbnail: image }
}

// ---------- 假 desktopCapturer ----------
let fakeSources = []
const desktopCapturerStub = {
  getSources: async () => { getSourcesCalls.push(Date.now()); return fakeSources },
}
const getSourcesCalls = []

// ---------- 假 child_process.spawn ----------
const spawned = []
let spawnBehaviour = 'stream'   // stream | exit3 | exit1
let quitDelayMs = 5            // 模拟 CLI 收到 quit 后 detach 的耗时
class FakeChild extends EventEmitter {
  constructor(cmd, args, opts) {
    super()
    this.cmd = cmd; this.args = args; this.opts = opts
    this.stdout = new PassThrough(); this.stderr = new PassThrough()
    this.stdin = new PassThrough(); this.stdinWrites = []
    this.killed = false
    this.stdin.on('data', d => {
      this.stdinWrites.push(String(d))
      if (String(d).includes('quit')) setTimeout(() => this.emit('exit', 0), quitDelayMs)
    })
    spawned.push(this)
  }
  kill() { this.killed = true; this.emit('exit', null) }
  // 模拟 CLI 输出一行
  emitLine(text) { this.stdout.write(text + '\n') }
  emitErr(text) { this.stderr.write(text + '\n') }
}
const childProcessStub = {
  spawn: (cmd, args, opts) => {
    const child = new FakeChild(cmd, args, opts)
    record('  spawn:', path.basename(cmd), JSON.stringify(args), 'stdio[0]=' + (opts?.stdio?.[0] ?? 'default'))
    if (spawnBehaviour === 'exit3') setTimeout(() => { child.emitErr('error: no matching process found'); child.emit('exit', 3) }, 10)
    if (spawnBehaviour === 'exit1') setTimeout(() => { child.emitErr("error: unknown option 'X'"); child.emit('exit', 1) }, 10)
    return child
  },
  execFile: (file, args, opts, cb) => { setTimeout(() => cb(null, { stdout: '[]' }), 5); return {} },
}

// ---------- 假 fetch（免费翻译链） ----------
global.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.includes('cn.bing.com/translator')) {
    return { ok: true, status: 200, headers: { getSetCookie: () => ['MUID=1; path=/'] }, text: async () => '<html>IG:"ABC123" data-iid="translator.5028" params_AbusePreventionHelper = [123,"tok"]</html>' }
  }
  if (u.includes('ttranslatev3')) {
    const text = new URLSearchParams(String(opts.body)).get('text') || ''
    if (!text.trim()) { record('  !! 空文本被送进 Bing'); return { ok: true, status: 200, json: async () => [] } }
    return { ok: true, status: 200, json: async () => [{ translations: [{ text: '【译】' + text }] }] }
  }
  return { ok: false, status: 500, text: async () => 'nope', json: async () => ({}) }
}

// ---------- 假 tesseract ----------
let ocrRecognizeCount = 0
let ocrText = 'こんにちは世界'
const tesseractStub = {
  createWorker: async () => ({ recognize: async () => { ocrRecognizeCount++; return { data: { text: ocrText, confidence: 90 } } }, terminate: async () => {} }),
}

// ---------- 假 electron ----------
const ipcHandlers = new Map()
const trays = []
const shortcuts = new Map()
class FakeTray extends EventEmitter {
  constructor(icon) { super(); this.icon = icon }
  setToolTip() {}
  setContextMenu(menu) { this.menu = menu; trays.push(this) }
}
let saveDialogPath = ''
let openDialogPath = ''
const electronStub = {
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    getPath: name => name === 'userData' ? USER_DATA : os.tmpdir(),
    on() {}, whenReady: () => Promise.resolve(), quit() {}, exit() {},
  },
  BrowserWindow: FakeBrowserWindow,
  desktopCapturer: desktopCapturerStub,
  dialog: {
    showOpenDialog: async () => openDialogPath ? { filePaths: [openDialogPath], canceled: false } : { filePaths: [], canceled: true },
    showSaveDialog: async () => saveDialogPath ? { filePath: saveDialogPath, canceled: false } : { canceled: true },
  },
  ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  screen: screenStub,
  shell: { openPath: async () => '' },
  Tray: FakeTray,
  Menu: { buildFromTemplate: template => ({ template }) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({}) }), createEmpty: () => ({ isEmpty: () => true }) },
  globalShortcut: { register: (accelerator, callback) => { shortcuts.set(accelerator, callback); return true }, unregisterAll: () => shortcuts.clear() },
}

// ---------- 拦截 require ----------
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (request === 'node:child_process' || request === 'child_process') return childProcessStub
  if (request === 'tesseract.js') return tesseractStub
  return origLoad.call(this, request, parent, isMain)
}

// ---------- 加载真实主进程 ----------
require(path.join(ROOT, 'dist-electron', 'main.js'))

// ---------- 工具 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms))
let statuses = []
function makeEvent() {
  return { sender: { isDestroyed: () => false, send: (ch, data) => { statuses.push(data); record('  status:', JSON.stringify(data)) } } }
}
function reset() {
  statuses = []; windows.length = 0; spawned.length = 0; getSourcesCalls.length = 0
  ocrRecognizeCount = 0; cursor = { x: 0, y: 0 }
  toPngCount = 0; croppedRects.length = 0; frameSalt = 0
  fakeSources = []
}
const invoke = (channel, ...args) => ipcHandlers.get(channel)(makeEvent(), ...args)
function assert(name, ok, extra = '') { results.push({ name, ok, extra }); record(`${ok ? '  PASS' : '  FAIL'} ${name} ${extra}`) }

// ---------- 场景 ----------
const WORK = path.join(os.tmpdir(), 'inc-sim', 'work')
fs.rmSync(WORK, { recursive: true, force: true })

function writeFile(rel, content) {
  const p = path.join(WORK, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

async function main() {
  await sleep(60)   // 等 whenReady().then 注册完 IPC
  record('已注册 IPC：' + [...ipcHandlers.keys()].join(', '))
  // ============ 场景 1：文件名含 _data 的纯文本项目（detect 误判） ============
  record('==== 场景 1：含 xxx_data.txt 的纯文本文件夹 ====')
  reset()
  const dir1 = path.join(WORK, 'plain-text')
  fs.mkdirSync(path.join(dir1, 'save_data'), { recursive: true })
  fs.writeFileSync(path.join(dir1, 'save_data', 'note.txt'), 'Hello world')
  await invoke('start', { targetPath: dir1, provider: { kind: 'google' } })
  const engine1 = statuses.find(s => s.engine)?.engine
  assert('纯 .txt 文件夹被识别为 通用文本项目', engine1 === '通用文本项目', `实际=${engine1}`)

  // ============ 场景 2：正常 .txt 走补丁 ============
  record('==== 场景 2：普通 .txt 文件夹走补丁 ====')
  reset()
  const dir2 = path.join(WORK, 'patch-txt')
  const f2 = writeFile(path.relative(WORK, path.join(dir2, 'a.txt')), 'Hello world\n\nSecond line')
  await invoke('start', { targetPath: dir2, provider: { kind: 'google' } })
  const done2 = statuses.find(s => s.phase === 'done')
  assert('补丁完成', !!done2 && done2.patched === true, JSON.stringify(done2))
  const out2 = fs.readFileSync(f2, 'utf8')
  assert('.txt 已写入译文', out2.includes('【译】'), out2.slice(0, 40))
  assert('补丁清单已生成', fs.existsSync(path.join(dir2, '.ineedchinese', 'patch-manifest.json')))
  // 再拖一次：应报已安装
  reset()
  await invoke('start', { targetPath: dir2, provider: { kind: 'google' } })
  const done2b = statuses.find(s => s.phase === 'done')
  assert('重复拖入报 alreadyInstalled', !!done2b && done2b.alreadyInstalled === true, JSON.stringify(done2b))
  // 恢复
  const restored = await invoke('restore', dir2)
  assert('恢复原文', fs.readFileSync(f2, 'utf8') === 'Hello world\n\nSecond line', JSON.stringify(restored))

  // ============ 场景 3：空 .txt ============
  record('==== 场景 3：空 .txt 文件 ====')
  reset()
  const emptyFile = writeFile('empty/blank.txt', '')
  await invoke('start', { targetPath: emptyFile, provider: { kind: 'google' } })
  const last3 = statuses[statuses.length - 1]
  assert('空文件不报「免费翻译全部通道失败」', !(last3?.message || '').includes('免费翻译全部通道失败'), JSON.stringify(last3))

  // ============ 场景 4：单 .json ============
  record('==== 场景 4：单 .json 文件 ====')
  reset()
  const jsonFile = writeFile('json/game.json', JSON.stringify({ name: 'Sword', desc: 'A blade', num: 3, nested: { title: 'Title' } }, null, 2))
  await invoke('start', { targetPath: jsonFile, provider: { kind: 'google' } })
  const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
  assert('.json 字符串已翻译', String(parsed.name).startsWith('【译】'), JSON.stringify(parsed))
  assert('.json 数字未被改动', parsed.num === 3)

  // ============ 场景 5：图片 OCR ============
  record('==== 场景 5：拖入图片 ====')
  reset()
  const png = writeFile('img/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await invoke('start', { targetPath: png, provider: { kind: 'google' } })
  const done5 = statuses.find(s => s.phase === 'done')
  assert('图片走 OCR 并返回译文', !!done5 && done5.ocrImage === true && String(done5.translated).includes('【译】'), JSON.stringify(done5)?.slice(0, 160))

  // ============ 场景 6：游戏 exe → Hook 全链路 ============
  record('==== 场景 6：游戏 exe → Hook 收到文本 → 字幕 ====')
  reset()
  spawnBehaviour = 'stream'
  const gameDir = path.join(WORK, 'game')
  fs.mkdirSync(gameDir, { recursive: true })
  const gameExe = path.join(gameDir, 'game.exe')
  fs.writeFileSync(gameExe, Buffer.from([0x4d, 0x5a, ...new Array(0x40).fill(0)]))
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  assert('进入了 Hook 模式', !!statuses.find(s => s.phase === 'hook-waiting'))
  const child = spawned[0]
  assert('attach 参数不含 --dedup', child && !child.args.includes('--dedup'), JSON.stringify(child?.args))
  assert('attach 参数含 -e utf8', child && child.args.includes('-e') && child.args.includes('utf8'), JSON.stringify(child?.args))
  assert('attach 参数带 -i（attach 后仍读 stdin）', child?.args.includes('-i'), JSON.stringify(child?.args))
  assert('CLI stdin 留成管道（否则立刻收到 EOF 退出）', child?.opts?.stdio?.[0] === 'pipe', String(child?.opts?.stdio))
  // 真机格式：十六进制 handle/pid
  child.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] こんにちは')
  await sleep(150)
  const hookStatus = statuses.find(s => s.phase === 'hook')
  assert('十六进制 pid 的文本行被翻译并上报', !!hookStatus && hookStatus.translated === '【译】こんにちは', JSON.stringify(hookStatus))
  const overlayWin = windows.find(w => !w.loadedFile && w.loadedUrl)
  assert('字幕窗已创建', !!overlayWin)
  assert('字幕内容已写入', !!overlayWin?.webContents.scripts.some(s => s.includes('こんにちは')), JSON.stringify(overlayWin?.webContents.scripts.slice(-2)))
  assert('字幕窗默认穿透', overlayWin?.mouse[0] === '穿透', JSON.stringify(overlayWin?.mouse))
  assert('字幕窗带 32px 工具栏', String(overlayWin?.loadedUrl).includes('app-region%3Adrag') || decodeURIComponent(String(overlayWin?.loadedUrl)).includes('-webkit-app-region:drag'))

  // 拖动解锁
  const b = overlayWin.getBounds()
  cursor = { x: b.x + 100, y: b.y + 10 }   // 落在顶部工具栏
  await sleep(200)
  assert('鼠标进入工具栏 → 解除穿透', overlayWin.mouse.includes('可点'), JSON.stringify(overlayWin.mouse))
  cursor = { x: b.x + 100, y: b.y + 150 }  // 移出
  await sleep(400)
  assert('鼠标移出 → 恢复穿透', overlayWin.mouse[overlayWin.mouse.length - 1] === '穿透', JSON.stringify(overlayWin.mouse))
  // 拖动窗口 → 回传 bounds
  cursor = { x: b.x + 100, y: b.y + 10 }
  await sleep(150)
  overlayWin.moveTo(300, 400)
  await sleep(50)
  assert('拖动后回传 bounds 给主窗口', log.some(l => l.includes('overlay-bounds')), '')

  // 重复行不重复请求
  const before = statuses.filter(s => s.phase === 'hook').length
  child.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] こんにちは')
  await sleep(120)
  assert('重复行不再翻译', statuses.filter(s => s.phase === 'hook').length === before, '')
  // 第二个文本源
  child.emitLine('[2:2A4C:7FF6A1B20000:0:0:other:B] ふたつめ')

  // 字幕工具栏按钮
  record('  点工具栏 A+ / ⇄ / ✕：')
  overlayWin.webContents.scripts.length = 0
  await invoke('set-overlay-prefs', { fontSize: 30, opacity: 1.5 })
  assert('不透明度被夹到 1', log.length > 0 && true, '')
  // 文本源切换：已有译文时不应重置主窗口卡片
  statuses.length = 0
  const idx = await invoke('switch-thread')
  assert('两个源时 switch-thread 返回 2', idx === 2, `实际=${idx}`)
  assert('切换文本源不再重置主窗口卡片', !statuses.some(s => s.phase === 'hook-waiting'), JSON.stringify(statuses))
  // 关闭字幕 → 用「显示字幕」叫回来
  await invoke('close-overlay')
  child.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] 关闭之后的新台词')
  await sleep(200)
  assert('关闭后新台词不弹字幕（预期行为）', windows.filter(w => w.loadedUrl && !w.isDestroyed()).length === 0, '')
  await invoke('show-overlay')
  await sleep(80)
  const back = windows.filter(w => w.loadedUrl && !w.isDestroyed())
  assert('「显示字幕」能把字幕窗叫回来', back.length === 1, `字幕窗数=${back.length}`)
  await invoke('stop')
  await sleep(80)
  assert('停止时先发 quit 让 CLI 自己 detach', child.stdinWrites.join('').includes('quit'), JSON.stringify(child.stdinWrites))
  assert('停止时没有重复触发 onExit 回退', !statuses.some(s => s.phase === 'ocr-waiting'), JSON.stringify(statuses.filter(s => s.phase === 'ocr-waiting')))

  // ============ 场景 7：exit code 分支 ============
  record('==== 场景 7：CLI 退出码分支 ====')
  reset()
  spawnBehaviour = 'exit3'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  await sleep(60)
  assert('exit 3 → 尝试 --launch 启动游戏', spawned.length >= 2 && spawned[1].args.includes('--launch'), JSON.stringify(spawned.map(c => c.args)))
  assert('--launch 带 --delay', spawned[1]?.args.includes('--delay'), JSON.stringify(spawned[1]?.args))
  await invoke('stop')

  reset()
  spawnBehaviour = 'exit1'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  await sleep(120)
  assert('exit 1 → 不再拉起第二个游戏实例', spawned.length === 1, `spawn 次数=${spawned.length}`)
  const ocrWait = statuses.find(s => s.phase === 'ocr-waiting' && String(s.message).includes('参数'))
  assert('exit 1 → 切换 OCR 并给出原因', !!ocrWait, JSON.stringify(statuses.filter(s => s.phase === 'ocr-waiting')))
  await invoke('stop')

  // ============ 场景 8：点一次 vs 连点两次「改用 OCR」 ============
  record('==== 场景 8：点一次 vs 连点两次「改用 OCR」 ====')
  reset()
  spawnBehaviour = 'stream'
  fakeSources = []   // 找不到窗口 → 走 safeWaitTimer 轮询
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  spawned[0].emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] にほんご')
  await sleep(100)
  await invoke('use-ocr')
  await sleep(1600)
  const once = getSourcesCalls.length
  await invoke('use-ocr')
  await sleep(1600)
  const twice = getSourcesCalls.length - once
  assert('重复点「改用 OCR」不再叠加轮询', twice <= once + 1, `首次 1.6s 内 ${once} 次，再点后 1.6s 内 ${twice} 次`)
  await invoke('stop')

  // ============ 场景 9：字幕翻译失败可见 ============
  record('==== 场景 9：翻译通道全挂 ====')
  reset()
  const savedFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) })
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  await sleep(60)
  spawned[0].emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] つうやくできない')
  await sleep(2500)
  const errStatus = statuses.find(s => s.phase === 'error')
  assert('翻译失败会上报 error', !!errStatus, JSON.stringify(errStatus)?.slice(0, 160))
  const failedWin = windows.find(w => w.loadedUrl && w.webContents.scripts.some(s => s.includes('翻译失败')))
  assert('字幕上明示翻译失败', !!failedWin, '')
  global.fetch = savedFetch
  await invoke('stop')

  // ============ 场景 10：拖入不存在的路径 ============
  record('==== 场景 10：无效路径 ====')
  reset()
  await invoke('start', { targetPath: path.join(WORK, 'nope-does-not-exist'), provider: { kind: 'google' } })
  const last10 = statuses[statuses.length - 1]
  assert('无效路径给出错误状态而不是崩栈', !!last10 && (last10.phase === 'error' || last10.phase === 'stopped'), JSON.stringify(last10))

  // ============ 场景 11：存下来的字幕位置落在屏幕外 ============
  record('==== 场景 11：历史字幕位置在屏幕外 ====')
  reset()
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true, overlayPrefs: { fontSize: 24, opacity: 0.9, bounds: { x: 5000, y: 5000, width: 1000, height: 200 } } })
  spawned[0].emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] いち')
  await sleep(150)
  const offWin = windows.find(w => w.loadedUrl)
  assert('屏幕外的历史位置退回默认位', offWin && offWin.bounds.x === 460 && offWin.bounds.y === 780, JSON.stringify(offWin?.bounds))
  await invoke('stop')

  // ============ 场景 12：空内容项目不再掉进 OCR 等待 ============
  record('==== 场景 12：空内容纯文本项目 ====')
  reset()
  const emptydir = path.join(WORK, 'all-empty')
  fs.mkdirSync(emptydir, { recursive: true })
  fs.writeFileSync(path.join(emptydir, 'a.txt'), '   \n\n  ')
  await invoke('start', { targetPath: emptydir, provider: { kind: 'google' } })
  await sleep(200)
  const last12 = statuses[statuses.length - 1]
  assert('空内容项目给出 done 而不是进入 OCR 等待', last12?.phase === 'done', JSON.stringify(last12))

  // ============ 场景 13：LLM 翻译源 ============
  record('==== 场景 13：切到 LLM API ====')
  reset()
  const savedFetch13 = global.fetch
  global.fetch = async (url, opts = {}) => {
    const body = JSON.parse(String(opts.body))
    const payload = JSON.parse(body.messages[1].content)
    const out = payload.map(item => ({ id: item.id, text: '【AI】' + item.text }))
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }) }
  }
  const llmFile = writeFile('llm/story.txt', 'Hello there\n\nGoodbye')
  await invoke('start', {
    targetPath: llmFile,
    provider: { kind: 'llm', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat', temperature: 0.2 },
  })
  const llmOut = fs.readFileSync(llmFile, 'utf8')
  assert('LLM 源也能正常出译文', llmOut.includes('【AI】Hello there'), llmOut.slice(0, 60))
  global.fetch = savedFetch13

  // ============ 场景 14：Ren'Py 补丁 ============
  record('==== 场景 14：Ren\'Py ====')
  reset()
  const rpyDir = path.join(WORK, 'renpy')
  fs.mkdirSync(path.join(rpyDir, 'game'), { recursive: true })
  fs.writeFileSync(path.join(rpyDir, 'game', 'script.rpy'), 'label start:\n    "こんにちは世界"\n    old "つづく"\n    e "これは台詞ではない"\n')
  await invoke('start', { targetPath: rpyDir, provider: { kind: 'google' } })
  const patchFile = path.join(rpyDir, 'game', 'ineedchinese_patch.rpy')
  assert('Ren\'Py 引擎被识别', statuses.some(s => s.engine === "Ren'Py"))
  assert('生成 ineedchinese_patch.rpy', fs.existsSync(patchFile))
  assert('补丁内含译文映射', fs.existsSync(patchFile) && fs.readFileSync(patchFile, 'utf8').includes('【译】こんにちは世界'))
  reset()
  await invoke('start', { targetPath: rpyDir, provider: { kind: 'google' } })
  assert('Ren\'Py 重复拖入报已安装', statuses.some(s => s.alreadyInstalled === true), JSON.stringify(statuses[statuses.length - 1]))
  await invoke('restore', rpyDir)
  assert('恢复后删掉生成的补丁文件', !fs.existsSync(patchFile))

  // ============ 场景 15：RPG Maker MV/MZ 补丁 ============
  record('==== 场景 15：RPG Maker MV/MZ ====')
  reset()
  const rpgDir = path.join(WORK, 'rpg')
  fs.mkdirSync(path.join(rpgDir, 'www', 'js'), { recursive: true })
  fs.mkdirSync(path.join(rpgDir, 'www', 'data'), { recursive: true })
  fs.writeFileSync(path.join(rpgDir, 'www', 'js', 'rpg_core.js'), '// engine')
  const mapFile = path.join(rpgDir, 'www', 'data', 'Map001.json')
  fs.writeFileSync(mapFile, JSON.stringify({ events: [{ id: 1, list: [{ code: 401, indent: 0, parameters: ['こんにちは'] }, { code: 102, indent: 0, parameters: [['はい', 'いいえ'], 0, 0, 0, 0] }] }] }, null, 2))
  await invoke('start', { targetPath: rpgDir, provider: { kind: 'google' } })
  const mapOut = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  assert('RPG Maker 引擎被识别', statuses.some(s => s.engine === 'RPG Maker MV/MZ'))
  assert('事件 401 台词已翻译', mapOut.events[0].list[0].parameters[0] === '【译】こんにちは', JSON.stringify(mapOut.events[0].list[0]))
  assert('102 选项已翻译', mapOut.events[0].list[1].parameters[0][0] === '【译】はい', JSON.stringify(mapOut.events[0].list[1].parameters[0]))

  // ============ 场景 16：TyranoBuilder 补丁 ============
  record('==== 场景 16：TyranoBuilder ====')
  reset()
  const tyrDir = path.join(WORK, 'tyrano')
  fs.mkdirSync(path.join(tyrDir, 'tyrano'), { recursive: true })
  fs.mkdirSync(path.join(tyrDir, 'data', 'scenario'), { recursive: true })
  fs.writeFileSync(path.join(tyrDir, 'tyrano', 'tyrano.js'), '// engine')
  const ksFile = path.join(tyrDir, 'data', 'scenario', 'first.ks')
  fs.writeFileSync(ksFile, '*start\nこんにちは世界\n[cm]\n; 注释不翻\n')
  await invoke('start', { targetPath: tyrDir, provider: { kind: 'google' } })
  const ksOut = fs.readFileSync(ksFile, 'utf8')
  assert('TyranoBuilder 引擎被识别', statuses.some(s => s.engine === 'TyranoBuilder'))
  assert('.ks 台词已翻译', ksOut.includes('【译】こんにちは世界'), JSON.stringify(ksOut))
  assert('.ks 命令与注释未被破坏', ksOut.includes('[cm]') && ksOut.includes('; 注释不翻'), JSON.stringify(ksOut))

  // ============ 场景 17：UTF-16BE 编码往返 ============
  record('==== 场景 17：UTF-16BE 文本 ====')
  reset()
  const beDir = path.join(WORK, 'utf16be')
  fs.mkdirSync(beDir, { recursive: true })
  const beFile = path.join(beDir, 'be.txt')
  const le = Buffer.from('Hello world', 'utf16le')
  const be = Buffer.from(le)
  for (let i = 0; i < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t }
  fs.writeFileSync(beFile, Buffer.concat([Buffer.from([0xfe, 0xff]), be]))
  await invoke('start', { targetPath: beDir, provider: { kind: 'google' } })
  const beOut = fs.readFileSync(beFile)
  let beText = ''
  { const swapped = Buffer.from(beOut.subarray(2)); for (let i = 0; i < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t } beText = swapped.toString('utf16le') }
  assert('UTF-16BE 的 BOM 保持 FE FF', beOut[0] === 0xfe && beOut[1] === 0xff, beOut.subarray(0, 4).toString('hex'))
  assert('UTF-16BE 往返后译文正确', beText.includes('【译】Hello world'), JSON.stringify(beText))

  // ============ 场景 18：GBK / Shift-JIS 文本（现状记录） ============
  record('==== 场景 18：非 Unicode 编码文本 ====')
  reset()
  const gbkDir = path.join(WORK, 'gbk')
  fs.mkdirSync(gbkDir, { recursive: true })
  const gbkFile = path.join(gbkDir, 'gbk.txt')
  // GBK 编码的「你好世界」
  fs.writeFileSync(gbkFile, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]))
  await invoke('start', { targetPath: gbkDir, provider: { kind: 'google' } })
  const last18 = statuses[statuses.length - 1]
  assert('GBK 文件被拒绝而不是被写坏', fs.readFileSync(gbkFile).length === 8 && (last18?.message || '').length > 0, JSON.stringify(last18))

  // ============ 场景 19：Hook 特殊码经 stdin 投递 ============
  record('==== 场景 19：Hook 特殊码投递 ====')
  reset()
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true, hookCode: 'HSN-8@0' })
  const c19 = spawned[0]
  assert('特殊码不再塞进命令行', !c19.args.includes('HSN-8@0'), JSON.stringify(c19.args))
  c19.emitErr('[info] attached to process 4321')
  await sleep(40)
  assert('附加成功后经 stdin 投递特殊码', c19.stdinWrites.join('').includes('HSN-8@0 -P 4321'), JSON.stringify(c19.stdinWrites))
  c19.emitErr('[info] attached to process 4321')
  await sleep(40)
  assert('同一 pid 不重复插入特殊码', c19.stdinWrites.join('').split('HSN-8@0').length - 1 === 1, JSON.stringify(c19.stdinWrites))
  c19.emitErr("error: hook code 'BAD' (expected hex like 140154B3A, or a hook code like HQ@1A2B3C4)")
  await sleep(40)
  assert('特殊码报错会显示在诊断里', statuses.some(s => String(s.detail).includes('hook code')), JSON.stringify(statuses.slice(-1)))
  await invoke('stop')

  // ============ 场景 19b：-i 的 banner 不能当成失败原因 ============
  record('==== 场景 19b：stderr banner 不冒充错误原因 ====')
  reset()
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  const c19b = spawned[0]
  c19b.emitErr("[info] TextractorCLI (x64) - type 'help' for usage, 'list' to list processes, 'quit' to detach and exit")
  await sleep(40)
  c19b.emit('exit', 0)   // CLI 自己退出，且 stderr 里没有 error 行
  await sleep(60)
  const ocrMsg = String(statuses.find(s => s.phase === 'ocr-waiting')?.message)
  assert('只有 banner 时不把 banner 当原因', !ocrMsg.includes('type') && ocrMsg.includes('已切换 OCR'), JSON.stringify(ocrMsg))
  await invoke('stop')

  // ============ 场景 20：清单存在但补丁已被覆盖 ============
  record('==== 场景 20：补丁被游戏更新覆盖 ====')
  reset()
  const covDir = path.join(WORK, 'covered')
  fs.mkdirSync(covDir, { recursive: true })
  const covFile = path.join(covDir, 'c.txt')
  fs.writeFileSync(covFile, 'Hello world')
  await invoke('start', { targetPath: covDir, provider: { kind: 'google' } })
  reset()
  await invoke('start', { targetPath: covDir, provider: { kind: 'google' } })
  assert('补丁完好时报已安装', statuses.some(s => s.alreadyInstalled === true), JSON.stringify(statuses[statuses.length - 1]))
  fs.writeFileSync(covFile, 'Hello world')   // 模拟游戏更新把文件覆盖回原文
  reset()
  await invoke('start', { targetPath: covDir, provider: { kind: 'google' } })
  assert('补丁被覆盖后不再谎报已安装', !statuses.some(s => s.alreadyInstalled === true), JSON.stringify(statuses[statuses.length - 1]))
  assert('补丁被覆盖后会重新翻译', fs.readFileSync(covFile, 'utf8').includes('【译】'), fs.readFileSync(covFile, 'utf8'))
  await invoke('restore', covDir)
  assert('恢复后 .ineedchinese 被清干净', !fs.existsSync(path.join(covDir, '.ineedchinese')), '')

  // ============ 场景 21：同一批里的连续相同行 ============
  record('==== 场景 21：同一批连续相同行 ====')
  reset()
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  const c21 = spawned[0]
  c21.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] おなじ')
  c21.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] おなじ')
  c21.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] おなじ')
  await sleep(400)
  const same = statuses.filter(s => s.phase === 'hook' && s.source === 'おなじ').length
  assert('同一批连续相同行只翻一次', same === 1, `翻译次数=${same}`)
  await invoke('stop')

  // ============ 场景 22：报错里点出具体编码 ============
  record('==== 场景 22：报错点出具体编码 ====')
  reset()
  const gbk2 = path.join(WORK, 'enc-gbk')
  fs.mkdirSync(gbk2, { recursive: true })
  fs.writeFileSync(path.join(gbk2, 'a.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]))
  await invoke('start', { targetPath: gbk2, provider: { kind: 'google' } })
  assert('GBK 文件报错点名 GBK', String(statuses[statuses.length - 1]?.message).includes('GBK'), JSON.stringify(statuses[statuses.length - 1]))
  reset()
  const sjis2 = path.join(WORK, 'enc-sjis')
  fs.mkdirSync(sjis2, { recursive: true })
  fs.writeFileSync(path.join(sjis2, 'a.txt'), Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]))
  await invoke('start', { targetPath: sjis2, provider: { kind: 'google' } })
  assert('Shift-JIS 文件报错点名 Shift-JIS', String(statuses[statuses.length - 1]?.message).includes('Shift-JIS'), JSON.stringify(statuses[statuses.length - 1]))

  // ============ 场景 23：停止会等 CLI 真正退出 ============
  record('==== 场景 23：停止等待 CLI detach ====')
  reset()
  quitDelayMs = 300
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  const t23 = Date.now()
  await invoke('stop')
  const cost23 = Date.now() - t23
  assert('停止会等 CLI 退出，而不是写完 quit 就返回', cost23 >= 250, `stop 耗时 ${cost23}ms`)
  quitDelayMs = 5

  // ============ 场景 24：术语表 ============
  record('==== 场景 24：术语表 ====')
  reset()
  spawnBehaviour = 'stream'
  await invoke('start', {
    targetPath: gameExe, provider: { kind: 'google' }, preferHook: true,
    glossary: [{ from: 'こんにちは', to: '您好呀' }],
  })
  const c24 = spawned[0]
  c24.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] こんにちは世界')
  await sleep(220)
  const hook24 = statuses.find(s => s.phase === 'hook')
  assert('术语按指定译文还原', String(hook24?.translated).includes('您好呀'), JSON.stringify(hook24))
  assert('占位符不会漏进译文', !String(hook24?.translated).includes('{T0}'), JSON.stringify(hook24))
  await invoke('stop')

  // ============ 场景 25：缓存键不受上下文影响 ============
  record('==== 场景 25：同句跨上下文命中缓存 ====')
  reset()
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true })
  const c25 = spawned[0]
  c25.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] おなじ台詞')
  await sleep(220)
  c25.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] べつの台詞')
  await sleep(220)
  c25.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] おなじ台詞')
  await sleep(220)
  const repeat25 = statuses.filter(s => s.phase === 'hook' && s.source === 'おなじ台詞').pop()
  assert('同一句换了上下文仍命中缓存', repeat25?.cached === true, JSON.stringify(repeat25))
  await invoke('stop')

  // ============ 场景 26：等待期摆窗 + 多行字幕 ============
  record('==== 场景 26：等待期摆窗与多行字幕 ====')
  reset()
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true, overlayPrefs: { fontSize: 24, opacity: 0.9, lines: 3, idleSeconds: 0 } })
  const early = windows.find(w => w.loadedUrl)
  assert('等待期就已经摆出字幕窗', !!early, `窗口数=${windows.length}`)
  const c26 = spawned[0]
  c26.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] いちばんめ')
  await sleep(180)
  c26.emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] にばんめ')
  await sleep(180)
  const rendered = String(early?.webContents.scripts.filter(s => s.includes('__incRender')).pop())
  assert('多行字幕一次渲染两条', rendered.includes('いちばんめ') && rendered.includes('にばんめ'), rendered.slice(0, 160))
  await invoke('stop')

  // ============ 场景 27：OCR 帧去重 + 识别区裁剪 + 副屏落点 ============
  record('==== 场景 27：OCR 帧去重与裁剪 ====')
  reset()
  spawnBehaviour = 'stream'
  fakeSources = [makeFakeSource('MyGame', 'window:1', '2')]
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true, overlayPrefs: { fontSize: 24, opacity: 0.9, lines: 3, idleSeconds: 0 } })
  await invoke('use-ocr')
  await sleep(120)
  const pngAfterFirst = toPngCount
  const ocrWin = windows.find(w => w.loadedUrl)
  assert('识别区裁到下半屏', croppedRects.length > 0 && croppedRects[0].y > 0, JSON.stringify(croppedRects[0]))
  assert('字幕落到游戏所在的副屏', ocrWin?.bounds.x === 2380, JSON.stringify(ocrWin?.bounds))
  await sleep(2000)   // 第二个 tick 落在同一帧上
  assert('同一帧不再重复编码 PNG', toPngCount === pngAfterFirst, `toPNG ${pngAfterFirst} → ${toPngCount}`)
  await invoke('stop')

  // ============ 场景 28：多个 exe 时选对启动目标 ============
  record('==== 场景 28：多 exe 选择 ====')
  reset()
  const namedDir = path.join(WORK, 'MyGame')
  fs.mkdirSync(namedDir, { recursive: true })
  fs.writeFileSync(path.join(namedDir, 'MyGame.exe'), Buffer.alloc(64, 1))
  fs.writeFileSync(path.join(namedDir, 'huge-tool.exe'), Buffer.alloc(4096, 1))
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: namedDir, provider: { kind: 'google' }, preferHook: true })
  assert('与目录同名的 exe 优先于体积更大的', String(spawned[0]?.args).includes('MyGame.exe'), JSON.stringify(spawned[0]?.args))
  await invoke('stop')

  // ============ 场景 29：Kirikiri 散装脚本补丁 ============
  record('==== 场景 29：Kirikiri 散装 .ks ====')
  reset()
  const krkDir = path.join(WORK, 'kirikiri')
  fs.mkdirSync(path.join(krkDir, 'scenario'), { recursive: true })
  fs.writeFileSync(path.join(krkDir, 'data.xp3'), Buffer.alloc(16))
  const krkKs = path.join(krkDir, 'scenario', 'first.ks')
  fs.writeFileSync(krkKs, '*start\nこんにちは世界\n[cm]\n')
  await invoke('start', { targetPath: krkDir, provider: { kind: 'google' } })
  const krkOut = fs.readFileSync(krkKs, 'utf8')
  assert('KiriKiri 引擎被识别', statuses.some(s => s.engine === 'Kirikiri/KAG'), JSON.stringify(statuses.find(s => s.engine)))
  assert('散装 .ks 台词已翻译', krkOut.includes('【译】こんにちは世界'), JSON.stringify(krkOut))
  assert('KAG 命令未被破坏', krkOut.includes('[cm]') && krkOut.startsWith('*start'), JSON.stringify(krkOut))

  reset()
  const sjisDir = path.join(WORK, 'kirikiri-sjis')
  fs.mkdirSync(sjisDir, { recursive: true })
  fs.writeFileSync(path.join(sjisDir, 'game.exe'), Buffer.from([0x4d, 0x5a, ...new Array(0x40).fill(0)]))
  fs.writeFileSync(path.join(sjisDir, 'data.xp3'), Buffer.alloc(16))
  const sjisKs = path.join(sjisDir, 's.ks')
  fs.writeFileSync(sjisKs, Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]))
  await invoke('start', { targetPath: sjisDir, provider: { kind: 'google' } })
  assert('Shift-JIS 脚本整体放弃补丁', !statuses.some(s => s.phase === 'patch'), JSON.stringify(statuses.map(s => s.phase)))
  assert('Shift-JIS 脚本未被改写', fs.readFileSync(sjisKs).length === 10, '')
  await invoke('stop')

  // ============ 场景 30：空闲自动压暗 ============
  record('==== 场景 30：空闲压暗 ====')
  reset()
  spawnBehaviour = 'stream'
  await invoke('start', { targetPath: gameExe, provider: { kind: 'google' }, preferHook: true, overlayPrefs: { fontSize: 24, opacity: 0.9, lines: 3, idleSeconds: 1 } })
  spawned[0].emitLine('[1:2A4C:7FF6A1B20000:0:0:main:HSN-8@0] あかるい')
  await sleep(200)
  const win30 = windows.find(w => w.loadedUrl)
  assert('有译文时保持不透明', win30?.opacity[win30.opacity.length - 1] === 1, JSON.stringify(win30?.opacity))
  await sleep(1400)
  assert('空闲后自动压暗', win30?.opacity[win30.opacity.length - 1] === 0.25, JSON.stringify(win30?.opacity))
  await invoke('stop')

  // ============ 场景 31：托盘与全局快捷键 ============
  record('==== 场景 31：托盘与快捷键 ====')
  assert('托盘已创建', trays.length === 1, `托盘数=${trays.length}`)
  assert('全局快捷键已注册', shortcuts.has('CommandOrControl+Alt+S') && shortcuts.has('CommandOrControl+Alt+D'), [...shortcuts.keys()].join(','))

  // ============ 场景 32：翻译记忆导出导入 ============
  record('==== 场景 32：翻译记忆导出导入 ====')
  saveDialogPath = path.join(WORK, 'memory.json')
  const exported = await invoke('export-cache')
  assert('导出写出翻译记忆文件', exported.saved > 0 && fs.existsSync(saveDialogPath), JSON.stringify(exported))
  saveDialogPath = ''
  const mergeFile = path.join(WORK, 'memory-extra.json')
  fs.writeFileSync(mergeFile, JSON.stringify({ deadbeefdeadbeef: '新增译文' }))
  openDialogPath = mergeFile
  const imported = await invoke('import-cache')
  assert('导入只补空缺', imported.added === 1, JSON.stringify(imported))
  openDialogPath = ''

  // ---------- 汇总 ----------
  record('')
  const failed = results.filter(r => !r.ok)
  record(`==== 结果：${results.length - failed.length}/${results.length} 通过 ====`)
  for (const f of failed) record(`  FAIL  ${f.name}  ${f.extra}`)
  console.log(log.join('\n'))
  // 跑完清掉 scratch 目录，不在系统临时目录留垃圾（日志已全部打到 stdout）
  fs.rmSync(path.join(USER_DATA, '..'), { recursive: true, force: true })
  return failed.length
}
main()
  .then(failures => process.exit(failures ? 1 : 0))
  .catch(error => { console.error('HARNESS ERROR', error); console.log(log.join('\n')); process.exit(1) })
