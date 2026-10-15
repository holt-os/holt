/**
 * Read all of STDIN with a hard timeout, for the per-call plumbing commands
 * (`holt hook inject|capture`, `holt statusline`) that Claude Code pipes JSON to.
 *
 * Resolves with whatever was buffered when stdin ends, errors, or the timeout
 * fires. When no stdin is piped (e.g. `</dev/null`), 'end' fires immediately so we
 * return ''. Never rejects.
 *
 * The timeout is cleared once stdin ends: a pending timer keeps Node alive, so
 * leaving it running made every call wait out the full timeout (~2s per prompt).
 * clearTimeout rather than unref(): unref() could let Node exit before stdin is
 * fully read and drop a memory capture.
 */
export function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let input = '';
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(input);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        input += chunk;
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
    if (!done) timer = setTimeout(finish, timeoutMs);
  });
}
