import type { ComfyMetadata } from '../parser/comfyui.ts';

export interface ModelLinkRecord {
  url: string;
  note?: string;
  updatedAt: string;
}

export interface TaggingConfig {
  includeModels: boolean;
  includeLoras: boolean;
  usePrefix: boolean;
  modelPrefix: string;
  loraPrefix: string;
  /** Default false: keep full filename ("打标按完整名称，可以附带前缀"). */
  stripExtension: boolean;
}

export interface ComfyPluginStoreData {
  version: 1;
  modelLinks: Record<string, ModelLinkRecord>;
  tagConfig: TaggingConfig;
}

export const DEFAULT_TAG_CONFIG: TaggingConfig = {
  includeModels: true,
  includeLoras: true,
  usePrefix: true,
  modelPrefix: 'model:',
  loraPrefix: 'lora:',
  stripExtension: false,
};

export function createEmptyStore(): ComfyPluginStoreData {
  return {
    version: 1,
    modelLinks: {},
    tagConfig: { ...DEFAULT_TAG_CONFIG },
  };
}

export function isSafeHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function sanitizeTagConfig(input: Partial<TaggingConfig> | null | undefined): TaggingConfig {
  const base = { ...DEFAULT_TAG_CONFIG };
  if (!input || typeof input !== 'object') return base;
  if (typeof input.includeModels === 'boolean') base.includeModels = input.includeModels;
  if (typeof input.includeLoras === 'boolean') base.includeLoras = input.includeLoras;
  if (typeof input.usePrefix === 'boolean') base.usePrefix = input.usePrefix;
  if (typeof input.stripExtension === 'boolean') base.stripExtension = input.stripExtension;
  if (typeof input.modelPrefix === 'string') base.modelPrefix = input.modelPrefix.slice(0, 32);
  if (typeof input.loraPrefix === 'string') base.loraPrefix = input.loraPrefix.slice(0, 32);
  return base;
}

export function normalizeStoreData(raw: unknown): ComfyPluginStoreData {
  const empty = createEmptyStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const obj = raw as Record<string, unknown>;

  const modelLinks: Record<string, ModelLinkRecord> = {};
  if (obj.modelLinks && typeof obj.modelLinks === 'object' && !Array.isArray(obj.modelLinks)) {
    for (const [key, val] of Object.entries(obj.modelLinks as Record<string, unknown>)) {
      const cleanKey = key.trim();
      if (!cleanKey) continue;
      if (typeof val === 'string' && isSafeHttpUrl(val)) {
        modelLinks[cleanKey] = { url: val.trim(), updatedAt: new Date().toISOString() };
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        const rec = val as Record<string, unknown>;
        if (typeof rec.url === 'string' && isSafeHttpUrl(rec.url)) {
          modelLinks[cleanKey] = {
            url: rec.url.trim(),
            ...(typeof rec.note === 'string' && rec.note.trim() ? { note: rec.note.trim().slice(0, 200) } : {}),
            updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString(),
          };
        }
      }
    }
  }

  return {
    version: 1,
    modelLinks,
    tagConfig: sanitizeTagConfig(obj.tagConfig as Partial<TaggingConfig> | undefined),
  };
}

export function lookupModelLink(
  links: Record<string, ModelLinkRecord>,
  modelName: string,
): { key: string; record: ModelLinkRecord } | null {
  if (modelName in links) {
    return { key: modelName, record: links[modelName] };
  }
  const lower = modelName.toLowerCase();
  for (const [k, v] of Object.entries(links)) {
    if (k.toLowerCase() === lower) return { key: k, record: v };
  }
  return null;
}

function formatNameForTag(name: string, stripExtension: boolean): string {
  const trimmed = name.trim();
  if (!stripExtension) return trimmed;
  return trimmed.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/iu, '');
}

export function buildTagsForMetadata(metadata: ComfyMetadata, config: TaggingConfig): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  const pushTag = (raw: string) => {
    const cleaned = raw.trim().slice(0, 255);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(cleaned);
  };

  if (config.includeModels) {
    const prefix = config.usePrefix ? config.modelPrefix : '';
    for (const model of metadata.models) {
      const base = formatNameForTag(model.name, config.stripExtension);
      if (base) pushTag(`${prefix}${base}`);
    }
  }

  if (config.includeLoras) {
    const prefix = config.usePrefix ? config.loraPrefix : '';
    for (const lora of metadata.loras) {
      const base = formatNameForTag(lora.name, config.stripExtension);
      if (base) pushTag(`${prefix}${base}`);
    }
  }

  return tags;
}
