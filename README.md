# INEEDCHINESE

把游戏 .exe 拖进窗口，就自动开始翻译为简体中文。

- 能安全打补丁的引擎（Ren'Py、RPG Maker MV/MZ、TyranoBuilder、TXT/JSON 文本）会自动生成中文补丁，以后直接启动游戏就是中文；可随时一键恢复原文。
- 其他游戏优先用**文本 Hook**（Textractor，从内存直接抓文本，毫秒级出字幕）；hook 不上时自动切换 OCR 置顶字幕，也可随时手动切换。均不修改游戏文件。
- 翻译结果缓存在本地，重复文本即时出译，不重复消耗请求。

## 文本 Hook 注意事项

- Hook 属于进程注入，部分杀毒软件会拦截：请把安装目录下的 `resources/textractor` 加入白名单。
- 少数带反作弊的游戏无法 hook，45 秒无文本会自动切换 OCR。
- 字幕没出对话？点「切换文本源」在多路文本间循环。
- Hook 组件为 Textractor（Chenx221 维护版，GPLv3），首次构建前运行 `npm run setup:textractor` 下载。

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

## 构建

```powershell
npm.cmd run build    # 类型检查 + 构建
npm.cmd run dist:win # 打包 Windows 安装包与便携版到 release/
```
