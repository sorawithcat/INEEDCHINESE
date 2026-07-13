# INEEDCHINESE

Windows 游戏与应用 AI 简体中文翻译工具。拖入游戏后自动识别引擎，用户只需选择最终效果：

- **中文补丁**：提取可安全修改的文本，批量翻译、校验、备份并安装；支持恢复原始文件。
- **无注入字幕**：自动启动并定位游戏窗口，通过 OCR 与外部置顶字幕翻译；不写入、不注入、不 Hook 游戏。

## 当前自动识别

- Ren’Py：有可读 `.rpy` 源脚本时生成直接文本补丁。
- RPG Maker MV/MZ：按数据库字段和事件指令生成 JSON 补丁。
- TyranoBuilder：处理未封包 `.ks` 剧本并保留标签。
- Unity Mono/IL2CPP：已有 XUnity.AutoTranslator 时进行游戏内替换。
- TXT/JSON：生成带备份的通用文本补丁。
- XP3、PCK、RGSS3A、Wolf/Bakin 等封包：使用无注入字幕。

补丁模式会在游戏目录创建 `.ineedchinese`，其中保存原文件备份、翻译缓存和 SHA-256 清单。全部翻译和校验完成前不会修改游戏文件。

## 开发

```powershell
npm.cmd install
npm.cmd run dev
```

## 构建验证

```powershell
npm.cmd run build
```

## Windows 安装包与便携版

```powershell
npm.cmd run dist:win
```

输出目录为 `release`。
