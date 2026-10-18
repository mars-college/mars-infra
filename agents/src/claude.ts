import { spawn } from 'node:child_process';
import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GatewayConfig } from './config.js';

export interface CharacterRun {
  characterId: string;
  systemPrompt: string;
  input: string;
}
export interface CharacterRunner {
  run(input: CharacterRun): Promise<string>;
  close?(): void;
}

// A fixed organizer-owned CLI lane, not a subscription credential broker.
// Only native Claude login is accepted; never inherit provider/API/token secrets.
export class ClaudeRunner implements CharacterRunner {
  readonly #abort = new AbortController();

  close(): void { this.#abort.abort(); }
  constructor(private readonly config: Pick<GatewayConfig, 'claude_command' | 'state_root' | 'timeout_ms'>) {}

  async run(input: CharacterRun): Promise<string> {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.characterId)) throw new Error('Invalid character ID');
    const cwd = join(this.config.state_root, input.characterId);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const metadata = await lstat(cwd);
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
      throw new Error('Character state directory must be a private directory');
    }
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const authOutput = await runProcess(this.config.claude_command, ['auth', 'status'], '', cwd, env,
      Math.min(10_000, this.config.timeout_ms), this.#abort.signal);
    let auth: { loggedIn?: boolean; authMethod?: string };
    try { auth = JSON.parse(authOutput); } catch { throw new Error('Claude authentication status was not valid JSON'); }
    if (auth.loggedIn !== true || auth.authMethod !== 'claude.ai') {
      throw new Error('Operator native Claude login required; API/token/provider fallback is disabled');
    }
    const output = await runProcess(this.config.claude_command, [
      '-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--no-session-persistence', '--max-turns', '1', '--output-format', 'json',
      '--system-prompt', input.systemPrompt,
    ], input.input, cwd, env, this.config.timeout_ms, this.#abort.signal);
    try {
      const payload: unknown = JSON.parse(output);
      if (!payload || typeof payload !== 'object' || !('result' in payload) ||
          typeof payload.result !== 'string' || !payload.result.trim() ||
          ('is_error' in payload && payload.is_error === true)) throw new Error();
      return payload.result.trim();
    } catch {
      throw new Error('Claude did not return a successful text result');
    }
  }
}

function runProcess(command: string, args: string[], input: string, cwd: string,
    env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error('Claude runner is closed'));
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: 'pipe' });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failure: string | undefined;
  const stop = (reason: string) => {
    failure = reason;
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    } else child.kill('SIGKILL');
  };
  const abort = () => stop('Claude runner is closed');
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('Claude run timed out'), timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 256 * 1024) { stop('Claude output exceeded its limit'); return; }
    chunks.push(chunk);
  });
  // Drain but never retain/reflect stderr: CLI diagnostics can contain secrets.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('error', () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    reject(new Error('Could not launch Claude CLI; install/configure the operator executable'));
  });
  child.on('close', code => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (failure || code !== 0) reject(new Error(failure ?? 'Claude CLI failed; inspect its configuration privately'));
    else resolve(Buffer.concat(chunks).toString('utf8'));
  });
  child.stdin.end(input);
  return promise;
}
