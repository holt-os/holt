/**
 * Unit-style checks for the Windows side of src/scheduler.ts. Run with:
 * npx tsx scripts/scheduler.test.ts
 *
 * These matter more than the POSIX builders because Windows cannot be
 * exercised on the machines Holt is usually developed on, so the quoting rules
 * have to be pinned down here instead.
 */
import assert from 'node:assert/strict';
import {
  type Job,
  buildWindowsScript,
  buildSchtasksArgs,
  cmdQuote,
  taskName,
  cmdScriptPath,
} from '../src/scheduler';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log('ok - ' + name);
}

const base: Job = {
  id: 'abc123',
  name: 'brief',
  task: 'daily brief',
  when: '09:30',
  workspace: 'C:\\Users\\Dee\\My Work',
  notify: false,
};

check('cmdQuote leaves simple tokens alone', () => {
  assert.equal(cmdQuote('plain'), 'plain');
  assert.equal(cmdQuote('C:\\path\\ok'), 'C:\\path\\ok');
});

check('cmdQuote wraps spaces and cmd metacharacters', () => {
  assert.equal(cmdQuote('has space'), '"has space"');
  assert.equal(cmdQuote('a&b'), '"a&b"');
  assert.equal(cmdQuote('a|b'), '"a|b"');
});

check('cmdQuote doubles embedded quotes, the cmd escape', () => {
  assert.equal(cmdQuote('say "hi"'), '"say ""hi"""');
});

check('script is CRLF terminated, as cmd requires', () => {
  const s = buildWindowsScript(base, 'holt');
  assert.ok(s.startsWith('@echo off\r\n'));
  assert.ok(s.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(s), 'every LF must be preceded by CR');
});

check('script cds into the workspace with /d and quotes the path', () => {
  const s = buildWindowsScript(base, 'holt');
  assert.ok(s.includes('cd /d "C:\\Users\\Dee\\My Work"'));
});

check('a spaced task phrase is quoted, so it stays one argument', () => {
  const s = buildWindowsScript(base, 'holt');
  assert.ok(s.includes('run "daily brief"'));
});

check('a holt path under Program Files is quoted', () => {
  const s = buildWindowsScript(base, 'C:\\Program Files\\holt\\holt.cmd');
  assert.ok(s.includes('"C:\\Program Files\\holt\\holt.cmd" run'));
});

check('--brain is passed through when set', () => {
  const s = buildWindowsScript({ ...base, brain: 'claude' }, 'holt');
  assert.ok(s.includes('--brain claude'));
});

check('notify only fires after a successful run', () => {
  const s = buildWindowsScript({ ...base, notify: true }, 'holt');
  const guard = s.indexOf('if errorlevel 1 exit /b 1');
  const notify = s.indexOf('holt notify');
  assert.ok(guard > -1, 'guard line present');
  assert.ok(notify > guard, 'notify comes after the guard');
});

check('no notify line when notify is off', () => {
  assert.ok(!buildWindowsScript(base, 'holt').includes('notify'));
});

check('a routine runs its runArgs and owns its own output', () => {
  const s = buildWindowsScript({ ...base, runArgs: ['routine', 'run', 'my digest'] }, 'holt');
  assert.ok(s.includes('holt routine run "my digest" --quiet'));
  assert.ok(!s.includes('--out'), 'routines route their own output');
});

check('schtasks argv registers a daily task with /F so re-adds are clean', () => {
  const argv = buildSchtasksArgs(base, 'C:\\t\\abc123.cmd');
  assert.deepEqual(argv, [
    '/Create',
    '/F',
    '/SC',
    'DAILY',
    '/ST',
    '09:30',
    '/TN',
    'Holt abc123',
    '/TR',
    'C:\\t\\abc123.cmd',
  ]);
});

check('schtasks zero-pads the time, which /ST demands', () => {
  const argv = buildSchtasksArgs({ ...base, when: '7:05' }, 'x.cmd');
  assert.equal(argv[argv.indexOf('/ST') + 1], '07:05');
});

check('task name and script path are derived from the id', () => {
  assert.equal(taskName('abc123'), 'Holt abc123');
  assert.ok(cmdScriptPath('abc123').endsWith('abc123.cmd'));
});

console.log(`\n${passed} checks passed.`);
