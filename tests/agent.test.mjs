import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const directory = await mkdtemp(join(tmpdir(),'trae-agent-test-'));
await build({entryPoints:['src/agent.ts'],outfile:join(directory,'agent.cjs'),bundle:true,platform:'node'});
const { Agent } = await import(join(directory,'agent.cjs'));
await test('app-server handles history, resume, streaming, approval and interruption', async () => {
 const events=[];
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:process.env,update:event=>events.push(event),request:async()=>({decision:'decline'}),log:()=>{},exited:()=>{}});
 try {
  assert.deepEqual((await agent.history()).data,[]);
  assert.equal((await agent.models()).data[0].model,'test-model');
  assert.deepEqual(await agent.respondModeChange('saved-thread','mode-request','approved'),{threadId:'saved-thread',requestId:'mode-request',decision:'approved'});
  assert.equal((await agent.resume('saved-thread')).thread.id,'saved-thread');
  agent.newThread();
  assert.equal(await agent.prompt('test'),'thread-test');
  await agent.cancel();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(events.some(event=>event.method==='item/agentMessage/delta' && event.params.delta==='hello'));
  assert.ok(events.some(event=>event.method==='item/completed' && event.params.item.aggregatedOutput==='decline'));
  assert.ok(events.some(event=>event.method==='turn/completed' && event.params.turn.status==='interrupted'));
 } finally {agent.dispose();}
});
await test('externally resolved server requests do not write a duplicate response',async()=>{
 const events=[];let release;
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:{...process.env,TRAE_TEST_EXTERNAL_RESOLVE:'1'},update:event=>{events.push(event);if(event.method==='serverRequest/resolved')release?.({decision:'decline'});},request:()=>new Promise(resolve=>release=resolve),log:()=>{},exited:()=>{}});
 try {await agent.prompt('test');await new Promise(resolve=>setTimeout(resolve,30));assert.ok(events.some(event=>event.method==='serverRequest/resolved'));assert.ok(!events.some(event=>event.method==='item/completed'));}finally{agent.dispose();}
});
await test('startup failure rejects instead of hanging',async()=>{
 const agent=new Agent({executable:'/does-not-exist/traecli',args:[],cwd:process.cwd(),env:process.env,update:()=>{},request:async()=>({}),log:()=>{},exited:()=>{}});
 try {await assert.rejects(agent.history(),/ENOENT/);}finally{agent.dispose();}
});
await test('failed initialization can reconnect on the same agent without replaying prompts',async()=>{
 let starts=0;
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:{...process.env,TRAE_TEST_FAIL_INIT:'1'},update:()=>{},request:async()=>({}),log:()=>{},exited:()=>{},status:status=>{if(status==='正在连接')starts++;}});
 try { await assert.rejects(agent.history(),/test initialization failure/); agent.options.env.TRAE_TEST_FAIL_INIT='0'; assert.deepEqual((await agent.history()).data,[]);assert.equal(starts,2); }finally{agent.dispose();}
});
await test('reasoning effort is transmitted in the app-server turn request',async()=>{
 const events=[];
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:process.env,update:event=>events.push(event),request:async()=>({decision:'decline'}),log:()=>{},exited:()=>{}});
 try{await agent.prompt('test',undefined,undefined,'high');await new Promise(resolve=>setTimeout(resolve,30));assert.ok(events.some(event=>event.method==='item/agentMessage/delta'&&event.params.delta==='hello:high'));}finally{agent.dispose();}
});
await test('model mode uses modelBackendVariant and does not send serviceTier',async()=>{
 const events=[];
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:process.env,update:event=>events.push(event),request:async()=>({decision:'decline'}),log:()=>{},exited:()=>{}});
 try{await agent.prompt('test',undefined,undefined,undefined,'sol__max');await new Promise(resolve=>setTimeout(resolve,30));assert.ok(events.some(event=>event.method==='item/agentMessage/delta'&&event.params.delta==='mode:sol__max'));}finally{agent.dispose();}
});
await test('queue status extends the turn start timeout',async()=>{
 const events=[];
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:{...process.env,TRAE_TEST_QUEUE:'1'},queuedTurnTimeoutMs:150,update:event=>events.push(event),request:async()=>({decision:'decline'}),log:()=>{},exited:()=>{}});
 try{await agent.models();agent.options.rpcTimeoutMs=20;assert.equal(await agent.prompt('queued'),'thread-test');assert.ok(events.some(event=>event.method==='queue/status'&&event.params.position===3));}finally{agent.dispose();}
});
await test('context compaction uses the long queue timeout without becoming an interruptible turn',async()=>{
 const events=[];
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:{...process.env,TRAE_TEST_COMPACT_QUEUE:'1'},queuedTurnTimeoutMs:150,update:event=>events.push(event),request:async()=>({decision:'decline'}),log:()=>{},exited:()=>{}});
 try{
  await agent.resume('saved-thread');agent.options.rpcTimeoutMs=20;
  assert.deepEqual(await agent.compact('keep decisions'),{threadId:'saved-thread',userGuidance:'keep decisions'});
  assert.equal(agent.turnId,undefined);assert.ok(events.some(event=>event.method==='queue/status'&&event.params.operation==='contextCompaction'));
 }finally{agent.dispose();}
});
await test('permission overrides reach the CLI and default restores the original policy',async()=>{
 const events=[];
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:{...process.env,TRAE_TEST_PERMISSIONS:'1'},update:event=>events.push(event),request:async()=>({decision:'decline'}),log:()=>{},exited:()=>{}});
 try{
  await agent.prompt('full',undefined,undefined,undefined,undefined,{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});await new Promise(resolve=>setTimeout(resolve,30));await agent.cancel();
  await agent.prompt('restore default');await new Promise(resolve=>setTimeout(resolve,30));
  const received=events.filter(event=>event.method==='item/agentMessage/delta').map(event=>JSON.parse(event.params.delta.slice('permissions:'.length)));
  assert.deepEqual(received[0],{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
  assert.deepEqual(received[1],{approvalPolicy:'untrusted',sandboxPolicy:{type:'readOnly',networkAccess:false}});
 }finally{agent.dispose();}
});
await test('persistent message queue supports add, list, edit, reorder, delete and start',async()=>{
 const events=[];
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:{...process.env,TRAE_TEST_QUEUE_API:'1'},update:event=>events.push(event),request:async()=>({}),log:()=>{},exited:()=>{}});
 try{
  await agent.resume('queued-thread');
  const first=(await agent.addQueued('first','client-first',[{name:'demo',path:'/tmp/demo/SKILL.md'}])).queuedSubmission;
  const second=(await agent.addQueued('second','client-second')).queuedSubmission;
  assert.deepEqual((await agent.listQueued()).data.map(item=>item.id),[first.id,second.id]);
  const updated=await agent.updateQueued(first.id,[{type:'text',text:'edited',text_elements:[]},{type:'skill',name:'demo',path:'/tmp/demo/SKILL.md'}]);
  assert.equal(updated.queuedSubmission.input[0].text,'edited');
  await agent.reorderQueued([second.id,first.id]);assert.deepEqual((await agent.listQueued()).data.map(item=>item.id),[second.id,first.id]);
  assert.equal((await agent.deleteQueued(first.id)).deleted,true);
  const started=await agent.startQueued(second.id);assert.match(started.turn.id,/^queued-turn-/);assert.deepEqual((await agent.listQueued()).data,[]);
  assert.ok(events.some(event=>event.method==='thread/queue/changed'));
 }finally{agent.dispose();}
});
await test('starting a queued message inherits the long model queue timeout',async()=>{
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:{...process.env,TRAE_TEST_QUEUE_START_TIMEOUT:'1'},queuedTurnTimeoutMs:150,update:()=>{},request:async()=>({}),log:()=>{},exited:()=>{}});
 try{await agent.resume('queued-thread');const item=(await agent.addQueued('later','client')).queuedSubmission;agent.options.rpcTimeoutMs=20;assert.match((await agent.startQueued(item.id)).turn.id,/^queued-turn-/);}finally{agent.dispose();}
});
await test('btw transmits a side question without replacing the active turn',async()=>{
 const events=[];const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),update:event=>events.push(event),log:()=>{},exited:()=>{},request:async()=>({decision:'accept'})});
 try {
  await agent.resume('thread-test');agent.turnId='main-turn';
  assert.deepEqual(await agent.btw('进展如何？','main-turn'),{turnId:'main-turn'});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(agent.turnId,'main-turn');assert.ok(events.some(event=>event.method==='turn/btw/delta'&&event.params.delta==='answer:进展如何？'));
  assert.ok(events.some(event=>event.method==='turn/btw/completed'));assert.equal(events.some(event=>event.method==='turn/started'),false);
 }finally{agent.dispose();}
});
await rm(directory,{recursive:true,force:true});
await test('skill discovery and structured invocation, and context compaction use native RPCs',async()=>{
 const events=[];
 const agent=new Agent({executable:process.execPath,args:[resolve('tests/mock-server.cjs')],cwd:process.cwd(),env:{...process.env,TRAE_TEST_SKILLS:'1'},update:event=>events.push(event),request:async()=>({decision:'decline'}),log:()=>{},exited:()=>{}});
 try {
  const skill=(await agent.skills()).data[0].skills[0];assert.equal(skill.name,'demo');
  await agent.prompt('Use demo',undefined,undefined,undefined,undefined,undefined,[{name:skill.name,path:skill.path}]);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(events.some(event=>event.method==='item/agentMessage/delta'&&event.params.delta==='skills:[{"type":"skill","name":"demo","path":"/tmp/demo/SKILL.md"}]'));
  assert.deepEqual(await agent.compact('keep important decisions'),{threadId:'thread-test',userGuidance:'keep important decisions'});
 } finally {agent.dispose();}
});
