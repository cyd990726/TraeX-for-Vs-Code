import { execFile } from 'node:child_process';
export type CliOptions = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
export function isAuthError(error: unknown) {
  return /not logged in|not authenticated|authentication required|please (?:log|sign) in|login required|unauthorized|\b401\b|未登录|请先登录|登录(?:已)?(?:过期|失效)/i.test(String(error));
}
export function loginStatus(options: CliOptions): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(options.executable, [...options.args, 'login', 'status'], { cwd: options.cwd, env: options.env, timeout: 10000, maxBuffer: 65536, windowsHide: true }, (error, stdout, stderr) => {
      const result = `${stdout}\n${stderr}`;
      if (error && isAuthError(result)) resolve(false);
      else if (error) reject(new Error(error.code === 'ENOENT' ? '未找到 TRAE CLI，请安装 CLI 或在设置中配置 traecli.executable。' : '无法检查 TRAE CLI 登录状态，请检查 CLI 配置后重试。'));
      else resolve(true);
    });
  });
}
