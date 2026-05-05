# SRT Sandbox 技术文档

## 简介

SRT（Sandbox Runtime，`@anthropic-ai/sandbox-runtime`）是 Anthropic 发布的跨平台沙箱库，为 AI CLI 子进程提供内核级别的文件系统和网络隔离。在 zylos-recruit 中，SRT 保护宿主系统免受 prompt injection 攻击—��即使面试对话中的 AI 被恶意 prompt 操纵，也无法访问 `~/zylos/memory/`、`.env`、凭证等敏感数据。

核心特性：
- **跨平台**：Linux 使用 bwrap (bubblewrap) 命名空间隔离，macOS 使用 sandbox-exec (Seatbelt) 策略执行
- **deny-default + whitelist**：默认拒绝全部，按需精确放回
- **fail-closed**：依赖缺失时拒绝执行 AI 调用，不静默降级
- **对调用方透明**：`spawnSandboxed()` 保持与 `spawn()` 一致的接口

## 技术原理

### 整体流程

```
适配器调用
    │
    ▼
spawnSandboxed(cmd, args, opts, sandbox)
    │
    ├── 1. 构建 runtimeConfig（文件策略 + 网络策略）
    ├── 2. 序列化 payload 到 /tmp（JSON）
    ├── 3. spawn sandbox-runner.js（子进程）
    │
    ▼  sandbox-runner.js 内部：
    ├── 4. 读取并删除 payload 文件
    ├── 5. SandboxManager.initialize(runtimeConfig)
    ├── 6. SandboxManager.wrapWithSandbox(command, shell)
    ├── 7. 以 shell 方��� spawn 包裹后的命令
    ├── 8. 转发信号，等待退出
    └── 9. SandboxManager.cleanupAfterCommand()
```

### 文件系统策略

deny-default 策略确保沙箱进程看不到任何非显式允许的路径：

```javascript
{
  filesystem: {
    denyRead: [HOME, ZYLOS_DIR],      // 全面拒绝
    allowRead: [                       // 精确放回
      ...supportPaths,                 // 运行时二进制依赖
      ...srtVendorPaths(),             // SRT 自身 seccomp 二进制
      ...authStatePaths,               // CLI 认证状态
      ...readOnlyPaths,                // 场景数据（如简历文件）
    ],
    allowWrite: [
      ...authStatePaths,               // CLI session 写入
      ...tempWritePaths,               // 临时目录
    ],
  }
}
```

实际效果：

| 路径 | 沙箱内 | 原因 |
|------|--------|------|
| `~/zylos/memory/` | 不可见 | denyRead [ZYLOS_DIR] |
| `~/zylos/.env` | 不可见 | denyRead [ZYLOS_DIR] |
| `~/.claude/` | 可读写 | authStatePaths（session resume 需要） |
| `~/.claude.json` | 只读 | 全局配置，非 session 数据 |
| `/tmp/` | 可写 | 运行时临时文件 |
| 简历文件 | 只读 | 仅 resume_eval 场景，精确到文件 |

### 网络策略

SRT 提供域名级网络白名单（通过 HTTP/SOCKS 代理 + `--unshare-net`）：

```javascript
{
  network: {
    allowedDomains: ['api.anthropic.com', 'api.openai.com', ...],
    deniedDomains: ['metadata.google.internal', '169.254.169.254', 'localhost'],
  }
}
```

当前 zylos-recruit 未启用网络隔离（`network: {}`），因为面试场景需要 WebFetch 访问候选人任意 URL。安全由文件系统隔离兜底——即使 AI 能访问网络，也无法读取到敏感文件用于外泄。

### 命令包裹

SRT 不直接 spawn 进程，而是返回一个包裹后的 shell 命令字符串：

```javascript
const command = shellQuote([cmd, ...args]);
const wrapped = await SandboxManager.wrapWithSandbox(command, 'bash');
spawn(wrapped, { shell: true });
```

包裹后的命令包含 bwrap/sandbox-exec 前缀和所有挂载/策略参数。shell-quote 库确保 prompt 中的特殊字符（空格、引号、`$`、反引号等）不会导致命令注入。

### Per-Scenario 配置

每个适配器在调用 `spawnSandboxed()` 时传入场景特定的 sandbox 对象：

```javascript
spawnSandboxed('claude', args, opts, {
  scenario: 'resume_eval',
  runtime: 'claude',
  authStatePaths: ['~/.claude'],
  readOnlyPaths: ['/path/to/exact/resume.pdf'],
});
```

场景配置矩阵：

| 场景 | 文件访问 | 工具 |
|------|---------|------|
| chat（面试对话） | 无（仅 auth 可写） | WebFetch |
| chat_summary | 无 | 无 |
| portrait | 无 | 无 |
| resume_eval | 简历文件只读 | Read, WebFetch |
| auto_match | 简历文件只读 | Read |
| interview_questions | knowledge/ 只读 | Read, WebFetch |

## 平台差异

### Linux (bwrap)

- `--tmpfs /home`：用空内���文件系统覆盖 /home，宿主文件完全不可见
- `--ro-bind`：按路径将文件/目录以只读方式暴露到沙箱
- `--bind`：按路径以可读写方式暴���
- `--unshare-pid/ipc/uts/cgroup`：PID/IPC/主机名/cgroup 命名空间隔离
- `--unshare-net`：网络命名空间隔离（启用网络策略时）
- `--die-with-parent`：父进程退出时沙箱自动终止
- 支持双层沙箱：SRT bwrap（外层）+ Codex Landlock（内层）共存

### macOS (Seatbelt)

- 使用 sandbox-exec + 生成的 Seatbelt profile
- `(deny default)` 基础 + 允许规则
- 无法创建私有挂载命名空间或 tmpfs
- 目录名可见（可 `ls`），但文件内容不可读
- 不支持 PID namespace
- 不支持嵌套 sandbox-exec（内层会覆盖外层规则）

### 平台策略总结

| | Linux | macOS |
|---|---|---|
| Claude | SRT bwrap 全沙箱 | SRT seatbelt 全沙箱 |
| Codex | SRT bwrap + Codex Landlock（双层） | SRT seatbelt + bypass Codex sandbox（单层） |
| Gemini | SRT bwrap 全沙箱 | SRT seatbelt + `--include-directories` |

## 依赖

| 依赖 | 平台 | 用途 | 缺失行为 |
|------|------|------|---------|
| bwrap (bubblewrap) | Linux | 命名空间隔离 | fail-closed (exit 126) |
| socat | Linux | 网络代理桥接 | 网络隔离不可用 |
| rg (ripgrep) | Linux | SRT 扫描危险路径 | fail-closed |
| sandbox-exec | macOS | Seatbelt 策略执行 | fail-closed |

post-install hook 自动安装 Linux 依赖（apt install bubblewrap socat ripgrep）。macOS sandbox-exec 为系统内置。

## 技术规范（可迁移）

### 集成 SRT 的最小代码结构

```
src/lib/runtimes/
├── sandbox.js          # SRT 集成层：策略构建 + spawnSandboxed()
└── sandbox-runner.js   # 子进程入口：初始化 SRT + 包裹命令 + 信号转发
```

### sandbox.js 核心导出

```javascript
// 构建 SRT 配置
export function buildSandboxRuntimeConfig(cmd, opts, sandbox) → runtimeConfig

// 透明沙箱 spawn
export function spawnSandboxed(cmd, args, opts, sandbox) → ChildProcess

// shell 引用（安全拼接命令）
export function quoteSandboxCommand(cmd, args) → string
```

### sandbox 参数规范

```javascript
{
  scenario: string,          // 场景标识（用于日志和策略选择）
  runtime: string,           // 运行时名称（决定 auth 路径）
  authStatePaths: string[],  // CLI 认证/状态目录（可读写）
  readOnlyPaths: string[],   // 场景数据（只读）
  writePaths: string[],      // 额外可写路径（可选）
  supportReadPaths: string[],// 额外运行时支持路径（可选）
  allowUnsandboxed: boolean, // 沙箱失败时是否允许不沙箱执行（默认 false）
  network: {                 // 网络策略（可选）
    allowedDomains: string[],
    deniedDomains: string[],
  },
}
```

### runtimeConfig 输出结构

```javascript
{
  network: {},                    // 空对象 = 不隔离网络
  filesystem: {
    denyRead: [HOME, PROJECT_DIR],
    allowRead: [...],
    allowWrite: [...],
    denyWrite: [],
    allowGitConfig: false,
  },
  enableWeakerNestedSandbox: false,
  enableWeakerNetworkIsolation: false,
  ripgrep: { command: 'rg' },
  mandatoryDenySearchDepth: 3,
}
```

### 信号与生命周期

sandbox-runner.js 的职责：
1. 读取 payload（JSON 配置），立即删除（避免敏感路径泄露）
2. 初始化 SRT：`SandboxManager.initialize(runtimeConfig)`
3. 包裹命令：`SandboxManager.wrapWithSandbox(command, shell)`
4. spawn shell 进程，继承 stdio
5. 转发 SIGINT/SIGTERM/SIGHUP 给子进程
6. 子进程退出后��用 `SandboxManager.cleanupAfterCommand()`
7. 以子进程的退出码退出

### fail-closed 实现

```javascript
try {
  await SandboxManager.initialize(config);
  wrappedCommand = await SandboxManager.wrapWithSandbox(command, shell);
} catch (err) {
  if (!allowUnsandboxed) {
    process.exit(126);  // 拒绝执行
  }
  // 仅当显式允许时降级为不沙箱执行（开发/测试用途）
  wrappedCommand = command;
}
```

### 迁移到其他项目

1. **安装依赖**：`npm install @anthropic-ai/sandbox-runtime shell-quote`
2. **复制框架**：`sandbox.js` + `sandbox-runner.js`
3. **修改 deny 范围**：将 `HOME`/`ZYLOS_DIR` 替换为你的项目敏感路径
4. **定义场景策略**：按场景声明 `readOnlyPaths` 和工具限制
5. **在适配器中调用**：将原有 `spawn(cmd, args)` 替换为 `spawnSandboxed(cmd, args, opts, sandbox)`

## 关键验证结论（Keypoints）

以下是开发过程中重要的试错和验证结论，移植时应特别注意。

### K1: deny-default 优于 deny-specific

**结论**：必须使用 deny `$HOME` + deny `项目目录`，然后精确 allowRead。不能反过来只 deny 已知敏感路径——因为项目目录会随时新增组件、配置，漏掉一个就是安全漏洞���

**验证**：最初考虑过 Direction B（只 deny memory/、.env 等具体路径），被否决。

### K2: SRT 自身二进制需要 allowRead

**结论**：SRT 的 `apply-seccomp` 二进制在 `node_modules/@anthropic-ai/sandbox-runtime/vendor/` 目录下。��果该目录被 denyRead 覆盖（如安装在 `~/zylos/node_modules/` 下），SRT 初始化会失败（exit 127）。

**修复**：通过 `import.meta.resolve` 动态定位 SRT vendor 目录，加入 allowRead。不硬编码路径。

### K3: commandSupportPaths 必须用目录而非文件

**结论**：bwrap `--ro-bind` 挂载的是路径，如果 $HOME 已被 tmpfs 覆盖，对 `$HOME/.local/bin/claude`（文件级别）做 ro-bind 会失败（挂载点不存在）。必须 bind 其父目录。

**修复**：`commandSupportPaths()` 改为 `path.dirname(resolved)` 而非精确文件路径。

### K4: supportPaths 必须排除项目目录

**结论**：`commandSupportPaths()` 动态解析 CLI 路径。如果 CLI 安装在 `~/zylos/node_modules/.bin/` 下，会动态把 `~/zylos/` 加入 supportPaths → allowRead，破坏 deny-default 保护。

**修复**：`supportPaths` 构建后过滤掉 ZYLOS_DIR 及其子路径。

### K5: macOS 嵌套 sandbox-exec 行为不可预测

**结论**：两层 sandbox-exec 不是简单的规则交集。内层 sandbox-exec 可以覆盖外层的 allow 规则，���致外层明确允许的路径在内层也无法访问。`enableWeakerNestedSandbox: true` 无法解决（OS 层面限制）。

**修复**：macOS 上 Codex 使用 `--dangerously-bypass-approvals-and-sandbox` 禁用其自身 sandbox-exec，SRT seatbelt 作为唯一安全层。

### K6: Codex Landlock 需要 /tmp 可写

**结论**：Linux 上 Codex CLI 的 Landlock 沙箱初始化需要写入 `/tmp` 下的临时文件。如果 SRT 不将 `/tmp` 加入 allowWrite，Landlock 无法初始化 → shell 无法启动 → 所有文件读取场景返回 0 分。

**修复**：sandbox.js 的 `tempWritePaths` 加入 `/tmp`。同时设置 `TMPDIR=/tmp`（macOS 上 Codex 默认 TMPDIR 可能不是 /tmp）。

### K7: `codex exec resume` 不接受 --sandbox 参数

**结论**：`codex exec resume <id> <prompt>` 命令的参数解析与 `codex exec` 不同，传 `--sandbox read-only` 会报 "unexpected argument" 错误。

**修复**：Linux resume 路径不传沙箱参数（SRT bwrap 仍生效），macOS resume 只传 `--dangerously-bypass-approvals-and-sandbox`。

### K8: ~/.claude.json ≠ ~/.claude/

**结论**：`~/.claude.json` 是 Claude Code 全局配置文件（启动次数、功能标记缓存���），与 `~/.claude/` 目录（session 数据）是兄弟关系。Seatbelt 对 `~/.claude` 的子路径规则不覆盖 `~/.claude.json`。

**症状**：macOS 上 Claude CLI 启动时读取 `~/.claude.json` 被 Seatbelt 拦截 → 静默 exit 0，stdout 为空。

**修复**：新增 `runtimeReadOnlyConfigPaths`，将 `.claude.json` 放入 allowRead（不放 allowWrite——全局配置不应被沙箱内进程修改）。

### K9: --allowedTools ≠ 白名单

**结论**：Claude CLI 的 `--allowedTools` 是"权限预批准"（additive），不是白名单。未列出的工具仍可用（只是需要人工确认���。在 `claude -p` 非交互模式下，未预批准的��具自动拒绝——但这依赖于非交互模式，不是工具本身被移除。

**正确做��**：使用 `--tools "ToolA,ToolB"` 做白名单（只有列出的工具可用）。`--tools ""` = 纯对话模式。

### K10: Gemini 策略文件必须是 TOML

**结论**：Gemini CLI Policy Engine 只接受 TOML 格式。之前用 YAML 格式写 admin-policy，所有 deny 规则静默无效——没有报错，也没有拒绝任何工具调用。

**修复**：策略文件改为 TOML 格式 + 正确的工具名称。同时加 `--skip-trust` + `GEMINI_CLI_TRUST_WORKSPACE=true` 解决沙箱 CWD 不被信任的问题。

### K11: ~/.claude 可以安全地以 rw 挂载

**结论**：经三级权限测试验证（2026-05-03），即使 `~/.claude` 以 `--bind`（可写）方式挂载进沙箱：
- `--allowedTools Bash`（非交互 -p 模式）：工具请求被自动拒绝
- `--permission-mode auto`：Claude Code 对 .claude 有特殊写保护
- 唯一绕过方式：`--dangerously-skip-permissions`（recruit 不使用）

CLI 进程自身的 session 数据写入是内部操作不走权限系统，属于正常功能。无需改为 `--ro-bind` + 子目录可写的脆弱方案。

### K12: network: {} 不等于禁用网络

**结论**：SRT 配置中 `network: {}` 表示不配置网络策略（不启用 `--unshare-net`），进程可正常访问网络。只有 `network.allowedDomains` 存在时才触发网络隔离。

之前误传了包含 `allowedDomains` 的 network 配置对象，导致 SRT 启用了 `--unshare-net` + 代理——但代理配置中引用了未定义的 `parentProxy` 变量导致崩溃。改为 `network: {}` 后正常。
