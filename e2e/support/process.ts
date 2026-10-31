import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface StartOptions {
  /** Shown in error messages. */
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningProcess {
  readonly label: string;
  readonly pid: number;
  /** Everything the process wrote so far. */
  output(): { readonly stdout: string; readonly stderr: string };
  /** The exit, once it happened (never rejects). */
  readonly exited: Promise<ExitInfo>;
  hasExited(): boolean;
  /** Stops the process and everything it started. Safe to call twice. */
  stop(): Promise<void>;
}

const MAX_CAPTURE = 256 * 1024;
const append = (current: string, chunk: Buffer): string => {
  const next = current + chunk.toString('utf8');
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
};

/** Starts a child process in the background, capturing its output. Windows-safe: no shell, a hidden window. */
export function startProcess(options: StartOptions): RunningProcess {
  const child: ChildProcess = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  let exitInfo: ExitInfo | null = null;
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once('error', (error) => {
      stderr += `\n[spawn error] ${error.message}`;
      exitInfo = { code: null, signal: null };
      resolve(exitInfo);
    });
  });
  const pid = child.pid ?? -1;

  return {
    label: options.label,
    pid,
    output: () => ({ stdout, stderr }),
    exited,
    hasExited: () => exitInfo !== null,
    async stop() {
      if (exitInfo !== null || pid < 0) return;
      killTree(pid);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    },
  };
}

/** Ends a process and its children: `taskkill /T` on Windows, the process group elsewhere. */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

export interface WaitOptions {
  readonly timeoutMs: number;
  /** Stop waiting at once, with the captured output, when this process exits. */
  readonly process?: RunningProcess;
  /** Accepts the answer; the default is any status below 500. */
  readonly accept?: (status: number) => boolean;
  readonly intervalMs?: number;
}

/** Polls a URL until it answers acceptably, or fails with a message that names what it waited for. */
export async function waitForHttp(url: string, options: WaitOptions): Promise<void> {
  const accept = options.accept ?? ((status: number) => status < 500);
  const deadline = performance.now() + options.timeoutMs;
  let last = 'no answer yet';
  while (performance.now() < deadline) {
    if (options.process?.hasExited()) {
      const { stdout, stderr } = options.process.output();
      throw new Error(
        `${options.process.label} exited before ${url} answered.\n--- stderr ---\n${stderr.slice(-4000)}\n--- stdout ---\n${stdout.slice(-2000)}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      await response.arrayBuffer();
      if (accept(response.status)) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
  }
  throw new Error(`${url} did not answer within ${options.timeoutMs} ms (last result: ${last})`);
}
