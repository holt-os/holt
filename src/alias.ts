/** Install/remove a custom launch alias (e.g. `ai`) in the user's shell rc. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const START = '# >>> holt launch alias >>>';
const END = '# <<< holt launch alias <<<';

export function rcFile(): string {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return join(homedir(), '.zshrc');
  if (shell.includes('bash')) return join(homedir(), '.bashrc');
  return join(homedir(), '.profile');
}

export interface AliasResult {
  ok: boolean;
  file: string;
  message?: string;
}

export function installAlias(name: string): AliasResult {
  const file = rcFile();
  const block = `${START}\nalias ${name}="holt chat"\n${END}`;
  try {
    let content = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const re = new RegExp(`${START}[\\s\\S]*?${END}`);
    if (re.test(content)) content = content.replace(re, block);
    else content = content.replace(/\n*$/, '\n') + block + '\n';
    writeFileSync(file, content, 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, message: `Could not write ${file}: ${(e as Error).message}` };
  }
}

export function currentAlias(): string | null {
  const file = rcFile();
  try {
    const m = readFileSync(file, 'utf8').match(/alias\s+([^\s=]+)="holt chat"/);
    return m ? (m[1] as string) : null;
  } catch {
    return null;
  }
}

export function removeAlias(): AliasResult {
  const file = rcFile();
  try {
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf8').replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n*`), '\n');
      writeFileSync(file, content, 'utf8');
    }
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, message: (e as Error).message };
  }
}
