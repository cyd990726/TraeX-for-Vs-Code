import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ServerNotification } from './protocol/ServerNotification';
import type { ServerRequest } from './protocol/ServerRequest';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { ThreadResumeResponse } from './protocol/v2/ThreadResumeResponse';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse';
import type { ThreadListResponse } from './protocol/v2/ThreadListResponse';
import type { Permissions } from './permissions';
import type { ReasoningEffort } from './protocol/ReasoningEffort';
import type { ModelListResponse } from './protocol/v2/ModelListResponse';

export class Agent {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 0;
  private disposed = false;
  private threadId?: string;
  private turnId?: string;
  private cancelled = false;
  private defaultPermissions?: Permissions;
  private transport = 0;
  private completedTurns = new Set<string>();
  constructor(private options: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; update: (event: ServerNotification) => void; request: (request: ServerRequest) => Promise<unknown>; log: (text: string) => void; exited: () => void; status?: (status: string) => void }) {}
  private initialize() {
    if (this.disposed) return Promise.reject(new Error('会话已关闭'));
    if (!this.ready) this.ready = this.connect().catch(error => {
      this.ready = undefined;
      ++this.transport;
      this.child?.kill(); this.child = undefined;
      this.threadId = undefined; this.turnId = undefined;
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.options.status?.('连接失败，可重试');
      throw error;
    });
    return this.ready;
  }
  private async connect() {
    const transport = ++this.transport;
    this.options.status?.('正在连接');
    const child = spawn(this.options.executable, [...this.options.args, 'app-server', '--stdio'], { cwd: this.options.cwd, env: this.options.env, stdio: 'pipe', windowsHide: true });
    this.child = child;
    child.stderr.on('data', data => this.options.log(String(data)));
    child.stdin.on('error', error => { if (transport === this.transport) this.fail(error); });
    child.once('error', error => { if (transport === this.transport) this.fail(error); });
    child.once('exit', () => { if (transport !== this.transport) return; this.ready = undefined; this.threadId = undefined; this.turnId = undefined; this.fail(new Error('TRAE CLI 进程已退出')); this.options.status?.('连接已断开'); if (!this.disposed) this.options.exited(); });
    createInterface({ input: child.stdout }).on('line', line => {
      if (transport !== this.transport || this.disposed) return;
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      try { message = JSON.parse(line); } catch { this.options.log(line + '\n'); return; }
      if (message.method) {
        if (message.id !== undefined) {
          const id = message.id;
          void this.options.request(message as ServerRequest).then(result => { if (transport === this.transport) this.write({ id, result }); }, error => { if (transport === this.transport) this.write({ id, error: { code: -32603, message: String(error) } }); });
        } else {
          const event = message as ServerNotification;
          if (event.method === 'turn/started' && event.params.threadId === this.threadId) this.turnId = event.params.turn.id;
          if (event.method === 'turn/completed') { this.completedTurns.add(event.params.turn.id); if (event.params.threadId === this.threadId) this.turnId = undefined; }
          this.options.update(event);
        }
      } else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      }
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await this.rpc('initialize', { clientInfo: { name: 'traecli-vscode', title: 'TRAE CLI Sidebar', version: '0.14.2' }, capabilities: { experimentalApi: false } });
    this.write({ method: 'initialized', params: {} });
    this.options.status?.('已连接');
  }
  private write(message: unknown) { if (!this.disposed && this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  private rpc<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); this.options.status?.('请求超时，请重新连接'); const error = new Error(`${method} 超时，请重新连接确认任务状态`); if (method === 'turn/start') error.name = 'TurnStartUncertain'; reject(error); }, 30000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer }); this.write({ id, method, params });
    });
  }
  private fail(error: Error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  async history(cursor?: string) { await this.initialize(); return this.rpc<ThreadListResponse>('thread/list', { cwd: this.options.cwd, limit: 50, sortKey: 'updated_at', cursor: cursor ?? null }); }
  async skills() { await this.initialize(); return this.rpc<{data:{cwd:string;skills:{name:string;description:string;path:string;enabled:boolean}[]}[]}>('skills/list', {cwds:[this.options.cwd],forceReload:true}); }
  async compact(guidance?: string) { await this.initialize(); if (!this.threadId) throw new Error('请先开始一个会话'); return this.rpc('thread/compact/start', {threadId:this.threadId,...(guidance ? {userGuidance:guidance} : {})}); }
  async models() { await this.initialize(); return this.rpc<ModelListResponse>('model/list', {}); }
  async resume(threadId: string) { await this.initialize(); const result = await this.rpc<ThreadResumeResponse>('thread/resume', { threadId, cwd: this.options.cwd }); this.defaultPermissions = result.approvalPolicy && result.sandbox ? {approvalPolicy:result.approvalPolicy,sandboxPolicy:result.sandbox} : undefined; this.threadId = result.thread.id; this.turnId = result.thread.turns.find(turn => turn.status === 'inProgress')?.id; return result; }
  newThread() { this.threadId = undefined; this.turnId = undefined; }
  async prompt(text: string, model?: string, modelProvider?: string, effort?: ReasoningEffort, modelBackendVariant?: string, permissions?: Permissions, skills?: {name:string;path:string}[]) {
    this.cancelled = false;
    await this.initialize();
    if (!this.threadId) {
      const result = await this.rpc<ThreadStartResponse>('thread/start', { cwd: this.options.cwd, ...(model ? { model } : {}), ...(modelProvider ? { modelProvider } : {}) });
      this.defaultPermissions = result.approvalPolicy && result.sandbox ? {approvalPolicy:result.approvalPolicy,sandboxPolicy:result.sandbox} : undefined;
      this.threadId = result.thread.id;
    }
    if (this.cancelled) return;
    const result = await this.rpc<TurnStartResponse>('turn/start', { threadId: this.threadId, ...(permissions ?? this.defaultPermissions ?? {}), input: [{ type: 'text', text, text_elements: [] }, ...(skills ?? []).map(skill => ({type:'skill',...skill}))], ...(effort ? { effort } : {}), ...(modelBackendVariant ? { modelBackendVariant } : {}), ...(model ? { model } : {}), ...(modelProvider ? { modelProvider } : {}) });
    if (result.turn.status === 'inProgress' && !this.completedTurns.has(result.turn.id)) this.turnId = result.turn.id;
    if (this.cancelled) await this.cancel();
    return this.threadId;
  }
  async cancel() { this.cancelled = true; if (this.threadId && this.turnId) await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); }
  dispose() { this.disposed = true; ++this.transport; this.fail(new Error('连接已关闭')); this.child?.kill(); }
}
