export const slashCommands = [
  {name:'model', description:'选择模型', picker:true},
  {name:'mode', description:'选择模型 Mode 和查看上下文窗口', picker:true},
  {name:'reasoning', description:'选择 Reasoning Level', picker:true},
  {name:'permissions', description:'选择执行权限', picker:true},
  {name:'skills', description:'选择技能，添加到下一条请求', picker:true},
  {name:'new', description:'新建会话，当前任务继续在后台运行'},
  {name:'clear', description:'开始新会话，释放当前上下文并保留历史'},
  {name:'history', description:'返回当前项目的会话列表'},
  {name:'review', description:'审阅当前会话的文件变更'},
  {name:'compact', description:'压缩当前会话上下文'},
  {name:'status', description:'查看当前会话和连接状态'},
  {name:'init', description:'让智能体检查项目并创建或更新 AGENTS.md'},
  {name:'help', description:'查看侧栏支持的命令'},
] as const;
export type SlashOption = {id:string; label:string; description?:string; selected?:boolean};
