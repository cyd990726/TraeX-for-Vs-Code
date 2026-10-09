import { permissionChoices } from './permissions';
import { slashCommands } from './slash';
import { renderMarkdown } from './markdown';
const vscode = acquireVsCodeApi();
const prompt = document.getElementById('prompt');
const messages = document.getElementById('messages');
const approvals = document.getElementById('approvals');
let busy = false;
let running = false;
let lastDraft;
let revision = 0;
let viewKey;
let phase = '';
let startedAt;
let windowEnd = null;
let stateSnapshot;
const store = new Map();
const statusNames = { inProgress: '执行中', completed: '已完成', failed: '失败', declined: '已拒绝', interrupted: '已停止', pending: '待执行' };
const taskStatus = document.getElementById('status');
taskStatus.classList.add('task-status');
if (document.getElementById('composer').contains(taskStatus)) document.getElementById('composer').before(taskStatus);
function refreshStatus() { const elapsed = startedAt ? ` · ${Math.floor((Date.now() - startedAt) / 1000)}秒` : ''; taskStatus.textContent = busy ? phase + elapsed : ''; }
setInterval(refreshStatus, 1000);
function processActivityLabel(value = '') {
  if (/等待授权/.test(value)) return '等待授权';
  if (/排队/.test(value)) return '排队中';
  if (/生成回复/.test(value)) return '生成回复中';
  if (/执行命令/.test(value)) return '执行命令中';
  if (/修改文件/.test(value)) return '修改文件中';
  if (/停止/.test(value)) return '正在停止';
  if (/启动|准备|连接|登录/.test(value)) return '正在启动';
  if (/思考/.test(value)) return '思考中';
  return '模型处理中';
}
const nodes = new Map();
const processGroups = new Map();
const processOpen = new Map();
const post = message => vscode.postMessage({ ...message, viewKey });
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const connectionPanel = document.getElementById('connection');
const connectionLabel = element('span', 'connection-label');
const reconnectButton = document.getElementById('reconnect') ?? element('button');
reconnectButton.id = 'reconnect'; reconnectButton.type = 'button'; reconnectButton.textContent = '重新连接';
reconnectButton.title = '重新连接并恢复会话，不自动重发请求'; reconnectButton.hidden = true;
reconnectButton.onclick = () => post({type: 'reconnect'});
connectionPanel.replaceChildren(connectionLabel, reconnectButton);
const usageHint = document.getElementById('token-usage') ?? document.querySelector('footer .hint');
const usageValue = element('span', 'usage-value'); usageValue.setAttribute('aria-live', 'polite');
usageHint.replaceChildren(usageValue);
usageHint.title = 'CLI 返回的本会话累计 Token 用量，收到用量通知时实时更新；尚未返回时显示 —。Enter 发送，Shift+Enter 换行。';
let usageSnapshot;
function formatTokens(tokens) {
  const units = ['', 'K', 'M', 'B', 'T', 'P'];
  let value = tokens, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  let rounded = Math.round(value * 100) / 100;
  if (rounded >= 1000 && unit < units.length - 1) { rounded /= 1000; unit++; }
  return `${rounded.toLocaleString(undefined, {maximumFractionDigits: 2})}${units[unit]}`;
}
function refreshUsage() {
  const tokens = usageSnapshot?.session;
  usageValue.textContent = tokens == null ? '— tokens' : `${formatTokens(tokens)} tokens`;
  usageValue.title = tokens == null ? 'CLI 尚未返回用量数据' : `${tokens.toLocaleString()} tokens`;
  usageValue.setAttribute('aria-label', tokens == null ? 'Token 用量尚未返回' : `${tokens.toLocaleString()} tokens`);
}
refreshUsage();
function resizePrompt() {
  const style = getComputedStyle(prompt);
  const minimum = 2 * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const maximum = Math.max(200, minimum);
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(maximum, Math.max(minimum, prompt.scrollHeight))}px`;
  prompt.style.overflowY = prompt.scrollHeight > maximum ? 'auto' : 'hidden';
}
let promptWidth;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width > 0 && entry.contentRect.width !== promptWidth) {
    promptWidth = entry.contentRect.width;
    resizePrompt();
  }
}).observe(prompt);
function send() { if (submitSlash()) return; if (!busy && prompt.value.trim()) { const text = prompt.value; prompt.value = ''; lastDraft = ''; resizePrompt(); post({ type: 'send', text, revision: ++revision }); } }
document.getElementById('composer').addEventListener('submit', event => { event.preventDefault(); send(); });
prompt.addEventListener('keydown', event => { if (handleSlashKey(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } });
prompt.addEventListener('input', () => { lastDraft = prompt.value; post({ type: 'draft', text: prompt.value, revision: ++revision }); resizePrompt(); refreshSlash(); if (!running && !busy) document.getElementById('send').disabled = !prompt.value.trim(); });
for (const type of ['back', 'new', 'history', 'attach', 'review']) document.getElementById(type)?.addEventListener('click', () => post({ type }));
if (!document.getElementById('back')) { const back = element('button', '', '←'); back.id = 'back'; back.setAttribute('aria-label', '返回会话列表'); document.querySelector('header').prepend(back); back.onclick = () => post({type:'back'}); }
const sessionHome = document.getElementById('session-home') ?? element('section', 'session-home');
if (!sessionHome.id) { sessionHome.id = 'session-home'; messages.before(sessionHome); }
const authPanel = element('section', 'auth-panel'); authPanel.id = 'auth-panel'; authPanel.setAttribute('aria-label', 'TRAE CLI 登录'); sessionHome.before(authPanel);
let authSignature = '';
function showAuth(data) {
  const signature = JSON.stringify([data.authRequired, data.loginPending, data.loginError]);
  if (authSignature === signature) return;
  authSignature = signature;
  document.body.dataset.auth = data.authRequired ? 'required' : 'ready';
  authPanel.replaceChildren();
  if (!data.authRequired) return;
  authPanel.append(element('h2', '', '登录 TRAE CLI'), element('p', '', '登录后即可查看本项目的历史会话并开始对话。'));
  const login = element('button', 'auth-login', data.loginPending ? '查看登录终端' : '去登录');
  login.onclick = () => post({ type: 'login' }); authPanel.append(login);
  const status = element('p', 'session-notice', data.loginPending ? '请在 VS Code 终端完成登录，完成后会自动刷新会话列表。' : '使用 TRAE CLI 官方登录流程。');
  status.setAttribute('role', 'status'); authPanel.append(status);
  const check = element('button', 'auth-check', '我已登录，重新检测'); check.onclick = () => post({ type: 'checkLogin' }); authPanel.append(check);
  if (data.loginError) { const error = element('p', 'session-error', data.loginError); error.setAttribute('role', 'alert'); authPanel.append(error); }
}
function sessionTime(seconds) {
  const date = new Date(seconds * 1000); const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  if (days === 0) return date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  if (days === 1) return '昨天';
  return date.toLocaleDateString([], {month:'short', day:'numeric', ...(date.getFullYear() !== today.getFullYear() ? {year:'numeric'} : {})});
}
let sessionSignature = '';
function showSessions(data) {
  document.body.dataset.page = data.page ?? 'chat';
  const signature = JSON.stringify([data.sessions, data.project, data.historyLoading, data.historyError, data.hasMoreSessions, data.currentSession, data.busy, data.transition]);
  if (signature === sessionSignature) return;
  const focusedId = sessionHome.contains(document.activeElement) ? document.activeElement.dataset.sessionId : undefined;
  sessionSignature = signature; sessionHome.replaceChildren();
  const heading = element('div', 'session-heading');
  heading.append(element('h2', '', '项目会话'), element('p', '', data.project ?? '当前项目'));
  const refresh = element('button', 'session-refresh', '↻'); refresh.title = '刷新会话'; refresh.setAttribute('aria-label', '刷新会话'); refresh.disabled = !!data.historyLoading;
  refresh.onclick = () => post({ type: 'refreshSessions' }); heading.append(refresh); sessionHome.append(heading);
  const create = element('button', 'session-create', '＋ 新建会话'); create.disabled = !!data.transition; create.onclick = () => post({type:'new'}); sessionHome.append(create);
  if (data.currentSession) {
    const active = element('button', 'continue-session', data.busy ? '返回正在处理的会话 →' : '返回当前会话 →');
    active.onclick = () => post({ type: 'continueSession' }); active.disabled = !!data.transition; sessionHome.append(active);
  }
  if (data.historyLoading) { const loading = element('p', 'session-notice', '正在加载本项目的会话…'); loading.setAttribute('role', 'status'); sessionHome.append(loading); }
  if (data.historyError) { const error = element('p', 'session-error', data.historyError); error.setAttribute('role', 'alert'); sessionHome.append(error); }
  if (!data.sessions?.length && !data.historyLoading && !data.historyError) {
    const empty = element('div', 'session-empty'); empty.append(element('strong', '', '从一个新会话开始'), element('p', '', '描述任务，或把代码选区添加到对话中。')); sessionHome.append(empty);
  }
  const pending = (data.sessions ?? []).filter(session => session.status && session.status !== '就绪');
  const recent = (data.sessions ?? []).filter(session => !pending.includes(session));
  for (const [label, sessions] of [['正在进行', pending], ['最近会话', recent]]) {
    if (!sessions.length) continue;
    sessionHome.append(element('h3', 'session-group', `${label} · ${sessions.length}`));
    for (const session of sessions) {
      const card = element('button', 'session-card'); card.dataset.sessionId = session.id; card.dataset.status = session.status ?? ''; card.title = session.title; card.disabled = !!data.transition;
      if (session.id === data.currentSession) card.setAttribute('aria-current', 'true');
      const top = element('div', 'session-card-top'); top.append(element('strong', 'session-title', session.title));
      if (session.status && session.status !== '就绪') top.append(element('span', 'session-badge', session.status));
      card.append(top);
      if (session.preview && session.preview !== session.title) card.append(element('span', 'session-preview', session.preview));
      const meta = element('span', 'session-meta');
      const time = element('time', '', sessionTime(session.updatedAt)); time.title = new Date(session.updatedAt * 1000).toLocaleString(); meta.append(time);
      if (session.model) { const model = element('span', 'session-model', session.model); model.title = session.model; meta.append(model); }
      if (session.id === data.currentSession) meta.append(element('span', 'session-current', '当前'));
      card.append(meta); card.onclick = () => post({ type: session.id === data.currentSession ? 'continueSession' : 'openSession', id: session.id }); sessionHome.append(card);
      if (session.id === focusedId) card.focus({preventScroll:true});
    }
  }
  if (data.hasMoreSessions) { const more = element('button', 'session-more', data.historyLoading ? '加载中…' : '加载更多'); more.disabled = !!data.historyLoading; more.onclick = () => post({ type: 'moreSessions' }); sessionHome.append(more); }
}
const jumpLatest = element('button', 'jump-latest', '↓ 回到最新'); jumpLatest.hidden = true; jumpLatest.type = 'button'; document.querySelector('footer').prepend(jumpLatest);
function updateJump() { jumpLatest.hidden = windowEnd === null && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 70; }
messages.addEventListener('scroll', updateJump, {passive:true});
jumpLatest.onclick = () => {
  if (windowEnd !== null && stateSnapshot) { windowEnd = null; window.dispatchEvent(new MessageEvent('message', {data: {...stateSnapshot, reset: false, messages: [], removed: []}})); }
  messages.scrollTop = messages.scrollHeight; updateJump();
};
const actions = document.querySelector('.actions');
const sendButton = document.getElementById('send');
actions.append(sendButton);
document.getElementById('stop')?.remove();
sendButton.addEventListener('click', event => {
  if (running) { event.preventDefault(); sendButton.disabled = true; sendButton.title = '正在终止'; post({ type: 'stop' }); }
});
const modelButton = document.getElementById('model');
const modelAnchor = element('div', 'model-anchor');
modelButton.before(modelAnchor); modelAnchor.append(modelButton);
const modelMenu = element('div', 'model-menu');
modelMenu.hidden = true; modelMenu.setAttribute('role', 'menu'); modelMenu.setAttribute('aria-label', '选择模型');
modelAnchor.append(modelMenu);
modelButton.setAttribute('aria-haspopup', 'menu'); modelButton.setAttribute('aria-expanded', 'false');
function fitModelMenu() {
  if (modelMenu.hidden) return;
  modelMenu.style.maxHeight = `${Math.max(40, Math.min(320, modelButton.getBoundingClientRect().top - 16))}px`;
}
new ResizeObserver(fitModelMenu).observe(document.body);
function closeModels() { modelMenu.hidden = true; modelButton.setAttribute('aria-expanded', 'false'); reasoningMenu.hidden = true; reasoningButton.setAttribute('aria-expanded', 'false'); modeMenu.hidden = true; modeButton.setAttribute('aria-expanded', 'false'); permissionsMenu.hidden = true; permissionsButton.setAttribute('aria-expanded', 'false'); }
modelButton.addEventListener('click', () => {
  if (!modelMenu.hidden) { closeModels(); return; }
  closeModels(); modelMenu.hidden = false; modelButton.setAttribute('aria-expanded', 'true');
  fitModelMenu(); modelMenu.replaceChildren(element('div', 'model-message', '加载模型中…'));  post({ type: 'model' });
});
document.addEventListener('click', event => { if (!modelAnchor.contains(event.target) && !reasoningAnchor.contains(event.target) && !modeAnchor.contains(event.target) && !permissionsAnchor.contains(event.target)) closeModels(); });
modelAnchor.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeModels(); modelButton.focus(); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const options = [...modelMenu.querySelectorAll('button')];
    if (!modelMenu.hidden && options.length) { event.preventDefault(); const index = options.indexOf(document.activeElement); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus(); }
  }
});
const effortLabels = {none:'None', minimal:'Minimal', low:'Low', medium:'Medium', high:'High', xhigh:'XHigh', max:'Max', ultra:'Ultra'};
const reasoningAnchor = element('div', 'reasoning-anchor'); modelAnchor.after(reasoningAnchor);
const reasoningButton = element('button', '', 'Reasoning⌄'); reasoningButton.id = 'reasoning'; reasoningButton.type = 'button'; reasoningButton.title = 'Reasoning Level：设置下一次请求的推理强度'; reasoningButton.setAttribute('aria-haspopup', 'menu'); reasoningButton.setAttribute('aria-expanded', 'false'); reasoningButton.setAttribute('aria-label', '选择 Reasoning Level');
const reasoningMenu = element('div', 'model-menu reasoning-menu'); reasoningMenu.hidden = true; reasoningMenu.setAttribute('role','menu'); reasoningMenu.setAttribute('aria-label','Reasoning Level'); reasoningAnchor.append(reasoningButton,reasoningMenu);
function fitReasoningMenu() {
  if (reasoningMenu.hidden) return;
  const anchor = reasoningButton.getBoundingClientRect();
  reasoningMenu.style.maxHeight = `${Math.max(40, Math.min(320, anchor.top - 16))}px`;
  const width = reasoningMenu.getBoundingClientRect().width;
  reasoningMenu.style.right = 'auto';
  reasoningMenu.style.left = `${Math.max(12 - anchor.left, Math.min(0, innerWidth - 12 - anchor.left - width))}px`;
}
new ResizeObserver(fitReasoningMenu).observe(document.body);
reasoningButton.onclick = () => {
  const open = reasoningMenu.hidden; closeModels(); if (!open) return;
  reasoningMenu.hidden = false; reasoningButton.setAttribute('aria-expanded','true'); fitReasoningMenu(); reasoningMenu.replaceChildren(element('div','model-message','加载推理等级中…')); post({type:'reasoning'});
};
reasoningAnchor.addEventListener('keydown', event => {
  if (event.key === 'Escape') {event.preventDefault(); closeModels(); reasoningButton.focus();}
  if (!reasoningMenu.hidden && ['ArrowDown','ArrowUp'].includes(event.key)) {
    const options = [...reasoningMenu.querySelectorAll('button')]; if (!options.length) return;
    event.preventDefault(); const index = options.indexOf(document.activeElement); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
  }
});
const modeAnchor = element('div', 'mode-anchor'); modelAnchor.after(modeAnchor);
const modeButton = element('button', '', 'Mode⌄'); modeButton.id = 'mode'; modeButton.type = 'button'; modeButton.setAttribute('aria-haspopup','menu'); modeButton.setAttribute('aria-expanded','false'); modeButton.setAttribute('aria-label','选择 Mode');
const modeMenu = element('div','model-menu mode-menu'); modeMenu.hidden = true; modeMenu.setAttribute('role','menu'); modeMenu.setAttribute('aria-label','Mode'); modeAnchor.append(modeButton,modeMenu);
function fitModeMenu() {
  if (modeMenu.hidden) return;
  const anchor = modeButton.getBoundingClientRect();
  modeMenu.style.maxHeight = `${Math.max(40, Math.min(320, anchor.top - 16))}px`;
  const width = modeMenu.getBoundingClientRect().width;
  modeMenu.style.left = `${Math.max(12 - anchor.left, Math.min(0, innerWidth - 12 - anchor.left - width))}px`;
}
new ResizeObserver(fitModeMenu).observe(document.body);
modeButton.onclick = () => {
  const open = modeMenu.hidden; closeModels(); if (!open) return;
  modeMenu.hidden = false; modeButton.setAttribute('aria-expanded','true'); fitModeMenu(); modeMenu.replaceChildren(element('div','model-message','加载模型模式中…'));post({type:'mode'});
};
modeAnchor.addEventListener('keydown', event => {
  if(event.key === 'Escape'){event.preventDefault();closeModels();modeButton.focus();}
  if(!modeMenu.hidden && ['ArrowDown','ArrowUp'].includes(event.key)) {
    const options=[...modeMenu.querySelectorAll('button')];if(!options.length)return;
    event.preventDefault();const index=options.indexOf(document.activeElement);options[(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length].focus();
  }
});
let permissionMode = 'default';
const permissionsAnchor = element('div', 'permissions-anchor'); modeAnchor.after(permissionsAnchor);
const permissionsButton = element('button', '', '默认权限⌄'); permissionsButton.id = 'permissions'; permissionsButton.type = 'button'; permissionsButton.setAttribute('aria-label','选择权限');permissionsButton.setAttribute('aria-haspopup','menu');permissionsButton.setAttribute('aria-expanded','false');
const permissionsMenu = element('div','model-menu permissions-menu');permissionsMenu.hidden = true;permissionsMenu.setAttribute('role','menu');permissionsMenu.setAttribute('aria-label','权限设置');permissionsAnchor.append(permissionsButton,permissionsMenu);
function fitPermissionsMenu() {
  if(permissionsMenu.hidden)return;
  const anchor=permissionsButton.getBoundingClientRect();permissionsMenu.style.maxHeight=`${Math.max(40,Math.min(360,anchor.top-16))}px`;
  const width=permissionsMenu.getBoundingClientRect().width;permissionsMenu.style.left=`${Math.max(12-anchor.left,Math.min(0,innerWidth-12-anchor.left-width))}px`;
}
new ResizeObserver(fitPermissionsMenu).observe(document.body);
permissionsButton.onclick=()=>{
 const open=permissionsMenu.hidden;closeModels();if(!open)return;
 permissionsMenu.replaceChildren();
 for(const option of permissionChoices){
  const button=element('button','model-option');button.type='button';button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(option.id===permissionMode));button.append(element('span','permission-name',option.name),element('span','permission-description',option.description));
  button.onclick=()=>{post({type:'selectPermissions',mode:option.id});closeModels();permissionsButton.focus();};permissionsMenu.append(button);
 }
 permissionsMenu.hidden=false;permissionsButton.setAttribute('aria-expanded','true');fitPermissionsMenu();
};
permissionsAnchor.addEventListener('keydown',event=>{
 if(event.key==='Escape'){event.preventDefault();closeModels();permissionsButton.focus();}
 if(!permissionsMenu.hidden&&['ArrowDown','ArrowUp'].includes(event.key)){const options=[...permissionsMenu.querySelectorAll('button')];event.preventDefault();const index=options.indexOf(document.activeElement);options[(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length].focus();}
});
const modelControls = element('div', 'model-controls');
modelControls.append(document.getElementById('attach'), modelAnchor, modeAnchor, reasoningAnchor);
actions.prepend(modelControls);

const slashMenu = element('div', 'slash-menu'); slashMenu.id = 'slash-menu'; slashMenu.hidden = true; slashMenu.setAttribute('role','listbox'); slashMenu.setAttribute('aria-label','命令与选项');
document.getElementById('composer').append(slashMenu);
prompt.setAttribute('aria-controls',slashMenu.id);prompt.setAttribute('aria-autocomplete','list');prompt.setAttribute('aria-expanded','false');
let slashStage = '', slashRequest = 0, slashOptions = [], slashRows = [], slashIndex = 0, slashLoading = false, slashError = '', slashDismissed, slashRenderKey;
function closeSlash() {slashStage='';slashRequest++;slashMenu.hidden=true;prompt.setAttribute('aria-expanded','false');prompt.removeAttribute('aria-activedescendant');}
function fitSlash() {if(!slashMenu.hidden)slashMenu.style.maxHeight=`${Math.max(40,Math.min(320,document.getElementById('composer').getBoundingClientRect().top-12))}px`;}
new ResizeObserver(fitSlash).observe(document.body);
function activeSlash(index) {
  slashIndex=index;
  [...slashMenu.querySelectorAll('[role=option]')].forEach((node,i)=>node.setAttribute('aria-selected',String(i===index)));
  const node=slashMenu.querySelectorAll('[role=option]')[index];
  if(node) {prompt.setAttribute('aria-activedescendant',node.id);const top=node.offsetTop,bottom=top+node.offsetHeight;if(top<slashMenu.scrollTop)slashMenu.scrollTop=top;else if(bottom>slashMenu.scrollTop+slashMenu.clientHeight)slashMenu.scrollTop=bottom-slashMenu.clientHeight;}else prompt.removeAttribute('aria-activedescendant');
}
function slashOptionDisabled(option) {
  return !!stateSnapshot?.transition || (running && (slashStage === 'permissions' || (!slashStage && ['compact','init','permissions'].includes(option.id))));
}
function renderSlash(query='') {
  const renderKey=JSON.stringify([slashStage,query,slashOptions,slashLoading,slashError,running,!!stateSnapshot?.transition]);
  if(!slashMenu.hidden && slashRenderKey===renderKey)return;
  slashRenderKey=renderKey;
  const needle=query.toLowerCase();
  slashRows=(slashStage ? slashOptions : slashCommands.map(command=>({id:command.name,label:'/'+command.name,description:command.description,picker:command.picker}))).filter(option=>[option.label,option.id,option.description].some(value=>String(value??'').toLowerCase().includes(needle))).sort((a,b)=>Number(b.id.toLowerCase()===needle)-Number(a.id.toLowerCase()===needle));
  slashMenu.replaceChildren(element('div','slash-heading',slashStage ? '/'+slashStage+' · 选择选项' : '命令'));
  if(slashStage) {const back=element('button','slash-back','← 命令列表');back.type='button';back.onclick=()=>{prompt.value='/';commitSlashDraft();slashStage='';slashDismissed=undefined;refreshSlash();prompt.focus();};slashMenu.firstChild.append(back);}
  slashRows.forEach((option,index)=>{
    const button=element('button','slash-option');button.type='button';button.id='slash-option-'+index;button.setAttribute('role','option');
    button.append(element('span','slash-name',option.label+(option.selected?' ✓':'')),element('span','slash-description',option.description??''));
    button.disabled=slashOptionDisabled(option);
    button.onpointermove=()=>activeSlash(index);button.onclick=()=>chooseSlash(index);slashMenu.append(button);
  });
  if(!slashRows.length)slashMenu.append(element('div','slash-empty',slashLoading?'正在加载…':slashError || (slashStage ? '没有匹配的可选项' : '没有匹配的命令')));
  slashMenu.hidden=false;prompt.setAttribute('aria-expanded','true');activeSlash(0);fitSlash();
}
function refreshSlash() {
  if(prompt.value!==slashDismissed)slashDismissed=undefined;
  const match=prompt.value.match(/^\/([^\s]*)(?:\s(.*))?$/s);
  if(!match || slashDismissed===prompt.value || document.body.dataset.page==='sessions' || document.body.dataset.auth==='required') {closeSlash();slashStage='';return;}
  const command=slashCommands.find(command=>command.name===match[1] && command.picker);
  const stage=command && match[2]!==undefined ? command.name : '';
  if(stage!==slashStage) {
    slashStage=stage;slashOptions=[];slashError='';slashLoading=!!stage;
    if(stage)post({type:'slashOptions',command:stage,requestId:++slashRequest});
  }
  closeModels();renderSlash(stage ? match[2]??'' : match[1]);
}
function commitSlashDraft() {lastDraft=prompt.value;post({type:'draft',text:prompt.value,revision:++revision});resizePrompt();}
function chooseSlash(index) {
  const option=slashRows[index];if(!option || slashOptionDisabled(option))return;
  if(!slashStage && option.picker) {prompt.value='/'+option.id+' ';commitSlashDraft();slashDismissed=undefined;refreshSlash();prompt.focus();return;}
  const command=slashStage || option.id;const selected=slashStage ? option.id : undefined;
  prompt.value='';commitSlashDraft();closeSlash();slashStage='';post({type:'slashExecute',command,option:selected});prompt.focus();
}
function submitSlash() {
  if(!prompt.value.startsWith('/'))return false;
  if(slashMenu.hidden) {slashDismissed=undefined;refreshSlash();}
  if(slashRows.length)chooseSlash(slashIndex);return true;
}
function handleSlashKey(event) {
  if(event.isComposing || slashMenu.hidden)return false;
  if(event.key==='Escape') {event.preventDefault();slashDismissed=prompt.value;closeSlash();return true;}
  if(['ArrowDown','ArrowUp'].includes(event.key) || (event.ctrlKey && ['n','p'].includes(event.key.toLowerCase()))) {
    event.preventDefault();if(slashRows.length)activeSlash((slashIndex+(['ArrowDown','n'].includes(event.key)?1:-1)+slashRows.length)%slashRows.length);return true;
  }
  if((event.key==='Enter'&&!event.shiftKey)||event.key==='Tab') {event.preventDefault();chooseSlash(slashIndex);return true;}
  return false;
}
slashMenu.addEventListener('mousedown',event=>event.preventDefault());
prompt.addEventListener('focus',()=>{if(prompt.value.startsWith('/'))refreshSlash();});
prompt.addEventListener('compositionend',refreshSlash);
document.addEventListener('click',event=>{if(!slashMenu.contains(event.target)&&event.target!==prompt){slashDismissed=prompt.value;closeSlash();}});
// Render received Markdown on animation frames, retaining completed block nodes.
// A burst is spread over at most 80ms; no text is invented or held for a whole reply.
const streams = new Map();
let streamFrame = 0;
function scheduleStreams() { if (!streamFrame) streamFrame = requestAnimationFrame(paintStreams); }
function finishMarkdown(body, text) { renderMarkdown(body, text); }
function queueStream(node, message) {
  const body = node.querySelector('.content');
  let stream = streams.get(message.id);
  if (!stream) {
    renderMarkdown(body, '');
    stream = { node, body, visible: '', target: '', queue: [], status: 'streaming', deadline: performance.now() + 80 };
    streams.set(message.id, stream);
  }
  if (!message.text.startsWith(stream.target)) {
    stream.visible = ''; stream.target = ''; stream.queue = []; renderMarkdown(body, '');
  }
  if (message.text !== stream.target) {
    if (!stream.queue.length) stream.deadline = performance.now() + 80;
    stream.queue = stream.queue.concat(Array.from(message.text.slice(stream.target.length)));
    stream.target = message.text;
  }
  stream.status = message.status;
  scheduleStreams();
}
function paintStreams(now) {
  streamFrame = 0;
  const follow = windowEnd === null && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 70;
  for (const [id, stream] of streams) {
    if (!stream.node.isConnected) { streams.delete(id); continue; }
    const frames = Math.max(1, Math.ceil((stream.deadline - now) / 16.7));
    const count = Math.ceil(stream.queue.length / frames);
    if (count) { const text = stream.queue.splice(0, count).join(''); stream.visible += text; renderMarkdown(stream.body, stream.visible); }
    if (!stream.queue.length && stream.status !== 'streaming') {
      finishMarkdown(stream.body, stream.target); stream.node.classList.remove('streaming'); streams.delete(id);
    }
  }
  if (follow) messages.scrollTop = messages.scrollHeight;
  if ([...streams.values()].some(stream => stream.queue.length)) scheduleStreams();
}
window.addEventListener('message', ({ data }) => {
  if (data.type === 'stream') {
    if (data.viewKey && data.viewKey !== viewKey) return;
    const message = store.get(data.id); if (!message || typeof data.delta !== 'string') return;
    message.text += data.delta; message.status = 'streaming'; phase = '生成回复'; refreshStatus();
    const node = nodes.get(data.id); if (node) { node.classList.add('streaming'); queueStream(node, message); }
    return;
  }
  if (data.type === 'slashOptions') {
    if((data.viewKey && data.viewKey!==viewKey) || data.requestId!==slashRequest || data.command!==slashStage || !prompt.value.startsWith('/'+slashStage+' '))return;
    slashOptions=data.options??[];slashError=data.error??'';slashLoading=false;renderSlash(prompt.value.slice(slashStage.length+2));return;
  }
  if (data.type === 'modelModes') {
    if (data.viewKey && data.viewKey !== viewKey) return;
    modeMenu.replaceChildren();
    for(const option of data.options ?? []) {
      const button=element('button','model-option');button.type='button';button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(!!option.selected));button.title=option.description ?? '';
      button.append(element('span','mode-name',option.name || option.id));if(option.description)button.append(element('span','mode-description',option.description));
      button.onclick=()=>{post({type:'selectMode',mode:option.id});closeModels();modeButton.focus();};modeMenu.append(button);
    }
    if(!modeMenu.childElementCount)modeMenu.append(element('div','model-message',data.error ?? '当前模型使用默认模型模式。'));
    fitModeMenu();return;
  }
  if (data.type === 'reasoningLevels') {
    if (data.viewKey && data.viewKey !== viewKey) return;
    reasoningMenu.replaceChildren();
    for (const option of data.options ?? []) {
      const button = element('button','model-option',effortLabels[option.id] ?? option.id); button.type = 'button'; button.setAttribute('role','menuitemradio'); button.setAttribute('aria-checked',String(!!option.selected)); button.title = option.description ?? '';
      button.onclick = () => {post({type:'selectReasoning',effort:option.id});closeModels();reasoningButton.focus();}; reasoningMenu.append(button);
    }
    if (!reasoningMenu.childElementCount) reasoningMenu.append(element('div','model-message',data.error ?? '当前模型不支持调节推理强度。'));
    fitReasoningMenu(); return;
  }
  if (data.type === 'models') {
    if (data.viewKey && data.viewKey !== viewKey) return;
    modelMenu.replaceChildren();
    for (const model of data.models ?? []) {
      const option = element('button', 'model-option', model.label); option.type = 'button';
      option.title = model.description; option.setAttribute('role', 'menuitemradio'); option.setAttribute('aria-checked', String(!!model.selected));
      option.onclick = () => { post({ type: 'selectModel', id: model.id }); closeModels(); modelButton.focus(); };
      modelMenu.append(option);
    }
    if (!modelMenu.childElementCount) modelMenu.append(element('div', 'model-message', data.error ?? '暂无可用模型'));
    fitModelMenu();
    return;
  }
  if (data.type !== 'state') return;
  stateSnapshot = data;
  usageSnapshot = data.tokenUsage; refreshUsage();
  if (data.viewKey && data.viewKey !== viewKey) { viewKey = data.viewKey; revision = data.draftRevision ?? 0; lastDraft = undefined; closeModels(); closeSlash(); slashStage=''; slashRequest++; }
  showAuth(data);
  showSessions(data);
  if (data.page === 'sessions' || data.authRequired) {closeModels();closeSlash();}
  running = !!data.busy;
  busy = data.busy || data.transition; phase = data.phase ?? '处理中'; startedAt = data.startedAt; refreshStatus();
  if (data.reset) { streams.clear(); store.clear(); windowEnd = null; }
  if (data.reset === undefined && data.messages) store.clear();
  for (const id of data.removed ?? []) store.delete(id);
  for (const message of data.messages ?? []) store.set(message.id, message);
  const all = [...store.values()];
  const end = windowEnd ?? all.length;
  const visible = all.slice(Math.max(0, end - 200), end);
  let latestUserIndex = visible.findLastIndex(message => message.role === 'user');
  const taskInProgress = !!data.busy || !!data.transition;
  const hasCurrentProcess = visible.slice(latestUserIndex + 1).some(message => message.role === 'tool' && message.process !== false);
  if (taskInProgress && end === all.length && latestUserIndex >= 0 && !hasCurrentProcess) {
    visible.splice(latestUserIndex + 1, 0, { id: `activity-${data.viewKey ?? 'chat'}`, turnId:data.activeTurnId, role: 'tool', text: '任务状态', status: 'inProgress', processKind: 'activity' });
  }
  latestUserIndex = visible.findLastIndex(message => message.role === 'user');
  let pager = messages.querySelector('.pager');
  if (!pager) { pager = element('div', 'pager'); messages.prepend(pager); }
  pager.replaceChildren();
  if (end > 200) { const older = element('button', '', '查看更早的消息'); older.onclick = () => { windowEnd = Math.max(200, end - 150); window.dispatchEvent(new MessageEvent('message', { data: { ...data, reset: false, messages: [], removed: [] } })); }; pager.append(older); }

  const needsReconnect = !!data.reconnectNeeded || /断开|失败|超时/.test(data.connection ?? '') || /状态待确认/.test(data.phase ?? '');
  reconnectButton.hidden = !needsReconnect;
  reconnectButton.disabled = !!data.transition;
  reconnectButton.textContent = data.transition && needsReconnect ? '重新连接中…' : '重新连接';
  connectionLabel.textContent = needsReconnect && ['已连接', '尚未连接'].includes(data.connection) ? '连接状态待确认' : data.connection ?? '';
  connectionPanel.hidden = !needsReconnect && (!data.connection || ['已连接', '尚未连接'].includes(data.connection));
  sendButton.textContent = running ? '■' : '↑';
  sendButton.type = running ? 'button' : 'submit';
  sendButton.title = running ? '终止任务' : '发送';
  sendButton.setAttribute('aria-label', sendButton.title);
  sendButton.disabled = !!data.transition || data.phase === '正在停止' || (!running && !prompt.value.trim());
  document.getElementById('new').disabled = !!data.transition;
  document.getElementById('back').disabled = !!data.transition;
  document.getElementById('history').disabled = !!data.transition;
  document.getElementById('history').title = '返回项目会话列表';
  refreshStatus();
  const title = document.querySelector('.header-leading span') ?? document.querySelector('header > span');
  if (title) { title.classList.add('conversation-title'); title.textContent = data.page === 'sessions' ? 'TRAE' : (data.conversationTitle ?? 'TRAE'); title.title = title.textContent; }
  document.getElementById('model').textContent = data.model + '⌄';
  modelButton.title = '模型：' + data.model;
  permissionMode = permissionChoices.some(option=>option.id===data.permissionMode) ? data.permissionMode : 'default';
  permissionsButton.textContent = permissionChoices.find(option=>option.id===permissionMode).name + '⌄';
  const permissionsLocked = !!data.busy || !!data.transition;
  const permissionsTitle = permissionsLocked ? '当前任务已按启动时权限运行，任务结束后可修改。' : permissionChoices.find(option=>option.id===permissionMode).description + ' 下一个任务生效。';
  if (permissionsLocked) { permissionsMenu.hidden = true; permissionsButton.setAttribute('aria-expanded','false'); }
  permissionsAnchor.title = permissionsTitle;
  permissionsButton.title = permissionsTitle;
  permissionsButton.setAttribute('aria-label', permissionsLocked ? permissionsTitle : '选择权限。' + permissionsTitle);
  permissionsButton.disabled = permissionsLocked;
  modeAnchor.hidden = data.modeSupported === false;
  actions.dataset.mode = String(!modeAnchor.hidden);
  if (modeAnchor.hidden) {
    const focused = modeAnchor.contains(document.activeElement);
    modeMenu.hidden = true; modeButton.setAttribute('aria-expanded', 'false');
    if (focused) modelButton.focus();
  }
  modeButton.textContent = data.modeSupported === false ? (data.modeLabel || '默认') : (data.modeLabel || (data.modelMode ? (/max$/i.test(data.modelMode) ? 'Max' : 'Standard') : 'Mode')) + '⌄';
  modeButton.disabled = !!data.transition || data.modeSupported === false;
  modeButton.title = data.modeSupported === false ? '当前模型没有可选 Mode，使用默认模式' : 'Mode：' + (data.modeLabel || (data.modelMode ? (/max$/i.test(data.modelMode) ? 'Max' : 'Standard') : '模型默认')) + '，下一次请求生效';
  reasoningAnchor.hidden = data.reasoningSupported === false;
  actions.dataset.reasoning = String(!reasoningAnchor.hidden);
  if (reasoningAnchor.hidden) {
    const focused = reasoningAnchor.contains(document.activeElement);
    reasoningMenu.hidden = true; reasoningButton.setAttribute('aria-expanded', 'false');
    if (focused) modelButton.focus();
  }
  reasoningButton.textContent = (effortLabels[data.reasoning] ?? 'Reasoning') + '⌄';
  reasoningButton.disabled = !!data.transition || data.reasoningSupported === false;
  reasoningButton.title = data.reasoningSupported === false ? '当前模型不支持调节 Reasoning Level' : 'Reasoning Level：' + (effortLabels[data.reasoning] ?? '模型默认') + '，下一次请求生效';
  if ((data.draftRevision ?? revision) >= revision && data.draft !== lastDraft) { prompt.value = data.draft; lastDraft = data.draft; resizePrompt(); }
  if (document.activeElement===prompt && prompt.value.startsWith('/') && data.page!=='sessions') refreshSlash();
  if (!running && !data.transition) sendButton.disabled = !prompt.value.trim();
  const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 70;
  const ids = new Set(visible.map(message => message.id));
  for (const [id, node] of nodes) if (!ids.has(id)) { streams.delete(id); node.remove(); nodes.delete(id); }
  const empty = messages.querySelector('.empty');
  if (all.length) empty?.remove();
  else if (!empty) {
    const welcome = element('div', 'empty'); welcome.append(element('h2', '', '今天想完成什么？'), element('p', '', 'TRAE 可以理解代码、完成修改并运行检查。'));
    for (const text of ['了解这个项目', '检查当前代码']) { const button = element('button', '', text); button.onclick = () => { prompt.value = text; lastDraft = text; post({ type: 'draft', text, revision: ++revision }); resizePrompt(); sendButton.disabled = false; prompt.focus(); }; welcome.append(button); }
    messages.append(welcome);
  }
  let previous = pager;
  let currentProcess, currentProcessEntry, lastProcessNode;
  const usedProcesses = new Map();
  for (let messageIndex = 0; messageIndex < visible.length; messageIndex++) {
    const message = visible[messageIndex];
    const isProcess = message.role === 'tool' && message.process !== false;
    if (isProcess && !currentProcess) {
      const key = `${viewKey ?? 'chat'}:${message.id}`;
      let group = processGroups.get(key);
      if (!group) {
        group = element('details', 'process-group');
        const summary = element('summary', 'process-summary');const indicator=element('span','process-indicator');indicator.setAttribute('aria-hidden','true');summary.append(indicator,element('span', 'process-label', '思考与工具调用'), element('span','process-meta'));
        group.append(summary, element('div','process-items'));
        group.open = processOpen.get(key) ?? false;
        group.addEventListener('toggle',()=>processOpen.set(key,group.open));
        processGroups.set(key,group);
      }
      if (previous.nextSibling !== group) messages.insertBefore(group, previous.nextSibling);
      previous = group; currentProcess = group; lastProcessNode = undefined;
      currentProcessEntry={group,steps:[],startIndex:messageIndex};usedProcesses.set(key,currentProcessEntry);
    } else if (!isProcess) {currentProcess=undefined;currentProcessEntry=undefined;lastProcessNode=undefined;}
    if (isProcess) currentProcessEntry.steps.push(message);

    let node = nodes.get(message.id);
    if (!node) {
      node = element('article', message.role);
      if (message.role !== 'tool') { node.append(element('div', 'content')); if (message.role === 'user') node.append(element('span','message-status')); if (message.role === 'assistant') { const copy = element('button', 'copy', '复制'); copy.onclick = () => post({ type: 'copy', text: store.get(message.id)?.text ?? '' }); node.append(copy); } }
      nodes.set(message.id, node);
    }
    if (isProcess) {
      const parent=currentProcess.querySelector('.process-items');
      if ((lastProcessNode ? lastProcessNode.nextSibling : parent.firstChild)!==node) parent.insertBefore(node,lastProcessNode ? lastProcessNode.nextSibling : parent.firstChild);
      lastProcessNode=node;
    } else {
      if (previous.nextSibling !== node) messages.insertBefore(node, previous.nextSibling);
      previous=node;
    }
    node.classList.toggle('streaming', message.role === 'assistant' && message.status === 'streaming');
    node.classList.toggle('failed', message.status === 'failed');
    const signature = JSON.stringify(message);
    if (node.dataset.signature !== signature) {
      if (message.role === 'tool') {
        const emptyReasoning=message.processKind==='reasoning'&&!message.reasoningHasSummary&&!message.detail;
        if(emptyReasoning) {
          let title=node.querySelector('.tool-static');
          if(!title) {title=element('div','tool-title tool-static');node.replaceChildren(title);}
          title.textContent=`思考${message.status ? ` · ${statusNames[message.status] ?? message.status}` : ''}`;
        } else {
          let details=node.querySelector('.tool-details');
          if(!details) {details=element('details','tool-details');details.append(element('summary','tool-title'),element('pre','detail'),element('div','files'));node.replaceChildren(details);}
          details.querySelector('.tool-title').textContent = `${message.status === 'inProgress' ? '◌' : message.status === 'failed' ? '!' : '›'} ${message.text}${message.status ? ` · ${statusNames[message.status] ?? message.status}` : ''}`;
          details.querySelector('.detail').textContent = message.detail ?? '';
          const files = details.querySelector('.files'); files.replaceChildren();
          for (const path of message.paths ?? []) { const button = element('button', '', path.split(/[\\/]/).pop()); button.title = path; button.onclick = () => post({ type: 'reviewFile', id: message.id, path }); files.append(button); }
        }
      } else { const body = node.querySelector('.content'); if (message.role === 'assistant') { if (message.status === 'streaming' || streams.has(message.id)) queueStream(node, message); else finishMarkdown(body, message.text); } else { body.textContent = message.text; const delivery=node.querySelector('.message-status'); if(delivery){delivery.textContent=message.status==='failed'?'发送失败 · 内容已恢复到输入框':'';delivery.hidden=message.status!=='failed';} } }
      node.dataset.signature = signature;
    }
  }
  const processEntries=[...usedProcesses.values()];
  const currentProcessEntries=data.activeTurnId ? processEntries.filter(entry=>entry.steps.some(step=>step.turnId===data.activeTurnId)) : processEntries.filter(entry=>latestUserIndex<0||entry.startIndex>latestUserIndex);
  const waitingForApproval=/等待授权/.test(phase);
  const foregroundProcess=waitingForApproval ? undefined : currentProcessEntries.findLast(entry=>entry.steps.some(step=>step.status==='inProgress'&&!['plan','activity'].includes(step.processKind)));
  const fallbackProcess=taskInProgress ? currentProcessEntries.at(-1) : undefined;
  for(const [key,{group,steps}] of usedProcesses) {
    const pendingStep=steps.findLast(step=>step.status==='inProgress'&&!['plan','activity'].includes(step.processKind));
    const activeStep=foregroundProcess?.group===group ? pendingStep : undefined;
    const fallbackActive=!foregroundProcess&&fallbackProcess?.group===group;
    const active=!!activeStep||(fallbackActive&&!waitingForApproval);
    const backgroundActive=!!pendingStep&&!active;
    const label=activeStep ? (activeStep.processKind==='reasoning'||activeStep.text==='思考摘要' ? '思考中' : '调用工具 '+(activeStep.toolName || activeStep.text)) : fallbackActive ? processActivityLabel(phase) : '思考与工具调用';
    group.querySelector('.process-label').textContent=label;
    group.querySelector('.process-summary').title=activeStep ? activeStep.text : fallbackActive ? processActivityLabel(phase) : '点击展开查看思考与工具调用详情';
    const failed=steps.some(step=>step.status==='failed');
    const stopped=steps.some(step=>['interrupted','declined'].includes(step.status));
    const status=fallbackActive&&waitingForApproval?'等待授权':active?'进行中':backgroundActive?'后台进行中':failed?'有步骤失败':stopped?'已停止':steps.every(step=>step.status==='completed')?'已完成':'已记录';
    const realSteps=steps.filter(step=>step.processKind!=='activity');
    group.querySelector('.process-meta').textContent=`${realSteps.length ? `${realSteps.length} 项 · ` : ''}${status}`;
    group.querySelector('.process-items').hidden=!realSteps.length;
    group.dataset.status=active?'inProgress':fallbackActive&&waitingForApproval?'waiting':backgroundActive?'background':failed?'failed':'completed';
  }
  for(const [key,group] of processGroups) if(!usedProcesses.has(key)) {group.remove();processGroups.delete(key);processOpen.delete(key);}
  const approvalSignature = JSON.stringify(data.approvals);
  if (approvals.dataset.signature !== approvalSignature) {
    approvals.replaceChildren(); approvals.dataset.signature = approvalSignature;
    for (const approval of data.approvals) {
      const card = element('div', 'approval'); card.append(element('strong', '', approval.title), element('pre', '', approval.detail));
      const actions = element('div', 'approval-actions');
      for (const choice of approval.choices ?? []) {
        const button = element('button', choice.kind ? `approval-${choice.kind}` : '', choice.label); button.type = 'button'; button.title = choice.description ?? '';
        button.onclick = () => { for (const button of card.querySelectorAll('button')) button.disabled = true; post({ type: 'permission', id: approval.id, choice: choice.id }); };
        actions.append(button);
      }
      card.append(actions);
      approvals.append(card);
    }
  }
  const attachments = document.getElementById('attachments');
  const attachmentSignature = JSON.stringify(data.attachments);
  if (attachments.dataset.signature !== attachmentSignature) {
  attachments.dataset.signature = attachmentSignature; attachments.replaceChildren();
  for (const attachment of data.attachments) { const chip = element('span', 'chip'); const preview = element('button', '', attachment.label); preview.title = `预览上下文 · ${attachment.size ?? 0} 字符`; preview.onclick = () => post({ type: 'previewAttachment', id: attachment.id }); const remove = element('button', '', '×'); remove.title = '移除上下文'; remove.setAttribute('aria-label', `移除 ${attachment.label}`); remove.onclick = () => post({ type: 'removeAttachment', id: attachment.id }); chip.append(preview, remove); attachments.append(chip); }
  }
  if (bottom && windowEnd === null) messages.scrollTop = messages.scrollHeight;
  updateJump();
});
prompt.addEventListener('keyup', event => { if (event.key === '@' && !event.isComposing) post({ type: 'pickFile' }); });
post({ type: 'ready' });
