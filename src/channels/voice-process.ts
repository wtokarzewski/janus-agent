import { spawn } from 'node:child_process';

const MAX_DIAGNOSTIC_BYTES = 1_048_576;

/** Direct executables only: no shell/wrapper, and settle after the child closes. */
export function runVoiceProcess(executable: string, args: string[], options: {
  signal: AbortSignal; maxOutputBytes: number;
}): Promise<Buffer> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnosticBytes = 0;
    let failure: Error | undefined;
    const terminate = (message: string) => {
      failure ??= new Error(message);
      // SIGKILL forces direct-child termination on Windows as well as POSIX.
      child.kill('SIGKILL');
    };
    const abort = () => terminate('Voice processing cancelled or timed out');
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) terminate('Voice process output exceeds its limit');
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) terminate('Voice diagnostic output exceeds its limit');
    });
    child.on('error', () => { failure ??= new Error('Cannot start voice executable; check installation and permissions'); });
    child.on('close', (code) => {
      options.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('Voice executable failed; check audio, model and installation'));
      else resolve(Buffer.concat(chunks));
    });
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  });
}
