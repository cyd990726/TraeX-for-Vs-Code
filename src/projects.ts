import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
function canonical(path: string) {
  let value = resolve(path);
  try { value = realpathSync(value); } catch { /* A removed directory still compares lexically. */ }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
export function sameProject(cwd: unknown, project: string) { return typeof cwd === 'string' && canonical(cwd) === canonical(project); }
