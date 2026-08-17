/**
 * `holt update`: one word to get the latest Holt. Non-technical users will
 * never run an npm command, so without this they would stay on their install
 * version forever. Detects a Homebrew install and routes accordingly.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { VERSION } from '../version';
import { c, createReader } from '../ui';

async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@holt-os/holt/latest', {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

/** True when this running binary was installed through Homebrew. */
function isBrewInstall(): boolean {
  try {
    const p = realpathSync(process.argv[1] ?? '');
    return p.includes('/Cellar/') || p.includes('/homebrew/') || p.includes('/linuxbrew/');
  } catch {
    return false;
  }
}

export async function update(): Promise<void> {
  const { ask, close } = createReader();
  try {
    console.log(c.dim(`\n  You have holt ${VERSION}. Checking for a newer one...`));
    const latest = await latestVersion();
    if (!latest) {
      console.log(c.dim('  Could not reach the registry. Check your internet connection and try again.\n'));
      return;
    }
    if (latest === VERSION) {
      console.log(c.green(`  You are on the latest version (${VERSION}).`) + '\n');
      return;
    }
    console.log(`  Newer version available: ${c.bold(latest)}`);

    if (isBrewInstall()) {
      const a = ((await ask('  Update now via Homebrew? [Y/n] ')) ?? '').trim().toLowerCase();
      if (a === 'n' || a === 'no') {
        console.log(c.dim('  Later, then. The command is: brew upgrade holt\n'));
        return;
      }
      const r = spawnSync('brew', ['upgrade', 'holt'], { stdio: 'inherit' });
      if (r.status === 0) console.log(c.green(`\n  Updated to ${latest}.`) + '\n');
      else console.log(c.dim('\n  Homebrew reported a problem above. You can retry with: brew upgrade holt\n'));
      return;
    }

    const a = ((await ask('  Update now? [Y/n] ')) ?? '').trim().toLowerCase();
    if (a === 'n' || a === 'no') {
      console.log(c.dim('  Later, then. The command is: npm install -g @holt-os/holt\n'));
      return;
    }
    const r = spawnSync('npm', ['install', '-g', '@holt-os/holt'], { stdio: 'inherit' });
    if (r.status === 0) {
      console.log(c.green(`\n  Updated to ${latest}.`) + '\n');
    } else {
      console.log(
        c.dim(
          '\n  The install hit a permission problem. Two easy ways out:\n' +
            '    1. Run it once with sudo: sudo npm install -g @holt-os/holt\n' +
            '    2. Or install Node with nvm (https://nvm.sh) so no sudo is ever needed.\n',
        ),
      );
    }
  } finally {
    close();
  }
}
