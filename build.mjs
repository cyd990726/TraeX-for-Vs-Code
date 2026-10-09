import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true, platform: 'node', external: ['vscode'], sourcemap: true });
await build({ entryPoints: ['src/chat.js'], outfile: 'dist/chat.js', bundle: true, platform: 'browser' });
copyFileSync('media/chat.css', 'dist/chat.css');
