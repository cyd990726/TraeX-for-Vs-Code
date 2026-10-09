const threadId=process.env.TRAE_TEST_UNIQUE_THREADS==='1'?'thread-'+process.pid:'thread-test';
const rl = require('node:readline').createInterface({input:process.stdin});
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
rl.on('line',line=>{
 const message=JSON.parse(line);
 if (message.method==='initialize') send(process.env.TRAE_TEST_FAIL_INIT==='1'?{id:message.id,error:{message:'test initialization failure'}}:{id:message.id,result:{}});
 if (message.method==='thread/list') send({id:message.id,result:{data:[],nextCursor:null}});
 if (message.method==='skills/list') send({id:message.id,result:{data:[{cwd:message.params.cwds[0],skills:[{name:'demo',path:'/tmp/demo/SKILL.md',description:'Demo skill',enabled:true}]}]}});
 if (message.method==='thread/compact/start') send({id:message.id,result:{threadId:message.params.threadId,userGuidance:message.params.userGuidance}});
 if (message.method==='model/list') send({id:message.id,result:{data:[{model:'test-model'}]}});
 if (message.method==='thread/start') {send({method:'thread/started',params:{thread:{id:threadId},approvalPolicy:'untrusted',sandbox:{type:'readOnly',networkAccess:false}}});send({id:message.id,result:{thread:{id:threadId},approvalPolicy:'untrusted',sandbox:{type:'readOnly',networkAccess:false}}});}
 if (message.method==='thread/resume') send({id:message.id,result:{thread:{id:message.params.threadId,turns:[]}}});
 if (message.method==='turn/start') {
  const start=()=>{send({id:message.id,result:{turn:{id:'turn-test',status:'inProgress'}}});send({method:'turn/started',params:{threadId:threadId,turn:{id:'turn-test'}}});send({method:'item/agentMessage/delta',params:{threadId:threadId,itemId:'item-test',delta:process.env.TRAE_TEST_SKILLS==='1' ? 'skills:'+JSON.stringify(message.params.input.filter(item=>item.type==='skill')) : process.env.TRAE_TEST_PERMISSIONS==='1' ? 'permissions:'+JSON.stringify({approvalPolicy:message.params.approvalPolicy,sandboxPolicy:message.params.sandboxPolicy}) : message.params.serviceTier !== undefined ? 'UNEXPECTED_SERVICE_TIER' : message.params.modelBackendVariant ? 'mode:'+message.params.modelBackendVariant : message.params.effort ? 'hello:'+message.params.effort : 'hello'}});send({id:'approval-test',method:'item/commandExecution/requestApproval',params:{threadId:threadId,turnId:'turn-test',itemId:'command-test',command:'echo hello'}});};
  if(process.env.TRAE_TEST_QUEUE==='1'){send({method:'queue/status',params:{threadId:threadId,turnId:'turn-test',state:'waiting',operation:null,position:3,message:null}});setTimeout(start,60);}else start();
 }
 if(message.id==='approval-test') send({method:'item/completed',params:{threadId:threadId,item:{id:'command-test',type:'commandExecution',command:'echo hello',aggregatedOutput:message.result.decision}}});
 if(message.method==='turn/interrupt') {send({id:message.id,result:{}});send({method:'turn/completed',params:{threadId:threadId,turn:{id:'turn-test',status:'interrupted'}}});}
});
