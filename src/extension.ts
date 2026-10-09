import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Agent } from './agent';
import { slashCommands, type SlashOption } from './slash';
type Attachment = { id: string; label: string; text: string; skill?: {name:string;path:string} };
import { UsageStore, type UsageData } from './usage';
import { reconstructBefore } from './review';
import { sameProject } from './projects';
import { loginStatus, isAuthError } from './auth';
import type { ServerNotification } from './protocol/ServerNotification';
import type { ServerRequest } from './protocol/ServerRequest';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { ReasoningEffort } from './protocol/ReasoningEffort';
import type { ReasoningEffortOption } from './protocol/v2/ReasoningEffortOption';
import { permissionChoices, permissionsFor, type PermissionMode } from './permissions';
import { modelModes, resolveMode, type ModelMode } from './modelModes';
import type { Model } from './protocol/v2/Model';
import type { McpServerElicitationRequestParams } from './protocol/v2/McpServerElicitationRequestParams';
import type { McpElicitationSchema } from './protocol/v2/McpElicitationSchema';
import type { McpElicitationPrimitiveSchema } from './protocol/v2/McpElicitationPrimitiveSchema';
import type { ModelFallbackEvent } from './protocol/v2/ModelFallbackEvent';

type Message = { role: 'user' | 'assistant' | 'tool' | 'error'; text: string; id: string; turnId?: string; detail?: string; status?: string; process?: boolean; reasoningHasSummary?: boolean; processKind?: string; toolName?: string; paths?: string[]; changes?: { path: string; diff: string; currentPath?: string }[] };
type Approval = { id: string; title: string; detail: string; accept: unknown; decline: unknown; resolve: (response: unknown) => void };
type ModelLoad = { percent: number; queueSize?: number };
type QueueStatus = { turnId: string; state: string; position: number | null; message: string | null; operation: string | null };
type SessionSummary = { id: string; name?: string | null; preview?: string; updatedAt: number; cwd: string; model?: string | null };
const MAX_LIVE_SESSIONS = 6;
const MAX_HISTORY_SESSIONS = 500;
const MAX_MESSAGES = 500;
const MAX_MESSAGE_CHARACTERS = 8_000_000;
const MAX_TEXT_CHARACTERS = 200_000;
const MAX_DETAIL_CHARACTERS = 200_000;
const MAX_DIFF_CHARACTERS = 1_000_000;
const MAX_VIRTUAL_DOCUMENTS = 40;
export class Sidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  // Each live conversation owns an independent CLI process and task state.
  private readonly runtimeId = 'local-' + randomBytes(8).toString('hex');
  private current: Sidebar = this;
  private liveSessions = new Set<Sidebar>([this]);
  private view?: vscode.WebviewView;
  private agent?: Agent;
  private messages: Message[] = [];
  private busy = false;
  private stopRequested = false;
  private draft = '';
  private epoch = 0;
  private threadId?: string;
  private activeTurnId?: string;
  private completedTurnIds = new Set<string>();
  private compacting = false;
  private restoredUsage = false;
  private usage: UsageStore;
  private page: 'sessions' | 'chat' = 'sessions';
  private sessions: SessionSummary[] = [];
  private historyLoading = false;
  private historyError = '';
  private authRequired = false;
  private loginPending = false;
  private loginError = '';
  private loginTerminal?: vscode.Terminal;
  private loginTimer?: NodeJS.Timeout;
  private disposed = false;
  private historyCursor?: string;
  private historyRequest = 0;
  private sessionDrafts = new Map<string, { text: string; attachments: Attachment[] }>();
  private selectedModel?: Pick<Model, 'model' | 'displayName' | 'modelProviderId'>;
  private modelLoad?: ModelLoad;
  private queueStatus?: QueueStatus;
  private queueLoadTurnId?: string;
  private selectedReasoning?: ReasoningEffort;
  private reasoningOptions?: ReasoningEffortOption[];
  private permissionMode: PermissionMode = 'default';
  private slashSkills: {name:string;description:string;path:string;enabled:boolean}[] = [];
  private selectedMode?: string;
  private modeOptions?: ModelMode[];
  private transition = false;
  private phase = '就绪';
  private connection = '尚未连接';
  private reconnectNeeded = false;
  private draftRevision = 0;
  private syncTimer?: NodeJS.Timeout;
  private draftTimer?: NodeJS.Timeout;
  private fullSync = true;
  private fingerprints = new Map<string, string>();
  private virtualDocuments = new Map<string, string>();
  private inFlight?: { text: string; attachments: Attachment[]; messageId: string };
  private turnStartedAt?: number;
  private lastActivityAt?: number;
  private attachments: Attachment[] = [];
  private approvals = new Map<string, Approval>();
  private output: vscode.OutputChannel;
  constructor(private context: vscode.ExtensionContext, private owner?: Sidebar) {
    this.usage = owner?.usage ?? new UsageStore(context.workspaceState.get<UsageData>('tokenUsage'));
    this.output = owner?.output ?? vscode.window.createOutputChannel('TRAE CLI');
    if (owner) { this.virtualDocuments = owner.virtualDocuments; this.page = 'chat'; this.readLoginStatus = () => owner.readLoginStatus(); return; }
    this.selectedModel = context.workspaceState.get('selectedModel');
    this.selectedReasoning = context.workspaceState.get('selectedReasoning');
    this.selectedMode = context.workspaceState.get('selectedMode');
    const savedDrafts = context.workspaceState.get<Record<string, string>>('sessionDrafts');
    this.draft = savedDrafts ? savedDrafts.new ?? '' : context.workspaceState.get('draft', '');
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('trae-review', { provideTextDocumentContent: uri => this.virtualDocuments.get(uri.toString()) ?? '' }));
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const uri = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name));
    const nonce = randomBytes(18).toString('hex');
    view.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri('chat.css')}"></head><body data-page="sessions"><header><div class="header-leading"><button id="back" title="返回会话列表" aria-label="返回会话列表">←</button><span>TRAE</span></div><nav><button id="review" title="审阅文件变更">变更</button><button id="history" title="历史会话">历史</button><button id="new" title="新建会话">新会话</button></nav></header><section id="session-home" aria-label="当前项目会话"></section><main id="messages" aria-live="polite"></main><section id="approvals" aria-label="权限确认"></section><footer><div id="connection" role="status"></div><div id="attachments"></div><div id="status" class="task-status" role="status"></div><form id="composer"><textarea id="prompt" rows="2" placeholder="向 TRAE 提问，或描述要完成的任务" aria-label="消息"></textarea><div class="actions"><button id="attach" type="button" title="添加文件或选中代码">＋</button><button id="model" type="button" title="选择模型">默认模型⌄</button><button id="send" type="submit" title="发送" aria-label="发送">↑</button></div></form><div class="hint" id="token-usage"></div></footer><script nonce="${nonce}" src="${uri('chat.js')}"></script></body></html>`;
    const listener = view.webview.onDidReceiveMessage(message => {
      if (!message || typeof message !== 'object') return;
      const target = this.current;
      if (message.viewKey && message.viewKey !== target.runtimeId && !['ready', 'login', 'checkLogin', 'refreshSessions', 'moreSessions', 'openSession'].includes(message.type)) return;
      if (message.type === 'ready') { this.fullSync = true; this.sync(); if (this.page === 'sessions') void this.loadSessions(); }
      if (message.type === 'login') void this.login();
      if (message.type === 'checkLogin') void this.checkLogin();
      if (message.type === 'send' && typeof message.text === 'string') { if (Number.isSafeInteger(message.revision)) target.draftRevision = Math.max(target.draftRevision, message.revision); void target.send(message.text); }
      if (message.type === 'draft' && typeof message.text === 'string' && Number.isSafeInteger(message.revision) && message.revision >= target.draftRevision) {
        target.draft = message.text; target.draftRevision = message.revision;
        clearTimeout(target.draftTimer); target.draftTimer = setTimeout(() => { void target.stashDraft(); }, 250);
      }
      if (message.type === 'copy' && typeof message.text === 'string') void vscode.env.clipboard.writeText(message.text);
      if (message.type === 'new') void this.restart();
      if (message.type === 'stop') void target.cancel();
      if (message.type === 'history' || message.type === 'back') void this.history();
      if (message.type === 'refreshSessions') void this.loadSessions();
      if (message.type === 'moreSessions') void this.loadSessions(true);
      if (message.type === 'openSession' && typeof message.id === 'string') void this.openSession(message.id);
      if (message.type === 'continueSession' && target.threadId) { this.page = 'chat'; this.fullSync = true; this.sync(); }
      if (message.type === 'reconnect') void target.reconnect();
      if (message.type === 'review') void target.reviewChanges();
      if (message.type === 'pickFile') void target.pickFile();
      if (message.type === 'previewAttachment' && typeof message.id === 'string') void target.previewAttachment(message.id);
      if (message.type === 'reviewFile' && typeof message.id === 'string' && typeof message.path === 'string') void target.reviewFile(message.id, message.path);
      if (message.type === 'slashOptions' && typeof message.command === 'string' && Number.isSafeInteger(message.requestId)) void target.loadSlashOptions(message.command, message.requestId);
      if (message.type === 'slashExecute' && typeof message.command === 'string') void target.executeSlash(message.command, typeof message.option === 'string' ? message.option : undefined);
      if (message.type === 'model') void target.chooseModel();
      if (message.type === 'selectPermissions') target.setPermissionMode(message.mode);
      if (message.type === 'mode') void target.chooseMode();
      if (message.type === 'selectMode' && typeof message.mode === 'string') void target.chooseMode(message.mode);
      if (message.type === 'reasoning') void target.chooseReasoning();
      if (message.type === 'selectReasoning' && typeof message.effort === 'string') void target.chooseReasoning(message.effort);
      if (message.type === 'selectModel' && typeof message.id === 'string') void target.chooseModel(message.id);
      if (message.type === 'attach') void target.attachFile();
      if (message.type === 'removeAttachment') { target.attachments = target.attachments.filter(item => item.id !== message.id); this.sync(); }
      if (message.type === 'openFile' && typeof message.path === 'string') void target.openFile(message.path);
      if (message.type === 'permission' && typeof message.id === 'string') {
        const pending = target.approvals.get(message.id); if (!pending) return;
        pending.resolve(message.decision === 'accept' ? pending.accept : pending.decline); target.phase = '处理中'; target.approvals.delete(message.id); this.sync();
      }
    });
    view.onDidDispose(() => { listener.dispose(); if (this.view === view) this.view = undefined; });
  }
  private sync(immediate = false) {
    if (this.owner) { this.owner.sync(immediate); return; }
    if (this.disposed) return;
    if (immediate) { clearTimeout(this.syncTimer); this.syncTimer = undefined; this.flush(); return; }
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => { this.syncTimer = undefined; this.flush(); }, 16);
  }
  private flush() {
    if (!this.view) return;
    const target = this.current;
    const sessionRows = this.sessionRows();
    const reset = this.fullSync;
    const ids = new Set(target.messages.map(message => message.id));
    const removed = [...this.fingerprints.keys()].filter(id => !ids.has(id));
    for (const id of removed) this.fingerprints.delete(id);
    const changed = target.messages.filter(message => {
      const signature = JSON.stringify(message); const previous = this.fingerprints.get(message.id);
      this.fingerprints.set(message.id, signature); return reset || previous !== signature;
    });
    this.fullSync = false;
    void this.view.webview.postMessage({ type: 'state', viewKey: target.runtimeId, authRequired: this.authRequired || target.authRequired, loginPending: this.loginPending, loginError: this.loginError, page: this.page, project: vscode.workspace.workspaceFolders?.[0]?.name ?? '未打开项目', sessions: sessionRows, conversationTitle: sessionRows.find(session => session.id === (target.threadId ?? target.runtimeId))?.title ?? '新会话', historyLoading: this.historyLoading, historyError: this.historyError, hasMoreSessions: !!this.historyCursor, currentSession: target.threadId, activeTurnId: target.activeTurnId, reset, messages: changed, removed, busy: target.busy, transition: target.transition, connection: target.connection, reconnectNeeded: target.reconnectNeeded, phase: target.phase, startedAt: target.turnStartedAt, draftRevision: target.draftRevision, draft: target.draft, model: target.selectedModel?.displayName ?? '默认模型', tokenUsage: { session: this.usage.summary(target.threadId).session }, permissionMode: target.permissionMode, modelMode: target.selectedMode, modeLabel: target.modeOptions?.find(option => option.id === target.selectedMode)?.name, modeSupported: target.modeOptions ? target.modeOptions.length > 0 : undefined, reasoning: target.selectedReasoning, reasoningSupported: target.reasoningOptions ? target.reasoningOptions.length > 0 : undefined, attachments: target.attachments.map(({ id, label, text }) => ({ id, label, size: text.length })), approvals: [...target.approvals.values()].map(({ id, title, detail }) => ({ id, title, detail })) });
  }
  private cliOptions() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('请先打开项目文件夹。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区。');
    const config = vscode.workspace.getConfiguration('traecli');
    const paths = [join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
    let executable = config.get<string>('executable', 'traecli');
    if (executable === 'traecli' && process.platform !== 'win32') executable = paths.map(path => join(path, executable)).find(existsSync) ?? executable;
    return { executable, args: config.get<string[]>('arguments', []), cwd: folder.uri.fsPath, env: { ...process.env, PATH: [...paths, process.env.PATH ?? ''].join(delimiter) } };
  }
  private readLoginStatus() { return loginStatus(this.cliOptions()); }
  private async ensureAuthenticated() {
    const authenticated = await this.readLoginStatus();
    if (this.disposed) return false;
    this.authRequired = !authenticated;
    this.sync(); return authenticated;
  }
  private loginChecking = false;
  private async checkLogin() {
    if (this.loginChecking || this.disposed) return;
    this.loginChecking = true; this.loginError = ''; this.sync();
    try {
      if (!await this.ensureAuthenticated()) {
        this.loginError = this.loginPending ? '' : '尚未检测到登录，请完成终端中的登录后重试。';
        return;
      }
      if (this.disposed) return;
      clearTimeout(this.loginTimer); this.loginPending = false;
      await this.current.reconnect();
    } catch (error) { if (!this.disposed) this.loginError = String(error); }
    finally { this.loginChecking = false; if (!this.disposed) this.sync(); }
  }
  private async login() {
    if (this.disposed || this.current.busy || this.current.transition) return;
    if (this.loginPending) { this.loginTerminal?.show(); return; }
    try {
      const options = this.cliOptions();
      this.authRequired = true; this.loginError = '';
      if (!this.loginTerminal) {
        const terminal = vscode.window.createTerminal({ name: 'TRAE CLI 登录', shellPath: options.executable, shellArgs: [...options.args, 'login'], cwd: options.cwd, env: options.env });
        this.loginTerminal = terminal;
        const listener = vscode.window.onDidCloseTerminal(closed => {
          if (closed !== terminal) return;
          const pending = this.loginPending;
          listener.dispose(); this.loginTerminal = undefined; this.loginPending = false;
          clearTimeout(this.loginTimer); if (pending) void this.checkLogin();
        });
        this.context.subscriptions.push(listener);
      }
      this.loginTerminal.show(); this.loginPending = true; this.sync();
      const deadline = Date.now() + 10 * 60 * 1000;
      const poll = async () => {
        if (this.disposed || !this.loginPending) return;
        await this.checkLogin();
        if (this.disposed || !this.loginPending) return;
        if (Date.now() >= deadline) {
          this.loginPending = false; this.loginError = '自动检测已暂停，完成登录后点击“我已登录，重新检测”。'; this.sync();
        } else this.loginTimer = setTimeout(() => { void poll(); }, 3000);
      };
      this.loginTimer = setTimeout(() => { void poll(); }, 3000);
    } catch (error) { this.loginPending = false; this.loginError = `无法启动登录：${String(error)}`; this.sync(); }
  }
  private getAgent() {
    if (this.agent) return this.agent;
    const epoch = this.epoch;
    this.agent = new Agent({ ...this.cliOptions(),
      update: event => { if (epoch === this.epoch) this.update(event); }, log: text => this.output.append(text),
      status: status => { if (epoch === this.epoch) { this.connection = status; if (/断开|失败|超时/.test(status)) this.reconnectNeeded = true; this.sync(); } },
      exited: () => { if (epoch === this.epoch) { this.agent?.dispose(); this.agent = undefined; this.busy = false; this.compacting = false; this.activeTurnId = undefined; this.phase = '就绪'; this.turnStartedAt = undefined; this.clearApprovals(); this.restoreInFlight(); this.error('TRAE CLI 已断开，点击输入框上方的“重新连接”恢复会话。'); } },
      request: request => epoch !== this.epoch ? Promise.reject(new Error('连接已关闭')) : this.request(request)
    });
    return this.agent;
  }
  private limitText(text: string, limit: number, keepTail = false) {
    if (text.length <= limit) return text;
    const marker = keepTail ? '… 已省略较早内容 …\n' : '\n… 后续内容已省略 …';
    const available = Math.max(0, limit - marker.length);
    return keepTail ? marker + text.slice(-available) : text.slice(0, available) + marker;
  }
  private normalizeMessage(message: Message) {
    message.text = this.limitText(message.text, MAX_TEXT_CHARACTERS);
    if (message.detail !== undefined) message.detail = this.limitText(message.detail, MAX_DETAIL_CHARACTERS, message.processKind === 'commandExecution');
    if (message.changes) for (const change of message.changes) change.diff = this.limitText(change.diff, MAX_DIFF_CHARACTERS);
    return message;
  }
  private messageSize(message: Message) {
    return message.text.length + (message.detail?.length ?? 0) + (message.changes?.reduce((sum, change) => sum + change.diff.length + change.path.length, 0) ?? 0);
  }
  private trimMessages() {
    for (const message of this.messages) this.normalizeMessage(message);
    let total = this.messages.reduce((sum, message) => sum + this.messageSize(message), 0);
    while (this.messages.length > MAX_MESSAGES || total > MAX_MESSAGE_CHARACTERS) {
      const index = this.messages.findIndex(message => !['inProgress', 'streaming'].includes(message.status ?? '') && message.id !== this.inFlight?.messageId);
      if (index < 0) break;
      total -= this.messageSize(this.messages[index]);
      this.messages.splice(index, 1);
    }
  }
  private pushMessage(message: Message) { this.messages.push(this.normalizeMessage(message)); this.trimMessages(); }
  private appendDetail(message: Message, delta: string, keepTail = false) {
    message.detail = this.limitText((message.detail ?? '') + delta, MAX_DETAIL_CHARACTERS, keepTail);
  }
  private isForegroundTurn(turnId?: string) { return !turnId || this.activeTurnId === turnId || (!this.activeTurnId && this.busy); }
  private upsert(item: ThreadItem, turnId?: string) {
    let message: Message | undefined;
    if (item.type === 'userMessage') message = { id: item.id, turnId, role: 'user', text: item.content.filter(input => input.type === 'text').map(input => input.text).join('\n') };
    if (item.type === 'agentMessage') message = { id: item.id, turnId, role: 'assistant', text: item.text };
    if (item.type === 'commandExecution') message = { id: item.id, turnId, role: 'tool', text: item.command, detail: item.aggregatedOutput ?? '', status: item.status };
    if (item.type === 'fileChange') message = { id: item.id, turnId, role: 'tool', text: `修改 ${item.changes.length} 个文件`, status: item.status, paths: item.changes.map(change => change.path), changes: item.changes.map(({ path, diff, kind }) => ({ path, diff, currentPath: kind.type === 'update' ? kind.move_path ?? path : path })), detail: item.changes.map(change => `${change.path}\n${change.diff}`).join('\n\n') };
    if (item.type === 'mcpToolCall') message = { id: item.id, turnId, role: 'tool', text: `${item.server} / ${item.tool}`, status: item.status, detail: JSON.stringify(item.result ?? item.arguments, null, 2) };
    if (item.type === 'dynamicToolCall') message = { id: item.id, turnId, role: 'tool', text: `${item.namespace ? `${item.namespace} / ` : ''}${item.tool}`, status: item.status, detail: JSON.stringify(item.contentItems ?? item.arguments, null, 2), processKind: 'dynamicToolCall', toolName: item.tool };
    if (item.type === 'reasoning') message = { id: item.id, turnId, role: 'tool', text: '思考摘要', detail: item.summary.join('\n'), reasoningHasSummary: item.summary.some(text => !!text) };
    if (item.type === 'plan') message = { id: item.id, turnId, role: 'tool', text: '计划', detail: item.text };
    if (item.type === 'webSearch') message = { id: item.id, turnId, role: 'tool', text: `搜索：${item.query}` };
    if (item.type === 'contextCompaction') message = { id: item.id, turnId, role: 'tool', text: '上下文压缩', status: 'completed', processKind: 'contextCompaction', toolName: '上下文压缩' };
    if (!message) return;
    if(message.role==='tool') {message.processKind=item.type;message.toolName=item.type==='commandExecution'?'Bash':item.type==='fileChange'?'文件修改':item.type==='mcpToolCall'?`${item.server} / ${item.tool}`:item.type==='dynamicToolCall'?item.tool:item.type==='webSearch'?'搜索':item.type==='plan'?'计划':item.type==='contextCompaction'?'上下文压缩':undefined;}
    this.normalizeMessage(message);
    // Replace the optimistic user message with the authoritative server item.
    const index = this.messages.findIndex(existing => existing.id === item.id);
    if (index >= 0) { if (!message.turnId) message.turnId = this.messages[index].turnId; if (message.role === 'assistant' && !message.text) message.text = this.messages[index].text; if(message.role==='tool' && message.text==='思考摘要') {message.reasoningHasSummary=message.reasoningHasSummary || this.messages[index].reasoningHasSummary;if(!message.detail)message.detail=this.messages[index].detail;} this.messages[index] = message; }
    else if (message.role === 'user' && this.messages.at(-1)?.id.startsWith('pending-')) this.messages[this.messages.length - 1] = message;
    else this.messages.push(message);
    this.trimMessages();
  }
  private update(event: ServerNotification) {
    if ('threadId' in event.params && this.threadId && event.params.threadId !== this.threadId) return;
    if (event.method === 'thread/tokenUsage/updated') {
      this.threadId ??= event.params.threadId;
      this.usage.update(event.params.threadId, event.params.tokenUsage.total.totalTokens, this.restoredUsage);
      void this.context.workspaceState.update('tokenUsage', this.usage.data);
      this.sync(true); return;
    }
    if (event.method === 'thread/started') this.threadId = event.params.thread.id;
    if (event.method === 'item/started' || event.method === 'item/completed') {
      this.upsert(event.params.item, event.params.turnId);
      const process=this.messages.find(message=>message.id===event.params.item.id);
      if(process?.role==='tool') {if(event.method==='item/started' && !this.completedTurnIds.has(event.params.turnId))process.status='inProgress';else if(!process.status || process.status==='inProgress')process.status='completed';}
      if (event.params.item.type === 'agentMessage') { const message = this.messages.find(message => message.id === event.params.item.id); if (message) message.status = event.method === 'item/started' && !this.completedTurnIds.has(event.params.turnId) ? 'streaming' : 'completed'; }
      if (event.method === 'item/started' && this.isForegroundTurn(event.params.turnId)) this.phase = event.params.item.type === 'commandExecution' ? '执行命令' : event.params.item.type === 'fileChange' ? '修改文件' : event.params.item.type === 'agentMessage' ? '生成回复' : event.params.item.type === 'reasoning' ? '思考中' : '处理中';
    }
    if (event.method === 'turn/started') {
      if (this.busy && this.activeTurnId && this.activeTurnId !== event.params.turn.id) return;
      const now = Date.now();
      this.completedTurnIds.delete(event.params.turn.id); this.busy = true; this.activeTurnId = event.params.turn.id; this.turnStartedAt ??= now; this.lastActivityAt = now; this.queueStatus = undefined; this.queueLoadTurnId = undefined; this.phase = '模型处理中';
    }
    if (event.method === 'queue/status') {
      const queue = { turnId: event.params.turnId, state: event.params.state, position: event.params.position, message: event.params.message, operation: event.params.operation };
      if (queue.operation !== 'contextCompaction' && this.busy && this.activeTurnId && this.activeTurnId !== queue.turnId) return;
      this.queueStatus = queue;
      if (queue.operation === 'contextCompaction') { this.compacting = true; this.transition = true; }
      else { this.busy = true; this.activeTurnId = queue.turnId; }
      this.turnStartedAt ??= Date.now(); this.lastActivityAt = Date.now();
      this.phase = this.queuePhase(queue.state, queue.position, queue.message, queue.operation);
      if (!queue.operation && this.queueLoadTurnId !== queue.turnId) { this.queueLoadTurnId = queue.turnId; void this.refreshModelLoad(queue.turnId); }
    }
    if (event.method === 'turn/plan/updated') {
      const id = 'plan-' + event.params.turnId;
      const text = event.params.plan.map(step => `${step.status === 'completed' ? '✓' : '○'} ${step.step}`).join('\n');
      const existing = this.messages.find(item => item.id === id);
      const status=this.completedTurnIds.has(event.params.turnId)||event.params.plan.every(step=>step.status==='completed')?'completed':'inProgress';
      if (existing) {existing.detail = text;existing.status=status;existing.processKind='plan';existing.toolName='计划';existing.turnId=event.params.turnId;} else this.pushMessage({ id, turnId:event.params.turnId, role: 'tool', text: '执行计划', detail: text, status, processKind:'plan', toolName:'计划' });
    }
    if (event.method === 'item/agentMessage/delta') {
      const existing = this.messages.find(item => item.id === event.params.itemId);
      const firstChunk = !existing?.text;
      let canSendDelta = true;
      if (existing) {
        const combined = existing.text + event.params.delta;
        const bounded = this.limitText(combined, MAX_TEXT_CHARACTERS);
        canSendDelta = bounded === combined; existing.text = bounded; existing.status = this.completedTurnIds.has(event.params.turnId) ? 'completed' : 'streaming'; existing.turnId ??= event.params.turnId;
      }
      else this.pushMessage({ id: event.params.itemId, turnId:event.params.turnId, role: 'assistant', text: event.params.delta, status: this.completedTurnIds.has(event.params.turnId) ? 'completed' : 'streaming' });
      if (this.isForegroundTurn(event.params.turnId)) this.phase = '生成回复';
      this.trimMessages();
      const host = this.owner ?? this;
      if (host.current !== this) { this.sync(); return; }
      if (canSendDelta && !firstChunk && host.view && !host.fullSync && host.fingerprints.has(event.params.itemId)) {
        void host.view.webview.postMessage({ type: 'stream', viewKey: this.runtimeId, id: event.params.itemId, delta: event.params.delta });
      } else this.sync(true);
      return;
    }
    if (event.method === 'item/reasoning/summaryTextDelta') {
      const existing = this.messages.find(message => message.id === event.params.itemId);
      if (existing) {existing.detail = this.limitText((existing.reasoningHasSummary ? existing.detail ?? '' : '') + event.params.delta, MAX_DETAIL_CHARACTERS);existing.reasoningHasSummary=true;existing.status=this.completedTurnIds.has(event.params.turnId)?'completed':'inProgress';existing.processKind='reasoning';existing.turnId=event.params.turnId;}
      else this.pushMessage({ id: event.params.itemId, turnId:event.params.turnId, role: 'tool', text: '思考摘要', detail: event.params.delta, status:this.completedTurnIds.has(event.params.turnId)?'completed':'inProgress', processKind:'reasoning', reasoningHasSummary:true });
      if (this.isForegroundTurn(event.params.turnId)) this.phase = '思考中';
    }
    if (event.method === 'item/reasoning/textDelta') {
      const existing=this.messages.find(message=>message.id===event.params.itemId);
      if(existing) {existing.status=this.completedTurnIds.has(event.params.turnId)?'completed':'inProgress';existing.processKind='reasoning';existing.turnId=event.params.turnId;}
      else this.pushMessage({id:event.params.itemId,turnId:event.params.turnId,role:'tool',text:'思考摘要',status:this.completedTurnIds.has(event.params.turnId)?'completed':'inProgress',processKind:'reasoning',reasoningHasSummary:false});
      if (this.isForegroundTurn(event.params.turnId)) this.phase='思考中';
    }
    if (event.method === 'item/commandExecution/outputDelta') {
      const existing = this.messages.find(item => item.id === event.params.itemId);
      if (existing) { existing.turnId ??= event.params.turnId; this.appendDetail(existing, event.params.delta, true); }
    }
    if (event.method === 'item/fileChange/outputDelta') {
      const existing = this.messages.find(item => item.id === event.params.itemId);
      if (existing) { existing.turnId ??= event.params.turnId; this.appendDetail(existing, event.params.delta, true); }
    }
    if (event.method === 'item/mcpToolCall/progress') {
      const existing = this.messages.find(item => item.id === event.params.itemId);
      if (existing) { existing.turnId ??= event.params.turnId; this.appendDetail(existing, `${existing.detail ? '\n' : ''}${event.params.message}`); }
    }
    if (event.method === 'model/rerouted') {
      const id = `model-rerouted-${event.params.turnId}`;
      const message: Message = { id, turnId:event.params.turnId, role:'tool', process:false, processKind:'modelFallback', text:`模型已自动切换：${event.params.fromModel} → ${event.params.toModel}`, detail:`原因：${event.params.reason}`, status:'completed' };
      const index = this.messages.findIndex(item => item.id === id); if (index >= 0) this.messages[index] = message; else this.pushMessage(message);
    }
    if (event.method === 'model/fallback') {
      this.updateModelFallback(event.params.turnId, event.params.event);
    }
    if (event.method === 'thread/compacted') {
      this.compacting = false; this.transition = false; this.turnStartedAt = undefined; this.queueStatus = undefined; this.queueLoadTurnId = undefined; this.phase = '就绪';
      if (!this.messages.some(message => message.id === `compaction-${event.params.turnId}`)) this.pushMessage({ id:`compaction-${event.params.turnId}`, turnId:event.params.turnId, role:'tool', process:false, text:'上下文已压缩', status:'completed' });
    }
    if (event.method === 'turn/completed') {
      this.completedTurnIds.add(event.params.turn.id); while(this.completedTurnIds.size>1000)this.completedTurnIds.delete(this.completedTurnIds.values().next().value!);
      const completingActive = !this.activeTurnId || this.activeTurnId === event.params.turn.id;
      if (completingActive) { this.busy = false; this.activeTurnId = undefined; this.phase = '就绪'; this.turnStartedAt = undefined; this.queueStatus = undefined; this.queueLoadTurnId = undefined; this.clearApprovals(); }
      for(const message of this.messages)if((message.turnId===event.params.turn.id || (!message.turnId && completingActive)) && message.role==='tool' && message.status==='inProgress')message.status=event.params.turn.status==='completed'?'completed':'interrupted';
      for (const message of this.messages) if ((message.turnId===event.params.turn.id || (!message.turnId && completingActive)) && message.status === 'streaming') message.status = 'completed';
      if (event.params.turn.error) this.error(event.params.turn.error.message);
      if (event.params.turn.status === 'interrupted') this.pushMessage({ id: randomBytes(8).toString('hex'), turnId:event.params.turn.id, role: 'tool', process:false, text: '已停止' });
      (this.owner ?? this).pruneLiveSessions();
    }
    if (event.method === 'error') this.error(event.params.error.message);
    this.trimMessages();
    this.sync(event.method === 'turn/completed' || event.method === 'item/completed');
  }
  private updateModelFallback(turnId: string, event: ModelFallbackEvent) {
    const id = `model-fallback-${turnId}`;
    let message = this.messages.find(item => item.id === id);
    if (!message) {
      message = { id, turnId, role:'tool', process:false, processKind:'modelFallback', text:'正在切换备用模型', detail:'', status:'inProgress' };
      this.pushMessage(message);
    }
    const target = 'target' in event ? event.target : 'to' in event ? event.to : undefined;
    const targetName = target ? `${target.provider} / ${target.model}${target.modelBackendVariant ? ` (${target.modelBackendVariant})` : ''}` : '';
    if (event.type === 'attemptStarted') {
      message.text = `正在切换备用模型：${targetName}`;
      this.appendDetail(message, `${message.detail ? '\n' : ''}第 ${event.ordinal} 次尝试：${event.from.model} → ${event.to.model}`);
      message.status = this.completedTurnIds.has(turnId) ? 'completed' : 'inProgress'; if (this.isForegroundTurn(turnId)) this.phase = '正在切换备用模型';
    } else if (event.type === 'candidateSkipped') {
      this.appendDetail(message, `${message.detail ? '\n' : ''}跳过 ${targetName}：${event.reason}`);
    } else if (event.type === 'settingsAdjusted') {
      this.appendDetail(message, `${message.detail ? '\n' : ''}${event.field}：${event.requested ?? '默认'} → ${event.effective ?? '默认'}（${event.reason}）`);
    } else if (event.type === 'attemptFailed') {
      this.appendDetail(message, `${message.detail ? '\n' : ''}${targetName} 尝试失败：${event.errorKind}，已重试 ${event.retryCount} 次`);
      message.status = this.completedTurnIds.has(turnId) ? 'completed' : 'inProgress'; if (this.isForegroundTurn(turnId)) this.phase = '备用模型重试中';
    } else if (event.type === 'committed') {
      message.text = `已切换备用模型：${targetName}`;
      this.appendDetail(message, `${message.detail ? '\n' : ''}已在第 ${event.ordinal} 个候选模型提交，共尝试 ${event.attemptCount} 次。`);
      message.status = 'completed'; if (this.isForegroundTurn(turnId)) this.phase = '模型处理中';
    } else {
      message.text = '备用模型切换失败';
      this.appendDetail(message, `${message.detail ? '\n' : ''}已尝试 ${event.attempts} 次，最终错误：${event.finalErrorKind}`);
      message.status = 'failed'; if (this.isForegroundTurn(turnId)) this.phase = '备用模型不可用';
    }
    this.normalizeMessage(message);
  }
  private async request(request: ServerRequest): Promise<unknown> {
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      const detail = request.method === 'item/commandExecution/requestApproval' ? `${request.params.command ?? ''}\n${request.params.cwd ?? ''}\n${request.params.reason ?? ''}` : request.params.reason ?? '允许修改文件？';
      return this.waitForApproval(request.id, request.method === 'item/fileChange/requestApproval' ? '文件修改需要授权' : '命令执行需要授权', detail, {decision:'accept'}, {decision:'decline'});
    }
    if (request.method === 'item/permissions/requestApproval') {
      const detail = [request.params.reason, `工作目录：${request.params.cwd}`, JSON.stringify(request.params.permissions, null, 2)].filter(Boolean).join('\n\n');
      return this.waitForApproval(request.id, '需要额外的文件或网络权限', detail, {decision:'accept'}, {decision:'decline'});
    }
    if (request.method === 'applyPatchApproval') {
      const files = Object.keys(request.params.fileChanges).join('\n') || '未提供文件列表';
      const detail = [request.params.reason, request.params.grantRoot ? `授权目录：${request.params.grantRoot}` : '', files].filter(Boolean).join('\n\n');
      return this.waitForApproval(request.id, '文件修改需要授权', detail, {decision:'approved'}, {decision:'denied'});
    }
    if (request.method === 'execCommandApproval') {
      const detail = [`${request.params.command.join(' ')}`, request.params.cwd, request.params.reason ?? ''].filter(Boolean).join('\n');
      return this.waitForApproval(request.id, '命令执行需要授权', detail, {decision:'approved'}, {decision:'denied'});
    }
    if (request.method === 'item/tool/requestUserInput') {
      const epoch = this.epoch;
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of request.params.questions) {
        let answer: string | undefined;
        if (question.options?.length) { const options = question.options.map(option => ({ label: option.label, description: option.description })); const result = await vscode.window.showQuickPick([...options, { label: '输入其他回答', description: '' }], { title: question.question }); if (result?.label === '输入其他回答') answer = await vscode.window.showInputBox({ prompt: question.question, password: question.isSecret }); else answer = result?.label; }
        else answer = await vscode.window.showInputBox({ prompt: question.question, password: question.isSecret });
        if (epoch !== this.epoch) return { answers: {} };
        answers[question.id] = { answers: answer ? [answer] : [] };
      }
      return { answers };
    }
    if (request.method === 'mcpServer/elicitation/request') return this.requestMcpElicitation(request.params);
    if (request.method === 'account/chatgptAuthTokens/refresh') {
      this.authRequired = true; this.loginError = '登录令牌已失效，请重新登录 TRAE CLI。'; this.sync();
      throw this.serverRequestError('扩展不持有账户令牌，请通过 TRAE CLI 登录流程刷新。', -32001);
    }
    if (request.method === 'item/tool/call') throw this.serverRequestError(`未注册动态工具：${request.params.namespace ? `${request.params.namespace}/` : ''}${request.params.tool}`, -32601);
    if (request.method === 'attestation/generate') throw this.serverRequestError('当前 VS Code 扩展不提供设备证明能力。', -32601);
    throw this.serverRequestError(`尚不支持服务端请求：${(request as ServerRequest).method}`, -32601);
  }
  private waitForApproval(idValue: string | number, title: string, detail: string, accept: unknown, decline: unknown) {
    return new Promise(resolve => {
      const id = String(idValue); this.phase = '等待授权'; this.approvals.set(id, { id, title, detail, accept, decline, resolve }); this.sync();
    });
  }
  private serverRequestError(message: string, code: number) {
    const error = new Error(message) as Error & {code:number}; error.code = code; return error;
  }
  private asElicitationSchema(value: unknown): McpElicitationSchema | undefined {
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'object' || !('properties' in value) || !value.properties || typeof value.properties !== 'object') return;
    return value as McpElicitationSchema;
  }
  private async requestMcpElicitation(params: McpServerElicitationRequestParams) {
    if (params.mode === 'url') {
      const choice = await vscode.window.showInformationMessage(`${params.serverName} 请求在浏览器中打开链接。\n${params.message}`, {modal:true, detail:params.url}, '打开链接', '拒绝');
      if (choice !== '打开链接') return {action:'decline'};
      await vscode.env.openExternal(vscode.Uri.parse(params.url));
      return {action:'accept'};
    }
    const schema = params.mode === 'form' ? params.requestedSchema : this.asElicitationSchema(params.requestedSchema);
    if (!schema) throw this.serverRequestError(`${params.serverName} 请求了当前扩展无法解析的表单。`, -32602);
    const content: Record<string, string | number | boolean | string[]> = {};
    const required = new Set(schema.required ?? []);
    for (const [name, field] of Object.entries(schema.properties)) {
      if (!field) continue;
      const result = await this.promptElicitationField(params.serverName, name, field, required.has(name));
      if (result.cancelled) return {action:'cancel'};
      if (result.value !== undefined) content[name] = result.value;
    }
    return {action:'accept', content};
  }
  private async promptElicitationField(serverName: string, name: string, field: McpElicitationPrimitiveSchema, required: boolean): Promise<{cancelled:boolean;value?:string|number|boolean|string[]}> {
    const title = `${serverName} · ${field.title ?? name}`;
    const placeHolder = field.description ?? (required ? '必填' : '可选');
    if (field.type === 'boolean') {
      const selected = await vscode.window.showQuickPick([{label:'是',value:true},{label:'否',value:false}], {title, placeHolder});
      return selected ? {cancelled:false,value:selected.value} : {cancelled:true};
    }
    if (field.type === 'array') {
      const entries = 'anyOf' in field.items ? field.items.anyOf.map(option => ({label:option.title,value:option.const})) : field.items.enum.map(value => ({label:value,value}));
      const selected = await vscode.window.showQuickPick(entries, {title, placeHolder, canPickMany:true});
      return selected ? {cancelled:false,value:selected.map(option => option.value)} : {cancelled:true};
    }
    if (field.type === 'string' && ('oneOf' in field || 'enum' in field)) {
      const entries = 'oneOf' in field ? field.oneOf.map(option => ({label:option.title,value:option.const})) : field.enum.map((value, index) => ({label:'enumNames' in field ? field.enumNames?.[index] ?? value : value,value}));
      const selected = await vscode.window.showQuickPick(entries, {title, placeHolder});
      return selected ? {cancelled:false,value:selected.value} : {cancelled:true};
    }
    const defaultValue = field.default === undefined ? '' : String(field.default);
    const input = await vscode.window.showInputBox({
      title, prompt:field.description, value:defaultValue,
      validateInput:value => {
        if (required && !value.trim()) return '此项为必填项';
        if (field.type === 'string') {
          if (field.minLength !== undefined && value.length < field.minLength) return `至少输入 ${field.minLength} 个字符`;
          if (field.maxLength !== undefined && value.length > field.maxLength) return `最多输入 ${field.maxLength} 个字符`;
        } else if (value.trim()) {
          const number = Number(value); if (!Number.isFinite(number)) return '请输入有效数字';
          if (field.type === 'integer' && !Number.isInteger(number)) return '请输入整数';
          if (field.minimum !== undefined && number < field.minimum) return `不能小于 ${field.minimum}`;
          if (field.maximum !== undefined && number > field.maximum) return `不能大于 ${field.maximum}`;
        }
        return undefined;
      }
    });
    if (input === undefined) return {cancelled:true};
    if (!input && !required) return {cancelled:false};
    return field.type === 'number' || field.type === 'integer' ? {cancelled:false,value:Number(input)} : {cancelled:false,value:input};
  }
  private error(text: string) {
    if (/超时|连接.*失败|已断开/.test(text)) this.reconnectNeeded = true;
    if (isAuthError(text)) {
      this.authRequired = true; this.loginError = ''; this.busy = false;
      this.activeTurnId = undefined; this.phase = '需要登录'; this.turnStartedAt = undefined; this.restoreInFlight(); this.clearApprovals();
    }
    this.pushMessage({ role: 'error', text, id: randomBytes(8).toString('hex') }); this.sync();
  }
  private async send(text: string) {
    if (this.page !== 'chat' || this.busy || this.transition || !text.trim()) return;
    const epoch = this.epoch;
    if (this.authRequired || this.owner?.authRequired) { this.sync(); return; }
    const creating = !this.threadId;
    const submittedAttachments = [...this.attachments];
    const input = [text.trim(), ...submittedAttachments.map(item => item.text)].join('\n\n');
    const limit = vscode.workspace.getConfiguration('traecli').get<number>('maxContextCharacters', 200000);
    if (input.length > limit) { this.error(`消息和附件共 ${input.length} 字符，超过 ${limit} 字符限制，请移除附件或缩小选区。`); return; }
    this.inFlight = { text, attachments: submittedAttachments, messageId: 'pending-' + randomBytes(8).toString('hex') };
    this.draft = ''; this.attachments = []; this.stashDraft();
    void this.context.workspaceState.update('draft', '');
    const startedAt = Date.now();
    this.turnStartedAt = startedAt; this.lastActivityAt = startedAt; this.phase = '准备请求';
    this.pushMessage({ role: 'user', text: input, id: this.inFlight.messageId });
    this.transition = true; this.sync();
    try {
      if (!await this.ensureAuthenticated() || epoch !== this.epoch) { this.restoreInFlight(); return; }
      const needsCatalog = (this.selectedReasoning && !this.reasoningOptions) || (this.selectedMode && !this.modeOptions);
      if (needsCatalog) {
        const models = (await this.getAgent().models()).data;
        const model = this.selectedModel ? models.find(model => model.model === this.selectedModel?.model && model.modelProviderId === this.selectedModel?.modelProviderId) : models.find(model => model.isDefault);
        if (model) this.applyModeCatalog(model);
        else { this.selectedMode = undefined; this.modeOptions = []; this.selectedReasoning = undefined; this.reasoningOptions = []; }
      }
      if (epoch !== this.epoch) { this.restoreInFlight(); return; }
    }
    catch (error) { this.restoreInFlight(); this.error(String(error)); return; }
    finally { this.transition = false; this.sync(); }
    this.busy = true; this.phase = '启动任务'; this.turnStartedAt = startedAt; this.lastActivityAt = startedAt; this.stopRequested = false;
    this.sync();
    try {
      if (this.stopRequested) { this.restoreInFlight(); this.busy = false; this.activeTurnId = undefined; this.sync(); return; }
      const id = await this.getAgent().prompt(input, this.selectedModel?.model, this.selectedModel?.modelProviderId ?? undefined, this.selectedReasoning, this.selectedMode, permissionsFor(this.permissionMode, this.cliOptions().cwd), this.attachmentsForSend());
      if (epoch !== this.epoch) return;
      if (id) { this.inFlight = undefined; if (creating) { this.sessionDrafts.delete('new'); const drafts = this.context.workspaceState.get<Record<string, string>>('sessionDrafts', {}); await this.context.workspaceState.update('sessionDrafts', { ...drafts, new: '' }); } } else this.restoreInFlight();
      this.threadId = id; if (id) await this.context.workspaceState.update('threadId', id); else { this.busy = false; this.activeTurnId = undefined; }
    } catch (error) { if (epoch === this.epoch) {
      const uncertain = error instanceof Error && error.name === 'TurnStartUncertain';
      this.busy = uncertain; this.phase = uncertain ? '状态待确认，请重连' : '发送失败';
      if (!uncertain) this.activeTurnId = undefined;
      this.restoreInFlight(); this.clearApprovals(); this.error(`${String(error)}\n输入和附件已恢复。${uncertain ? '请先重连确认任务状态，不要重复发送。' : '可重试；诊断见输出面板 TRAE CLI。'}`);
    } }
    this.sync();
  }
  private restoreInFlight() {
    if (!this.inFlight) return;
    const snapshot = this.inFlight; this.inFlight = undefined;
    this.draft = this.draft ? `${snapshot.text}\n\n${this.draft}` : snapshot.text;
    const existing = new Set(this.attachments.map(item => item.id));
    this.attachments = [...snapshot.attachments.filter(item => !existing.has(item.id)), ...this.attachments];
    const pending = this.messages.find(item => item.id === snapshot.messageId);
    if (pending) pending.status = 'failed';
    this.stashDraft(); void this.context.workspaceState.update('draft', this.draft);
  }
  private clearApprovals() { for (const pending of this.approvals.values()) pending.resolve(pending.decline); this.approvals.clear(); }
  private async cancel() { this.phase = '正在停止'; this.stopRequested = true; this.clearApprovals(); try { await this.agent?.cancel(); } catch (error) { this.error(String(error)); } this.sync(); }
  private createSession() { return new Sidebar(this.context, this); }
  async restart() {
    const host = this.owner ?? this;
    if (host.current.transition) return;
    host.current.stashDraft();
    const session = host.createSession();
    session.permissionMode = host.current.permissionMode; session.selectedModel = host.current.selectedModel; session.modelLoad = host.current.modelLoad; session.selectedReasoning = host.current.selectedReasoning; session.reasoningOptions = host.current.reasoningOptions; session.selectedMode = host.current.selectedMode; session.modeOptions = host.current.modeOptions;
    host.liveSessions.add(session); host.current = session; host.page = 'chat';
    host.pruneLiveSessions();
    host.fullSync = true; host.sync(true);
  }
  private rememberSession(session: Sidebar) {
    if (!session.threadId) return;
    const existing = this.sessions.find(item => item.id === session.threadId);
    const preview = session.messages.find(message => message.role === 'user')?.text ?? existing?.preview ?? '';
    const summary: SessionSummary = {
      id:session.threadId, name:existing?.name ?? null, preview,
      updatedAt:Math.floor((session.lastActivityAt ?? Date.now()) / 1000),
      cwd:vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? existing?.cwd ?? '',
      model:session.selectedModel?.displayName ?? existing?.model ?? null
    };
    this.sessions = [summary, ...this.sessions.filter(item => item.id !== summary.id)].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0, MAX_HISTORY_SESSIONS);
  }
  private releaseRootConversation() {
    ++this.epoch; this.clearApprovals(); this.agent?.dispose(); this.agent = undefined;
    this.messages = []; this.threadId = undefined; this.activeTurnId = undefined; this.completedTurnIds.clear(); this.inFlight = undefined;
    this.busy = false; this.compacting = false; this.transition = false; this.turnStartedAt = undefined;
    this.queueStatus = undefined; this.queueLoadTurnId = undefined; this.connection = '尚未连接'; this.phase = '就绪';
  }
  private pruneLiveSessions() {
    const host = this.owner ?? this;
    while (host.liveSessions.size > MAX_LIVE_SESSIONS) {
      const candidate = [...host.liveSessions]
        .filter(session => session !== host.current && !session.busy && !session.transition && !session.inFlight && !session.approvals.size && !session.draft && !session.attachments.length)
        .sort((a,b)=>(a.lastActivityAt ?? 0)-(b.lastActivityAt ?? 0))[0];
      if (!candidate) break;
      host.rememberSession(candidate); host.liveSessions.delete(candidate);
      if (candidate === host) candidate.releaseRootConversation(); else candidate.dispose();
    }
  }
  private sessionRows() {
    const rows = new Map(this.sessions.map(({ id, name, preview, updatedAt, model }) => [id, { id, title: name || preview || '未命名会话', preview, updatedAt, model, status: '', live: false }]));
    for (const session of this.liveSessions) {
      if (!session.threadId && !session.messages.length && !session.draft && !session.attachments.length) continue;
      const id = session.threadId ?? session.runtimeId;
      const saved = rows.get(id);
      const preview = session.messages.find(message => message.role === 'user')?.text ?? session.draft;
      rows.set(id, { id, title: saved?.title || preview || '新会话', preview: saved?.preview || preview, updatedAt: session.lastActivityAt ? Math.floor(session.lastActivityAt / 1000) : saved?.updatedAt ?? Math.floor(Date.now() / 1000), model: session.selectedModel?.displayName ?? '', status: session.approvals.size ? '等待授权' : session.busy ? session.phase : '就绪', live: true });
    }
    return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private stashDraft() {
    const key = this.threadId ?? 'new';
    this.sessionDrafts.set(key, { text: this.draft, attachments: [...this.attachments] });
    const saved = this.context.workspaceState.get<Record<string, string>>('sessionDrafts', {});
    void this.context.workspaceState.update('sessionDrafts', { ...saved, [key]: this.draft });
  }
  private restoreDraft(key: string) {
    const draft = this.sessionDrafts.get(key);
    this.draft = draft?.text ?? this.context.workspaceState.get<Record<string, string>>('sessionDrafts', {})[key] ?? '';
    this.attachments = draft?.attachments ?? [];
  }
  private async history() {
    if (this.current.transition) return;
    this.current.stashDraft(); this.page = 'sessions'; this.sync(); await this.loadSessions();
  }
  private async loadSessions(more = false) {
    if (this.historyLoading || (more && !this.historyCursor)) return;
    const request = ++this.historyRequest; const epoch = this.epoch;
    this.historyLoading = true; this.historyError = ''; this.sync();
    try {
      const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!project) throw new Error('请先打开项目文件夹。');
      if (!await this.ensureAuthenticated() || request !== this.historyRequest || epoch !== this.epoch) return;
      const result = await this.getAgent().history(more ? this.historyCursor : undefined);
      if (request !== this.historyRequest || epoch !== this.epoch) return;
      const incoming = result.data.filter(thread => sameProject(thread.cwd, project));
      const combined = new Map((more ? this.sessions : []).map(thread => [thread.id, thread]));
      for (const thread of incoming) combined.set(thread.id, thread);
      this.sessions = [...combined.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HISTORY_SESSIONS);
      this.historyCursor = this.sessions.length >= MAX_HISTORY_SESSIONS ? undefined : result.nextCursor ?? undefined;
    } catch (error) { if (request === this.historyRequest && epoch === this.epoch) { if (isAuthError(error)) this.authRequired = true; else this.historyError = String(error); } }
    finally { if (request === this.historyRequest) { this.historyLoading = false; this.sync(); } }
  }
  private async openSession(id: string) {
    if (this.current.transition) return;
    const live = [...this.liveSessions].find(session => (session.threadId ?? session.runtimeId) === id);
    if (live) { this.current.stashDraft(); this.current = live; this.page = 'chat'; this.fullSync = true; this.sync(true); return; }
    const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const selected = this.sessions.find(session => session.id === id);
    if (!project || !selected || !sameProject(selected.cwd, project)) return;
    const previous = this.current;
    previous.stashDraft(); previous.transition = true; this.historyError = ''; this.sync();
    const session = this.createSession();
    try {
      const resumed = await session.getAgent().resume(id);
      if (this.disposed) { session.dispose(); return; }
      session.restoredUsage = true;
      if (resumed.tokenUsage) { session.usage.baseline(resumed.thread.id, resumed.tokenUsage.total.totalTokens); void this.context.workspaceState.update('tokenUsage', this.usage.data); }
      session.threadId = resumed.thread.id; session.selectedReasoning = resumed.reasoningEffort ?? undefined; session.selectedMode = resumed.modelBackendVariant;
      session.selectedModel = { model: resumed.model, displayName: resumed.model, modelProviderId: resumed.modelProvider };
      for (const turn of resumed.thread.turns) { if (turn.status !== 'inProgress') session.completedTurnIds.add(turn.id); for (const item of turn.items) session.upsert(item, turn.id); }
      session.busy = resumed.thread.turns.some(turn => turn.status === 'inProgress');
      session.activeTurnId = resumed.thread.turns.find(turn => turn.status === 'inProgress')?.id;
      session.phase = session.busy ? '处理中' : '就绪';
      session.restoreDraft(session.threadId);
      this.liveSessions.add(session); this.current = session; this.page = 'chat'; this.fullSync = true;
      this.pruneLiveSessions();
    } catch (error) {
      session.dispose();
      if (isAuthError(error)) this.authRequired = true; else this.historyError = `打开会话失败：${String(error)}`;
    } finally { previous.transition = false; this.sync(true); }
  }
  private postToSession(message: object) {
    const host = this.owner ?? this;
    if (host.current === this) void host.view?.webview.postMessage({ ...message, viewKey: this.runtimeId });
  }
  private async chooseModel(id?: string) {
    if (this.transition) return; const epoch = this.epoch;
    try {
      const models = (await this.getAgent().models()).data.filter(model => !model.hidden);
      if (epoch !== this.epoch) return;
      if (id === undefined) {
        const current = this.selectedModel ? models.find(model => model.model === this.selectedModel?.model && model.modelProviderId === this.selectedModel?.modelProviderId) : models.find(model => model.isDefault);
        if (current) this.rememberModelLoad(current);
        this.postToSession({ type: 'models', models: models.map(model => ({ id: model.id, label: model.displayName, description: model.description, selected: model.model === this.selectedModel?.model && model.modelProviderId === this.selectedModel?.modelProviderId })) });
        return;
      }
      const selected = models.find(model => model.id === id);
      if (selected) {
        const changed = this.selectedModel?.model !== selected.model || this.selectedModel?.modelProviderId !== selected.modelProviderId;
        this.selectedModel = { model: selected.model, displayName: selected.displayName, modelProviderId: selected.modelProviderId };
        if (changed) { this.selectedMode = undefined; this.selectedReasoning = undefined; }
        this.applyModeCatalog(selected);
        await this.context.workspaceState.update('selectedMode', this.selectedMode);
        await this.context.workspaceState.update('selectedReasoning', this.selectedReasoning);
        await this.context.workspaceState.update('selectedModel', this.selectedModel); this.sync();
      }
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.postToSession({ type: 'models', models: [], error: '加载模型失败，请重试' });
      this.error(String(error));
    }
  }
  private attachmentsForSend() { return this.inFlight?.attachments.flatMap(attachment => attachment.skill ? [attachment.skill] : []); }
  private setPermissionMode(mode: unknown) {
    if (this.busy || this.transition || !permissionChoices.some(option => option.id === mode)) return false;
    this.permissionMode = mode as PermissionMode; this.sync(); return true;
  }
  private async loadSlashOptions(command: string, requestId: number) {
    const epoch = this.epoch;
    try {
      let options: SlashOption[] = [];
      if (command === 'permissions') options = permissionChoices.map(option => ({id:option.id,label:option.name,description:option.description,selected:option.id===this.permissionMode}));
      else if (command === 'skills') {
        const entries = (await this.getAgent().skills()).data;
        if (epoch !== this.epoch) return;
        this.slashSkills = entries.flatMap(entry => entry.skills).filter(skill => skill.enabled);
        options = this.slashSkills.map(skill => ({id:skill.path,label:skill.name,description:skill.description}));
      } else if (['model','mode','reasoning'].includes(command)) {
        const models = (await this.getAgent().models()).data.filter(model => !model.hidden);
        if (epoch !== this.epoch) return;
        if (command === 'model') options = models.map(model => ({id:model.id,label:model.displayName,description:model.description,selected:model.model===this.selectedModel?.model && model.modelProviderId===this.selectedModel?.modelProviderId}));
        else {
          const selected = this.selectedModel ? models.find(model => model.model===this.selectedModel?.model && model.modelProviderId===this.selectedModel?.modelProviderId) : models.find(model => model.isDefault);
          if (selected) {
            this.applyModeCatalog(selected);
            options = command === 'mode' ? (this.modeOptions ?? []).map(mode => ({id:mode.id,label:mode.name,description:mode.contextWindow ? `上下文窗口 ${mode.contextWindow.toLocaleString()} tokens` : '',selected:mode.id===this.selectedMode})) : (this.reasoningOptions ?? []).map(option => ({id:option.reasoningEffort,label:option.reasoningEffort,description:option.description,selected:option.reasoningEffort===this.selectedReasoning}));
          }
        }
      } else return;
      this.postToSession({type:'slashOptions',command,requestId,options});
    } catch(error) { if(epoch===this.epoch) this.postToSession({type:'slashOptions',command,requestId,options:[],error:'加载失败，请重新输入命令重试。'}); this.output.appendLine(String(error)); }
  }
  private async executeSlash(command: string, option?: string) {
    if (this.transition || !slashCommands.some(entry => entry.name===command)) return;
    try {
      const host = this.owner ?? this;
      if (command === 'model' && option) await this.chooseModel(option);
      else if (command === 'mode' && option) await this.chooseMode(option);
      else if (command === 'reasoning' && option) await this.chooseReasoning(option);
      else if (command === 'permissions') this.setPermissionMode(option);
      else if (command === 'skills' && option) {
        const skill = this.slashSkills.find(entry=>entry.path===option && entry.enabled); if(!skill)return;
        if (!this.attachments.some(entry=>entry.skill?.path===skill.path)) this.attachments.push({id:randomBytes(8).toString('hex'),label:'技能 · '+skill.name,text:'使用技能 $'+skill.name,skill:{name:skill.name,path:skill.path}});
        this.sync();
      }
      else if (command === 'new' || command === 'clear') await host.restart();
      else if (command === 'history') await host.history();
      else if (command === 'review') await this.reviewChanges();
      else if (command === 'compact') {
        if(this.busy) {this.error('请等待当前任务完成后再压缩上下文。');return;}
        if(!this.threadId) {this.error('请先开始一个会话，再压缩上下文。');return;}
        this.transition=true;this.compacting=true;this.turnStartedAt=Date.now();this.phase='压缩上下文';this.sync();
        try {await this.getAgent().compact();}
        finally {this.compacting=false;this.transition=false;this.turnStartedAt=undefined;this.queueStatus=undefined;this.queueLoadTurnId=undefined;this.phase='就绪';this.sync();}
      }
      else if (command === 'init') await this.send('请检查当前项目的代码结构、开发命令和现有约定，创建或更新项目根目录的 AGENTS.md，记录适合本项目的开发与验证指南。');
      else if (command === 'status' || command === 'help') {
        this.pushMessage({id:randomBytes(8).toString('hex'),role:'tool',process:false,text:command==='help'?'侧栏命令':'会话状态',detail:command==='help'?slashCommands.map(entry=>'/'+entry.name+' · '+entry.description).join('\n'):`连接：${this.connection}\n会话：${this.threadId ?? '尚未开始'}\n模型：${this.selectedModel?.displayName ?? '默认模型'}\n状态：${this.phase}`});this.sync();
      }
    } catch(error) {this.error(String(error));}
  }
  private async chooseReasoning(effort?: string) {
    if (this.transition) return;
    const epoch = this.epoch; const model = this.selectedModel;
    try {
      const models = (await this.getAgent().models()).data.filter(model => !model.hidden);
      if (epoch !== this.epoch || model !== this.selectedModel) return;
      const selected = model ? models.find(entry => entry.model === model.model && entry.modelProviderId === model.modelProviderId) : models.find(entry => entry.isDefault);
      if (!selected) { this.postToSession({type:'reasoningLevels', options:[], error:'请先选择模型，再设置 Reasoning Level。'}); return; }
      this.applyModeCatalog(selected);
      if (effort !== undefined) {
        const option = (this.reasoningOptions ?? []).find(option => option.reasoningEffort === effort);
        if (option) { this.selectedReasoning = option.reasoningEffort; await this.context.workspaceState.update('selectedReasoning', this.selectedReasoning); }
      } else this.postToSession({type:'reasoningLevels', options:(this.reasoningOptions ?? []).map(option => ({id:option.reasoningEffort, description:option.description, selected:option.reasoningEffort === this.selectedReasoning})), error:this.reasoningOptions?.length ? undefined : '当前模型不支持调节 Reasoning Level。'});
      this.sync();
    } catch (error) { this.postToSession({type:'reasoningLevels', options:[], error:'加载推理等级失败，请重试。'}); this.output.appendLine(String(error)); }
  }
  private applyModeCatalog(model: Model) {
    this.rememberModelLoad(model);
    this.modeOptions = modelModes(model);
    const mode = resolveMode(this.modeOptions, this.selectedMode);
    this.selectedMode = mode?.id;
    this.reasoningOptions = mode?.reasoning ?? model.supportedReasoningEfforts ?? [];
    const defaultEffort = mode?.defaultReasoning ?? model.defaultReasoningEffort;
    if (!this.reasoningOptions.some(option => option.reasoningEffort === this.selectedReasoning)) this.selectedReasoning = this.reasoningOptions.find(option => option.reasoningEffort === defaultEffort)?.reasoningEffort ?? this.reasoningOptions[0]?.reasoningEffort;
  }
  private rememberModelLoad(model: Model) {
    const load = model.businessMetadata?.load;
    if (!load) { this.modelLoad = undefined; return; }
    const queueSize = load.queue_size === null ? undefined : Number(load.queue_size);
    const validQueueSize = queueSize !== undefined && Number.isSafeInteger(queueSize) && queueSize >= 0;
    this.modelLoad = { percent: Math.max(0, Math.min(100, Math.round(load.load_percent))), ...(validQueueSize ? { queueSize } : {}) };
  }
  private async refreshModelLoad(turnId: string) {
    const epoch = this.epoch;
    try {
      const models = (await this.getAgent().models()).data;
      if (epoch !== this.epoch || this.queueStatus?.turnId !== turnId) return;
      const model = this.selectedModel ? models.find(model => model.model === this.selectedModel?.model && model.modelProviderId === this.selectedModel?.modelProviderId) : models.find(model => model.isDefault);
      if (model) this.rememberModelLoad(model);
      const queue = this.queueStatus;
      if (queue?.turnId === turnId) { this.phase = this.queuePhase(queue.state, queue.position, queue.message, queue.operation); this.sync(); }
    } catch (error) { if (this.queueLoadTurnId === turnId) this.queueLoadTurnId = undefined; this.output.appendLine(`读取模型负载失败：${String(error)}`); }
  }
  private queuePhase(state: string, position: number | null, message: string | null, operation: string | null) {
    const parts: string[] = [];
    if (!operation && this.modelLoad) parts.push(`模型负载 ${this.modelLoad.percent}%`);
    const subject = operation === 'contextCompaction' ? '上下文压缩' : '';
    if (state === 'ready') parts.push(`${subject}排队完成，正在启动`);
    else if (state === 'queued' || state === 'waiting') {
      parts.push(`${subject}排队中`);
      if (position !== null) parts.push(`队列第 ${Math.max(1, position)} 位`);
      else if (!operation && this.modelLoad?.queueSize) parts.push(`当前约 ${this.modelLoad.queueSize} 个请求`);
    } else parts.push(message || `${subject}队列状态：${state}`);
    return parts.join(' · ');
  }
  private async chooseMode(id?: string) {
    if (this.transition) return;
    const epoch = this.epoch; const model = this.selectedModel;
    try {
      const models = (await this.getAgent().models()).data.filter(entry => !entry.hidden);
      if (epoch !== this.epoch || model !== this.selectedModel) return;
      const selected = model ? models.find(entry => entry.model === model.model && entry.modelProviderId === model.modelProviderId) : models.find(entry => entry.isDefault);
      if (!selected) { this.postToSession({type:'modelModes', options:[], error:'请先选择模型，再设置 Mode。'}); return; }
      this.applyModeCatalog(selected);
      if (id !== undefined) {
        const option = this.modeOptions?.find(option => option.id === id);
        if (option) { this.selectedMode = option.id; this.applyModeCatalog(selected); await this.context.workspaceState.update('selectedMode', this.selectedMode); await this.context.workspaceState.update('selectedReasoning', this.selectedReasoning); }
      } else this.postToSession({type:'modelModes', options:this.modeOptions?.map(option => ({id:option.id, name:option.name, description:option.contextWindow ? `上下文窗口 ${option.contextWindow.toLocaleString()} tokens` : '', selected:option.id === this.selectedMode})), error:this.modeOptions?.length ? undefined : '当前模型没有可选 Mode，使用模型默认模式。'});
      this.sync();
    } catch (error) { this.postToSession({type:'modelModes', options:[], error:'加载模型 Mode 失败，请重试。'}); this.output.appendLine(String(error)); }
  }
  async sendSelection() {
    if (!this.owner && this.current !== this) { await this.current.sendSelection(); return; }
    const editor = vscode.window.activeTextEditor; if (!editor || editor.selection.isEmpty) return;
    const path = vscode.workspace.asRelativePath(editor.document.uri);
    this.attachments.push({ id: randomBytes(8).toString('hex'), label: `${path}:${editor.selection.start.line + 1}`, text: `${path}:${editor.selection.start.line + 1}\n\`\`\`${editor.document.languageId}\n${editor.document.getText(editor.selection)}\n\`\`\`` });
    const host = this.owner ?? this; host.page = 'chat'; host.fullSync = true; await vscode.commands.executeCommand('traecli.chat.focus'); host.view?.show(true); this.sync();
  }
  private async attachFile() {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) { await this.sendSelection(); return; }
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, openLabel: '添加上下文' });
    for (const file of files ?? []) await this.addFile(file);
    this.sync();
  }
  private async reconnect() {
    if (this.transition) return;
    ++this.historyRequest; this.historyLoading = false;
    this.transition = true; this.phase = '重新连接'; this.sync();
    try {
      if (!await this.ensureAuthenticated() || this.disposed) return;
      this.restoreInFlight(); ++this.epoch; this.clearApprovals(); this.agent?.dispose(); this.agent = undefined;
      const saved = this.threadId;
      this.busy = false; this.compacting = false; this.activeTurnId = undefined;
      if (saved) {
        const resumed = await this.getAgent().resume(saved);
        this.restoredUsage = true;
        if (resumed.tokenUsage) { this.usage.baseline(resumed.thread.id, resumed.tokenUsage.total.totalTokens); void this.context.workspaceState.update('tokenUsage', this.usage.data); }
        this.threadId = resumed.thread.id; this.selectedReasoning = resumed.reasoningEffort ?? undefined; this.reasoningOptions = undefined; this.selectedMode = resumed.modelBackendVariant; this.modeOptions = undefined; this.messages = [];
        this.completedTurnIds.clear();
        for (const turn of resumed.thread.turns) { if (turn.status !== 'inProgress') this.completedTurnIds.add(turn.id); for (const item of turn.items) this.upsert(item, turn.id); }
        this.selectedModel = { model: resumed.model, displayName: resumed.model, modelProviderId: resumed.modelProvider };
        this.busy = resumed.thread.turns.some(turn => turn.status === 'inProgress');
        this.activeTurnId = resumed.thread.turns.find(turn => turn.status === 'inProgress')?.id;
      } else await this.getAgent().models();
      this.reconnectNeeded = false;
    } catch (error) { this.reconnectNeeded = true; this.error(`重新连接失败：${String(error)}`); }
    finally { this.transition = false; this.phase = this.busy ? '处理中' : '就绪'; this.fullSync = true; this.sync(); const host = this.owner ?? this; host.fullSync = true; if (host.page === 'sessions') void host.loadSessions(); }
  }
  private virtualUri(name: string, text: string) {
    const uri = vscode.Uri.from({ scheme: 'trae-review', path: `/${randomBytes(8).toString('hex')}/${name}` });
    this.virtualDocuments.set(uri.toString(), text);
    while (this.virtualDocuments.size > MAX_VIRTUAL_DOCUMENTS) this.virtualDocuments.delete(this.virtualDocuments.keys().next().value!);
    return uri;
  }
  private async previewAttachment(id: string) {
    const attachment = this.attachments.find(item => item.id === id); if (!attachment) return;
    await vscode.window.showTextDocument(this.virtualUri('context.md', attachment.text), { preview: true });
  }
  private async addFile(file: vscode.Uri) {
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      if (doc.getText().length > 100000) { void vscode.window.showWarningMessage('文件过大，请选中需要的代码片段。'); return; }
      const text = `${vscode.workspace.asRelativePath(file)}\n\`\`\`${doc.languageId}\n${doc.getText()}\n\`\`\``;
      const limit = vscode.workspace.getConfiguration('traecli').get<number>('maxContextCharacters', 200000);
      if (this.attachments.reduce((sum, item) => sum + item.text.length, this.draft.length) + text.length > limit) { void vscode.window.showWarningMessage('上下文总长度超限，请移除部分附件。'); return; }
      this.attachments.push({ id: randomBytes(8).toString('hex'), label: vscode.workspace.asRelativePath(file), text }); this.sync();
    } catch (error) { this.error(`无法添加文件：${String(error)}`); }
  }
  private async pickFile() {
    const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,.vscode-test}/**', 2000);
    const selected = await vscode.window.showQuickPick(files.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })), { title: '搜索项目文件并添加上下文（最多 2000 个候选）', matchOnDescription: true });
    if (selected) await this.addFile(selected.uri);
  }
  async reviewChanges() {
    if (!this.owner && this.current !== this) { await this.current.reviewChanges(); return; }
    const choices = this.messages.flatMap(message => (message.changes ?? []).map(change => ({ label: vscode.workspace.asRelativePath(change.path), description: message.status, id: message.id, path: change.path })));
    if (!choices.length) { void vscode.window.showInformationMessage('当前会话没有可审阅的文件变更。'); return; }
    const selected = await vscode.window.showQuickPick(choices, { title: '审阅会话中的文件变更' });
    if (selected) await this.reviewFile(selected.id, selected.path);
  }
  private async reviewFile(id: string, path: string) {
    const change = this.messages.find(message => message.id === id)?.changes?.find(change => change.path === path);
    if (!change) return;
    try {
      let current = '';
      try { current = (await vscode.workspace.openTextDocument(vscode.Uri.file(change.currentPath ?? path))).getText(); } catch (error) { if (existsSync(change.currentPath ?? path)) throw error; }
      const before = reconstructBefore(current, change.diff);
      if (before === undefined) {
        void vscode.window.showInformationMessage('当前文件与记录的补丁无法精确匹配，显示原始补丁供审阅。');
        await vscode.window.showTextDocument(this.virtualUri(`${basename(path)}.diff`, change.diff), { preview: true }); return;
      }
      const left = this.virtualUri(basename(path), before); const right = this.virtualUri(basename(path), current);
      await vscode.commands.executeCommand('vscode.diff', left, right, `${basename(path)} · TRAE 修改前 ↔ 当前`, { preview: true });
    } catch (error) { this.error(`无法打开差异：${String(error)}`); }
  }
  private async openFile(path: string) { const allowed = this.messages.some(message => message.paths?.includes(path)); if (!allowed) return; await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: true }); }
  dispose() { if (this.disposed) return; this.disposed = true; if (!this.owner) for (const session of this.liveSessions) if (session !== this) session.dispose(); clearTimeout(this.loginTimer); this.stashDraft(); ++this.historyRequest; clearTimeout(this.syncTimer); clearTimeout(this.draftTimer); void this.context.workspaceState.update('draft', this.draft); ++this.epoch; this.clearApprovals(); this.agent?.dispose(); if (!this.owner) { this.virtualDocuments.clear(); this.output.dispose(); } }
}
function escapeHtml(text: string) { return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)); }
export function activate(context: vscode.ExtensionContext) {
  const sidebar = new Sidebar(context);
  context.subscriptions.push(sidebar, vscode.window.registerWebviewViewProvider('traecli.chat', sidebar, { webviewOptions: { retainContextWhenHidden: true } }), vscode.commands.registerCommand('traecli.restart', () => sidebar.restart()), vscode.commands.registerCommand('traecli.open', () => vscode.commands.executeCommand('traecli.chat.focus')), vscode.commands.registerCommand('traecli.sendSelection', () => sidebar.sendSelection()), vscode.commands.registerCommand('traecli.reviewChanges', () => sidebar.reviewChanges()));
}
