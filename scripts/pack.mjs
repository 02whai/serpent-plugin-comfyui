import archiver from 'archiver';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');
const manifest = JSON.parse(readFileSync(path.join(distDir, 'serpent-plugin.json'), 'utf8'));

const fileName = `${manifest.id}-${manifest.version}-any.zip`;
mkdirSync(releaseDir, { recursive: true });
const zipPath = path.join(releaseDir, fileName);

await new Promise((resolve, reject) => {
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', resolve);
  archive.on('error', reject);

  archive.pipe(output);
  // Serpent requires clean relative POSIX entry names with no leading "./".
  archive.directory(distDir, false);
  archive.finalize();
});

const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(path.join(releaseDir, `${fileName}.sha256`), `${sha256}  ${fileName}\n`, 'utf8');

console.log(`Packed ${zipPath}`);
console.log(`SHA-256: ${sha256}`);
