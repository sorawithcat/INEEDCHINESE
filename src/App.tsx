import { type ReactNode, useEffect, useMemo, useState } from 'react'

type Profile = { name: string; prompt: string }
type Mode = 'patch' | 'safe'
type IconName = 'brand' | 'folder' | 'spark' | 'scan' | 'game' | 'settings' | 'shield' | 'stop' | 'play' | 'file' | 'chevron' | 'restore' | 'check'

const defaults: Profile[] = [
  { name: '通用应用', prompt: '将界面文本自然、准确地翻译为简体中文。术语前后一致，按钮文字简短。' },
  { name: '剧情游戏', prompt: '将游戏文本翻译为自然的简体中文。保留人物语气、世界观术语和情绪，不擅自增删内容。' },
  { name: '工具软件', prompt: '将软件界面翻译为专业简洁的简体中文，优先采用常见计算机术语。' },
]

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  const paths: Record<IconName, ReactNode> = {
    brand: <><path d="M5 5h6v6H5zM13 13h6v6h-6z"/><path d="M14 5h5v5M5 14v5h5"/></>,
    folder: <><path d="M3 7.5h7l2 2h9v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 9.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5"/></>,
    spark: <><path d="m12 3 1.5 4.2L18 9l-4.5 1.8L12 15l-1.5-4.2L6 9l4.5-1.8z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/></>,
    scan: <><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/></>,
    game: <><path d="M8 6h8a6 6 0 0 1 5.5 8.4l-1.3 3a2 2 0 0 1-3.4.5L15 16h-6l-1.8 1.9a2 2 0 0 1-3.4-.5l-1.3-3A6 6 0 0 1 8 6Z"/><path d="M7 10v4M5 12h4M16 11h.01M18 13h.01"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.8-1L14.4 3h-4.8l-.4 3.1a8 8 0 0 0-1.8 1l-2.4-1-2 3.4L5.1 11a7 7 0 0 0 0 2L3 14.5l2 3.4 2.4-1a8 8 0 0 0 1.8 1l.4 3.1h4.8l.4-3.1a8 8 0 0 0 1.8-1l2.4 1 2-3.4-2.1-1.5a7 7 0 0 0 .1-1Z"/></>,
    shield: <path d="M12 3 5 6v5c0 4.8 2.8 8.2 7 10 4.2-1.8 7-5.2 7-10V6zM9 12l2 2 4-5"/>,
    stop: <rect x="7" y="7" width="10" height="10" rx="2"/>,
    play: <path d="m8 5 11 7-11 7z"/>,
    file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 13h6M9 17h4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    restore: <><path d="M4 10a8 8 0 1 1 2 7"/><path d="M4 4v6h6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
  }
  return <svg {...common}>{paths[name]}</svg>
}

function loadStored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || '') as T } catch { return fallback }
}

export default function App() {
  const bridge = window.translator
  const [inspection, setInspection] = useState<Inspection>()
  const [mode, setMode] = useState<Mode>('safe')
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [patchInstalled, setPatchInstalled] = useState(false)
  const [message, setMessage] = useState('拖入游戏后将自动识别引擎与处理方式')
  const [progress, setProgress] = useState<TranslationProgress>()
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>()
  const [profiles, setProfiles] = useState<Profile[]>(() => loadStored('profiles', defaults))
  const [profile, setProfile] = useState(1)
  const [config, setConfig] = useState(() => loadStored('ai-config', { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', temperature: 0.2 }))

  useEffect(() => localStorage.setItem('profiles', JSON.stringify(profiles)), [profiles])
  useEffect(() => localStorage.setItem('ai-config', JSON.stringify(config)), [config])
  useEffect(() => bridge?.onProgress(setProgress), [bridge])
  useEffect(() => bridge?.onRuntimeStatus(status => { setRuntimeStatus(status); if (status.message) setMessage(status.message); if (status.state === 'stopped') setRunning(false) }), [bridge])

  const patchSupported = useMemo(() => {
    if (!inspection) return false
    if (['Kirikiri/KAG', 'Godot', 'RPG Maker VX Ace', 'Wolf RPG', 'RPG Developer Bakin'].includes(inspection.type)) return false
    return inspection.type === 'Ren\'Py' || inspection.type === 'RPG Maker MV/MZ' || inspection.type === 'TyranoBuilder' || inspection.type.startsWith('Unity') || inspection.files.length > 0
  }, [inspection])

  const route = useMemo(() => {
    if (!inspection) return { title: '等待检测', detail: '选择目标后自动决定，无需手动挑选引擎' }
    if (mode === 'safe') return { title: '窗口 OCR · 外部字幕', detail: '自动启动并定位游戏窗口，不写入游戏目录' }
    if (inspection.type === 'Ren\'Py') return { title: 'Ren’Py 直接文本补丁', detail: '生成独立补丁脚本，安装前自动备份并校验' }
    if (inspection.type === 'RPG Maker MV/MZ') return { title: 'RPG Maker 数据补丁', detail: '按数据库字段与事件指令提取并替换文本' }
    if (inspection.type === 'TyranoBuilder') return { title: 'Tyrano 剧本补丁', detail: '翻译未封包 KS 剧本，保留标签与控制指令' }
    if (inspection.type.startsWith('Unity')) return { title: 'XUnity 游戏内替换', detail: '自动接入已安装的 XUnity，直接替换界面文本' }
    if (inspection.files.length) return { title: '通用文本资源补丁', detail: '处理 TXT / JSON，并保留可回滚备份' }
    return { title: '当前引擎不支持安全补丁', detail: '请使用无注入字幕模式' }
  }, [inspection, mode])

  async function inspect(path?: string) {
    if (!path || !bridge) return
    if (running || busy) await stop()
    setMessage('正在分析游戏结构…'); setPatchInstalled(false); setProgress(undefined)
    try { const result = await bridge.inspectTarget(path); const status = await bridge.patchStatus(path); setInspection(result); setPatchInstalled(status.installed); setMessage(status.installed ? `已识别 ${result.type}，当前已安装 ${status.files} 个补丁文件` : `已识别 ${result.type}，翻译方式已自动配置`) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }

  async function start() {
    if (!inspection) return setMessage('请先拖入游戏或选择目标')
    if (!config.apiKey) return setMessage('请先填写 API Key')
    if (mode === 'patch' && !patchSupported) return setMessage(`${inspection.type} 暂不支持安全补丁，请选择无注入字幕`)
    setBusy(true); setProgress(undefined); setRuntimeStatus(undefined)
    try {
      if (mode === 'patch') {
        setMessage('正在提取并翻译可安全替换的文本…')
        const result = await bridge.createPatch({ targetPath: inspection.target, prompt: profiles[profile].prompt, config })
        setMessage(result.message); setPatchInstalled(!result.runtime); setRunning(result.runtime)
      } else {
        setMessage('正在自动定位游戏窗口…')
        await bridge.startSafeMode({ targetPath: inspection.target, prompt: profiles[profile].prompt, config, contextSize: 5 })
        setRunning(true)
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setRunning(false) }
    finally { setBusy(false) }
  }

  async function stop() {
    await bridge?.stopAutoMode(); setRunning(false); setBusy(false); setRuntimeStatus(undefined); setMessage('翻译会话已停止')
  }

  async function restore() {
    if (!inspection) return
    try { const result = await bridge.restorePatch(inspection.target); setPatchInstalled(false); setMessage(`已恢复 ${result.restored} 个原始文件`) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }

  return <div className="appShell">
    <nav className="rail"><div className="brandMark"><Icon name="brand" size={24}/></div><button className="railButton active" title="工作台"><Icon name="game"/></button><div className="railSpacer"/><button className="railButton" title="设置"><Icon name="settings"/></button></nav>

    <section className="workspace">
      <header className="topbar"><div><div className="eyebrow">AUTOMATIC LOCALIZATION</div><h1>INEED<span>CHINESE</span></h1></div><div className="topStatus"><span className={config.apiKey ? 'statusDot online' : 'statusDot'}/><div><b>{config.apiKey ? 'AI 已配置' : '等待配置 AI'}</b><small>{config.model}</small></div></div></header>

      <div className={`targetPanel ${inspection ? 'hasTarget' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; inspect(file ? bridge?.pathForFile(file) : undefined) }}>
        <div className="targetIcon"><Icon name={inspection ? 'game' : 'folder'} size={26}/></div><div className="targetCopy"><div className="panelLabel">翻译目标</div><h2>{inspection ? inspection.type : '拖入游戏 EXE 或游戏目录'}</h2><p>{inspection ? inspection.target : '系统将自动识别引擎、文件结构和最合适的处理方式'}</p></div>
        {inspection && <div className="targetStats"><span><b>{inspection.totalFiles}</b> 文件</span><span><b>{inspection.files.length}</b> 文本资源</span></div>}
        <button className="selectButton" onClick={async () => inspect(await bridge?.chooseTarget())}><Icon name="folder"/>{inspection ? '更换目标' : '选择目标'}</button>
      </div>

      <div className="sectionHeading"><div><span className="sectionIndex">01</span><div><h3>选择最终效果</h3><p>只选择是否修改游戏，具体引擎与翻译方式由系统自动处理</p></div></div>{inspection && <span className="recommendation"><Icon name="spark" size={14}/> 已识别 {inspection.type}</span>}</div>

      <div className="autoModeGrid">
        <button className={`autoModeCard ${mode === 'patch' ? 'selected' : ''}`} disabled={running || busy} onClick={() => setMode('patch')}><span className="autoModeIcon patch"><Icon name="file" size={25}/></span><span className="autoModeCopy"><span className="autoModeTop"><b>中文补丁</b><em>直接替换</em></span><strong>像原生汉化一样显示中文</strong><small>自动提取、翻译、备份并安装；支持一键恢复原文。</small><span className="modeBenefits"><i><Icon name="check" size={12}/> 游戏内中文</i><i><Icon name="check" size={12}/> 可回滚</i></span></span><span className="choiceDot"/></button>
        <button className={`autoModeCard ${mode === 'safe' ? 'selected' : ''}`} disabled={running || busy} onClick={() => setMode('safe')}><span className="autoModeIcon safe"><Icon name="scan" size={25}/></span><span className="autoModeCopy"><span className="autoModeTop"><b>无注入字幕</b><em>零修改</em></span><strong>自动识别窗口并显示翻译字幕</strong><small>只读取游戏画面，不注入进程，也不修改任何游戏文件。</small><span className="modeBenefits"><i><Icon name="check" size={12}/> 安全兼容</i><i><Icon name="check" size={12}/> 自动定位</i></span></span><span className="choiceDot"/></button>
      </div>

      <div className="routePanel"><div className="routeIcon"><Icon name={mode === 'patch' ? 'file' : 'scan'}/></div><div><span>AUTO ROUTE</span><b>{route.title}</b><p>{route.detail}</p></div><Icon name="chevron"/></div>

      <div className="sessionActions">
        {!running && !busy && !(patchInstalled && mode === 'patch') && <button className="primaryAction" disabled={!inspection || (mode === 'patch' && !patchSupported)} onClick={start}><Icon name="play"/>{mode === 'patch' ? '生成并安装中文补丁' : '开始无注入翻译'}</button>}
        {(running || busy) && <button className="stopAction" onClick={stop}><Icon name="stop"/>{busy ? '取消当前任务' : '停止翻译'}</button>}
        {patchInstalled && !busy && <button className="restoreAction" onClick={restore}><Icon name="restore"/>恢复原始文件</button>}
      </div>

      <div className="activityPanel always"><div className="activityTop"><span className={running || busy ? 'pulse live' : 'pulse'}/><b>{busy ? '正在处理' : running ? '翻译运行中' : '状态'}</b><span>{message}</span></div>{progress && <><div className="progressLine"><div style={{ width: `${((progress.current - 1 + progress.chunk / progress.chunks) / progress.total) * 100}%` }}/></div><div className="activityMeta"><span>{progress.current} / {progress.total}</span><span>{progress.file}</span><span>批次 {progress.chunk} / {progress.chunks}</span></div></>}{runtimeStatus?.state === 'translated' && <div className="translationPreview"><span>最近译文</span><p>{runtimeStatus.translated}</p></div>}{runtimeStatus?.state === 'error' && <div className="errorText">{runtimeStatus.message}</div>}</div>
    </section>

    <aside className="controlPanel"><div className="controlHeader"><div><span>TRANSLATION CONSOLE</span><h2>翻译控制台</h2></div><span className="secureBadge"><Icon name="shield" size={14}/> 本地保存</span></div>
      <div className="settingGroup"><div className="settingTitle"><span>AI PROVIDER</span><b>模型服务</b></div><label>API 地址<input value={config.baseUrl} onChange={event => setConfig({ ...config, baseUrl: event.target.value })}/></label><div className="fieldRow"><label>模型<input value={config.model} onChange={event => setConfig({ ...config, model: event.target.value })}/></label><label className="tempField">温度<input type="number" min="0" max="2" step="0.1" value={config.temperature} onChange={event => setConfig({ ...config, temperature: Number(event.target.value) })}/></label></div><label>API Key<div className="secretField"><input type="password" placeholder="输入服务密钥" value={config.apiKey} onChange={event => setConfig({ ...config, apiKey: event.target.value })}/><span>{config.apiKey ? '已保存' : '必填'}</span></div></label></div>
      <div className="settingGroup"><div className="settingTitle"><span>TRANSLATION PROFILE</span><b>翻译策略</b></div><div className="profileTabs">{profiles.map((item, index) => <button className={profile === index ? 'active' : ''} key={item.name} onClick={() => setProfile(index)}>{item.name}</button>)}</div><label>专用提示词<textarea rows={8} value={profiles[profile].prompt} onChange={event => setProfiles(profiles.map((item, index) => index === profile ? { ...item, prompt: event.target.value } : item))}/></label><div className="promptMeta"><span>{profiles[profile].prompt.length} 字符</span><span><Icon name="shield" size={12}/> 占位符强校验</span></div></div>
      <div className="safetyNote"><Icon name="shield"/><div><b>{mode === 'patch' ? '事务式补丁安装' : '严格无注入模式'}</b><p>{mode === 'patch' ? '翻译全部完成并验证后才修改文件；失败自动回滚。' : '仅捕获窗口画面；不会写入、注入或 Hook 游戏。'}</p></div></div>
    </aside>
  </div>
}
