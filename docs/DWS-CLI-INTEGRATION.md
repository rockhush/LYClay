# DWS CLI 集成方案

## 概述

DWS CLI (DingTalk Workspace CLI) 已集成到 LYClaw 中，实现自动化安装和使用。

## 架构设计

### 方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| ~~运行时下载~~ | - | ❌ 启动慢<br>❌ 需要网络<br>❌ 可能失败 |
| **打包时预下载** ✅ | ✅ 启动快<br>✅ 离线可用<br>✅ 稳定可靠 | - |

### 最终方案：打包时预下载

**工作流程**：
```
开发者打包阶段
    ↓
运行构建脚本下载所有平台的 DWS CLI
    ↓
打包进安装包 (resources/bin/)
    ↓
用户安装 LYClaw
    ↓
首次启动时从安装包提取到 ~/.dws/
    ↓
用户可以直接使用
```

## 文件结构

### 构建时
```
resources/bin/
├── darwin/
│   ├── dws-darwin-amd64.tar.gz    # macOS Intel
│   └── dws-darwin-arm64.tar.gz    # macOS Apple Silicon
├── win32/
│   ├── dws-windows-amd64.zip      # Windows x64
│   └── dws-windows-arm64.zip      # Windows ARM
└── linux/
    ├── dws-linux-amd64.tar.gz     # Linux x64
    └── dws-linux-arm64.tar.gz     # Linux ARM
```

### 安装后 (用户端)
```
~/.dws/
├── config.json              # DWS 配置
├── .gitignore               # 安全保护
├── cache/                   # 缓存目录
├── dws (或 dws.exe)         # DWS CLI 二进制
└── token                    # 访问令牌
```

## 实现细节

### 1. 构建脚本

**文件**: `scripts/download-dws-cli.mjs`

**功能**: 从 GitHub Releases 下载所有平台的 DWS CLI

**使用方法**:
```bash
# 下载当前平台
pnpm dws:download

# 下载指定平台
pnpm dws:download:win
pnpm dws:download:mac
pnpm dws:download:linux

# 下载所有平台 (release 时用)
pnpm dws:download:all
```

**集成到构建流程**:
- `package` 命令自动下载当前平台
- `release` 命令下载所有平台
- `prep:win-binaries` 包含 Windows 下载

### 2. 安装包配置

**文件**: `electron-builder.yml`

添加 DWS CLI 到 extraResources:
```yaml
extraResources:
  # ... 其他资源
  - from: resources/bin/
    to: bin/
    filter:
      - "**/*"
```

### 3. 安装逻辑

**文件**: `electron/utils/dws-cli-installer.ts`

**功能**:
- 从安装包提取 DWS CLI
- 解压并安装到 `~/.dws/`
- 设置可执行权限 (Unix)
- 错误处理和日志记录

**调用时机**: 应用启动时自动执行

### 4. 环境变量配置

**文件**: `electron/utils/token-storage.ts`

**功能**:
- 登录成功后设置环境变量 `DWS_ACCESS_TOKEN`
- Windows: 使用 `setx` 设置系统级环境变量
- macOS/Linux: 写入 shell 配置文件

## 用户使用

### 方式 1: ClawX 内部调用

ClawX 内部可以直接调用 DWS CLI:
```typescript
import { getDwsCliPath } from './dws-env-setup';

const dwsPath = getDwsCliPath(); // 返回 ~/.dws/dws 或 ~/.dws/dws.exe
// 使用 execSync(`${dwsPath} command`)
```

### 方式 2: 用户命令行使用

用户需要将 `~/.dws` 添加到 PATH:

**Windows (PowerShell)**:
```powershell
$env:Path += ";$env:USERPROFILE\.dws"
# 永久添加:
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$env:USERPROFILE\.dws", "User")
```

**macOS/Linux (bash/zsh)**:
```bash
echo 'export PATH="$HOME/.dws:$PATH"' >> ~/.zshrc  # macOS
echo 'export PATH="$HOME/.dws:$PATH"' >> ~/.bashrc  # Linux
source ~/.zshrc  # 或 source ~/.bashrc
```

添加后可以直接使用:
```bash
dws --version
dws login
dws workspace list
```

## 开发指南

### 本地开发

```bash
# 1. 下载当前平台的 DWS CLI
pnpm dws:download

# 2. 启动开发服务器
pnpm dev
```

### 打包发布

```bash
# Windows
pnpm package:win

# macOS
pnpm package:mac

# Linux
pnpm package:linux

# 发布 (下载所有平台)
pnpm release
```

### 更新 DWS CLI

当 DWS CLI 有新版本时:

1. 更新 GitHub Release
2. 重新运行 `pnpm dws:download:all`
3. 重新打包发布

## 故障排查

### DWS CLI 未找到

**问题**: 启动后 `~/.dws/dws` 不存在

**解决方法**:
```bash
# 开发模式
pnpm dws:download

# 或手动下载
# 访问: https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/latest
# 下载对应平台的文件到 resources/bin/<platform>/
```

### 环境变量未生效

**问题**: Python 脚本无法读取 `DWS_ACCESS_TOKEN`

**原因**: `setx` 设置的环境变量需要重启终端/IDE

**解决方法**:
1. 完全关闭 IDE
2. 重新打开
3. 或直接从文件读取: `~/.dws/token`

### 权限问题 (macOS/Linux)

**问题**: `Permission denied` 执行 `dws` 命令

**解决方法**:
```bash
chmod +x ~/.dws/dws
```

## 技术细节

### 跨平台支持

| 平台 | 架构 | 文件名 | 格式 |
|------|------|--------|------|
| macOS | x64 | dws-darwin-amd64.tar.gz | tar.gz |
| macOS | arm64 | dws-darwin-arm64.tar.gz | tar.gz |
| Windows | x64 | dws-windows-amd64.zip | zip |
| Windows | arm64 | dws-windows-arm64.zip | zip |
| Linux | x64 | dws-linux-amd64.tar.gz | tar.gz |
| Linux | arm64 | dws-linux-arm64.tar.gz | tar.gz |

### 安装大小

每个平台的 DWS CLI 约 4-5 MB，总共约 25 MB。

### 性能影响

- **构建时**: 增加约 1-2 分钟下载时间 (仅首次)
- **安装包大小**: 增加约 25 MB (包含所有平台)
- **运行时**: 几乎无影响 (秒级提取)

## 相关文件

- `scripts/download-dws-cli.mjs` - 下载脚本
- `electron/utils/dws-cli-installer.ts` - 安装逻辑
- `electron/utils/dws-env-setup.ts` - 环境配置
- `electron/utils/token-storage.ts` - Token 管理
- `electron/main/index.ts` - 应用启动
- `electron-builder.yml` - 打包配置
- `package.json` - 构建命令

## 更新日志

### v1.0.0 (2026-05-13)
- ✅ 实现 DWS CLI 自动安装
- ✅ 集成到打包流程
- ✅ 支持所有主流平台
- ✅ Token 自动保存和环境变量设置
- ✅ 环境变量系统级配置 (Windows setx)
