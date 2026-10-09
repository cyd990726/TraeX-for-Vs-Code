import type { AskForApproval } from './protocol/v2/AskForApproval';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy';
export type PermissionMode = 'default' | 'read-only' | 'workspace' | 'full';
export type Permissions = { approvalPolicy: AskForApproval; sandboxPolicy: SandboxPolicy };
export const permissionChoices = [
  {id:'default', name:'默认权限', description:'使用打开此会话时的 CLI 权限配置。'},
  {id:'read-only', name:'只读', description:'可读取文件；不允许写文件或访问网络，不申请提升权限。'},
  {id:'workspace', name:'项目内编辑', description:'允许修改当前项目；网络访问或超出沙箱的操作按需请求授权。'},
  {id:'full', name:'完全访问', description:'可访问沙箱外的文件和网络，执行操作不再请求授权。'},
] as const;
export function permissionsFor(mode: PermissionMode, cwd: string): Permissions | undefined {
  if (mode === 'read-only') return {approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}};
  if (mode === 'workspace') return {approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
  if (mode === 'full') return {approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}};
  return undefined;
}
