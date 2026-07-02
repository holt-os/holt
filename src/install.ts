/** Run an external command with the terminal attached (installs, logins). */
import { spawn } from 'node:child_process';

export function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'inherit' });
    } catch {
      resolve(-1);
      return;
    }
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}
