import { useEffect, useState } from 'react'

type LlmConfig = { baseUrl: string; apiKey: string; model: string; temperature: number }

const defaultLlm: LlmConfig = { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', temperature: 0.2 }

function load<T>(key: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') } } catch { return fallback }
}

export default function App() {
  const [target, setTarget] = useState<string>()
  const [status, setStatus] = useState<Status>()
  const [dragging, setDragging] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [providerKind, setProviderKind] = useState<'google' | 'llm'>(() => localStorage.getItem('provider-kind') === 'llm' ? 'llm' : 'google')
  const [llm, setLlm] = useState<LlmConfig>(() => load('llm-config', defaultLlm))
  const [preferHook, setPreferHook] = useState(() => localStorage.getItem('engine-preference') === 'hook')
  const [tab, setTab] = useState<'file' | 'text'>('file')
  const [pasteText, setPasteText] = useState('')
  const [pasteResult, setPasteResult] = useState('')
  const [pasteBusy, setPasteBusy] = useState(false)

  const provider: ProviderSettings = providerKind === 'google' ? { kind: 'google' } : { kind: 'llm', ...llm }
  const busy = status?.phase === 'inspect' || status?.phase === 'patch' || status?.phase === 'hook' || status?.phase === 'hook-waiting' || status?.phase === 'ocr' || status?.phase === 'ocr-waiting'

  useEffect(() => window.translator.onStatus(setStatus), [])
  useEffect(() => localStorage.setItem('provider-kind', providerKind), [providerKind])
  useEffect(() => localStorage.setItem('llm-config', JSON.stringify(llm)), [llm])
  useEffect(() => localStorage.setItem('engine-preference', preferHook ? 'hook' : 'patch'), [preferHook])

  async function begin(path?: string) {
    if (!path) return
    if (providerKind === 'llm' && !llm.apiKey) { setSettingsOpen(true); setStatus({ phase: 'error', message: '使用 LLM 翻译前请先填写 API Key' }); return }
    setTarget(path)
    setStatus({ phase: 'inspect' })
    try { await window.translator.start({ targetPath: path, provider, preferHook }) }
    catch (error) { setStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) }) }
  }

  async function stop() {
    await window.translator.stop()
  }

  async function restore() {
    if (!target) return
    try {
      const result = await window.translator.restore(target)
      setStatus({ phase: 'stopped', message: `已恢复 ${result.restored} 个原始文件` })
    } catch (error) { setStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) }) }
  }

  async function translatePaste() {
    const text = pasteText.trim()
    if (!text || pasteBusy) return
    if (providerKind === 'llm' && !llm.apiKey) { setSettingsOpen(true); setPasteResult('使用 LLM 翻译前请先在设置里填写 API Key'); return }
    setPasteBusy(true)
    setPasteResult('翻译中…')
    try {
      const result = await window.translator.translateText({ text, provider })
      setPasteResult(result.translated)
    } catch (error) { setPasteResult(error instanceof Error ? error.message : String(error)) }
    finally { setPasteBusy(false) }
  }

  const progress = status?.phase === 'patch' && status.pending ? Math.round((status.done || 0) / status.pending * 100) : undefined

  return (
    <div
      className={`app ${dragging ? 'dragging' : ''}`}
      onDragOver={event => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault()
        setDragging(false)
        const file = event.dataTransfer.files[0]
        if (file) begin(window.translator.pathForFile(file))
      }}
    >
      <header className="header">
        <span className="logo">INEEDCHINESE</span>
        <button className="gear" title="设置" onClick={() => setSettingsOpen(!settingsOpen)}>⚙</button>
      </header>

      <nav className="tabs">
        <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>拖入文件</button>
        <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>粘贴文本</button>
      </nav>

      {tab === 'text' ? (
        <main className="pastePanel">
          <textarea
            placeholder="粘贴要翻译的文本…"
            value={pasteText}
            onChange={event => setPasteText(event.target.value)}
          />
          <button className="button primary" disabled={!pasteText.trim() || pasteBusy} onClick={translatePaste}>
            {pasteBusy ? '翻译中…' : '翻译'}
          </button>
          {pasteResult && <div className="pasteResult">{pasteResult}</div>}
        </main>
      ) : (
      <main className="dropzone" onClick={() => { if (!busy) window.translator.chooseTarget().then(begin) }}>
        {!status || status.phase === 'stopped' ? (
          <div className="hint">
            {status?.message && <p className="lastMessage">{status.message}</p>}
            <p className="big">把文件拖到这里，自动翻译</p>
            <p className="small">.exe · .txt · .json · .png · .jpg · .jpeg · .webp · .bmp</p>
            <p className="small dim">
              点击选择文件 · <a className="link" onClick={event => { event.stopPropagation(); window.translator.chooseTarget('folder').then(begin) }}>选择文件夹</a>
            </p>
          </div>
        ) : status.phase === 'inspect' ? (
          <div className="hint"><p className="big">正在识别…</p>{status.engine && <p className="small">{status.engine}</p>}</div>
        ) : status.phase === 'patch' ? (
          <div className="hint wide" onClick={event => event.stopPropagation()}>
            <p className="big">正在翻译 {status.engine}</p>
            <p className="small dim">{status.file}</p>
            <div className="bar"><div style={{ width: `${progress ?? 0}%` }} /></div>
            <p className="small">{status.done ?? 0} / {status.pending ?? 0} 条{status.total && status.total > 1 ? ` · 文件 ${status.current}/${status.total}` : ''}</p>
            <button className="button danger" onClick={stop}>停止</button>
          </div>
        ) : status.phase === 'hook-waiting' ? (
          <div className="hint" onClick={event => event.stopPropagation()}>
            <p className="big">{status.engine || '文本 Hook'}</p>
            <p className="small">{status.message || '正在注入文本 Hook…'}</p>
            <div className="row">
              <button className="button" onClick={() => window.translator.useOcr()}>改用 OCR</button>
              <button className="button danger" onClick={stop}>停止</button>
            </div>
          </div>
        ) : status.phase === 'hook' ? (
          <div className="hint wide" onClick={event => event.stopPropagation()}>
            <p className="big">字幕运行中 <span className="live">●</span> <span className="tag">Hook</span></p>
            {status.source && <p className="source">{status.source}</p>}
            {status.translated && <p className="translated">{status.translated}</p>}
            <div className="row">
              <button className="button" onClick={() => window.translator.switchThread()}>切换文本源</button>
              <button className="button" onClick={() => window.translator.useOcr()}>改用 OCR</button>
              <button className="button danger" onClick={stop}>停止</button>
            </div>
          </div>
        ) : status.phase === 'ocr-waiting' ? (
          <div className="hint" onClick={event => event.stopPropagation()}>
            <p className="big">{status.engine || 'OCR 字幕'}</p>
            <p className="small">{status.message || '正在定位游戏窗口…'}</p>
            <button className="button danger" onClick={stop}>停止</button>
          </div>
        ) : status.phase === 'ocr' ? (
          <div className="hint wide" onClick={event => event.stopPropagation()}>
            <p className="big">字幕运行中 <span className="live">●</span></p>
            {status.source && <p className="source">{status.source}</p>}
            {status.translated && <p className="translated">{status.translated}</p>}
            <button className="button danger" onClick={stop}>停止</button>
          </div>
        ) : status.phase === 'done' ? (
          <div className="hint wide" onClick={event => event.stopPropagation()}>
            <p className="big">✓ {status.engine || '完成'}</p>
            <p className="small">{status.message}</p>
            {status.translated && (
              <>
                <div className="pasteResult">{status.translated}</div>
                <div className="row">
                  <button className="button" onClick={() => navigator.clipboard.writeText(status.translated || '')}>复制译文</button>
                  <button className="button primary" onClick={() => setStatus(undefined)}>翻译下一项</button>
                </div>
              </>
            )}
            {!status.translated && (
              <div className="row">
                {status.patched && <button className="button" onClick={restore}>恢复原文</button>}
                <button className="button primary" onClick={() => setStatus(undefined)}>翻译下一项</button>
              </div>
            )}
          </div>
        ) : status.phase === 'error' ? (
          <div className="hint" onClick={event => event.stopPropagation()}>
            <p className="big error">出错了</p>
            <p className="small">{status.message}</p>
            <div className="row">
              <button className="button primary" onClick={() => begin(target)}>重试</button>
              <button className="button" onClick={() => setStatus(undefined)}>返回</button>
            </div>
          </div>
        ) : null}
      </main>
      )}

      {settingsOpen && (
        <aside className="drawer">
          <div className="drawerHeader">
            <b>设置</b>
            <button className="gear" onClick={() => setSettingsOpen(false)}>✕</button>
          </div>
          <p className="label">翻译源</p>
          <label className="radio">
            <input type="radio" checked={providerKind === 'google'} onChange={() => setProviderKind('google')} />
            <span><b>免费翻译</b><small>开箱即用，多个通道自动切换</small></span>
          </label>
          <label className="radio">
            <input type="radio" checked={providerKind === 'llm'} onChange={() => setProviderKind('llm')} />
            <span><b>LLM API</b><small>DeepSeek 等 OpenAI 兼容服务，质量更好</small></span>
          </label>
          {providerKind === 'llm' && (
            <div className="fields">
              <label>API 地址<input value={llm.baseUrl} onChange={event => setLlm({ ...llm, baseUrl: event.target.value })} /></label>
              <label>模型<input value={llm.model} onChange={event => setLlm({ ...llm, model: event.target.value })} /></label>
              <label>API Key<input type="password" placeholder="必填" value={llm.apiKey} onChange={event => setLlm({ ...llm, apiKey: event.target.value })} /></label>
              <label>温度<input type="number" min="0" max="2" step="0.1" value={llm.temperature} onChange={event => setLlm({ ...llm, temperature: Number(event.target.value) })} /></label>
            </div>
          )}
          <p className="label">引擎处理</p>
          <label className="radio">
            <input type="radio" checked={!preferHook} onChange={() => setPreferHook(false)} />
            <span><b>中文补丁</b><small>永久生效，游戏内原生中文（推荐）</small></span>
          </label>
          <label className="radio">
            <input type="radio" checked={preferHook} onChange={() => setPreferHook(true)} />
            <span><b>实时 Hook</b><small>边玩边翻，外挂字幕，马上能玩</small></span>
          </label>
          <p className="note">翻译结果会缓存到本地，重复内容不再消耗请求。</p>
        </aside>
      )}
    </div>
  )
}
