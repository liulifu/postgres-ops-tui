import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {delimiter, resolve} from 'node:path';
import {createInterface} from 'node:readline';

export type DatabaseStat = {
  name: string;
  connections: number;
  commits: number;
  rollbacks: number;
  size: string;
};

export type Activity = {
  pid: number;
  user: string;
  database: string;
  state: string;
  wait: string;
  query: string;
};

export type LockStat = {
  locktype: string;
  mode: string;
  granted: string;
  count: number;
};

export type Metric = {
  label: string;
  value: number;
};

export type Snapshot = {
  container: string;
  server_version: string;
  collected_at: string;
  databases: DatabaseStat[];
  activity: Activity[];
  locks: LockStat[];
  metrics: Metric[];
  logs: string[];
};

export type ProbeInfo = {
  key: string;
  title: string;
};

export type QueryResult = {
  title: string;
  sql: string;
  output: string;
};

type Pending = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

export class GatewayClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private process: ChildProcessWithoutNullStreams;

  constructor() {
    const python = process.env.PG_TUI_PYTHON ?? process.env.PYTHON ?? 'python';
    const sourceRoot = process.cwd();
    this.process = spawn(python, ['-m', 'pg_ops_tui.pg_gateway'], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        PYTHONPATH: process.env.PYTHONPATH ? `${sourceRoot}${delimiter}${process.env.PYTHONPATH}` : sourceRoot
      }
    });

    const rl = createInterface({input: this.process.stdout});
    rl.on('line', line => this.handleLine(line));
    this.process.stderr.on('data', chunk => {
      process.stderr.write(String(chunk));
    });
    this.process.on('exit', code => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`gateway exited with code ${code ?? 'unknown'}`));
      }
      this.pending.clear();
    });
  }

  snapshot(): Promise<Snapshot> {
    return this.call<Snapshot>('snapshot', {});
  }

  checkpoint(): Promise<{message: string}> {
    return this.call<{message: string}>('checkpoint', {});
  }

  probeMenu(): Promise<ProbeInfo[]> {
    return this.call<ProbeInfo[]>('probe_menu', {});
  }

  runProbe(key: string): Promise<QueryResult> {
    return this.call<QueryResult>('run_probe', {key});
  }

  runSql(sql: string): Promise<QueryResult> {
    return this.call<QueryResult>('run_sql', {sql});
  }

  close(): void {
    this.process.kill();
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    this.process.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve: value => resolve(value as T), reject});
    });
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'gateway error'));
    } else {
      pending.resolve(message.result);
    }
  }
}
