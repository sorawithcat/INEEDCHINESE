import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export type HookText = { handle: string; pid: number; thread: string; text: string }

export type HookHandlers = {
  onText: (event: HookText) => void
  /** CLI 的 stderr 一行（[info] / error: ...）。必须消费：不读会把管道写满并阻塞子进程 */
  onLog: (line: string) => void
  /** 子进程结束；code 见 CLI 约定：1 参数错 2 注入失败 3 未找到进程 4 detach 超时 */
  onExit: (code: number | null) => void
}

/** 启动游戏后等待注入的毫秒数（CLI 默认 3000，吉里吉里这类引擎加载慢时容易注入失败） */
export const LAUNCH_DELAY_MS = 8000

// 全局参数：交互模式（attach 后继续读 stdin，特殊码要靠 stdin 投递）、显式 UTF-8 输出、
// 排除 Console 线程避免宿主消息混进字幕并抢走当前文本源。
// 不传 --dedup：Textractor 的重复过滤（TextThread::filterRepetition）会误吞正常台词，
// 重复行的拦截由 hookLastForwarded 与翻译缓存负责。
const GLOBAL_ARGS = ['-i', '-e', 'utf8', '--no-console']

/** CLI 附加成功后会往 stderr 写 `attached to process <pid>`，用它拿到 pid 才能投投特殊码 */
const ATTACHED_RE = /attached to process (\d+)/i

/** 读 PE 头判断 exe 位数（hook 注入必须用相同位数的 CLI） */
export async function exeArch(file: string): Promise<'x86' | 'x64'> {
  const handle = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(0x40)
    await handle.read(head, 0, head.length, 0)
    if (head.readUInt16LE(0) !== 0x5a4d) return 'x64'
    const peOffset = head.readUInt32LE(0x3c)
    const pe = Buffer.alloc(6)
    await handle.read(pe, 0, pe.length, peOffset)
    return pe.readUInt16LE(4) === 0x14c ? 'x86' : 'x64'
  } finally { await handle.close() }
}

function cliPath(arch: 'x86' | 'x64') {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'textractor')
    : path.join(process.cwd(), 'resources', 'textractor')
  return path.join(root, arch, 'TextractorCLI.exe')
}

export class HookSession {
  private child?: ChildProcess
  private buffer = ''
  private errorBuffer = ''
  /** 主动 kill 时置位：不要再回调 onExit，否则会被当成「CLI 自己退出」再触发一次回退 */
  private intentional = false
  private exited = false
  private hookCode = ''
  private hookedPids = new Set<number>()

  constructor(private arch: 'x86' | 'x64') {}

  /**
   * 优先 attach 已运行的游戏；失败（进程未运行）则由调用方改用 launch。
   * hookCode 不走命令行：实测 `attach -N xxx HSN-8@0` 会把特殊码当成独立命令而报
   * 「no attached process」，所以改为等 stderr 报出 pid 后再用 CLI 记录的 `<HookCode> -P <pid>` 投递。
   */
  attach(processName: string, handlers: HookHandlers, hookCode?: string) {
    this.hookCode = hookCode?.trim() || ''
    this.start([...GLOBAL_ARGS, 'attach', '-N', processName], handlers)
  }

  /** 游戏未运行时由 CLI 启动并附加 */
  launch(executable: string, handlers: HookHandlers, hookCode?: string, delayMs = LAUNCH_DELAY_MS) {
    this.hookCode = hookCode?.trim() || ''
    this.start([...GLOBAL_ARGS, '--launch', executable, '--delay', String(delayMs)], handlers)
  }

  private start(args: string[], handlers: HookHandlers) {
    const cli = cliPath(this.arch)
    this.intentional = false
    this.exited = false
    // stdin 必须留成管道：CLI 是按「从 stdin 读命令」的常驻宿主设计的，
    // 给它 /dev/null 会立刻收到 EOF 而提前退出；留成管道也让我们能用 quit 让它优雅 detach。
    this.child = spawn(cli, args, { cwd: path.dirname(cli), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    // 先记退出状态，kill() 才知道还有没有等下去的必要
    this.child.on('exit', () => { this.exited = true })
    // error 与 exit 都会触发，只回调一次防止误判
    let fired = false
    const exitOnce = (code: number | null) => { if (!fired && !this.intentional) { fired = true; handlers.onExit(code) } }
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop()!
      for (const line of lines) {
        const parsed = parseLine(line)
        if (parsed) handlers.onText(parsed)
      }
    })
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => {
      this.errorBuffer += chunk
      const lines = this.errorBuffer.split('\n')
      this.errorBuffer = lines.pop()!
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        handlers.onLog(text)
        this.insertHookIfAttached(text)
      }
    })
    this.child.on('error', () => exitOnce(2))
    this.child.on('exit', code => exitOnce(code))
  }

  /** 读到附加成功就把用户填的特殊码作为独立命令写进 stdin（每个 pid 只插一次） */
  private insertHookIfAttached(line: string) {
    if (!this.hookCode) return
    const pid = Number(line.match(ATTACHED_RE)?.[1])
    if (!pid || this.hookedPids.has(pid)) return
    this.hookedPids.add(pid)
    try { this.child?.stdin?.write(`${this.hookCode} -P ${pid}\n`) } catch { /* 管道已关闭 */ }
  }

  /**
   * 先发 quit 让 CLI 自己 detach 再退出；直接 TerminateProcess 会把 texthook.dll
   * 连同指向已关闭管道的钩子留在游戏进程里。
   * 返回的 Promise 在 CLI 真正退出（或 1.2 秒兜底强杀）后 resolve，调用方可以等它，
   * 否则退出应用时会立刻被 app.exit 掐断优雅流程。
   */
  kill(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child || this.intentional) return Promise.resolve()
    this.intentional = true
    if (this.exited) return Promise.resolve()
    return new Promise<void>(resolve => {
      const force = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } resolve() }, 1200)
      force.unref?.()
      child.once('exit', () => { clearTimeout(force); resolve() })
      try { child.stdin?.write('quit\n'); child.stdin?.end() } catch { clearTimeout(force); resolve() }
    })
  }
}

/** CLI 退出码的中文解释 */
export function hookExitReason(code: number | null): string {
  switch (code) {
    case 0: return '文本 Hook 已退出'
    case 1: return 'Hook 参数错误，特殊码格式可能不对'
    case 2: return 'Hook 注入失败，可能被杀毒软件拦截'
    case 3: return '未找到游戏进程'
    case 4: return 'Hook 卸载超时'
    default: return `Hook 异常退出（代码 ${code ?? '未知'}）`
  }
}

/**
 * 解析 `[handle:pid:addr:ctx:ctx2:thread:hookcode] 文本`
 *
 * handle/pid/addr/ctx/ctx2 全部是十六进制（CLI 用 %I64X / %I32X 格式化，见其 help 的输出说明），
 * 早期实现按十进制匹配会在 pid 含 A-F 时整行丢弃，导致永远收不到文本。
 * hookcode 本身可能带冒号（如 HB4@4A0123:gdi.dll:GetTextOutA），所以先按 ] 切出头部再取字段。
 */
function parseLine(line: string): HookText | undefined {
  const match = line.match(/^\[([^\]]*)\]\s?(.*)$/)
  if (!match) return undefined
  const fields = match[1].split(':')
  if (fields.length < 6) return undefined
  const text = match[2].trim()
  if (!text) return undefined
  return { handle: fields[0], pid: Number.parseInt(fields[1], 16), thread: fields[5], text }
}
