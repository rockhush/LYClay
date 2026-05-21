# DWS CLI 调用指南

## 问题

在 Node.js 中使用 `child_process.exec()` 或 `execSync()` 执行命令时，**不会加载 `.zshrc` 或 `.bashrc`**，因此即使 `~/.dws` 在 PATH 中也无法找到 `dws` 命令。

### 示例（错误）

```typescript
// ❌ 这不会工作 - 非交互式 shell 不加载 .zshrc
execSync('dws calendar --date tomorrow')
```

## 解决方案

### 方案 1：使用 `getDwsCliPath()` + 完整路径（推荐）

```typescript
import { getDwsCliPath } from '../utils/dws-env-setup';

// ✅ 使用完整路径
const dwsPath = getDwsCliPath(); // 返回 ~/.dws/dws 或 ~/.dws/dws.exe
execSync(`"${dwsPath}" calendar --date tomorrow`)
```

### 方案 2：使用封装的 `execDwsCommand()`

```typescript
import { execDwsCommand } from '../utils/dws-env-setup';

// ✅ 同步调用
const output = execDwsCommand(['calendar', '--date', 'tomorrow']);
console.log(output);

// ✅ 异步调用
const output = await execDwsCommandAsync(['calendar', '--date', 'tomorrow']);
console.log(output);
```

### 方案 3：设置 shell 为登录 shell（macOS/Linux）

```typescript
// ✅ 强制使用登录 shell（会加载 .zshrc）
execSync('dws calendar --date tomorrow', {
  shell: '/bin/zsh -l'  // macOS
  // shell: '/bin/bash -l'  // Linux
})
```

## API 文档

### `getDwsCliPath()`

返回 DWS CLI 的完整路径。

```typescript
function getDwsCliPath(): string

// 示例
const dwsPath = getDwsCliPath();
// macOS/Linux: /Users/username/.dws/dws
// Windows:     C:\Users\username\.dws\dws.exe
```

### `execDwsCommand(args, options?)`

同步执行 DWS CLI 命令。

```typescript
function execDwsCommand(
  args: string[],
  options?: { encoding?: BufferEncoding }
): string

// 示例
const output = execDwsCommand(['calendar', '--date', 'tomorrow']);
const output = execDwsCommand(['workspace', 'list'], { encoding: 'utf-8' });
```

### `execDwsCommandAsync(args, options?)`

异步执行 DWS CLI 命令。

```typescript
async function execDwsCommandAsync(
  args: string[],
  options?: { encoding?: BufferEncoding }
): Promise<string>

// 示例
const output = await execDwsCommandAsync(['calendar', '--date', 'tomorrow']);
```

## 最佳实践

1. **始终使用完整路径** - 不依赖 PATH 环境变量
2. **优先使用封装函数** - `execDwsCommand()` 和 `execDwsCommandAsync()`
3. **处理错误** - 命令可能失败，使用 try-catch
4. **超时设置** - 避免命令挂起

### 完整示例

```typescript
import { execDwsCommand } from '../utils/dws-env-setup';
import { logger } from '../utils/logger';

async function getTomorrowSchedule(): Promise<void> {
  try {
    const output = execDwsCommand(['calendar', '--date', 'tomorrow'], {
      encoding: 'utf-8',
    });
    
    logger.info('Tomorrow schedule:', output);
    return JSON.parse(output);
  } catch (error) {
    logger.error('Failed to get calendar:', error);
    throw new Error('Failed to fetch calendar data');
  }
}
```

## 跨平台兼容

| 平台 | DWS 路径 | Shell 命令 |
|------|----------|------------|
| macOS | `~/.dws/dws` | `/bin/zsh -l` |
| Linux | `~/.dws/dws` | `/bin/bash -l` |
| Windows | `~/.dws/dws.exe` | `powershell` |

`getDwsCliPath()` 和 `execDwsCommand()` 已处理所有平台差异。

## 相关文件

- `electron/utils/dws-env-setup.ts` - 核心函数
- `electron/utils/dws-cli-installer.ts` - 安装逻辑
