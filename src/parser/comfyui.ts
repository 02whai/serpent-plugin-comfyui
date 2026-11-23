import { extractImageTextChunks } from './png.ts';

export interface ComfyModelEntry {
  /** Full filename (without directory path), e.g. "krea2_turbo_int8_convrot.safetensors". */
  name: string;
  /** Original raw string from the node input. */
  rawName: string;
  nodeType: string;
  kind: 'checkpoint' | 'unet' | 'diffusion' | 'other';
}

export interface ComfyLoraEntry {
  /** Full filename (without directory path), e.g. "SushiSpin-Style.safetensors". */
  name: string;
  /** Original raw string from the node input. */
  rawName: string;
  strengthModel: number | null;
  strengthClip: number | null;
  nodeType: string;
}

export interface ComfySamplingParams {
  seed?: string;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  denoise?: number;
}

export interface ComfyMetadata {
  format: 'comfyui' | 'a1111' | 'none';
  /** Positive prompt only (negative prompt is intentionally excluded). */
  positivePrompt: string;
  models: ComfyModelEntry[];
  loras: ComfyLoraEntry[];
  params: ComfySamplingParams;
  nodeCount: number;
  sourceChunks: string[];
}

interface ComfyPromptNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
}

type ComfyPromptGraph = Record<string, ComfyPromptNode>;

type LinkRef = [string, number];

function isLinkRef(value: unknown): value is LinkRef {
  return (
    Array.isArray(value)
    && value.length === 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number'
  );
}

function linkNodeId(link: LinkRef): string {
  return String(link[0]);
}

export function normalizeModelFilename(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Normalize Windows & POSIX path separators and take the full file basename.
  const parts = trimmed.split(/[\\/]/u).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

function isEmptyModelValue(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return lower === 'none' || lower === 'null' || lower === 'off' || lower === 'disabled';
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 10_000) / 10_000;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed * 10_000) / 10_000;
    }
  }
  return null;
}

function resolveScalarValue(
  graph: ComfyPromptGraph,
  value: unknown,
  visited = new Set<string>(),
): unknown {
  if (!isLinkRef(value)) return value;
  const id = linkNodeId(value);
  if (visited.has(id)) return undefined;
  visited.add(id);
  const node = graph[id];
  if (!node || !node.inputs) return undefined;

  const inputs = node.inputs;
  for (const key of ['value', 'seed', 'noise_seed', 'int', 'float', 'number', 'text', 'string', 'sampler_name', 'scheduler']) {
    if (key in inputs) {
      const candidate = resolveScalarValue(graph, inputs[key], visited);
      if (candidate !== undefined) return candidate;
    }
  }
  return undefined;
}

const TERMINAL_NODE_PATTERNS = [
  /^SaveImage/iu,
  /^PreviewImage/iu,
  /^VHS_VideoCombine/iu,
  /^SaveAnimated/iu,
  /^SaveVideo/iu,
  /Image\s*Comparer/iu,
];

const SAMPLER_NODE_PATTERNS = [
  /^KSampler/iu,
  /^SamplerCustom/iu,
  /^ClownsharKSampler/iu,
  /^SharkSampler/iu,
  /^FaceDetailer/iu,
  /^UltimateSDUpscale/iu,
];

const EXCLUDED_MODEL_LOADER_PATTERNS = [
  /upscale/iu,
  /vae/iu,
  /clip/iu,
  /controlnet/iu,
  /stylemodel/iu,
  /ipadapter/iu,
  /insightface/iu,
  /pulid/iu,
  /reactor/iu,
  /ultralytics/iu,
  /samloader/iu,
  /groundingdino/iu,
  /florence/iu,
  /joycaption/iu,
  /wd14/iu,
  /tagger/iu,
  /rmbg/iu,
  /birefnet/iu,
  /depth/iu,
  /dwpose/iu,
  /openpose/iu,
  /patch/iu,
];

function collectReachableNodeIds(graph: ComfyPromptGraph): Set<string> {
  const allIds = Object.keys(graph);
  const roots: string[] = [];

  for (const id of allIds) {
    const ct = graph[id]?.class_type ?? '';
    if (TERMINAL_NODE_PATTERNS.some((re) => re.test(ct))) {
      roots.push(id);
    }
  }
  if (roots.length === 0) {
    for (const id of allIds) {
      const ct = graph[id]?.class_type ?? '';
      if (SAMPLER_NODE_PATTERNS.some((re) => re.test(ct))) {
        roots.push(id);
      }
    }
  }
  if (roots.length === 0) {
    return new Set(allIds);
  }

  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const currentId = queue.pop()!;
    if (reachable.has(currentId)) continue;
    const node = graph[currentId];
    if (!node) continue;
    reachable.add(currentId);
    const inputs = node.inputs ?? {};
    for (const val of Object.values(inputs)) {
      if (isLinkRef(val)) {
        const nextId = linkNodeId(val);
        if (!reachable.has(nextId) && graph[nextId]) {
          queue.push(nextId);
        }
      }
    }
  }
  return reachable;
}

function resolveTextFromNode(
  graph: ComfyPromptGraph,
  nodeId: string,
  visited = new Set<string>(),
): string[] {
  if (visited.has(nodeId)) return [];
  visited.add(nodeId);
  const node = graph[nodeId];
  if (!node || !node.inputs) return [];

  const ct = (node.class_type ?? '').toLowerCase();
  const inputs = node.inputs;
  const results: string[] = [];

  // Skip explicit zero-out conditioning nodes.
  if (ct.includes('zeroout')) return [];

  // Direct text-bearing inputs on encoders, prompt upsamplers, or primitive string nodes.
  const directTextKeys = [
    'text',
    'prompt',
    'value',
    'string',
    'clip_l',
    't5xxl',
    'text_g',
    'text_l',
    'positive',
    'instruction',
  ];
  let foundDirect = false;

  for (const key of directTextKeys) {
    if (!(key in inputs)) continue;
    const val = inputs[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      results.push(val.trim());
      foundDirect = true;
    } else if (isLinkRef(val)) {
      const nested = resolveTextFromNode(graph, linkNodeId(val), visited);
      if (nested.length > 0) {
        results.push(...nested);
        foundDirect = true;
      }
    }
  }

  // Conditional / switch / preview passthrough nodes (e.g. PreviewAny / AnySwitch / ImpactSwitch)
  if (!foundDirect) {
    for (const key of ['source', 'on_true', 'on_false', 'input', 'input1', 'input2', 'select', 'a', 'b']) {
      if (!(key in inputs)) continue;
      const val = inputs[key];
      if (isLinkRef(val)) {
        const nested = resolveTextFromNode(graph, linkNodeId(val), visited);
        if (nested.length > 0) {
          results.push(...nested);
          foundDirect = true;
          break;
        }
      }
    }
  }

  // String concatenation nodes (e.g. text_a + text_b, string_a + string_b)
  if (!foundDirect) {
    const concatParts: string[] = [];
    for (const key of Object.keys(inputs).sort()) {
      if (/^(text|string|str|part|prompt)[_-]?([a-z0-9]+)$/iu.test(key)) {
        const val = inputs[key];
        if (typeof val === 'string' && val.trim()) {
          concatParts.push(val.trim());
        } else if (isLinkRef(val)) {
          concatParts.push(...resolveTextFromNode(graph, linkNodeId(val), visited));
        }
      }
    }
    if (concatParts.length > 0) {
      const delimiter = typeof inputs.delimiter === 'string'
        ? inputs.delimiter
        : (typeof inputs.separator === 'string' ? inputs.separator : ', ');
      results.push(concatParts.join(delimiter));
      return results;
    }
  }

  // Conditioning passthrough nodes (FluxGuidance, ConditioningCombine, ReferenceLatent, etc.)
  if (!foundDirect) {
    for (const key of ['conditioning', 'conditioning_1', 'conditioning_2', 'conditioning_to', 'conditioning_from', 'guider', 'basic_pipe']) {
      if (!(key in inputs)) continue;
      const val = inputs[key];
      if (isLinkRef(val)) {
        results.push(...resolveTextFromNode(graph, linkNodeId(val), visited));
      }
    }
  }

  return results;
}

function extractPositivePrompt(graph: ComfyPromptGraph, activeIds: Set<string>): string {
  const collected: string[] = [];
  const seenText = new Set<string>();

  const pushUnique = (items: string[]) => {
    for (const item of items) {
      const cleaned = item.trim();
      if (!cleaned || seenText.has(cleaned)) continue;
      seenText.add(cleaned);
      collected.push(cleaned);
    }
  };

  // 1) Trace from sampler / guider nodes' `positive` or `guider` branches ONLY (never `negative`).
  for (const id of activeIds) {
    const node = graph[id];
    if (!node || !node.inputs) continue;
    const ct = node.class_type ?? '';
    const inputs = node.inputs;

    if (SAMPLER_NODE_PATTERNS.some((re) => re.test(ct)) || /Guider$/iu.test(ct)) {
      if (isLinkRef(inputs.positive)) {
        pushUnique(resolveTextFromNode(graph, linkNodeId(inputs.positive)));
      } else if (typeof inputs.positive === 'string' && inputs.positive.trim()) {
        pushUnique([inputs.positive]);
      }

      if (isLinkRef(inputs.guider)) {
        pushUnique(resolveTextFromNode(graph, linkNodeId(inputs.guider)));
      }

      if (/BasicGuider/iu.test(ct) && isLinkRef(inputs.conditioning)) {
        pushUnique(resolveTextFromNode(graph, linkNodeId(inputs.conditioning)));
      }
    }
  }

  const negativeOnlyIds = new Set<string>();
  const collectSubgraph = (startId: string, out: Set<string>) => {
    const stack = [startId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      const n = graph[cur];
      if (!n?.inputs) continue;
      for (const v of Object.values(n.inputs)) {
        if (isLinkRef(v) && graph[linkNodeId(v)]) stack.push(linkNodeId(v));
      }
    }
  };

  for (const id of activeIds) {
    const node = graph[id];
    if (!node?.inputs) continue;
    if (isLinkRef(node.inputs.negative)) {
      collectSubgraph(linkNodeId(node.inputs.negative), negativeOnlyIds);
    }
  }

  // 2) Fallback for edit/all-in-one nodes (e.g. Easy_QwenEdit2509, TextEncodeQwenImageEdit)
  if (collected.length === 0) {
    for (const id of activeIds) {
      if (negativeOnlyIds.has(id)) continue;
      const node = graph[id];
      if (!node || !node.inputs) continue;
      const title = (node._meta?.title ?? '').toLowerCase();
      if (title.includes('negative') || title.includes('反向') || title.includes('负向')) {
        continue;
      }
      const ct = (node.class_type ?? '').toLowerCase();
      if (ct.includes('cliptextencode') || ct.includes('qwenedit') || ct.includes('textencode') || ct.includes('conditioning')) {
        pushUnique(resolveTextFromNode(graph, id));
      }
    }
  }

  return collected.join('\n');
}

function extractModels(graph: ComfyPromptGraph, activeIds: Set<string>): ComfyModelEntry[] {
  const models: ComfyModelEntry[] = [];
  const seen = new Set<string>();

  const addModel = (rawName: string, nodeType: string, kind: ComfyModelEntry['kind']) => {
    if (isEmptyModelValue(rawName)) return;
    const name = normalizeModelFilename(rawName);
    const dedupeKey = name.toLowerCase();
    if (!name || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    models.push({ name, rawName: rawName.trim(), nodeType, kind });
  };

  for (const id of activeIds) {
    const node = graph[id];
    if (!node || !node.inputs) continue;
    const ct = node.class_type ?? '';
    if (EXCLUDED_MODEL_LOADER_PATTERNS.some((re) => re.test(ct))) continue;
    const inputs = node.inputs;

    const ckpt = resolveScalarValue(graph, inputs.ckpt_name);
    if (typeof ckpt === 'string') {
      addModel(ckpt, ct, 'checkpoint');
    }

    const unet = resolveScalarValue(graph, inputs.unet_name);
    if (typeof unet === 'string') {
      addModel(unet, ct, 'unet');
    }

    const diffusion = resolveScalarValue(graph, inputs.diffusion_model ?? inputs.model_name);
    if (typeof diffusion === 'string' && !/lora/iu.test(ct)) {
      addModel(diffusion, ct, 'diffusion');
    }
  }

  return models;
}

function extractLoras(graph: ComfyPromptGraph, activeIds: Set<string>): ComfyLoraEntry[] {
  const loras: ComfyLoraEntry[] = [];
  const seen = new Set<string>();

  const addLora = (
    rawName: string,
    strengthModel: number | null,
    strengthClip: number | null,
    nodeType: string,
  ) => {
    if (isEmptyModelValue(rawName)) return;
    // Skip zero-weight entries (common leftover slots in dynamic LoRA stacks).
    if (strengthModel !== null && Math.abs(strengthModel) < 1e-9) {
      return;
    }
    const name = normalizeModelFilename(rawName);
    if (!name) return;
    const dedupeKey = `${name.toLowerCase()}::${strengthModel ?? ''}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    loras.push({
      name,
      rawName: rawName.trim(),
      strengthModel,
      strengthClip,
      nodeType,
    });
  };

  for (const id of activeIds) {
    const node = graph[id];
    if (!node || !node.inputs) continue;
    const ct = node.class_type ?? '';
    const ctLower = ct.toLowerCase();
    const inputs = node.inputs;

    // 1) Power Lora Loader (rgthree): inputs.lora_1 = { on: true, lora: "...", strength: 0.8 }
    let matchedRgthree = false;
    for (const [key, val] of Object.entries(inputs)) {
      if (/^lora_\d+$/iu.test(key) && val && typeof val === 'object' && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>;
        if (obj.on === false) {
          matchedRgthree = true;
          continue;
        }
        if (typeof obj.lora === 'string') {
          matchedRgthree = true;
          const strengthModel = toFiniteNumber(obj.strength);
          const strengthClip = toFiniteNumber(obj.strengthTwo ?? obj.strength_clip);
          addLora(obj.lora, strengthModel, strengthClip, ct);
        }
      }
    }
    if (matchedRgthree) continue;

    // 2) LoRAStackDynamic / CR LoRA Stack / LoraLoaderStack / easy loraStack
    const indexedLoraKeys = Object.keys(inputs).filter((k) => /^lora_name_\d+$/iu.test(k));
    if (indexedLoraKeys.length > 0) {
      const explicitCount = toFiniteNumber(resolveScalarValue(graph, inputs.lora_count ?? inputs.num_loras));
      const inputMode = String(resolveScalarValue(graph, inputs.input_mode) ?? 'dropdown').toLowerCase();
      const maxIndex = explicitCount !== null && explicitCount >= 0
        ? Math.floor(explicitCount)
        : 20;

      for (let i = 1; i <= maxIndex; i++) {
        const switchKey = `switch_${i}`;
        if (switchKey in inputs) {
          const sw = resolveScalarValue(graph, inputs[switchKey]);
          if (sw === false || String(sw).toLowerCase() === 'off') continue;
        }

        const textName = resolveScalarValue(graph, inputs[`lora_name_text_${i}`]);
        const dropName = resolveScalarValue(graph, inputs[`lora_name_${i}`]);
        const rawName = (inputMode === 'text' && !isEmptyModelValue(textName))
          ? String(textName)
          : (typeof dropName === 'string' ? dropName : (typeof textName === 'string' ? textName : ''));

        if (isEmptyModelValue(rawName)) continue;

        const baseStrength = toFiniteNumber(resolveScalarValue(graph, inputs[`strength_${i}`]));
        const modelStrength = toFiniteNumber(
          resolveScalarValue(
            graph,
            inputs[`model_weight_${i}`]
              ?? inputs[`lora_wt_${i}`]
              ?? inputs[`model_str_${i}`]
              ?? inputs[`strength_model_${i}`],
          ),
        );
        const clipStrength = toFiniteNumber(
          resolveScalarValue(
            graph,
            inputs[`clip_weight_${i}`]
              ?? inputs[`clip_str_${i}`]
              ?? inputs[`clip_strength_${i}`]
              ?? inputs[`strength_clip_${i}`],
          ),
        );

        // In LoRAStackDynamic (simple visibility mode), `strength_i` is the actual active strength
        // while `model_strength_i` often stays at default 1.0.
        const effectiveStrength = baseStrength ?? modelStrength ?? toFiniteNumber(resolveScalarValue(graph, inputs[`model_strength_${i}`]));
        addLora(rawName, effectiveStrength, clipStrength, ct);
      }
      continue;
    }

    // 3) Standard LoraLoader / LoraLoaderModelOnly / LoraLoaderBypass / etc.
    if (ctLower.includes('lora') && 'lora_name' in inputs) {
      const rawName = resolveScalarValue(graph, inputs.lora_name);
      if (typeof rawName === 'string') {
        const strengthModel = toFiniteNumber(
          resolveScalarValue(graph, inputs.strength_model ?? inputs.strength ?? inputs.weight),
        );
        const strengthClip = toFiniteNumber(resolveScalarValue(graph, inputs.strength_clip));
        addLora(rawName, strengthModel, strengthClip, ct);
      }
    }
  }

  return loras;
}

function extractSamplingParams(graph: ComfyPromptGraph, activeIds: Set<string>): ComfySamplingParams {
  const params: ComfySamplingParams = {};

  // Prefer the primary generation sampler (denoise === 1, or highest step count) over hires/refine passes.
  const samplerNodes: Array<{ id: string; node: ComfyPromptNode; score: number }> = [];
  for (const id of activeIds) {
    const node = graph[id];
    if (!node || !node.inputs) continue;
    const ct = node.class_type ?? '';
    if (SAMPLER_NODE_PATTERNS.some((re) => re.test(ct))) {
      const denoise = toFiniteNumber(resolveScalarValue(graph, node.inputs.denoise)) ?? 1;
      const steps = toFiniteNumber(resolveScalarValue(graph, node.inputs.steps)) ?? 0;
      const score = (Math.abs(denoise - 1) < 1e-4 ? 1000 : 0) + steps;
      samplerNodes.push({ id, node, score });
    }
  }
  samplerNodes.sort((a, b) => b.score - a.score);

  for (const { node } of samplerNodes) {
    const inputs = node.inputs!;
    if (params.seed === undefined) {
      const seedVal = resolveScalarValue(graph, inputs.seed ?? inputs.noise_seed);
      if (seedVal !== undefined && seedVal !== null && String(seedVal).trim() !== '') {
        params.seed = String(seedVal);
      }
    }
    if (params.steps === undefined) {
      const steps = toFiniteNumber(resolveScalarValue(graph, inputs.steps));
      if (steps !== null) params.steps = steps;
    }
    if (params.cfg === undefined) {
      const cfg = toFiniteNumber(resolveScalarValue(graph, inputs.cfg));
      if (cfg !== null) params.cfg = cfg;
    }
    if (params.sampler === undefined) {
      const sampler = resolveScalarValue(graph, inputs.sampler_name ?? inputs.sampler);
      if (typeof sampler === 'string' && sampler.trim()) params.sampler = sampler.trim();
    }
    if (params.scheduler === undefined) {
      const scheduler = resolveScalarValue(graph, inputs.scheduler);
      if (typeof scheduler === 'string' && scheduler.trim()) params.scheduler = scheduler.trim();
    }
    if (params.denoise === undefined) {
      const denoise = toFiniteNumber(resolveScalarValue(graph, inputs.denoise));
      if (denoise !== null) params.denoise = denoise;
    }
  }

  for (const id of activeIds) {
    const node = graph[id];
    if (!node || !node.inputs) continue;
    const ct = node.class_type ?? '';
    const inputs = node.inputs;

    // Standalone sampler/scheduler/noise/guidance nodes in SamplerCustomAdvanced graphs
    if (params.seed === undefined && /RandomNoise|Seed/iu.test(ct)) {
      const seedVal = resolveScalarValue(graph, inputs.noise_seed ?? inputs.seed);
      if (seedVal !== undefined && seedVal !== null && String(seedVal).trim() !== '') {
        params.seed = String(seedVal);
      }
    }
    if (params.sampler === undefined && /KSamplerSelect/iu.test(ct)) {
      const sampler = resolveScalarValue(graph, inputs.sampler_name);
      if (typeof sampler === 'string' && sampler.trim()) params.sampler = sampler.trim();
    }
    if (/ManualSigmas/iu.test(ct) && params.steps === undefined && typeof inputs.sigmas === 'string') {
      const count = inputs.sigmas.split(',').map((s) => s.trim()).filter(Boolean).length;
      if (count > 1) params.steps = count - 1;
    }
    if (params.scheduler === undefined && /Scheduler/iu.test(ct)) {
      const scheduler = resolveScalarValue(graph, inputs.scheduler);
      if (typeof scheduler === 'string' && scheduler.trim()) params.scheduler = scheduler.trim();
      if (params.steps === undefined) {
        const steps = toFiniteNumber(resolveScalarValue(graph, inputs.steps));
        if (steps !== null) params.steps = steps;
      }
      if (params.denoise === undefined) {
        const denoise = toFiniteNumber(resolveScalarValue(graph, inputs.denoise));
        if (denoise !== null) params.denoise = denoise;
      }
    }
    if (params.cfg === undefined && /FluxGuidance/iu.test(ct)) {
      const guidance = toFiniteNumber(resolveScalarValue(graph, inputs.guidance));
      if (guidance !== null) params.cfg = guidance;
    }
  }

  return params;
}

/**
 * Fallback parser for Automatic1111-style `parameters` PNG text chunk.
 */
function parseA1111Parameters(raw: string, sourceChunks: string[]): ComfyMetadata {
  const lines = raw.split(/\r?\n/u);
  const posLines: string[] = [];
  let paramLine = '';

  for (const line of lines) {
    if (line.startsWith('Negative prompt:')) {
      // User explicitly does not want negative prompts.
      break;
    }
    if (line.startsWith('Steps:')) {
      paramLine = line;
      break;
    }
    posLines.push(line);
  }
  if (!paramLine) {
    const found = lines.find((l) => l.startsWith('Steps:'));
    if (found) paramLine = found;
  }

  const positivePrompt = posLines.join('\n').trim();
  const loras: ComfyLoraEntry[] = [];
  const loraRegex = /<lora:([^:>]+):([0-9.+-]+)(?::([0-9.+-]+))?>/giu;
  for (const match of positivePrompt.matchAll(loraRegex)) {
    loras.push({
      name: normalizeModelFilename(match[1]),
      rawName: match[1],
      strengthModel: toFiniteNumber(match[2]),
      strengthClip: match[3] ? toFiniteNumber(match[3]) : null,
      nodeType: 'A1111',
    });
  }

  const models: ComfyModelEntry[] = [];
  const params: ComfySamplingParams = {};
  if (paramLine) {
    const modelMatch = paramLine.match(/Model:\s*([^,]+)/u);
    if (modelMatch?.[1]) {
      models.push({
        name: normalizeModelFilename(modelMatch[1]),
        rawName: modelMatch[1].trim(),
        nodeType: 'A1111',
        kind: 'checkpoint',
      });
    }
    const seedMatch = paramLine.match(/Seed:\s*(\d+)/u);
    if (seedMatch?.[1]) params.seed = seedMatch[1];
    const stepsMatch = paramLine.match(/Steps:\s*(\d+)/u);
    if (stepsMatch?.[1]) params.steps = Number(stepsMatch[1]);
    const cfgMatch = paramLine.match(/CFG scale:\s*([0-9.]+)/u);
    if (cfgMatch?.[1]) params.cfg = Number(cfgMatch[1]);
    const samplerMatch = paramLine.match(/Sampler:\s*([^,]+)/u);
    if (samplerMatch?.[1]) params.sampler = samplerMatch[1].trim();
  }

  return {
    format: 'a1111',
    positivePrompt,
    models,
    loras,
    params,
    nodeCount: 0,
    sourceChunks,
  };
}

export function parseComfyPromptGraph(graph: ComfyPromptGraph, sourceChunks: string[] = ['prompt']): ComfyMetadata {
  const activeIds = collectReachableNodeIds(graph);
  const models = extractModels(graph, activeIds);
  const loras = extractLoras(graph, activeIds);
  const positivePrompt = extractPositivePrompt(graph, activeIds);
  const params = extractSamplingParams(graph, activeIds);

  return {
    format: 'comfyui',
    positivePrompt,
    models,
    loras,
    params,
    nodeCount: Object.keys(graph).length,
    sourceChunks,
  };
}

export function parseComfyMetadataFromBytes(bytes: Uint8Array): ComfyMetadata {
  const { chunks } = extractImageTextChunks(bytes);
  const sourceChunks = Object.keys(chunks);

  if (typeof chunks.prompt === 'string' && chunks.prompt.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(chunks.prompt) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parseComfyPromptGraph(parsed as ComfyPromptGraph, sourceChunks);
      }
    } catch {
      // Fall through to other chunks if prompt JSON is malformed.
    }
  }

  if (typeof chunks.parameters === 'string' && chunks.parameters.trim().length > 0) {
    return parseA1111Parameters(chunks.parameters, sourceChunks);
  }

  return {
    format: 'none',
    positivePrompt: '',
    models: [],
    loras: [],
    params: {},
    nodeCount: 0,
    sourceChunks,
  };
}
