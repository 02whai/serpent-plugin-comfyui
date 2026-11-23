import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(path.join(distDir, 'entry'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(distDir, 'entry', 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  minify: false,
});

copyFileSync(path.join(root, 'serpent-plugin.json'), path.join(distDir, 'serpent-plugin.json'));
copyFileSync(path.join(root, 'LICENSE'), path.join(distDir, 'LICENSE'));

for (const doc of ['README.md', 'README.zh-CN.md']) {
  const srcPath = path.join(root, doc);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, path.join(distDir, doc));
  }
}

console.log(`Built Serpent plugin package into ${distDir}`);
