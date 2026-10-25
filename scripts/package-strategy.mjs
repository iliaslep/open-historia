// Package an already-built Windows folder and its corresponding tracked source.
// Never read runtime profiles, credentials, caches or untracked workspace files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const root = process.cwd();
const output = path.join(root, 'release');
const folder = path.join(output, 'strategy', 'win-unpacked');
await fs.access(path.join(folder, 'Open Historia Strategy.exe'));
const source = new JSZip();
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).split('\0').filter(Boolean);
for (const file of tracked) {
  if (/^(server\/data\/|node_modules\/|release\/|\.git\/)/.test(file)) throw new Error(`Unsafe tracked source: ${file}`);
  source.file(file, await fs.readFile(path.join(root, file)));
}
const options = { type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } };
const sourceBytes = await source.generateAsync(options);
await fs.writeFile(path.join(output, 'Open-Historia-Strategy-0.3.0-Source.zip'), sourceBytes);
const bundle = new JSZip();
async function addFolder(directory, prefix) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), destination = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in Windows build: ${destination}`);
    if (entry.isDirectory()) await addFolder(file, destination);
    else bundle.file(destination, await fs.readFile(file));
  }
}
await addFolder(folder, 'Game');
bundle.file('Source.zip', sourceBytes);
bundle.file('PLAY_WINDOWS_RU.md', await fs.readFile('PLAY_WINDOWS_RU.md'));
bundle.file('LICENSE', await fs.readFile('LICENSE'));
bundle.file('MIGRATION_AND_INTELLIGENCE.md', await fs.readFile('MIGRATION_AND_INTELLIGENCE.md'));
const destination = path.join(output, 'Open-Historia-Strategy-0.3.0-Windows-x64.zip');
await fs.writeFile(destination, await bundle.generateAsync(options));
console.log(destination);
