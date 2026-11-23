<div align="center">

[🇺🇸 English](README.md) | **🇨🇳 简体中文**

# Serpent ComfyUI 元数据插件

面向 [Serpent](https://github.com/dolag233/Serpent) 的跨平台（`macOS / Windows / Linux` 通用 `any` 包）插件：纯本地解析 ComfyUI 生成元数据，支持为底模与 LoRA 手动绑定可点击跳转的网页链接，以及按完整名称一键 / 批量打标。

</div>

---

## 核心功能

- **纯本地解析 ComfyUI 元数据（不调 AI、零 API 费用）**
  - 提取**正向提示词**（不展示负向提示词），支持一键复制到剪贴板；
  - 识别底模（`UNETLoader`、`CheckpointLoaderSimple`、`DiffusionModelLoader` 等）与启用状态的 LoRA 及权重（兼容标准 `LoraLoader`、`LoRAStackDynamic`（按 `lora_count` 截断并过滤零权重残留）、`Power Lora Loader (rgthree)`、`CR LoRA Stack` 等）；
  - 提取采样参数（`Seed`、`Steps`、`CFG`、`Sampler`、`Scheduler`、`Denoise`，兼容 `ManualSigmas`、`Seed (rgthree)`），并支持 A1111 `parameters` 兜底解析。
- **模型 / LoRA 链接一次绑定、全局复用**
  - 为任意底模或 LoRA 完整文件名手动绑定网页地址（Civitai / LiblibAI / HuggingFace 等）；
  - 绑定一次后，库内所有历史和未来的同款模型图片都会自动支持一键在系统浏览器打开——**无需本地 `models/` 目录**，特别适合云端 ComfyUI 生图工作流；
  - 内置全局「模型链接库」管理窗口，支持一键复制 JSON 备份与合并导入。
- **一键 / 批量自动打标**
  - 默认按**完整文件名 + 分类前缀**（`model:`、`lora:`）写入 Serpent 原生标签，可在「打标规则」中随时开关前缀、自定义前缀文字或选择是否移除扩展名，带实时预览；
  - 支持右侧 Inspector 单图快捷打标，也支持画布多选图片后右键批量打标。
- **跨 macOS / Windows 迁移不丢失**
  - 链接映射表和打标规则保存在 `<资源库>/.serpent/plugin-files/com.whai.comfyui-metadata/comfyui-store.json`，换电脑拷贝资源库时会跟着标签一起带走。

## 安装方式

### 方式一：通过 GitHub 地址安装（推荐，支持后续检查更新）

1. 打开 Serpent → **设置 → 插件 → 高级安装**；
2. 粘贴本仓库地址：
   ```text
   https://github.com/02whai/serpent-plugin-comfyui
   ```
3. 安装范围建议选择 **全局**（插件已配置 `instanceScope: "library"`，链接与打标配置仍按资源库独立保存）；
4. 启用插件并确认信任无限制运行模式。

### 方式二：安装 Release ZIP 包

1. 前往 [GitHub Releases](https://github.com/02whai/serpent-plugin-comfyui/releases) 下载 `com.whai.comfyui-metadata-<版本>-any.zip`；
2. 在 Serpent → **设置 → 插件 → 高级安装 → 安装 ZIP** 中选择该压缩包即可。

## 使用说明

1. 在 Serpent 中点选任意 ComfyUI 生成的 `.png`（或 `.webp`）原图；
2. 在右侧 **Inspector**（或右键菜单 → **ComfyUI 元数据**）中使用：
   - **查看参数与链接**：查看底模、LoRA 及权重、采样参数、正向提示词；一键跳转已绑定网页、在「绑定链接」页绑定新网址、或在「打标规则」页调整标签格式；
   - **提取模型 / LoRA 打标**：单选或多选图片，一键写入模型与 LoRA 标签；
   - **管理 ComfyUI 模型链接库**：集中查看、打开、删除所有模型绑定，并导出/导入 JSON 备份。

> **小提示**：通过 `SaveImage` 节点保存的 `.png` 原图包含完整 ComfyUI 工作流信息；部分对比预览节点输出的 `.jpg`（如 `rgthree.compare._temp_*.jpg`）默认不含元数据。

## 运行模式与隐私说明

本插件使用 `unrestricted` 模式，仅用于：
1. 校验 `http://` / `https://` 后调用系统默认浏览器打开你绑定的模型网页（macOS `open` / Windows `cmd start` / Linux `xdg-open`）；
2. 在 Serpent 分配给本插件的资源库目录中读写 `comfyui-store.json`；
3. 调用系统剪贴板命令（`pbcopy` / `clip` / `xclip`）复制提示词、Seed 与备份 JSON。

本插件**不发起任何网络请求**，不上传任何图片或元数据。

## 本地开发与打包

```bash
npm install
npm run typecheck
npm test
npm run pack
```

## 许可证

[MIT](LICENSE)
