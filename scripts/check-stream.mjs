import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
const temp = await mkdtemp(join(tmpdir(),'trae-stream-'));
await build({entryPoints:['src/agent.ts'],outfile:join(temp,'agent.cjs'),bundle:true,platform:'node'});
const {Agent}=await import(join(temp,'agent.cjs'));
const started=Date.now();let deltaCount=0;let firstDelta;let lastDelta;let completion;
let resolve;const done=new Promise(r=>resolve=r);
const a=new Agent({executable:process.env.TRAE_EXECUTABLE ?? join(homedir(),'.local/bin/traecli'),args:[],cwd:process.cwd(),env:process.env,request:async()=>({decision:'decline'}),log:()=>{},exited:()=>resolve(),update:e=>{
 if(e.method==='item/agentMessage/delta'){deltaCount++;firstDelta??=Date.now();lastDelta=Date.now();if(deltaCount<=3)console.log('delta',deltaCount,'at',Date.now()-started,'ms','chars',e.params.delta.length);}
 if(e.method==='item/started'||e.method==='item/completed')console.log(e.method,e.params.item.type,'at',Date.now()-started,'ms');
 if(e.method==='turn/completed'){completion=Date.now();console.log('turn status',e.params.turn.status);resolve();}
}});
const timeout=setTimeout(resolve,60000);
try {await a.prompt('不要调用工具，不要读取或修改文件。请用中文写一篇约400字的短文，解释单元测试的作用。');await done;console.log(JSON.stringify({deltaCount,firstDeltaMs:firstDelta-started,lastDeltaMs:lastDelta-started,completionMs:completion-started}));}finally{clearTimeout(timeout);await a.cancel().catch(()=>{});a.dispose();await rm(temp,{recursive:true,force:true});}
