import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createEmptyStore,
  normalizeStoreData,
  type ComfyPluginStoreData,
} from './shared.ts';

export * from './shared.ts';

const STORE_FILENAME = 'comfyui-store.json';

export function readStoreFromDirectory(dirPath: string): ComfyPluginStoreData {
  const filePath = path.join(dirPath, STORE_FILENAME);
  if (!existsSync(filePath)) return createEmptyStore();
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return normalizeStoreData(raw);
  } catch {
    return createEmptyStore();
  }
}

export function writeStoreToDirectory(dirPath: string, data: ComfyPluginStoreData): void {
  mkdirSync(dirPath, { recursive: true });
  const filePath = path.join(dirPath, STORE_FILENAME);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}
