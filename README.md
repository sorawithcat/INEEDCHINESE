# INEEDCHINESE

把游戏 .exe 拖进窗口，就自动开始翻译为简体中文。

- 能安全打补丁的引擎（Ren'Py、RPG Maker MV/MZ、TyranoBuilder、TXT/JSON 文本）会自动生成中文补丁，以后直接启动游戏就是中文；可随时一键恢复原文。
- 其他游戏优先用**文本 Hook**（Textractor，从内存直接抓文本，毫秒级出字幕）；hook 不上时自动切换 OCR 置顶字幕，也可随时手动切换。均不修改游戏文件。
- 翻译结果缓存在本地，重复文本即时出译，不重复消耗请求。

## 文本 Hook 注意事项

- Hook 属于进程注入，部分杀毒软件会拦截：请把安装目录下的 `resources/textractor` 加入白名单。
- 少数带反作弊的游戏无法 hook，20 秒没抓到文本会自动切换 OCR。
- 自动 Hook 抓不到台词时，在设置里填「Hook 特殊码」（就是 Textractor 界面「Add hook」用的那串 `HSN-8@0` 之类的代码）。
- 字幕没出对话？点「切换文本源」，或在字幕工具栏上点 `⇄` 在多路文本间循环。
- Hook 组件为 Textractor（Chenx221 维护版，GPLv3），首次构建前运行 `npm run setup:textractor` 下载。

## 字幕窗

- 平时整窗点击穿透，不抢游戏的鼠标与键盘焦点。
- 把鼠标移到字幕**顶部**，工具栏会亮起：拖住把手可移动位置，`A-` / `A+` 调字号，`◐` 调背景不透明度，`⇄` 切换文本源，`✕` 关闭字幕。
- 鼠标离开顶部区域后立刻恢复穿透，位置与样式会被记住；若换了显示器导致位置落在屏幕外，会自动回到默认位置。
- 用 `✕` 关掉字幕后翻译仍在继续，主窗口的「显示字幕」可以把它叫回来。
- 翻译通道全部失败时，字幕上会直接显示失败原因，不再是「没反应」。

## 已知限制

- 只接受 UTF-8 / UTF-16（含 BOM）文本。GBK、Shift-JIS、Big5 等旧编码会被拒绝并**在报错里点出检测到的编码**，不会写坏原文件。
  译文是简体中文，多数旧编码（尤其 Shift-JIS）本身就表示不了，硬写回去只会毁掉游戏文本。
- 少数带反作弊的游戏无法 hook；Hook 模式下点「停止」会先让 Textractor 自己 detach 再退出。

## 翻译源

- 默认免费翻译，开箱即用。
- 设置（右上角齿轮）里可切换 LLM API（DeepSeek 等 OpenAI 兼容服务），长句和剧情文本质量更好。

## 补丁说明

补丁模式在游戏目录创建 `.ineedchinese`，保存原文件备份与 SHA-256 清单。全部翻译校验完成后才写入游戏文件，失败自动回滚。

## 开发

```powershell
npm.cmd install
npm.cmd run dev
```

## 仿真自检

```powershell
npm.cmd run build
npm.cmd run simulate   # 69 项断言，覆盖识别/补丁/Hook/字幕/编码，无需窗口与真实游戏
```

`scripts/simulate.cjs` 用假的 electron、child_process、fetch 驱动真实主进程代码，任何一项失败都会以非 0 退出。

## 构建

```powershell
npm.cmd run build    # 类型检查 + 构建
npm.cmd run dist:win # 打包 Windows 安装包与便携版到 release/
```
