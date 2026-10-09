import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const directory=await mkdtemp(join(tmpdir(),'trae-sidebar-'));
await build({entryPoints:['src/extension.ts'],outfile:join(directory,'sidebar.cjs'),bundle:true,platform:'node',plugins:[{name:'mock-vscode',setup(build){build.onResolve({filter:/^vscode$/},()=>({path:resolve('tests/vscode-mock.cjs')}));}}]});
const {Sidebar}=await import(join(directory,'sidebar.cjs'));
function controller(state=new Map()){const context={subscriptions:[],extensionUri:{fsPath:process.cwd()},workspaceState:{get:(k,fallback)=>state.get(k)??fallback,update:async(k,v)=>state.set(k,v)}};const sidebar = new Sidebar(context); sidebar.page='chat'; sidebar.readLoginStatus=async()=>true; return sidebar;}
await test('send failure preserves submitted draft, newer typing and attachments',async()=>{
 const sidebar=controller();
 sidebar.attachments=[{id:'attachment',label:'test.ts',text:'context'}];
 sidebar.agent={prompt:async()=>{sidebar.draft='new typing';throw new Error('offline');},dispose(){}};
 try{await sidebar.send('original');assert.equal(sidebar.draft,'original\n\nnew typing');assert.equal(sidebar.attachments[0].id,'attachment');assert.equal(sidebar.busy,false);assert.equal(sidebar.messages.find(message=>message.role==='user').status,'failed');}finally{sidebar.dispose();}
});
await test('send snapshots draft and attachments before asynchronous preflight',async()=>{
 const sidebar=controller();let releaseAuth;let submitted;
 sidebar.draft='first';sidebar.attachments=[{id:'a',label:'A',text:'A'}];
 sidebar.readLoginStatus=()=>new Promise(resolve=>releaseAuth=resolve);
 sidebar.agent={prompt:async text=>{submitted=text;return 'thread';},dispose(){}};
 try {
  const sending=sidebar.send('first');await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(sidebar.transition,true);assert.equal(sidebar.phase,'准备请求');assert.ok(sidebar.turnStartedAt);
  assert.deepEqual(sidebar.messages.map(message=>[message.role,message.text]),[['user','first\n\nA']]);
  sidebar.draft='next draft';sidebar.attachments.push({id:'b',label:'B',text:'B'});
  releaseAuth(true);await sending;
  assert.equal(submitted,'first\n\nA');assert.equal(sidebar.draft,'next draft');assert.deepEqual(sidebar.attachments.map(item=>item.id),['b']);assert.equal(sidebar.messages.filter(message=>message.role==='user').length,1);
 }finally{sidebar.dispose();}
});
await test('unsent new-session drafts use a stable reload key',async()=>{
 const state=new Map();const first=controller(state);
 first.draft='survives reload';first.stashDraft();
 const saved=state.get('sessionDrafts');assert.equal(saved.new,'survives reload');assert.equal(saved[first.runtimeId],undefined);
 first.dispose();const restored=controller(state);
 try{assert.equal(restored.draft,'survives reload');}finally{restored.dispose();}
});
await test('history restore locks sends until authoritative state is loaded',async()=>{
 const sidebar=controller();let release;let prompts=0;
 sidebar.agent={history:async()=>({data:[{id:'history',preview:'saved',updatedAt:1}],nextCursor:null}),resume:()=>new Promise(resolve=>release=resolve),prompt:async()=>prompts++,dispose(){}};
 try{
  sidebar.sessions=[{id:'history',cwd:'/tmp',preview:'saved',updatedAt:1}];
  const createSession=sidebar.createSession.bind(sidebar); sidebar.createSession=()=>{const session=createSession();session.agent=sidebar.agent;return session;};
  const operation=sidebar.openSession('history');await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(sidebar.transition,true);await sidebar.send('must not be sent');assert.equal(prompts,0);
  release({thread:{id:'history',turns:[]},model:'m',modelProvider:'p'});await operation;assert.equal(sidebar.transition,false);assert.equal(sidebar.current.threadId,'history');
 }finally{sidebar.dispose();}
});
await test('stream synchronization sends only changed messages after initial snapshot',async()=>{
 const sidebar=controller();const sent=[];sidebar.view={webview:{postMessage:message=>sent.push(message)}};
 try{
  sidebar.messages=[{id:'a',role:'assistant',text:'hello'},{id:'b',role:'user',text:'question'}];sidebar.flush();
  sidebar.messages[0].text+=' world';sidebar.flush();assert.equal(sent[1].reset,false);assert.deepEqual(sent[1].messages.map(item=>item.id),['a']);
 }finally{sidebar.dispose();}
});
await test('context limit rejects a send without consuming draft or attachments',async()=>{
 const sidebar=controller();sidebar.draft='draft';sidebar.attachments=[{id:'large',label:'large',text:'x'.repeat(200001)}];
 try{await sidebar.send('question');assert.equal(sidebar.draft,'draft');assert.equal(sidebar.attachments.length,1);assert.equal(sidebar.busy,false);}finally{sidebar.dispose();}
});
await test('reply deltas are visible before completion and late item start cannot erase text',async()=>{
 const sidebar=controller(); const sent=[];
 sidebar.view={webview:{postMessage:message=>{sent.push(JSON.parse(JSON.stringify(message)));}}}; sidebar.busy=true;
 try {
  sidebar.update({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'turn',itemId:'reply',delta:'第一段'}});
  assert.equal(sent.at(-1).messages.find(message=>message.id==='reply').text,'第一段');
  assert.equal(sent.at(-1).busy,true);
  sidebar.update({method:'item/started',params:{threadId:'t',turnId:'turn',item:{type:'agentMessage',id:'reply',text:''}}});
  sidebar.update({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'turn',itemId:'reply',delta:'第二段'}});
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(sent.at(-1).type,'state');
  assert.equal(sidebar.messages.find(message=>message.id==='reply').text,'第一段第二段');
  sidebar.update({method:'item/agentMessage/delta',params:{threadId:'t',turnId:'turn',itemId:'reply',delta:'第三段'}});
  assert.deepEqual(sent.at(-1),{type:'stream',viewKey:sidebar.runtimeId,id:'reply',delta:'第三段'});
  assert.equal(sidebar.busy,true);
  sidebar.update({method:'turn/completed',params:{threadId:'t',turn:{id:'turn',status:'completed',error:null}}});
  assert.equal(sent.at(-1).busy,false);
  assert.equal(sent.at(-1).messages.find(message=>message.id==='reply').status,'completed');
 }finally{sidebar.dispose();}
});
await test('session homepage includes only exact project sessions and paginates without duplicates',async()=>{
 const sidebar=controller();sidebar.page='sessions';let calls=0;
 sidebar.agent={history:async cursor=>{calls++;return cursor?{data:[{id:'local',cwd:'/tmp',updatedAt:2},{id:'second',cwd:'/tmp',updatedAt:3}],nextCursor:null}:{data:[{id:'local',cwd:'/tmp',updatedAt:1},{id:'foreign',cwd:'/another-project',updatedAt:9},{id:'child',cwd:'/tmp/subproject',updatedAt:5}],nextCursor:'next'};},dispose(){}};
 try{
  await sidebar.loadSessions();assert.deepEqual(sidebar.sessions.map(session=>session.id),['local']);assert.equal(sidebar.page,'sessions');assert.equal(sidebar.threadId,undefined);
  await sidebar.loadSessions(true);assert.deepEqual(sidebar.sessions.map(session=>session.id),['second','local']);assert.equal(calls,2);
  let resumed=false;sidebar.agent.resume=async()=>{resumed=true;};await sidebar.openSession('foreign');assert.equal(resumed,false);
 }finally{sidebar.dispose();}
});
await test('new conversation does not resume the previous workspace session',async()=>{
 const sidebar=controller();let resumes=0;
 sidebar.context.workspaceState.update('threadId','old');
 sidebar.agent={prompt:async()=> 'fresh',resume:async()=>{resumes++;},dispose(){}};
 try{await sidebar.send('new request');assert.equal(resumes,0);assert.equal(sidebar.threadId,'fresh');}finally{sidebar.dispose();}
});
await test('unauthenticated homepage gates history and preserves drafts',async()=>{
 const sidebar=controller(); let historyCalls=0;
 sidebar.page='sessions'; sidebar.draft='keep this'; sidebar.readLoginStatus=async()=>false;
 sidebar.agent={history:async()=>{historyCalls++;return {data:[]};},dispose(){}};
 try {
  await sidebar.loadSessions(); assert.equal(sidebar.authRequired,true); assert.equal(historyCalls,0); assert.equal(sidebar.historyLoading,false); assert.equal(sidebar.historyError,'');
  sidebar.page='chat'; await sidebar.send('keep this'); assert.equal(sidebar.draft,'keep this'); assert.equal(sidebar.messages.length,0);
 }finally{sidebar.dispose();}
});
await test('successful external login rebuilds connection and reloads project sessions',async()=>{
 const sidebar=controller(); let histories=0; let disposed=0;
 sidebar.page='sessions'; sidebar.authRequired=true; sidebar.loginPending=true; sidebar.readLoginStatus=async()=>true;
 const old={cancel:async()=>{},dispose:()=>disposed++};
 const fresh={models:async()=>({data:[]}),history:async()=>{histories++;return {data:[{id:'local',cwd:'/tmp',updatedAt:5}]};},dispose(){}};
 sidebar.agent=old; sidebar.getAgent=()=>{sidebar.agent=fresh;return fresh;};
 try {
  await sidebar.checkLogin(); await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(sidebar.authRequired,false); assert.equal(sidebar.loginPending,false); assert.equal(disposed,1); assert.equal(histories,1); assert.equal(sidebar.sessions[0].id,'local');
 }finally{sidebar.dispose();}
});
await test('status command failure is a retryable error, not an unauthenticated empty list',async()=>{
 const sidebar=controller(); sidebar.page='sessions'; sidebar.readLoginStatus=async()=>{throw new Error('CLI missing');};
 try{await sidebar.loadSessions();assert.equal(sidebar.authRequired,false);assert.equal(sidebar.historyError,'Error: CLI missing');assert.equal(sidebar.historyLoading,false);}finally{sidebar.dispose();}
});
await test('login starts official CLI once and cancellation allows retry',async()=>{
 const sidebar=controller(); sidebar.authRequired=true; sidebar.readLoginStatus=async()=>false;
 try {
  await sidebar.login(); const terminal=sidebar.loginTerminal;
  assert.deepEqual(terminal.options.shellArgs,['login']); assert.equal(sidebar.loginPending,true);
  await sidebar.login(); assert.equal(sidebar.loginTerminal,terminal); assert.equal(terminal.shows,2);
  terminal.__close(); await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(sidebar.loginPending,false); assert.equal(sidebar.authRequired,true); assert.match(sidebar.loginError,/尚未检测到登录/);
  await sidebar.login(); assert.notEqual(sidebar.loginTerminal,terminal); sidebar.loginTerminal.__close();
 }finally{sidebar.dispose();}
});
await test('expired login during a task unlocks login and restores submitted draft',async()=>{
 const sidebar=controller(); sidebar.busy=true; sidebar.inFlight={text:'unfinished',attachments:[{id:'a',label:'a',text:'context'}],messageId:'pending'};
 try {sidebar.error('401 Unauthorized');assert.equal(sidebar.authRequired,true);assert.equal(sidebar.busy,false);assert.equal(sidebar.draft,'unfinished');assert.equal(sidebar.attachments.length,1);}finally{sidebar.dispose();}
});
await test('return, new chat and switching preserve live tasks and isolate approvals and stop',async()=>{
 const sidebar=controller(); const states=[]; let stoppedA=0, disposedA=0, stoppedB=0, disposedB=0;
 sidebar.view={webview:{postMessage:message=>states.push(message)}};
 sidebar.threadId='a'; sidebar.busy=true; sidebar.phase='执行命令'; sidebar.draft='draft A';
 sidebar.agent={history:async()=>({data:[],nextCursor:null}),cancel:async()=>stoppedA++,dispose:()=>disposedA++};
 try {
  await sidebar.history(); assert.equal(sidebar.busy,true); assert.equal(stoppedA,0); assert.equal(disposedA,0);
  await sidebar.restart(); const b=sidebar.current; assert.notEqual(b,sidebar); assert.equal(sidebar.busy,true);
  b.threadId='b'; b.busy=true; b.draft='draft B'; b.agent={cancel:async()=>stoppedB++,dispose:()=>disposedB++};
  sidebar.update({method:'item/agentMessage/delta',params:{threadId:'a',itemId:'shared',delta:'only A'}});
  b.update({method:'item/agentMessage/delta',params:{threadId:'b',itemId:'shared',delta:'only B'}});
  assert.equal(sidebar.messages.at(-1).text,'only A'); assert.equal(b.messages.at(-1).text,'only B');
  sidebar.fullSync=true; sidebar.flush(); assert.equal(states.at(-1).messages.at(-1).text,'only B');
  const approval=sidebar.request({id:'same-approval',method:'item/commandExecution/requestApproval',params:{command:'A command'}});
  sidebar.flush(); assert.equal(states.at(-1).approvals.length,0); assert.equal(states.at(-1).sessions.find(row=>row.id==='a').status,'等待授权');
  await sidebar.openSession('a'); assert.equal(sidebar.current,sidebar); assert.equal(sidebar.draft,'draft A'); assert.equal(sidebar.approvals.size,1);
  await sidebar.cancel(); assert.equal(stoppedA,1); assert.equal(stoppedB,0); assert.equal(b.busy,true); assert.equal((await approval).decision,'decline');
  await sidebar.openSession('b'); assert.equal(sidebar.current,b); assert.equal(b.draft,'draft B'); assert.equal(disposedA,0); assert.equal(disposedB,0);
 }finally{sidebar.dispose();assert.equal(disposedA,1);assert.equal(disposedB,1);}
});
await test('late completion of background prompt is retained without replacing the current chat',async()=>{
 const sidebar=controller(); let release;
 sidebar.agent={prompt:()=>new Promise(resolve=>release=resolve),dispose(){}};
 try {
  const sending=sidebar.send('first task'); await new Promise(resolve=>setTimeout(resolve,5));
  await sidebar.restart(); const b=sidebar.current; b.agent={prompt:async()=> 'b',dispose(){}}; await b.send('second task');
  release('a'); await sending; assert.equal(sidebar.current,b); assert.equal(sidebar.threadId,'a'); assert.equal(b.threadId,'b'); assert.equal(sidebar.busy,true);
  sidebar.update({method:'turn/completed',params:{threadId:'a',turn:{id:'turn-a',status:'completed',error:null}}});
  assert.equal(sidebar.busy,false); assert.equal(b.busy,true);
 } finally {sidebar.dispose();}
});
await test('model-specific reasoning choices validate values, reach prompts and stay isolated',async()=>{
 const sidebar=controller();let sentEffort;
 const models=[{id:'m',model:'m',displayName:'Model',modelProviderId:'p',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'balanced'},{reasoningEffort:'high',description:'deep'}]},{id:'plain',model:'plain',displayName:'Plain',modelProviderId:'p',defaultReasoningEffort:'none',supportedReasoningEfforts:[]}];
 const agent={models:async()=>({data:models}),prompt:async(text,model,provider,effort)=>{sentEffort=effort;return 'a';},dispose(){}};
 sidebar.agent=agent;
 try {
  await sidebar.chooseModel('m');assert.equal(sidebar.selectedReasoning,'medium');
  await sidebar.chooseReasoning('ultra');assert.equal(sidebar.selectedReasoning,'medium');
  await sidebar.chooseReasoning('high');await sidebar.send('test');assert.equal(sentEffort,'high');
  await sidebar.restart();const b=sidebar.current;b.agent=agent;await b.chooseReasoning('medium');assert.equal(sidebar.selectedReasoning,'high');assert.equal(b.selectedReasoning,'medium');
  await b.chooseModel('plain');assert.equal(b.selectedReasoning,undefined);assert.equal(b.reasoningOptions.length,0);
 }finally{sidebar.dispose();}
});
await test('model modes use actual backend keys, update reasoning and stay isolated',async()=>{
 const sidebar=controller();let sentMode,sentEffort;
 const models=[{id:'m',model:'GPT-5.6-Sol',displayName:'GPT-5.6-Sol',modelProviderId:'p',defaultReasoningEffort:'medium',supportedReasoningEfforts:[],businessMetadata:{variants:{standard_key:'sol__dev',max_key:'sol__max',standard_context_window:272000,max_context_window:800000,standard_default_reasoning_level:'medium',max_default_reasoning_level:'high',standard_supported_reasoning_levels:[{effort:'medium',description:''}],max_supported_reasoning_levels:[{effort:'high',description:''}]}}},{id:'plain',model:'plain',displayName:'Plain',modelProviderId:'p',supportedReasoningEfforts:[]}];
 const agent={models:async()=>({data:models}),prompt:async(text,model,provider,effort,mode)=>{sentMode=mode;sentEffort=effort;return 'mode-session';},dispose(){}};sidebar.agent=agent;
 try{
  await sidebar.chooseModel('m');assert.equal(sidebar.selectedMode,'sol__dev');assert.equal(sidebar.selectedReasoning,'medium');
  await sidebar.chooseMode('invented');assert.equal(sidebar.selectedMode,'sol__dev');
  await sidebar.chooseMode('sol__max');await sidebar.send('test');assert.equal(sentMode,'sol__max');assert.equal(sentEffort,'high');
  await sidebar.restart();const b=sidebar.current;b.agent=agent;await b.chooseMode('sol__dev');assert.equal(sidebar.selectedMode,'sol__max');assert.equal(b.selectedMode,'sol__dev');assert.equal(b.selectedReasoning,'medium');
  await b.chooseModel('plain');assert.equal(b.selectedMode,undefined);assert.deepEqual(b.modeOptions,[]);
 }finally{sidebar.dispose();}
});
await test('read-only and workspace permissions use the current project and stay isolated',async()=>{
 const sidebar=controller();let permission;
 const agent={prompt:async(text,model,provider,effort,mode,policy)=>{permission=policy;return 'permissions';},dispose(){}};sidebar.agent=agent;
 try{
  sidebar.permissionMode='read-only';await sidebar.send('read');assert.deepEqual(permission,{approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}});
  await sidebar.restart();const b=sidebar.current;b.agent=agent;b.permissionMode='workspace';await b.send('edit');assert.equal(permission.approvalPolicy,'on-request');assert.equal(permission.sandboxPolicy.type,'workspaceWrite');assert.deepEqual(permission.sandboxPolicy.writableRoots,['/tmp']);assert.equal(permission.sandboxPolicy.networkAccess,false);assert.equal(sidebar.permissionMode,'read-only');
 }finally{sidebar.dispose();}
});
await rm(directory,{recursive:true,force:true});
await test('token notifications aggregate background sessions independently of the active view',()=>{
 const sidebar=controller();const second=sidebar.createSession();
 const notify=(session,id,total)=>session.update({method:'thread/tokenUsage/updated',params:{threadId:id,turnId:'turn',tokenUsage:{total:{totalTokens:total}},context:null}});
 try {
  sidebar.threadId='a';second.threadId='b';
  notify(sidebar,'a',100);notify(second,'b',50);notify(second,'b',50);notify(sidebar,'other',900);
  assert.equal(sidebar.usage.summary('a').session,100);
  assert.equal(sidebar.usage.summary('b').session,50);
  assert.equal(sidebar.usage.summary('a').day,150);
  assert.equal(sidebar.context.workspaceState.get('tokenUsage').records.length,2);
 }finally{second.dispose();sidebar.dispose();}
});
await test('failed reconnect keeps the original thread and draft; retry restores without resending',async()=>{
 const sidebar=controller();let resumes=0,prompts=0,interrupts=0;
 sidebar.threadId='original-thread';sidebar.draft='unsent draft';sidebar.reconnectNeeded=true;
 sidebar.agent={cancel:async()=>interrupts++,dispose(){}};
 sidebar.getAgent=()=>({resume:async id=>{assert.equal(id,'original-thread');if(++resumes===1)throw new Error('temporary resume failure');return {thread:{id,turns:[]},model:'m',modelProvider:'p'};},prompt:async()=>{prompts++;}});
 try {
  await sidebar.reconnect();assert.equal(sidebar.threadId,'original-thread');assert.equal(sidebar.draft,'unsent draft');assert.equal(sidebar.reconnectNeeded,true);
  await sidebar.reconnect();assert.equal(sidebar.threadId,'original-thread');assert.equal(sidebar.draft,'unsent draft');assert.equal(sidebar.reconnectNeeded,false);assert.equal(prompts,0);assert.equal(interrupts,0);
 }finally{sidebar.dispose();}
});
await test('completed live sessions keep their latest activity ordering',()=>{
 const sidebar=controller();sidebar.threadId='live';sidebar.sessions=[{id:'live',cwd:'/tmp',preview:'old',updatedAt:100}];
 try {
  sidebar.update({method:'turn/started',params:{threadId:'live',turn:{id:'turn',status:'inProgress',items:[]}}});
  const activeTime=sidebar.sessionRows().find(row=>row.id==='live').updatedAt;
  sidebar.update({method:'turn/completed',params:{threadId:'live',turn:{id:'turn',status:'completed',error:null}}});
  assert.equal(sidebar.sessionRows().find(row=>row.id==='live').updatedAt,activeTime);assert.ok(activeTime>100);
 }finally{sidebar.dispose();}
});
await test('queue status uses the existing task line with model load and position',async()=>{
 const sidebar=controller();sidebar.threadId='live';sidebar.busy=true;sidebar.agent={models:async()=>({data:[{isDefault:true,businessMetadata:{load:{load_percent:92,queue_size:8}}}]}),dispose(){}};
 try {
  sidebar.update({method:'queue/status',params:{threadId:'live',turnId:'turn',state:'waiting',operation:null,position:3,message:null}});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(sidebar.phase,'模型负载 92% · 排队中 · 队列第 3 位');assert.ok(sidebar.turnStartedAt);
  sidebar.update({method:'queue/status',params:{threadId:'live',turnId:'turn',state:'ready',operation:null,position:null,message:null}});
  assert.equal(sidebar.phase,'模型负载 92% · 排队完成，正在启动');
  sidebar.update({method:'turn/started',params:{threadId:'live',turn:{id:'turn',status:'inProgress',items:[]}}});assert.equal(sidebar.phase,'模型处理中');
 }finally{sidebar.dispose();}
});
await test('slash option lists use model catalog and permissions; skills become structured attachments',async()=>{
 const sidebar=controller();const responses=[];sidebar.postToSession=message=>responses.push(message);
 sidebar.agent={models:async()=>({data:[{id:'m',model:'model',displayName:'Model',modelProviderId:'p',description:'demo',hidden:false,isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high',description:'deep'}],defaultReasoningEffort:'high'}]}),skills:async()=>({data:[{skills:[{name:'demo',path:'/tmp/skill.md',description:'skill',enabled:true},{name:'off',path:'/tmp/off.md',enabled:false}]}]}),dispose(){}};
 try {
  await sidebar.loadSlashOptions('model',1);assert.equal(responses.at(-1).options[0].id,'m');
  await sidebar.loadSlashOptions('reasoning',2);assert.equal(responses.at(-1).options[0].id,'high');
  await sidebar.loadSlashOptions('permissions',3);assert.equal(responses.at(-1).options.length,4);
  await sidebar.executeSlash('permissions','read-only');assert.equal(sidebar.permissionMode,'read-only');
  await sidebar.executeSlash('permissions','invalid');assert.equal(sidebar.permissionMode,'read-only');
  sidebar.busy=true;await sidebar.executeSlash('permissions','full');assert.equal(sidebar.permissionMode,'read-only');
  sidebar.busy=false;sidebar.transition=true;await sidebar.executeSlash('permissions','full');assert.equal(sidebar.permissionMode,'read-only');sidebar.transition=false;
  await sidebar.executeSlash('permissions','full');assert.equal(sidebar.permissionMode,'full');
  await sidebar.loadSlashOptions('skills',4);assert.equal(responses.at(-1).options.length,1);
  await sidebar.executeSlash('skills','/tmp/off.md');assert.equal(sidebar.attachments.length,0);
  await sidebar.executeSlash('skills','/tmp/skill.md');assert.deepEqual(sidebar.attachments[0].skill,{name:'demo',path:'/tmp/skill.md'});
  await sidebar.executeSlash('skills','/tmp/skill.md');assert.equal(sidebar.attachments.length,1);
  let submitted;sidebar.agent.prompt=async(...args)=>{submitted=args;return 'thread';};await sidebar.send('do work');assert.deepEqual(submitted[6],[{name:'demo',path:'/tmp/skill.md'}]);
 }finally{sidebar.dispose();}
});
await test('reasoning details survive late item start and process statuses finish with the turn',()=>{
 const sidebar=controller();sidebar.threadId='t';
 try {
  sidebar.update({method:'item/reasoning/summaryTextDelta',params:{threadId:'t',itemId:'r',delta:'thinking details'}});
  sidebar.update({method:'item/started',params:{threadId:'t',item:{id:'r',type:'reasoning',summary:[]}}});
  assert.equal(sidebar.messages[0].detail,'thinking details');assert.equal(sidebar.messages[0].status,'inProgress');
  sidebar.update({method:'turn/completed',params:{threadId:'t',turn:{id:'turn',status:'completed',error:null}}});
  assert.equal(sidebar.messages[0].status,'completed');
 }finally{sidebar.dispose();}
});
await test('plan updates are identified separately from active tool calls',()=>{
 const sidebar=controller();sidebar.threadId='t';
 try {
  sidebar.update({method:'turn/plan/updated',params:{threadId:'t',turnId:'turn',explanation:null,source:null,plan:[{step:'修复问题',status:'inProgress'}]}});
  assert.equal(sidebar.messages[0].processKind,'plan');assert.equal(sidebar.messages[0].toolName,'计划');assert.equal(sidebar.messages[0].status,'inProgress');
 }finally{sidebar.dispose();}
});
await test('raw reasoning events create a live process without exposing hidden reasoning text',()=>{
 const sidebar=controller();sidebar.threadId='t';
 const delta=(method,text)=>sidebar.update({method,params:{threadId:'t',itemId:'r',delta:text}});
 try {
  delta('item/reasoning/textDelta','raw thought');assert.equal(sidebar.messages[0].status,'inProgress');assert.equal(sidebar.messages[0].processKind,'reasoning');assert.equal(sidebar.messages[0].detail,undefined);assert.doesNotMatch(JSON.stringify(sidebar.messages),/raw thought/);
  sidebar.update({method:'item/started',params:{threadId:'t',item:{id:'r',type:'reasoning',summary:[]}}});assert.equal(sidebar.messages[0].detail,undefined);
  delta('item/reasoning/summaryTextDelta','summary');assert.equal(sidebar.messages[0].detail,'summary');
  delta('item/reasoning/textDelta',' more raw');assert.equal(sidebar.messages[0].detail,'summary');
  delta('item/reasoning/summaryTextDelta',' continues');assert.equal(sidebar.messages[0].detail,'summary continues');
  sidebar.update({method:'item/completed',params:{threadId:'t',item:{id:'r',type:'reasoning',summary:[]}}});assert.equal(sidebar.messages[0].status,'completed');assert.equal(sidebar.messages[0].detail,'summary continues');
 }finally{sidebar.dispose();}
});
await test('permission, legacy approval and MCP form requests return safe protocol responses',async()=>{
 const sidebar=controller();
 try {
  const permission=sidebar.request({id:'permissions',method:'item/permissions/requestApproval',params:{threadId:'t',turnId:'turn',itemId:'item',environmentId:null,startedAtMs:Date.now(),cwd:'/tmp',reason:'需要联网',permissions:{network:{enabled:true},fileSystem:null}}});
  const pending=sidebar.approvals.get('permissions');assert.match(pending.detail,/需要联网/);pending.resolve(pending.accept);sidebar.approvals.delete('permissions');assert.deepEqual(await permission,{decision:'accept'});
  const legacy=sidebar.request({id:'legacy',method:'execCommandApproval',params:{conversationId:'t',callId:'call',approvalId:null,command:['npm','test'],cwd:'/tmp',reason:null,parsedCmd:[]}});
  sidebar.clearApprovals();assert.deepEqual(await legacy,{decision:'denied'});
  const form=await sidebar.request({id:'mcp',method:'mcpServer/elicitation/request',params:{threadId:'t',turnId:'turn',serverName:'demo',mode:'form',_meta:null,message:'配置',requestedSchema:{type:'object',required:['enabled'],properties:{enabled:{type:'boolean',title:'启用'},name:{type:'string',title:'名称',default:'demo'}}}}});
  assert.deepEqual(form,{action:'accept',content:{enabled:true,name:'demo'}});
  await assert.rejects(sidebar.request({id:'tool',method:'item/tool/call',params:{threadId:'t',turnId:'turn',callId:'call',namespace:null,tool:'missing',arguments:{}}}),error=>error.code===-32601&&/未注册动态工具/.test(error.message));
 } finally {sidebar.dispose();}
});
await test('context compaction queue state does not lock the ordinary turn lifecycle',()=>{
 const sidebar=controller();sidebar.threadId='t';
 try {
  sidebar.update({method:'queue/status',params:{threadId:'t',turnId:'compact-turn',state:'waiting',operation:'contextCompaction',position:2,message:null}});
  assert.equal(sidebar.busy,false);assert.equal(sidebar.transition,true);assert.equal(sidebar.compacting,true);assert.match(sidebar.phase,/上下文压缩排队中/);
  sidebar.update({method:'thread/compacted',params:{threadId:'t',turnId:'compact-turn'}});
  assert.equal(sidebar.transition,false);assert.equal(sidebar.compacting,false);assert.equal(sidebar.phase,'就绪');assert.equal(sidebar.messages.at(-1).text,'上下文已压缩');
 } finally {sidebar.dispose();}
});
await test('turn completion only finishes process state owned by that turn',()=>{
 const sidebar=controller();sidebar.threadId='t';sidebar.busy=true;sidebar.activeTurnId='new-turn';sidebar.messages=[{id:'old',turnId:'old-turn',role:'tool',text:'旧任务',status:'inProgress'},{id:'new',turnId:'new-turn',role:'tool',text:'新任务',status:'inProgress'}];
 try {
  sidebar.update({method:'turn/completed',params:{threadId:'t',turn:{id:'old-turn',status:'completed',error:null}}});
  assert.equal(sidebar.busy,true);assert.equal(sidebar.messages[0].status,'completed');assert.equal(sidebar.messages[1].status,'inProgress');
  sidebar.phase='模型处理中';sidebar.update({method:'item/reasoning/textDelta',params:{threadId:'t',turnId:'old-turn',itemId:'late-old-reasoning',delta:'hidden'}});
  assert.equal(sidebar.phase,'模型处理中');assert.equal(sidebar.messages.at(-1).status,'completed');
  sidebar.update({method:'turn/completed',params:{threadId:'t',turn:{id:'new-turn',status:'completed',error:null}}});
  assert.equal(sidebar.busy,false);assert.equal(sidebar.activeTurnId,undefined);assert.equal(sidebar.messages[1].status,'completed');
 } finally {sidebar.dispose();}
});
await test('model fallback is visible and records the committed effective model',()=>{
 const sidebar=controller();sidebar.threadId='t';sidebar.activeTurnId='turn';sidebar.busy=true;
 const from={ordinal:null,provider:'p',model:'primary',modelBackendVariant:null};const target={ordinal:1,provider:'p',model:'backup',modelBackendVariant:'max'};
 try {
  sidebar.update({method:'model/fallback',params:{threadId:'t',turnId:'turn',event:{type:'attemptStarted',ordinal:1,from,to:target,trigger:'modelCapacity'}}});
  let message=sidebar.messages.at(-1);assert.equal(message.process,false);assert.equal(message.status,'inProgress');assert.match(message.text,/backup/);
  sidebar.update({method:'model/fallback',params:{threadId:'t',turnId:'turn',event:{type:'committed',ordinal:1,configuredPrimary:from,target,trigger:'modelCapacity',attemptCount:1,settings:{}}}});
  message=sidebar.messages.at(-1);assert.equal(message.status,'completed');assert.match(message.text,/backup/);assert.match(message.detail,/共尝试 1 次/);
 } finally {sidebar.dispose();}
});
await test('message, virtual document and idle live-session caches are bounded',async()=>{
 const sidebar=controller();let rootDisposed=0;sidebar.threadId='root-thread';sidebar.lastActivityAt=-1;sidebar.agent={dispose:()=>rootDisposed++};
 try {
  for(let index=0;index<520;index++) sidebar.pushMessage({id:'message-'+index,role:'assistant',text:'message'});
  assert.equal(sidebar.messages.length,500);assert.equal(sidebar.messages[0].id,'message-20');
  sidebar.messages=[{id:'command',turnId:'turn',role:'tool',text:'build',status:'inProgress',processKind:'commandExecution',detail:''}];
  sidebar.update({method:'item/commandExecution/outputDelta',params:{threadId:'root-thread',turnId:'turn',itemId:'command',delta:'x'.repeat(210000)}});
  assert.ok(sidebar.messages[0].detail.length<=200000);assert.match(sidebar.messages[0].detail,/已省略较早内容/);
  for(let index=0;index<45;index++) sidebar.virtualUri(`doc-${index}.txt`,'content');
  assert.equal(sidebar.virtualDocuments.size,40);
  for(let index=0;index<6;index++) await sidebar.restart();
  assert.equal(sidebar.liveSessions.size,6);assert.equal(rootDisposed,1);assert.ok(sidebar.sessions.some(session=>session.id==='root-thread'));
 } finally {sidebar.dispose();}
});
