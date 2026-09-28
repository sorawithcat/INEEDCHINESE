// 拉取 Textractor (Chenx221 fork) 的 CLI 最小文件集到 resources/textractor/{x86,x64}
// 用法：npm run setup:textractor
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const VERSION = '260927'
const ARCHIVE_URL = `https://github.com/Chenx221/Textractor/releases/download/v${VERSION}/Textractor_${VERSION}.7z`
const SEVEN_ZR_URL = 'https://www.7-zip.org/a/7zr.exe'
const LICENSE_URL = 'https://raw.githubusercontent.com/Chenx221/Textractor/master/LICENSE'
const FILES = ['TextractorCLI.exe', 'texthook.dll', 'LoaderDll.dll', 'LocaleEmulator.dll']

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'resources', 'textractor')

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${url}`)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const stream = createWriteStream(destination)
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    stream.write(value)
  }
  await new Promise((resolve, reject) => { stream.end(); stream.on('finish', resolve); stream.on('error', reject) })
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'textractor-'))
try {
  const sevenzr = path.join(temp, '7zr.exe')
  const archive = path.join(temp, 'textractor.7z')
  console.log('下载 7zr 与 Textractor', VERSION, '…')
  await download(SEVEN_ZR_URL, sevenzr)
  await download(ARCHIVE_URL, archive)
  const names = ['x86', 'x64'].flatMap(arch => FILES.map(file => `${arch}/${file}`))
  await run(sevenzr, ['x', archive, `-o${temp}/out`, ...names, '-y'])
  for (const arch of ['x86', 'x64']) {
    for (const file of FILES) {
      await fs.mkdir(path.join(target, arch), { recursive: true })
      await fs.copyFile(path.join(temp, 'out', arch, file), path.join(target, arch, file))
    }
  }
  await download(LICENSE_URL, path.join(target, 'LICENSE.txt'))
  console.log('完成：', target)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
