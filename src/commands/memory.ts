import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  memStats,
  recall,
  clearMemory,
  loadTurns,
  embeddingsAvailable,
  backfillEmbeddings,
  EMBED_MODEL,
  factsMdPath,
  isGlobalEnabled,
  enableGlobal,
  disableGlobal,
  globalStats,
  globalWorkspaces,
  globalMemPath,
  memoryScopesPath,
} from '../memory';
import { ensureTrusted, workspace } from '../workspace';
import { c, createReader } from '../ui';

/** `holt memory [search <q> | clear]`: inspect or wipe this folder's memory. */
export async function memoryCmd(sub?: string, rest: string[] = []): Promise<void> {
  const { ask, close } = createReader();
  if (!(await ensureTrusted(ask))) { close(); return; }

  const action = (sub || '').toLowerCase();

  if (action === 'clear') {
    const s = memStats();
    if (s.turns === 0) { console.log(c.dim('\n  Memory is already empty.\n')); close(); return; }
    const a = ((await ask(`\n  Delete all ${s.turns} remembered moments in this folder? [y/N] `)) ?? '').trim().toLowerCase();
    if (a === 'y' || a === 'yes') { clearMemory(); console.log(c.green('  Memory cleared.\n')); }
    else console.log(c.dim('  Kept.\n'));
    close();
    return;
  }

  if (action === 'embed') {
    if (!(await embeddingsAvailable())) {
      console.log(c.dim(`\n  No local Ollama with ${EMBED_MODEL} reachable. Run "holt init" to set it up.\n`));
      close();
      return;
    }
    const missing = loadTurns().filter((t) => !Array.isArray(t.emb)).length;
    if (missing === 0) { console.log(c.dim('\n  All memories already have embeddings.\n')); close(); return; }
    console.log('');
    const r = await backfillEmbeddings((done, total) => {
      process.stdout.write(`\r  embedding ${done}/${total}...`);
    });
    console.log('\n' + c.green(`  Done. ${r.embedded} of ${r.total} memories embedded.`) + '\n');
    close();
    return;
  }

  if (action === 'facts') {
    if (!existsSync(factsMdPath())) {
      console.log(c.dim('\n  No facts distilled yet. They form when you end a chat session.\n'));
      close();
      return;
    }
    const body = readFileSync(factsMdPath(), 'utf8').trim();
    console.log('\n' + body + '\n');
    close();
    return;
  }

  if (action === 'search') {
    const q = rest.join(' ').trim();
    if (!q) { console.log(c.dim('\n  Usage: holt memory search <query>\n')); close(); return; }
    const hits = await recall(q, '__none__', 8);
    console.log('');
    if (hits.length === 0) console.log(c.dim('  Nothing relevant found.'));
    else for (const h of hits) {
      const when = new Date(h.turn.ts).toISOString().slice(0, 10);
      // Global hits carry their source folder; tag them so provenance is clear.
      const src = h.workspace ? c.dim(` [${basename(h.workspace)}]`) : '';
      console.log(
        `  ${c.accent(h.score.toFixed(2))}  ${c.dim(when)}  (${h.turn.role})${src} ${h.turn.content.slice(0, 100).replace(/\s+/g, ' ')}`,
      );
    }
    console.log('');
    close();
    return;
  }

  if (action === 'global') {
    globalCmd((rest[0] || '').toLowerCase(), rest.slice(1));
    close();
    return;
  }

  // An explicit but unrecognized subcommand is a typo, not a request for stats.
  if (action && !['clear', 'embed', 'facts', 'search', 'global'].includes(action)) {
    console.error(`\n  Unknown memory subcommand: "${sub}". Use: search <query> | facts | embed | global | clear\n`);
    process.exitCode = 1;
    close();
    return;
  }

  // default (no subcommand): stats
  const s = memStats();
  const embedOk = await embeddingsAvailable();
  const sessions = new Set(loadTurns().map((t) => t.session)).size;
  console.log('\n' + c.accent('Holt memory') + c.dim('  (this folder)'));
  console.log(`  moments     ${s.turns}`);
  console.log(`  facts       ${s.facts}  (./.holt/memory/facts.md)`);
  console.log(`  sessions    ${sessions}`);
  console.log(`  embedded    ${s.withEmbeddings} of ${s.turns}`);
  console.log(`  size        ${(s.bytes / 1024).toFixed(1)} KB  (./.holt/memory/turns.jsonl)`);
  console.log(`  recall via  ${embedOk ? 'embeddings (local Ollama)' : 'keyword match (start Ollama with an embed model for semantic recall)'}`);
  if (embedOk && s.withEmbeddings < s.turns) {
    console.log(c.dim(`\n  ${s.turns - s.withEmbeddings} moments lack embeddings. Run "holt memory embed" to upgrade them to semantic recall.`));
  }
  const gEnabled = isGlobalEnabled(workspace());
  console.log(`  global      ${gEnabled ? c.green('on') + c.dim('  (contributes + reads shared facts)') : c.dim('off  (this folder is isolated, the default)')}`);
  console.log(c.dim('\n  holt memory search <query>   find remembered moments'));
  console.log(c.dim('  holt memory facts            show distilled facts (facts.md)'));
  console.log(c.dim('  holt memory embed            embed older memories for semantic recall'));
  console.log(c.dim('  holt memory global           share high-value facts across your folders'));
  console.log(c.dim('  holt memory clear            wipe this folder\'s memory\n'));
  close();
}

/**
 * `holt memory global [on | off [--purge] | status]`: opt this folder into the
 * shared, cross-folder facts store (contribute + read), or inspect/leave it.
 * Per-folder isolation stays the default; nothing here touches unopted folders.
 */
function globalCmd(act: string, rest: string[]): void {
  const ws = workspace();

  if (act === 'on') {
    const already = isGlobalEnabled(ws);
    const added = enableGlobal(ws);
    const g = globalStats();
    if (already) console.log('\n' + c.green('  Global memory already on for this folder.'));
    else console.log('\n' + c.green('  Global memory ON for this folder.'));
    console.log(c.dim(`  Backfilled ${added} fact${added === 1 ? '' : 's'} into the shared store.`));
    console.log(c.dim(`  New facts here mirror automatically; recall now spans ${g.workspaces} contributing folder${g.workspaces === 1 ? '' : 's'}.\n`));
    return;
  }

  if (act === 'off') {
    const purge = rest.includes('--purge');
    if (!isGlobalEnabled(ws) && !purge) {
      console.log('\n' + c.dim('  Global memory is already off for this folder.\n'));
      return;
    }
    const { purged } = disableGlobal(ws, purge);
    console.log('\n' + c.green('  Global memory OFF for this folder.') + c.dim('  (recall is local-only again)'));
    if (purge) console.log(c.dim(`  Purged ${purged} of this folder's row${purged === 1 ? '' : 's'} from the shared store.`));
    else console.log(c.dim("  This folder's rows stay in the shared store. Re-run with --purge to remove them."));
    console.log('');
    return;
  }

  if (act === '' || act === 'status') {
    const enabled = isGlobalEnabled(ws);
    const g = globalStats();
    const contributors = globalWorkspaces();
    console.log('\n' + c.accent('Holt global memory') + c.dim('  (opt-in, shared facts across your folders)'));
    console.log(`  this folder    ${enabled ? c.green('on') : c.dim('off (isolated, the default)')}`);
    console.log(`  contributing   ${g.workspaces} folder${g.workspaces === 1 ? '' : 's'}`);
    console.log(`  shared facts   ${g.facts}`);
    console.log(`  size           ${(g.bytes / 1024).toFixed(1)} KB  (${globalMemPath()})`);
    console.log(`  registry       ${memoryScopesPath()}`);
    if (contributors.length) {
      console.log(c.dim('\n  Folders sharing facts:'));
      for (const w of contributors) console.log(c.dim(`    ${basename(w)}  ${w === ws ? '(this folder)' : w}`));
    }
    console.log(c.dim('\n  holt memory global on          share this folder\'s facts + read others'));
    console.log(c.dim('  holt memory global off         stop sharing + reading (add --purge to delete rows)'));
    console.log(c.dim('  holt memory global status      this view\n'));
    return;
  }

  console.error(`\n  Unknown "memory global" action: "${act}". Use: on | off [--purge] | status\n`);
  process.exitCode = 1;
}
