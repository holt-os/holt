import { existsSync, readFileSync } from 'node:fs';
import { memStats, recall, clearMemory, loadTurns, embeddingsAvailable, backfillEmbeddings, EMBED_MODEL, factsMdPath } from '../memory';
import { ensureTrusted } from '../workspace';
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
      console.log(`  ${c.accent(h.score.toFixed(2))}  ${c.dim(when)}  (${h.turn.role}) ${h.turn.content.slice(0, 100).replace(/\s+/g, ' ')}`);
    }
    console.log('');
    close();
    return;
  }

  // An explicit but unrecognized subcommand is a typo, not a request for stats.
  if (action && !['clear', 'embed', 'facts', 'search'].includes(action)) {
    console.error(`\n  Unknown memory subcommand: "${sub}". Use: search <query> | facts | embed | clear\n`);
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
  console.log(c.dim('\n  holt memory search <query>   find remembered moments'));
  console.log(c.dim('  holt memory facts            show distilled facts (facts.md)'));
  console.log(c.dim('  holt memory embed            embed older memories for semantic recall'));
  console.log(c.dim('  holt memory clear            wipe this folder\'s memory\n'));
  close();
}
