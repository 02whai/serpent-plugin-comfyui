<div align="center">

**🇺🇸 English** | [🇨🇳 简体中文](README.zh-CN.md)

# Serpent Plugin: ComfyUI Metadata

A cross-platform (`macOS / Windows / Linux`) plugin for [Serpent](https://github.com/dolag233/Serpent) that parses ComfyUI generation metadata locally, lets you bind reusable webpage URLs per model / LoRA, and batch-tags assets with full model & LoRA names.

</div>

---

## Features

- **Pure-Local ComfyUI Metadata Parsing (Zero AI API Cost)**
  - Extracts **positive prompt** (negative prompt intentionally omitted) with one-click copy.
  - Detects base models (`UNETLoader`, `CheckpointLoaderSimple`, `DiffusionModelLoader`, etc.) and active LoRAs with effective weights (`LoraLoader`, `LoRAStackDynamic` respecting `lora_count` & skipping zero-weight slots, `Power Lora Loader (rgthree)`, `CR LoRA Stack`, etc.).
  - Extracts sampling parameters (`Seed`, `Steps`, `CFG`, `Sampler`, `Scheduler`, `Denoise`, including `ManualSigmas` & `Seed (rgthree)`), plus Automatic1111 `parameters` fallback.
- **Bind Once, Reuse Everywhere (Model / LoRA → Webpage URL)**
  - Manually bind any `http://` / `https://` webpage (Civitai, LiblibAI, HuggingFace, etc.) to a model or LoRA filename.
  - Every past and future image referencing that model automatically unlocks one-click browser launch—no local `models/` directory required (ideal for cloud ComfyUI workflows).
  - Includes a global Link Library manager with JSON copy/backup and merge-import.
- **One-Click & Batch Auto-Tagging**
  - Writes full model and LoRA filenames with customizable prefixes (default `model:` / `lora:`) into Serpent native tags.
  - Works on single images from the Inspector or on multiple selected images via right-click context menu.
- **Portable Across macOS & Windows**
  - All URL bindings and tagging rules are persisted inside `<library>/.serpent/plugin-files/com.whai.comfyui-metadata/comfyui-store.json`, traveling cleanly with your Serpent library when migrating machines.

## Installation in Serpent

### Option 1: Install via GitHub (Recommended)

1. Open Serpent → **Settings → Plugins → Advanced Install**.
2. Paste this repository URL:
   ```text
   https://github.com/02whai/serpent-plugin-comfyui
   ```
3. Choose **Global** (recommended; plugin instances still isolate data per library via `instanceScope: "library"`).
4. Enable the plugin and confirm trust for the `unrestricted` runtime.

### Option 2: Install Release ZIP

1. Download `com.whai.comfyui-metadata-<version>-any.zip` from [GitHub Releases](https://github.com/02whai/serpent-plugin-comfyui/releases).
2. In Serpent → **Settings → Plugins → Advanced Install → Install ZIP**, pick the downloaded archive.

## Usage

1. Select a ComfyUI-generated `.png` (or `.webp`) image in Serpent.
2. In the right-hand **Inspector** (or right-click → **ComfyUI 元数据**):
   - **查看参数与链接**: Inspect positive prompt, models, LoRAs + weights, sampling params, jump to bound webpages, bind new URLs, or adjust tagging rules.
   - **提取模型 / LoRA 打标**: Single-click or batch-tag selected assets with their models and LoRAs.
   - **管理 ComfyUI 模型链接库**: Manage all saved model links and export/import JSON backups.

> **Tip**: Images saved via `SaveImage` (`.png`) preserve full ComfyUI metadata, whereas temporary comparison previews (e.g. `rgthree.compare._temp_*.jpg`) typically strip metadata at save time.

## Runtime & Privacy Disclosure

This plugin uses `runtime.mode: "unrestricted"` strictly for:
1. Opening user-bound `http://` / `https://` URLs in the system default browser (`open` on macOS, `cmd /c start` on Windows, `xdg-open` on Linux).
2. Reading/writing `comfyui-store.json` inside Serpent's library plugin data directory (`serpent.data.getDirectory`).
3. Copying prompt/Seed/JSON to the system clipboard (`pbcopy` / `clip` / `xclip`).

The plugin makes **no network requests** and never uploads images or metadata.

## Local Development

```bash
npm install
npm run typecheck
npm test
npm run pack
```

## License

[MIT](LICENSE)
