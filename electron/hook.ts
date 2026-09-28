import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export type HookText = { handle: string; pid: number; thread: string; text: string }

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

  constructor(private arch: 'x86' | 'x64') {}

  /**
   * 优先 attach 已运行的游戏；失败（进程未运行）则由调用方改用 launch。
   * onText 回调每行钩取文本；onExit 在进程结束时回调（exitCode 3 = 未找到进程）。
   */
  attach(processName: string, onText: (event: HookText) => void, onExit: (code: number | null) => void) {
    this.start(['attach', '-N', processName, '--dedup'], onText, onExit)
  }

  launch(executable: string, onText: (event: HookText) => void, onExit: (code: number | null) => void) {
    this.start(['--launch', executable, '--dedup'], onText, onExit)
  }

  private start(args: string[], onText: (event: HookText) => void, onExit: (code: number | null) => void) {
    const cli = cliPath(this.arch)
    this.child = spawn(cli, args, { cwd: path.dirname(cli), windowsHide: true })
    // error 与 exit 都会触发，只回调一次防止误判
    let fired = false
    const exitOnce = (code: number | null) => { if (!fired) { fired = true; onExit(code) } }
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop()!
      for (const line of lines) {
        const parsed = parseLine(line)
        if (parsed) onText(parsed)
      }
    })
    this.child.on('error', () => exitOnce(2))
    this.child.on('exit', code => exitOnce(code))
  }

  kill() {
    this.child?.kill()
    this.child = undefined
  }
}

/** 解析 `[handle:pid:addr:ctx:ctx2:thread:hookcode] 文本` */
function parseLine(line: string): HookText | undefined {
  const match = line.match(/^\[(\d+):(\d+):[0-9A-Fa-f]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:([^:]*):[^\]]*]\s?(.*)$/)
  if (!match) return undefined
  const text = match[4].trim()
  if (!text) return undefined
  return { handle: match[1], pid: Number(match[2]), thread: match[3], text }
}
