function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function resolveDigitalEmployeeUninstallError(error: unknown): string {
  const message = getErrorText(error);
  if (/\bEBUSY\b|resource busy or locked/i.test(message)) {
    return '文件正在被占用，暂时无法卸载。请停止相关任务或关闭占用程序，稍后重试。';
  }
  return '卸载失败，请稍后重试。';
}
