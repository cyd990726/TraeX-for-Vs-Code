const threadId=process.env.TRAE_TEST_UNIQUE_THREADS==='1'?'thread-'+process.pid:'thread-test';
let queued=[];let queueSequence=0;
const rl = require('node:readline').createInterface({input:process.stdin});
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
rl.on('line',line=>{
 const message=JSON.parse(line);
 if (message.method==='initialize') send(process.env.TRAE_TEST_FAIL_INIT==='1'?{id:message.id,error:{message:'test initialization failure'}}:process.env.TRAE_TEST_QUEUE_API==='1'&&!message.params.capabilities.experimentalApi?{id:message.id,error:{message:'experimental API must be enabled'}}:{id:message.id,result:{}});
 if (message.method==='thread/list') send({id:message.id,result:{data:[],nextCursor:null}});
 if (message.method==='skills/list') send({id:message.id,result:{data:[{cwd:message.params.cwds[0],skills:[{name:'demo',path:'/tmp/demo/SKILL.md',description:'Demo skill',enabled:true}]}]}});
 if (message.method==='thread/compact/start') {
  const complete=()=>send({id:message.id,result:{threadId:message.params.threadId,userGuidance:message.params.userGuidance}});
  if(process.env.TRAE_TEST_COMPACT_QUEUE==='1'){send({method:'queue/status',params:{threadId:message.params.threadId,turnId:'compact-turn',state:'waiting',operation:'contextCompaction',position:2,message:null}});setTimeout(complete,60);}else complete();
 }
 if (message.method==='model/list') send({id:message.id,result:{data:[{model:'test-model'}]}});
 if (message.method==='turn/btw') {
  const params={threadId:message.params.threadId,turnId:message.params.turnId??'btw-turn'};
  send({id:message.id,result:{turnId:params.turnId}});
  send({method:'turn/btw/delta',params:{...params,delta:'answer:'+message.params.question}});
  send({method:'turn/btw/completed',params:{...params,answer:'answer:'+message.params.question}});
 }
 if (message.method==='mode/change/respond') send({id:message.id,result:{threadId:message.params.threadId,requestId:message.params.requestId,decision:message.params.decision}});
 if (message.method==='thread/start') {send({method:'thread/started',params:{thread:{id:threadId},approvalPolicy:'untrusted',sandbox:{type:'readOnly',networkAccess:false}}});send({id:message.id,result:{thread:{id:threadId},approvalPolicy:'untrusted',sandbox:{type:'readOnly',networkAccess:false}}});}
 if (message.method==='thread/resume') send({id:message.id,result:{thread:{id:message.params.threadId,turns:[]}}});
 if(message.method==='thread/queue/add') {const item={id:`queued-${++queueSequence}`,input:message.params.input,clientUserMessageId:message.params.clientUserMessageId};queued.push(item);send({id:message.id,result:{queuedSubmission:item}});send({method:'thread/queue/changed',params:{threadId:message.params.threadId}});}
 if(message.method==='thread/queue/list') send({id:message.id,result:{data:queued,nextCursor:null}});
 if(message.method==='thread/queue/update') {const index=queued.findIndex(item=>item.id===message.params.queuedSubmissionId);if(index>=0)queued[index]={...queued[index],input:message.params.input};send({id:message.id,result:{queuedSubmission:queued[index]}});send({method:'thread/queue/changed',params:{threadId:message.params.threadId}});}
 if(message.method==='thread/queue/delete') {const before=queued.length;queued=queued.filter(item=>item.id!==message.params.queuedSubmissionId);send({id:message.id,result:{deleted:queued.length<before}});send({method:'thread/queue/changed',params:{threadId:message.params.threadId}});}
 if(message.method==='thread/queue/reorder') {const byId=new Map(queued.map(item=>[item.id,item]));queued=message.params.queuedSubmissionIds.map(id=>byId.get(id)).filter(Boolean);send({id:message.id,result:{}});send({method:'thread/queue/changed',params:{threadId:message.params.threadId}});}
 if(message.method==='thread/queue/start') {const start=()=>{const index=message.params.queuedSubmissionId?queued.findIndex(item=>item.id===message.params.queuedSubmissionId):0;const item=index>=0?queued.splice(index,1)[0]:undefined;if(!item){send({id:message.id,error:{message:'queue is empty'}});}else{const turn={id:`queued-turn-${queueSequence}`,status:'inProgress',items:[],itemsView:{type:'full'},error:null,startedAt:null,completedAt:null,durationMs:null};send({id:message.id,result:{turn}});send({method:'thread/queue/changed',params:{threadId:message.params.threadId}});send({method:'turn/started',params:{threadId:message.params.threadId,turn}});}};if(process.env.TRAE_TEST_QUEUE_START_TIMEOUT==='1'){send({method:'queue/status',params:{threadId:message.params.threadId,turnId:`queued-turn-${queueSequence}`,state:'waiting',operation:null,position:2,message:null}});setTimeout(start,60);}else start();}
 if (message.method==='turn/start') {
  const start=()=>{send({id:message.id,result:{turn:{id:'turn-test',status:'inProgress'}}});send({method:'turn/started',params:{threadId:threadId,turn:{id:'turn-test'}}});send({method:'item/agentMessage/delta',params:{threadId:threadId,itemId:'item-test',delta:process.env.TRAE_TEST_SKILLS==='1' ? 'skills:'+JSON.stringify(message.params.input.filter(item=>item.type==='skill')) : process.env.TRAE_TEST_PERMISSIONS==='1' ? 'permissions:'+JSON.stringify({approvalPolicy:message.params.approvalPolicy,sandboxPolicy:message.params.sandboxPolicy}) : message.params.serviceTier !== undefined ? 'UNEXPECTED_SERVICE_TIER' : message.params.modelBackendVariant ? 'mode:'+message.params.modelBackendVariant : message.params.effort ? 'hello:'+message.params.effort : 'hello'}});send({id:'approval-test',method:'item/commandExecution/requestApproval',params:{threadId:threadId,turnId:'turn-test',itemId:'command-test',command:'echo hello'}});if(process.env.TRAE_TEST_EXTERNAL_RESOLVE==='1')send({method:'serverRequest/resolved',params:{threadId:threadId,requestId:'approval-test'}});};
  if(process.env.TRAE_TEST_QUEUE==='1'){send({method:'queue/status',params:{threadId:threadId,turnId:'turn-test',state:'waiting',operation:null,position:3,message:null}});setTimeout(start,60);}else start();
 }
 if(message.id==='approval-test') send({method:'item/completed',params:{threadId:threadId,item:{id:'command-test',type:'commandExecution',command:'echo hello',aggregatedOutput:message.result.decision}}});
 if(message.method==='turn/interrupt') {send({id:message.id,result:{}});send({method:'turn/completed',params:{threadId:threadId,turn:{id:'turn-test',status:'interrupted'}}});}
});
