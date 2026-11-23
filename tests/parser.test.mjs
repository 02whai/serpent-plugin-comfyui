import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { extractPngTextChunks } from '../src/parser/png.ts';
import { parseComfyMetadataFromBytes, parseComfyPromptGraph } from '../src/parser/comfyui.ts';

function buildPngWithChunks(entries) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig];

  const makeChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); // CRC not validated by text extractor
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
  };

  for (const entry of entries) {
    if (entry.type === 'tEXt') {
      parts.push(makeChunk('tEXt', Buffer.concat([Buffer.from(entry.key), Buffer.from([0]), Buffer.from(entry.value, 'utf8')])));
    } else if (entry.type === 'iTXt') {
      const payload = entry.compressed ? deflateSync(Buffer.from(entry.value, 'utf8')) : Buffer.from(entry.value, 'utf8');
      parts.push(
        makeChunk(
          'iTXt',
          Buffer.concat([
            Buffer.from(entry.key),
            Buffer.from([0, entry.compressed ? 1 : 0, 0, 0, 0]),
            payload,
          ]),
        ),
      );
    }
  }
  parts.push(makeChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

test('extractPngTextChunks parses tEXt and compressed iTXt chunks', () => {
  const png = buildPngWithChunks([
    { type: 'tEXt', key: 'prompt', value: '{"1":{"class_type":"SaveImage"}}' },
    { type: 'iTXt', key: 'comment', value: '中文测试', compressed: true },
  ]);
  const chunks = extractPngTextChunks(png);
  assert.equal(chunks.prompt, '{"1":{"class_type":"SaveImage"}}');
  assert.equal(chunks.comment, '中文测试');
});

test('parseComfyPromptGraph extracts UNET, LoRAStackDynamic (respecting lora_count & zero weights), positive prompt only', () => {
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux/krea2_turbo_int8.safetensors' } },
    '2': {
      class_type: 'LoRAStackDynamic',
      inputs: {
        input_mode: 'dropdown',
        lora_count: 3,
        lora_name_1: 'style_a.safetensors',
        strength_1: 0.85,
        clip_strength_1: 1,
        lora_name_2: 'zero_off.safetensors',
        strength_2: 0,
        clip_strength_2: 1,
        lora_name_3: 'folder/style_b.safetensors',
        strength_3: 0.4,
        clip_strength_3: 1,
        lora_name_4: 'beyond_count.safetensors',
        strength_4: 0.9,
      },
    },
    '3': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'sunny anime girl on rooftop' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: ['3', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: 'bad anatomy, blurry, ugly' } },
    '6': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        seed: 123456789,
        steps: 24,
        cfg: 4.5,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], lora_stack: ['2', 0] } },
  };

  const result = parseComfyPromptGraph(graph);
  assert.equal(result.format, 'comfyui');
  assert.equal(result.positivePrompt, 'sunny anime girl on rooftop');
  assert.doesNotMatch(result.positivePrompt, /bad anatomy/);
  assert.deepEqual(result.models.map((m) => m.name), ['krea2_turbo_int8.safetensors']);
  assert.deepEqual(
    result.loras.map((l) => [l.name, l.strengthModel]),
    [
      ['style_a.safetensors', 0.85],
      ['style_b.safetensors', 0.4],
    ],
  );
  assert.equal(result.params.seed, '123456789');
  assert.equal(result.params.steps, 24);
  assert.equal(result.params.cfg, 4.5);
  assert.equal(result.params.sampler, 'euler');
});

test('parseComfyPromptGraph supports Power Lora Loader (rgthree) and ignores disabled slots', () => {
  const graph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'animagineXL.safetensors' } },
    '2': {
      class_type: 'Power Lora Loader (rgthree)',
      inputs: {
        model: ['1', 0],
        lora_1: { on: true, lora: 'sub/char_v1.safetensors', strength: 0.75 },
        lora_2: { on: false, lora: 'disabled_lora.safetensors', strength: 0.9 },
      },
    },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '1girl, blue eyes' } },
    '4': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['3', 0], steps: 20, seed: 42 } },
    '5': { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
  };
  const result = parseComfyPromptGraph(graph);
  assert.deepEqual(result.models.map((m) => m.name), ['animagineXL.safetensors']);
  assert.deepEqual(result.loras.map((l) => [l.name, l.strengthModel]), [['char_v1.safetensors', 0.75]]);
});

test('parseComfyMetadataFromBytes falls back to A1111 parameters without negative prompt', () => {
  const png = buildPngWithChunks([
    {
      type: 'tEXt',
      key: 'parameters',
      value: 'masterpiece, forest <lora:leaf_style:0.7>\nNegative prompt: lowres, bad hands\nSteps: 28, Sampler: DPM++ 2M, CFG scale: 7, Seed: 98765, Model: dreamshaper_8',
    },
  ]);
  const res = parseComfyMetadataFromBytes(png);
  assert.equal(res.format, 'a1111');
  assert.equal(res.positivePrompt, 'masterpiece, forest <lora:leaf_style:0.7>');
  assert.deepEqual(res.models.map((m) => m.name), ['dreamshaper_8']);
  assert.deepEqual(res.loras.map((l) => [l.name, l.strengthModel]), [['leaf_style', 0.7]]);
  assert.equal(res.params.seed, '98765');
});
