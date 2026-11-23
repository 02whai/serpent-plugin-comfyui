import { spawn } from 'node:child_process';
import { parseComfyMetadataFromBytes, type ComfyMetadata } from './parser/comfyui.ts';
import {
  buildTagsForMetadata,
  createEmptyStore,
  isSafeHttpUrl,
  lookupModelLink,
  normalizeStoreData,
  readStoreFromDirectory,
  sanitizeTagConfig,
  writeStoreToDirectory,
  type ComfyPluginStoreData,
  type TaggingConfig,
} from './store/config.ts';

interface SelectedAssetSummary {
  id: string;
  name: string;
  relativeFilePath?: string;
  mediaType?: string;
  byteSize?: number;
}

interface CommandInvocationContext {
  libraryId?: string;
  targetLibraryId?: string;
  assetIds?: string[];
  invocation?: {
    libraryId?: string;
    selection?: {
      assetIds?: string[];
      assets?: SelectedAssetSummary[];
    };
  };
}

interface SerpentTagItem {
  id: string;
  name: string;
}

type WidgetChild = unknown;

interface WidgetToolkit {
  state<T>(initial: T): { get(): T; set(value: T): void };
  column(...children: WidgetChild[]): unknown;
  row(...children: WidgetChild[]): unknown;
  group(title: string, ...children: WidgetChild[]): unknown;
  tabs(spec: {
    id: string;
    value: string;
    onChange?: (value: string) => void;
    tabs: Array<{ id: string; label: string; children: WidgetChild[] }>;
  }): unknown;
  note(text: string): unknown;
  heading(text: string): unknown;
  separator(): unknown;
  list(spec: {
    columns: string[];
    rows: Array<Array<string | { segments: Array<{ text: string; tone?: 'match' | 'change' }> }>>;
    emptyText?: string;
  }): unknown;
  text(spec: {
    id: string;
    label: string;
    value: string;
    description?: string;
    disabled?: boolean;
    onChange?: (value: string) => void;
  }): unknown;
  select(spec: {
    id: string;
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    description?: string;
    disabled?: boolean;
    onChange?: (value: string) => void;
  }): unknown;
  switch(spec: {
    id: string;
    label: string;
    value: boolean;
    description?: string;
    disabled?: boolean;
    onChange?: (value: boolean) => void;
  }): unknown;
  toggle(spec: {
    id: string;
    label: string;
    value: boolean;
    description?: string;
    disabled?: boolean;
    onChange?: (value: boolean) => void;
  }): unknown;
}

interface AssetMetadataRecord {
  assetId: string;
  description: string | null;
  tags?: Array<{ id: string; name: string; source: 'user' | 'ai' }>;
  entityVersion: number;
}

interface SerpentScopedApi {
  assets: {
    list: (input: { assetIds?: string[]; limit?: number; offset?: number }) => Promise<{ items?: SelectedAssetSummary[] }>;
    getMetadata: (assetId: string) => Promise<AssetMetadataRecord>;
    setMetadata: (input: {
      assetId: string;
      expectedVersion: number;
      description?: string | null;
    }) => Promise<AssetMetadataRecord>;
    readContent: (
      assetId: string,
      options?: { maxBytes?: number; offsetBytes?: number },
    ) => Promise<{
      assetId: string;
      revisionId: string;
      byteSize: number;
      dataBase64: string;
      truncated: boolean;
      mimeType: string | null;
    }>;
  };
  tags: {
    list: (input?: { limit?: number; offset?: number }) => Promise<{ items?: SerpentTagItem[]; total?: number }>;
    create: (name: string) => Promise<SerpentTagItem>;
    assign: (assetIds: string[], tagIds: string[]) => Promise<unknown>;
    remove: (assetIds: string[], tagIds: string[]) => Promise<unknown>;
  };
  ui: {
    notify: (input: { severity: 'info' | 'warning' | 'error'; message: string; title?: string }) => Promise<unknown>;
    openDialog: (input: {
      title: string;
      submitLabel?: string;
      render: (ui: WidgetToolkit) => unknown;
    }) => Promise<Record<string, unknown> | null>;
  };
}

interface SerpentPluginApi extends SerpentScopedApi {
  forLibrary?: (libraryId: string) => SerpentScopedApi;
  commands: {
    register: (id: string, handler: (context: CommandInvocationContext) => Promise<unknown> | unknown) => void;
  };
  storage: {
    get: (key: string, options?: { scope?: 'library' | 'user' }) => Promise<unknown>;
    set: (key: string, value: unknown, options?: { scope?: 'library' | 'user' }) => Promise<void>;
  };
  data?: {
    getDirectory: (options?: { scope?: 'library' | 'user' }) => Promise<{ path: string; scope: string }>;
  };
}

const STORAGE_FALLBACK_KEY = 'comfyui-store';
const INITIAL_READ_BYTES = 1024 * 1024;
const MAX_TOTAL_READ_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_BIND_ITEMS = 12;

function clip(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 1))}…`;
}

function openUrlInSystemBrowser(url: string): Promise<void> {
  if (!isSafeHttpUrl(url)) {
    return Promise.reject(new Error('仅支持 http:// 或 https:// 链接'));
  }
  return new Promise((resolve, reject) => {
    try {
      let child;
      if (process.platform === 'darwin') {
        child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      } else if (process.platform === 'win32') {
        child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      } else {
        child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      }
      child.once('error', reject);
      child.unref();
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function copyTextToSystemClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      let cmd = '';
      let args: string[] = [];
      if (process.platform === 'darwin') {
        cmd = 'pbcopy';
      } else if (process.platform === 'win32') {
        cmd = 'clip';
      } else {
        cmd = 'xclip';
        args = ['-selection', 'clipboard'];
      }
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`clipboard exited with code ${code ?? -1}`));
      });
      child.stdin.end(text, 'utf8');
    } catch (err) {
      reject(err);
    }
  });
}

function resolveScopedApi(serpent: SerpentPluginApi, context?: CommandInvocationContext): SerpentScopedApi {
  const libId = context?.invocation?.libraryId ?? context?.targetLibraryId ?? context?.libraryId;
  if (libId && typeof serpent.forLibrary === 'function') {
    try {
      return serpent.forLibrary(libId);
    } catch {
      return serpent;
    }
  }
  return serpent;
}

function extractSelection(context?: CommandInvocationContext): {
  assetIds: string[];
  assetsById: Map<string, SelectedAssetSummary>;
} {
  const assetsById = new Map<string, SelectedAssetSummary>();
  const snapAssets = context?.invocation?.selection?.assets ?? [];
  for (const a of snapAssets) {
    if (a?.id) assetsById.set(a.id, a);
  }
  const rawIds = context?.invocation?.selection?.assetIds ?? context?.assetIds ?? [];
  const assetIds = Array.from(new Set(rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  if (assetIds.length === 0 && assetsById.size > 0) {
    assetIds.push(...assetsById.keys());
  }
  return { assetIds, assetsById };
}

async function loadStore(serpent: SerpentPluginApi): Promise<{ data: ComfyPluginStoreData; dataDir: string | null }> {
  if (serpent.data?.getDirectory) {
    try {
      const dir = await serpent.data.getDirectory({ scope: 'library' });
      if (dir?.path) {
        return { data: readStoreFromDirectory(dir.path), dataDir: dir.path };
      }
    } catch {
      // Fall back to KV storage below.
    }
  }
  try {
    const stored = await serpent.storage.get(STORAGE_FALLBACK_KEY, { scope: 'library' });
    return { data: normalizeStoreData(stored), dataDir: null };
  } catch {
    return { data: createEmptyStore(), dataDir: null };
  }
}

async function saveStore(serpent: SerpentPluginApi, data: ComfyPluginStoreData, dataDir: string | null): Promise<void> {
  if (dataDir) {
    writeStoreToDirectory(dataDir, data);
    return;
  }
  if (serpent.data?.getDirectory) {
    try {
      const dir = await serpent.data.getDirectory({ scope: 'library' });
      if (dir?.path) {
        writeStoreToDirectory(dir.path, data);
        return;
      }
    } catch {
      // Fall back to KV storage.
    }
  }
  await serpent.storage.set(STORAGE_FALLBACK_KEY, data, { scope: 'library' });
}

async function readAssetBytesForMetadata(api: SerpentScopedApi, assetId: string): Promise<Buffer> {
  const first = await api.assets.readContent(assetId, { maxBytes: INITIAL_READ_BYTES });
  const firstBuf = Buffer.from(first.dataBase64, 'base64');

  if (!first.truncated) return firstBuf;
  const quickCheck = parseComfyMetadataFromBytes(firstBuf);
  if (quickCheck.format !== 'none') return firstBuf;

  const chunks: Buffer[] = [firstBuf];
  let offset = firstBuf.length;
  while (offset < MAX_TOTAL_READ_BYTES) {
    const slice = await api.assets.readContent(assetId, {
      offsetBytes: offset,
      maxBytes: INITIAL_READ_BYTES,
    });
    const part = Buffer.from(slice.dataBase64, 'base64');
    if (part.length === 0) break;
    chunks.push(part);
    offset += part.length;
    if (!slice.truncated) break;
  }
  return Buffer.concat(chunks);
}

async function fetchAllTagsByLowerName(api: SerpentScopedApi): Promise<Map<string, SerpentTagItem>> {
  const map = new Map<string, SerpentTagItem>();
  const pageSize = 200;
  let offset = 0;
  while (offset < 20_000) {
    const page = await api.tags.list({ limit: pageSize, offset });
    const items = Array.isArray(page?.items) ? page.items : [];
    for (const item of items) {
      if (item?.id && typeof item.name === 'string') {
        map.set(item.name.toLowerCase(), item);
      }
    }
    if (items.length < pageSize) break;
    offset += items.length;
  }
  return map;
}

async function ensureTagIds(
  api: SerpentScopedApi,
  tagNames: string[],
  existingByLower?: Map<string, SerpentTagItem>,
): Promise<string[]> {
  const cache = existingByLower ?? (await fetchAllTagsByLowerName(api));
  const tagIds: string[] = [];

  for (const rawName of tagNames) {
    const name = rawName.trim().slice(0, 255);
    if (!name) continue;
    const key = name.toLowerCase();
    let existing = cache.get(key);
    if (!existing) {
      try {
        existing = await api.tags.create(name);
        if (existing?.id) cache.set(key, existing);
      } catch {
        const refreshed = await fetchAllTagsByLowerName(api);
        existing = refreshed.get(key);
        if (existing) cache.set(key, existing);
      }
    }
    if (existing?.id) tagIds.push(existing.id);
  }

  return Array.from(new Set(tagIds));
}

async function applyTagsToAssets(
  api: SerpentScopedApi,
  assetIds: string[],
  tagConfig: TaggingConfig,
): Promise<{
  total: number;
  taggedAssets: number;
  skippedNoMetadata: number;
  skippedNoModelsOrLoras: number;
  appliedNames: string[];
}> {
  const tagCache = await fetchAllTagsByLowerName(api);
  let taggedAssets = 0;
  let skippedNoMetadata = 0;
  let skippedNoModelsOrLoras = 0;
  const appliedNamesSet = new Set<string>();

  for (const assetId of assetIds) {
    let bytes: Buffer;
    try {
      bytes = await readAssetBytesForMetadata(api, assetId);
    } catch {
      skippedNoMetadata++;
      continue;
    }

    const meta = parseComfyMetadataFromBytes(bytes);
    if (meta.format === 'none') {
      skippedNoMetadata++;
      continue;
    }

    const tagNames = buildTagsForMetadata(meta, tagConfig);
    if (tagNames.length === 0) {
      skippedNoModelsOrLoras++;
      continue;
    }

    const tagIds = await ensureTagIds(api, tagNames, tagCache);
    if (tagIds.length > 0) {
      await api.tags.assign([assetId], tagIds);
      taggedAssets++;
      for (const n of tagNames) appliedNamesSet.add(n);
    }
  }

  return {
    total: assetIds.length,
    taggedAssets,
    skippedNoMetadata,
    skippedNoModelsOrLoras,
    appliedNames: Array.from(appliedNamesSet),
  };
}

interface BindableModelItem {
  kindLabel: string;
  name: string;
  weightText: string;
}

function collectBindableItems(meta: ComfyMetadata): BindableModelItem[] {
  const items: BindableModelItem[] = [];
  const seen = new Set<string>();

  for (const m of meta.models) {
    const key = m.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kindLabel: '底模', name: m.name, weightText: '-' });
  }
  for (const l of meta.loras) {
    const key = l.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kindLabel: 'LoRA',
      name: l.name,
      weightText: l.strengthModel !== null ? String(l.strengthModel) : '-',
    });
  }
  return items;
}

export async function setup(apiOrContext: SerpentPluginApi | { serpent: SerpentPluginApi }): Promise<void> {
  const serpent: SerpentPluginApi = (
    apiOrContext && typeof apiOrContext === 'object' && 'serpent' in apiOrContext && apiOrContext.serpent
      ? apiOrContext.serpent
      : apiOrContext
  ) as SerpentPluginApi;

  // 1) Inspect ComfyUI metadata, open bound links, edit bindings, and configure/apply tags
  serpent.commands.register('comfy.inspect', async (context) => {
    const api = resolveScopedApi(serpent, context);
    const { assetIds, assetsById } = extractSelection(context);
    if (assetIds.length === 0) {
      await api.ui.notify({ severity: 'info', title: 'ComfyUI 元数据', message: '请先选择一张图片。' });
      return;
    }

    const assetId = assetIds[0];
    let asset = assetsById.get(assetId);
    if (!asset) {
      try {
        const listed = await api.assets.list({ assetIds: [assetId], limit: 1 });
        asset = listed?.items?.[0] ?? { id: assetId, name: assetId };
      } catch {
        asset = { id: assetId, name: assetId };
      }
    }

    let metadata: ComfyMetadata;
    try {
      const bytes = await readAssetBytesForMetadata(api, assetId);
      metadata = parseComfyMetadataFromBytes(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await api.ui.notify({
        severity: 'error',
        title: 'ComfyUI 元数据读取失败',
        message: `无法读取文件内容：${msg}`,
      });
      return;
    }

    const { data: store, dataDir } = await loadStore(serpent);
    const bindableItems = collectBindableItems(metadata);
    const editableItems = bindableItems.slice(0, MAX_INLINE_BIND_ITEMS);

    let assetMeta: AssetMetadataRecord | null = null;
    try {
      assetMeta = await api.assets.getMetadata(assetId);
    } catch {
      assetMeta = null;
    }

    const activeAssetTagNames = new Set<string>(
      (assetMeta?.tags ?? []).map((t) => t.name.toLowerCase()),
    );

    const buildAllCandidateTagNames = (cfg: TaggingConfig): Set<string> => {
      const set = new Set<string>();
      const variants: TaggingConfig[] = [
        cfg,
        { ...cfg, usePrefix: false },
        { ...cfg, stripExtension: !cfg.stripExtension },
        { ...cfg, usePrefix: false, stripExtension: !cfg.stripExtension },
      ];
      for (const v of variants) {
        for (const name of buildTagsForMetadata(metadata, v)) {
          set.add(name.toLowerCase());
        }
      }
      return set;
    };

    // Live mutable draft kept across tab switches
    const draftUrls = new Map<string, string>();
    for (const item of editableItems) {
      const existing = lookupModelLink(store.modelLinks, item.name);
      draftUrls.set(item.name, existing?.record.url ?? '');
    }
    const draftTagConfig: TaggingConfig = { ...store.tagConfig };

    const samplingSummaryParts: string[] = [];
    if (metadata.params.seed !== undefined) samplingSummaryParts.push(`Seed: ${metadata.params.seed}`);
    if (metadata.params.steps !== undefined) samplingSummaryParts.push(`Steps: ${metadata.params.steps}`);
    if (metadata.params.cfg !== undefined) samplingSummaryParts.push(`CFG: ${metadata.params.cfg}`);
    if (metadata.params.sampler) {
      samplingSummaryParts.push(
        metadata.params.scheduler
          ? `${metadata.params.sampler} / ${metadata.params.scheduler}`
          : metadata.params.sampler,
      );
    }
    if (metadata.params.denoise !== undefined && metadata.params.denoise !== 1) {
      samplingSummaryParts.push(`Denoise: ${metadata.params.denoise}`);
    }
    const samplingSummary = samplingSummaryParts.join(' · ');

    const dialogResult = await api.ui.openDialog({
      title: `ComfyUI · ${clip(asset.name, 42)}`,
      submitLabel: '保存设置与链接',
      render(ui) {
        const activeTab = ui.state<string>('overview');
        const statusMsg = ui.state<string>('');
        const selectedOpenTarget = ui.state<string>('');
        const tagTick = ui.state<number>(0);
        void tagTick.get();

        const boundOptions: Array<{ value: string; label: string }> = [];
        for (const item of editableItems) {
          const url = (draftUrls.get(item.name) ?? '').trim();
          if (isSafeHttpUrl(url)) {
            boundOptions.push({
              value: item.name,
              label: clip(`[${item.kindLabel}] ${item.name}`, 120),
            });
          }
        }
        const currentOpenTarget = boundOptions.some((o) => o.value === selectedOpenTarget.get())
          ? selectedOpenTarget.get()
          : (boundOptions[0]?.value ?? '');

        const modelRows = bindableItems.map((item) => {
          const url = (draftUrls.get(item.name) ?? lookupModelLink(store.modelLinks, item.name)?.record.url ?? '').trim();
          const hasUrl = isSafeHttpUrl(url);
          return [
            item.name,
            item.kindLabel === '底模' ? '底模' : item.weightText,
            hasUrl
              ? { segments: [{ text: '已绑定', tone: 'match' as const }] }
              : '未绑定',
          ];
        });

        const previewTags = metadata.format !== 'none'
          ? buildTagsForMetadata(metadata, draftTagConfig)
          : [];
        const matchedExistingCount = previewTags.filter((t) => activeAssetTagNames.has(t.toLowerCase())).length;
        const candidateSet = metadata.format !== 'none' ? buildAllCandidateTagNames(draftTagConfig) : new Set<string>();
        const removableCount = Array.from(activeAssetTagNames).filter((name) => candidateSet.has(name)).length;

        const overviewChildren: WidgetChild[] = [];
        if (metadata.format === 'none') {
          overviewChildren.push(
            ui.group(
              '未检测到 ComfyUI 元数据',
              ui.note('当前文件不包含 ComfyUI 或 A1111 生成信息。提示：JPEG 对比图（如 rgthree.compare._temp_*.jpg）默认不含工作流元数据，请尽量保留 SaveImage 输出的 PNG 原图。'),
            ),
          );
        } else {
          const targetUrl = currentOpenTarget ? (draftUrls.get(currentOpenTarget) ?? '').trim() : '';
          overviewChildren.push(
            ui.group(
              `模型与 LoRA（底模 ${metadata.models.length} · LoRA ${metadata.loras.length}）`,
              ui.list({
                columns: ['完整名称', '权重', '链接'],
                rows: modelRows,
                emptyText: '未检测到模型或 LoRA',
              }),
              boundOptions.length > 0
                ? ui.select({
                    id: 'openTargetSelect',
                    label: '跳转已绑定网页',
                    value: currentOpenTarget,
                    options: boundOptions,
                    description: clip(targetUrl, 120),
                    onChange: (val) => selectedOpenTarget.set(val),
                  })
                : ui.note('可在「绑定链接」页为模型/LoRA 填入网页地址（绑一次全局复用）。'),
              boundOptions.length > 0
                ? ui.toggle({
                    id: 'btnOpenSelectedUrl',
                    label: '在浏览器中打开选中链接',
                    value: false,
                    onChange: () => {
                      const urlToOpen = (draftUrls.get(currentOpenTarget) ?? '').trim();
                      if (!isSafeHttpUrl(urlToOpen)) {
                        statusMsg.set('所选项没有有效的 http/https 链接');
                        return;
                      }
                      void openUrlInSystemBrowser(urlToOpen).catch(() => {});
                      statusMsg.set(`已打开：${clip(urlToOpen, 64)}`);
                    },
                  })
                : null,
            ),
            ui.group(
              '正向提示词与参数',
              samplingSummary ? ui.note(samplingSummary) : null,
              metadata.positivePrompt
                ? ui.list({
                    columns: ['正向提示词（支持多行滚动）'],
                    rows: [[metadata.positivePrompt.slice(0, 8000)]],
                  })
                : ui.note('未提取到正向提示词文本'),
              metadata.positivePrompt || metadata.params.seed
                ? ui.row(
                    metadata.positivePrompt
                      ? ui.toggle({
                          id: 'btnCopyPrompt',
                          label: '复制正向提示词',
                          value: false,
                          onChange: () => {
                            void copyTextToSystemClipboard(metadata.positivePrompt).catch(() => {});
                            statusMsg.set('已复制正向提示词');
                          },
                        })
                      : null,
                    metadata.params.seed
                      ? ui.toggle({
                          id: 'btnCopySeed',
                          label: '复制 Seed',
                          value: false,
                          onChange: () => {
                            void copyTextToSystemClipboard(metadata.params.seed!).catch(() => {});
                            statusMsg.set(`已复制 Seed：${metadata.params.seed}`);
                          },
                        })
                      : null,
                  )
                : null,
            ),
          );

          overviewChildren.push(
            ui.group(
              '写入右侧栏（标签 / 描述）',
              ui.note(
                previewTags.length > 0
                  ? `标签状态：已写入 ${matchedExistingCount}/${previewTags.length} 个模型标签（点击下方按钮立即生效）`
                  : '当前打标规则未勾选任何标签项',
              ),
              previewTags.length > 0 || removableCount > 0
                ? ui.row(
                    previewTags.length > 0
                      ? ui.toggle({
                          id: 'btnApplyTagsNow',
                          label: `写入 ${previewTags.length} 个标签`,
                          value: false,
                          onChange: () => {
                            statusMsg.set('正在写入标签…');
                            void (async () => {
                              try {
                                const tagIds = await ensureTagIds(api, previewTags);
                                if (tagIds.length > 0) {
                                  await api.tags.assign([assetId], tagIds);
                                  for (const t of previewTags) activeAssetTagNames.add(t.toLowerCase());
                                  assetMeta = await api.assets.getMetadata(assetId).catch(() => assetMeta);
                                  statusMsg.set(`已立即写入 ${tagIds.length} 个模型/LoRA 标签`);
                                  tagTick.set(tagTick.get() + 1);
                                  await api.ui.notify({
                                    severity: 'info',
                                    title: 'ComfyUI 打标',
                                    message: `已写入 ${tagIds.length} 个模型/LoRA 标签`,
                                  });
                                }
                              } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                statusMsg.set(`写入标签失败：${msg}`);
                                await api.ui.notify({ severity: 'error', title: '写入标签失败', message: msg });
                              }
                            })();
                          },
                        })
                      : null,
                    removableCount > 0
                      ? ui.toggle({
                          id: 'btnClearTagsNow',
                          label: `清除本图 ${removableCount} 个模型标签`,
                          value: false,
                          onChange: () => {
                            statusMsg.set('正在清除本图模型标签…');
                            void (async () => {
                              try {
                                const freshMeta = await api.assets.getMetadata(assetId);
                                assetMeta = freshMeta;
                                const toRemove = (freshMeta.tags ?? [])
                                  .filter((t) => candidateSet.has(t.name.toLowerCase()));
                                if (toRemove.length > 0) {
                                  await api.tags.remove([assetId], toRemove.map((t) => t.id));
                                  for (const t of toRemove) activeAssetTagNames.delete(t.name.toLowerCase());
                                  statusMsg.set(`已清除本图 ${toRemove.length} 个模型/LoRA 标签`);
                                  tagTick.set(tagTick.get() + 1);
                                  await api.ui.notify({
                                    severity: 'info',
                                    title: 'ComfyUI 标签',
                                    message: `已清除本图 ${toRemove.length} 个模型/LoRA 标签`,
                                  });
                                } else {
                                  statusMsg.set('本图没有可清除的模型标签');
                                }
                              } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                statusMsg.set(`清除标签失败：${msg}`);
                                await api.ui.notify({ severity: 'error', title: '清除标签失败', message: msg });
                              }
                            })();
                          },
                        })
                      : null,
                  )
                : null,
              metadata.positivePrompt
                ? ui.toggle({
                    id: 'btnWritePromptToDesc',
                    label: '将正向提示词写入右侧「描述」栏',
                    value: false,
                    description: '写入后可直接在右侧栏多行查看，且支持 Serpent 顶部搜索框全文检索提示词',
                    onChange: () => {
                      statusMsg.set('正在写入右侧描述栏…');
                      void (async () => {
                        try {
                          const fresh = await api.assets.getMetadata(assetId);
                          const updated = await api.assets.setMetadata({
                            assetId,
                            expectedVersion: fresh.entityVersion,
                            description: metadata.positivePrompt.slice(0, 10_000),
                          });
                          assetMeta = updated;
                          statusMsg.set('已将正向提示词写入右侧「描述」栏');
                          await api.ui.notify({
                            severity: 'info',
                            title: 'ComfyUI 元数据',
                            message: '已将正向提示词写入右侧「描述」栏',
                          });
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : String(err);
                          statusMsg.set(`写入描述失败：${msg}`);
                          await api.ui.notify({ severity: 'error', title: '写入描述失败', message: msg });
                        }
                      })();
                    },
                  })
                : null,
            ),
          );
        }

        // Tab 2: Manual URL bindings separated cleanly by Models vs LoRAs
        const bindChildren: WidgetChild[] = [];
        if (editableItems.length === 0) {
          bindChildren.push(
            ui.group(
              '无可绑定项',
              ui.note('当前图片没有检测到模型或 LoRA。可在右键菜单「ComfyUI 元数据 → 管理 ComfyUI 模型链接库」中维护全局链接。'),
            ),
          );
        } else {
          bindChildren.push(
            ui.note('填写 http(s):// 链接后点右下角保存，按完整文件名全库复用；清空并保存可解绑。'),
          );

          const modelItems = editableItems
            .map((item, idx) => ({ item, idx }))
            .filter(({ item }) => item.kindLabel === '底模');
          const loraItems = editableItems
            .map((item, idx) => ({ item, idx }))
            .filter(({ item }) => item.kindLabel !== '底模');

          const buildUrlInput = (item: BindableModelItem, idx: number) => {
            const val = draftUrls.get(item.name) ?? '';
            const trimmed = val.trim();
            const desc = !trimmed
              ? undefined
              : isSafeHttpUrl(trimmed)
                ? '✓ 有效链接'
                : '⚠ 需以 http:// 或 https:// 开头';
            const label = item.weightText !== '-'
              ? `${item.name}  (${item.weightText})`
              : item.name;
            return ui.text({
              id: `modelUrl_${idx}`,
              label: clip(label, 150),
              value: val,
              ...(desc ? { description: desc } : {}),
              onChange: (nextVal) => {
                draftUrls.set(item.name, nextVal);
              },
            });
          };

          if (modelItems.length > 0) {
            bindChildren.push(
              ui.group('底模', ...modelItems.map(({ item, idx }) => buildUrlInput(item, idx))),
            );
          }
          if (loraItems.length > 0) {
            bindChildren.push(
              ui.group('LoRA', ...loraItems.map(({ item, idx }) => buildUrlInput(item, idx))),
            );
          }
        }

        // Tab 3: Tagging rules grouped cleanly with side-by-side prefix row
        const taggingChildren: WidgetChild[] = [
          ui.group(
            '打标范围与格式',
            ui.switch({
              id: 'cfgIncludeModels',
              label: '写入底模标签',
              value: draftTagConfig.includeModels,
              onChange: (v) => { draftTagConfig.includeModels = v; },
            }),
            ui.switch({
              id: 'cfgIncludeLoras',
              label: '写入 LoRA 标签',
              value: draftTagConfig.includeLoras,
              onChange: (v) => { draftTagConfig.includeLoras = v; },
            }),
            ui.switch({
              id: 'cfgUsePrefix',
              label: '附带分类前缀',
              value: draftTagConfig.usePrefix,
              description: '在完整名称前附加底模/LoRA 前缀',
              onChange: (v) => { draftTagConfig.usePrefix = v; },
            }),
            ui.switch({
              id: 'cfgStripExtension',
              label: '移除扩展名（.safetensors 等）',
              value: draftTagConfig.stripExtension,
              description: '默认关闭，保留完整文件名',
              onChange: (v) => { draftTagConfig.stripExtension = v; },
            }),
          ),
          draftTagConfig.usePrefix
            ? ui.group(
                '前缀文字',
                ui.row(
                  ui.text({
                    id: 'cfgModelPrefix',
                    label: '底模前缀',
                    value: draftTagConfig.modelPrefix,
                    onChange: (v) => { draftTagConfig.modelPrefix = v.slice(0, 32); },
                  }),
                  ui.text({
                    id: 'cfgLoraPrefix',
                    label: 'LoRA 前缀',
                    value: draftTagConfig.loraPrefix,
                    onChange: (v) => { draftTagConfig.loraPrefix = v.slice(0, 32); },
                  }),
                ),
              )
            : null,
          ui.group(
            `当前图片标签预览（${previewTags.length}）`,
            ui.list({
              columns: ['将写入的标签'],
              rows: previewTags.map((t) => [t]),
              emptyText: '当前设置不会生成标签',
            }),
          ),
        ];

        return ui.column(
          statusMsg.get() ? ui.note(`✓ ${statusMsg.get()}`) : null,
          ui.tabs({
            id: 'mainTabs',
            value: activeTab.get(),
            onChange: (next) => activeTab.set(next),
            tabs: [
              { id: 'overview', label: '参数与提示词', children: overviewChildren },
              { id: 'bind', label: `绑定链接 (${editableItems.length})`, children: bindChildren },
              { id: 'tagging', label: '打标规则', children: taggingChildren },
            ],
          }),
        );
      },
    });

    if (dialogResult === null) return;

    // Persist URL bindings & tagging config
    let savedLinksCount = 0;
    let invalidUrls: string[] = [];

    for (const item of editableItems) {
      const rawUrl = (draftUrls.get(item.name) ?? '').trim();
      const existing = lookupModelLink(store.modelLinks, item.name);
      const targetKey = existing ? existing.key : item.name;
      if (!rawUrl) {
        if (existing) {
          delete store.modelLinks[targetKey];
          savedLinksCount++;
        }
      } else if (isSafeHttpUrl(rawUrl)) {
        if (existing?.record.url !== rawUrl) {
          store.modelLinks[targetKey] = {
            url: rawUrl,
            updatedAt: new Date().toISOString(),
          };
          savedLinksCount++;
        }
      } else {
        invalidUrls.push(item.name);
      }
    }

    store.tagConfig = sanitizeTagConfig(draftTagConfig);
    await saveStore(serpent, store, dataDir);

    const parts: string[] = [];
    if (savedLinksCount > 0) parts.push(`已更新 ${savedLinksCount} 条模型链接`);
    if (parts.length === 0) parts.push('设置已保存');
    if (invalidUrls.length > 0) {
      parts.push(`跳过 ${invalidUrls.length} 个格式无效的链接（需 http/https 开头）`);
    }

    await api.ui.notify({
      severity: invalidUrls.length > 0 ? 'warning' : 'info',
      title: 'ComfyUI 元数据',
      message: parts.join('；'),
    });
  });

  // 2) Extract models & LoRAs and batch-assign Serpent tags
  serpent.commands.register('comfy.tag-selected', async (context) => {
    const api = resolveScopedApi(serpent, context);
    const { assetIds } = extractSelection(context);
    if (assetIds.length === 0) {
      await api.ui.notify({ severity: 'info', title: 'ComfyUI 自动打标', message: '请先选择至少一张图片。' });
      return;
    }

    const { data: store } = await loadStore(serpent);
    const summary = await applyTagsToAssets(api, assetIds, store.tagConfig);

    if (summary.taggedAssets === 0) {
      await api.ui.notify({
        severity: 'warning',
        title: 'ComfyUI 自动打标',
        message: `所选 ${summary.total} 项中未检测到可打标的 ComfyUI 模型或 LoRA（无元数据 ${summary.skippedNoMetadata} 项）。`,
      });
      return;
    }

    await api.ui.notify({
      severity: 'info',
      title: 'ComfyUI 自动打标完成',
      message: `已为 ${summary.taggedAssets}/${summary.total} 项写入标签（共涉及 ${summary.appliedNames.length} 个模型/LoRA 标签${summary.skippedNoMetadata > 0 ? `，跳过无元数据 ${summary.skippedNoMetadata} 项` : ''}）。`,
    });
  });

  // 3) Manage the global Model/LoRA -> URL dictionary & backup/import
  serpent.commands.register('comfy.manage-links', async (context) => {
    const api = resolveScopedApi(serpent, context);
    const { data: store, dataDir } = await loadStore(serpent);

    let newModelName = '';
    let newModelUrl = '';
    let importJsonText = '';
    let mutatedLive = false;

    const dialogResult = await api.ui.openDialog({
      title: 'ComfyUI 模型链接库',
      submitLabel: '保存 / 导入',
      render(ui) {
        const activeTab = ui.state<string>('list');
        const statusMsg = ui.state<string>('');
        const selectedKey = ui.state<string>('');

        const entries = Object.entries(store.modelLinks).sort((a, b) => a[0].localeCompare(b[0]));
        const options = entries.map(([name]) => ({
          value: name,
          label: clip(name, 120),
        }));
        const currentKey = options.some((o) => o.value === selectedKey.get())
          ? selectedKey.get()
          : (options[0]?.value ?? '');
        const currentUrl = currentKey ? (store.modelLinks[currentKey]?.url ?? '') : '';

        return ui.column(
          statusMsg.get() ? ui.note(`✓ ${statusMsg.get()}`) : null,
          ui.tabs({
            id: 'manageTabs',
            value: activeTab.get(),
            onChange: (next) => activeTab.set(next),
            tabs: [
              {
                id: 'list',
                label: `已绑定 (${entries.length})`,
                children: [
                  ui.group(
                    '模型链接列表',
                    ui.list({
                      columns: ['模型 / LoRA 文件名', '网页链接'],
                      rows: entries.map(([k, v]) => [k, clip(v.url, 64)]),
                      emptyText: '暂无已绑定的模型链接',
                    }),
                  ),
                  options.length > 0
                    ? ui.group(
                        '快捷操作',
                        ui.select({
                          id: 'manageSelect',
                          label: '选择模型 / LoRA',
                          value: currentKey,
                          options,
                          description: clip(currentUrl, 120),
                          onChange: (val) => selectedKey.set(val),
                        }),
                        ui.row(
                          ui.toggle({
                            id: 'btnManageOpen',
                            label: '打开选中网页',
                            value: false,
                            onChange: () => {
                              if (isSafeHttpUrl(currentUrl)) {
                                void openUrlInSystemBrowser(currentUrl).catch(() => {});
                                statusMsg.set(`已打开：${clip(currentUrl, 64)}`);
                              }
                            },
                          }),
                          ui.toggle({
                            id: 'btnManageDelete',
                            label: '删除选中绑定',
                            value: false,
                            onChange: () => {
                              if (currentKey && currentKey in store.modelLinks) {
                                delete store.modelLinks[currentKey];
                                mutatedLive = true;
                                void saveStore(serpent, store, dataDir).catch(() => {});
                                statusMsg.set(`已删除：${currentKey}`);
                              }
                            },
                          }),
                        ),
                      )
                    : null,
                ],
              },
              {
                id: 'edit',
                label: '新增与备份',
                children: [
                  ui.group(
                    '新增或更新绑定',
                    ui.text({
                      id: 'addModelName',
                      label: '完整文件名',
                      value: newModelName,
                      description: '例如 SushiSpin-Style.safetensors',
                      onChange: (v) => { newModelName = v; },
                    }),
                    ui.text({
                      id: 'addModelUrl',
                      label: '网页链接（http:// 或 https://）',
                      value: newModelUrl,
                      onChange: (v) => { newModelUrl = v; },
                    }),
                  ),
                  ui.group(
                    '跨设备备份 / 导入 JSON',
                    ui.toggle({
                      id: 'btnExportJson',
                      label: '复制全部链接库 JSON 到剪贴板',
                      value: false,
                      onChange: () => {
                        void copyTextToSystemClipboard(JSON.stringify(store.modelLinks, null, 2)).catch(() => {});
                        statusMsg.set(`已复制 ${Object.keys(store.modelLinks).length} 条链接备份 JSON`);
                      },
                    }),
                    ui.text({
                      id: 'importJson',
                      label: '粘贴 JSON 合并导入（可选）',
                      value: importJsonText,
                      description: '格式：{"model.safetensors": "https://..."} 或本插件导出的 JSON',
                      onChange: (v) => { importJsonText = v; },
                    }),
                  ),
                ],
              },
            ],
          }),
        );
      },
    });

    if (dialogResult === null) return;

    const notices: string[] = [];
    let dirty = mutatedLive;

    if (newModelName.trim() && newModelUrl.trim()) {
      if (isSafeHttpUrl(newModelUrl.trim())) {
        const existing = lookupModelLink(store.modelLinks, newModelName.trim());
        const targetKey = existing ? existing.key : newModelName.trim();
        store.modelLinks[targetKey] = {
          url: newModelUrl.trim(),
          updatedAt: new Date().toISOString(),
        };
        dirty = true;
        notices.push(`已绑定 ${targetKey}`);
      } else {
        notices.push('新增链接格式无效（需以 http:// 或 https:// 开头）');
      }
    }

    if (importJsonText.trim()) {
      try {
        const parsed = JSON.parse(importJsonText.trim()) as unknown;
        const normalized = normalizeStoreData(
          parsed && typeof parsed === 'object' && 'modelLinks' in (parsed as Record<string, unknown>)
            ? parsed
            : { modelLinks: parsed },
        );
        let count = 0;
        for (const [k, v] of Object.entries(normalized.modelLinks)) {
          store.modelLinks[k] = v;
          count++;
        }
        if (count > 0) {
          dirty = true;
          notices.push(`已合并导入 ${count} 条链接`);
        }
      } catch {
        notices.push('导入失败：JSON 格式无效');
      }
    }

    if (dirty) {
      await saveStore(serpent, store, dataDir);
    }

    if (notices.length > 0) {
      await api.ui.notify({
        severity: notices.some((n) => n.includes('无效') || n.includes('失败')) ? 'warning' : 'info',
        title: 'ComfyUI 模型链接库',
        message: notices.join('；'),
      });
    }
  });
}

export async function dispose(): Promise<void> {
  // Stateless backend.
}
