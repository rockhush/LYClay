function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function resolveDigitalEmployeeInstallError(error: unknown): string {
  const message = getErrorText(error);
  if (/digital employee package contains too many entries/i.test(message)) {
    return '安装包中的文件数量过多，已停止安装。请移除依赖缓存、构建产物或其他非必要文件，重新打包后再试。';
  }
  return `安装失败：${message || '请稍后重试。'}`;
}
