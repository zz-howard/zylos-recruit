# AI Sandbox Isolation — Technical Guide

zylos-recruit 的 AI 调用（面试对话、简历评估、画像生成等）通过沙箱隔离执行，防止 prompt injection 攻击访问宿主系统敏感数据。本文档说明隔离机制的设计、当前配置和使用方法。

## 三层防护架构

AI 子进程受三个独立安全层保护，每层互不依赖：

```
┌─────────────────────────────────────────────────────┐
│  Layer 3: Claude Code 权限层                         │
│  AI agent 通过工具操作文件/命令时，Claude Code 的      │
│  内置权限系统拦截未授权操作。即使文件系统可写，         │
│  AI 也无法绕过权限审批直接操作文件。                    │
├─────────────────────────────────────────────────────┤
│  Layer 2: 工具权限控制                                │
│  --disallowedTools 从 AI 的可用工具列表中移除危险工具   │
│  --allowedTools 预批准特定工具跳过权限确认              │
├─────────────────────────────────────────────────────┤
│  Layer 1: SRT 文件系统沙箱                            │
│  bwrap (Linux) / sandbox-exec (macOS) 在内核层面      │
│  隔离文件系统。deny-default + whitelist，宿主敏感       │
│  目录对沙箱进程完全不可见。                            │
└─────────────────────────────────────────────────────┘
```

三层各自独立生效。任何一层被绕过，其余两层仍然保护系统。

## Layer 1: SRT 文件系统沙箱

### 原理

基于 `@anthropic-ai/sandbox-runtime` (SRT)。Linux 使用 bwrap (bubblewrap) 的 Linux namespace 隔离，macOS 使用 sandbox-exec (Seatbelt) 的策略强制执行。

### 文件系统策略：deny-default + whitelist

```javascript
// sandbox.js — buildSandboxRuntimeConfig()
filesystem: {
  denyRead: [HOME, ZYLOS_DIR],        // 默认拒绝整个 $HOME 和 ~/zylos
  allowRead: [                         // 按需放回
    ...supportPaths,                   // 运行时依赖（node/nvm/npm 等）
    ...srtVendorPaths(),               // SRT 自身的 seccomp 二进制
    ...authStatePaths,                 // CLI 认证状态（~/.claude 等）
    ...readOnlyPaths,                  // 场景特定数据（如简历文件）
  ],
  allowWrite: [
    ...authStatePaths,                 // CLI 认证状态（需要写入 session 数据）
    ...tempWritePaths,                 // 临时目录
  ],
}
```

实际效果：

| 路径 | 沙箱内可见性 | 说明 |
|------|-------------|------|
| `~/zylos/memory/` | 不可见 | 被 denyRead [ZYLOS_DIR] 覆盖 |
| `~/zylos/.env` | 不可见 | 同上 |
| `~/zylos/components/*/config.json` | 不可见 | 同上 |
| `~/.claude/` | 可读可写 | authStatePaths，CLI 需要读写认证和 session |
| `/usr/`, `/bin/`, `/etc/` | 只读 | 系统路径 |
| `/tmp/zylos-recruit-sandbox/` | 可写 | 沙箱临时目录 |
| 简历文件（仅 resume_eval） | 只读 | readOnlyPaths 精确到文件 |

### ~/.claude 目录的安全性

`~/.claude` 以 `--bind`（可写）挂载进沙箱。经三级权限测试验证安全（2026-05-03）：

| 测试 | 结果 | 说明 |
|------|------|------|
| `--allowedTools Bash`（非交互模式） | 写入被拦截 | `-p` 模式无用户批准，工具请求被拒绝 |
| `--permission-mode auto` | 写入被拦截 | Claude Code 对 `.claude` 有特殊保护 |
| `--dangerously-skip-permissions` | 写入成功 | 唯一绕过方式 |

**结论**：recruit 不传 `--dangerously-skip-permissions`，因此 AI agent 无法通过工具写入 `.claude`。CLI 进程自身的写入（session 数据、history）是内部操作不走权限系统，属于正常功能所需。

### Linux bwrap 关键机制

- `--tmpfs /home`：在 /home 挂载临时内存文件系统，宿主 /home（含 ~/zylos/memory/）完全不可见
- `--ro-bind`：按需将特定路径以只读方式暴露到沙箱
- `--bind`：按需将特定路径以可读写方式暴露
- `--unshare-pid/ipc/uts/cgroup`：PID/IPC/主机名/cgroup 命名空间隔离
- `--die-with-parent`：父进程退出时沙箱进程自动终止

### macOS Seatbelt 差异

macOS 使用 sandbox-exec 策略，`(deny default)` 作为基础。与 bwrap 的差异：

- 无法创建私有挂载命名空间或伪空 home
- 目录名可见（可以 `ls` 看到目录名），但文件内容不可读
- 不支持 PID namespace
- 策略是规则匹配，非命名空间隔离

### 依赖

| 依赖 | 平台 | 用途 | 缺失行为 |
|------|------|------|---------|
| bwrap | Linux | 命名空间沙箱 | fail-closed |
| socat | Linux | 网络代理桥接（启用网络隔离时） | 网络代理失败 |
| rg (ripgrep) | Linux | SRT 扫描危险文件并添加 deny mount | fail-closed |
| sandbox-exec | macOS | Seatbelt 策略执行 | fail-closed |

post-install hook 自动安装 bwrap、socat、rg（Linux apt）。macOS 的 sandbox-exec 是系统内置。

## Layer 2: 工具权限控制

### 两个参数的区别（关键）

Claude CLI 的 `--allowedTools` 和 `--disallowedTools` 语义完全不同：

| 参数 | 语义 | 效果 |
|------|------|------|
| `--allowedTools` | 权限预批准（additive） | 将指定工具加入"免审批"列表，跳过用户确认。**不是白名单**，不传的工具仍然可用（只是需要权限确认） |
| `--disallowedTools` | 工具移除（subtractive） | 将指定工具从 AI 的可用工具列表中完全移除，AI 无法使用 |

在 `claude -p`（非交互模式）下：
- 未被 `--allowedTools` 预批准的工具 → 权限请求被自动拒绝（无用户可批准）
- 被 `--disallowedTools` 移除的工具 → AI 完全看不到该工具

**实际含义**：必须同时使用两个参数——`--disallowedTools` 移除危险工具，`--allowedTools` 预批准需要的工具。

### 当前配置

```javascript
// claude.js
const DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebSearch', 'Agent'];
const ALLOWED_TOOLS = ['WebFetch', 'Read'];
```

所有场景统一应用，在 `call()` 和 `stream()` 中：

```javascript
args.push('--allowedTools', ALLOWED_TOOLS.join(','));
args.push('--disallowedTools', DISALLOWED_TOOLS.join(','));
```

### 工具分类

| 工具 | 状态 | 理由 |
|------|------|------|
| Bash | 移除 | 命令执行能力，最高风险 |
| Edit | 移除 | 文件修改 |
| Write | 移除 | 文件创建/覆盖 |
| NotebookEdit | 移除 | Notebook 修改 |
| WebSearch | 移除 | 搜索引擎调用（难以控制搜索内容） |
| Agent | 移除 | 子代理派生（可能绕过限制） |
| **Read** | **保留 + 预批准** | 文件读取（受 SRT 文件系统隔离保护，只能读到 allowRead 路径） |
| **WebFetch** | **保留 + 预批准** | HTTP 获取（用于读取候选人 GitHub/博客/JD 链接） |

### 不支持通配符

`--disallowedTools "*"` 或 `"all"` 无效。必须逐个列出工具名。

### 其他运行时

| 运行时 | 工具限制机制 |
|--------|-------------|
| Claude CLI | `--disallowedTools` + `--allowedTools`（已实现） |
| Codex CLI | `--sandbox read-only`（Codex 自有沙箱机制） |
| Gemini CLI | `-y` 自动确认（待验证工具限制能力） |
| ChatGPT (HTTP) | HTTP API 调用，无工具定义（天然安全） |

## Layer 3: Claude Code 权限层

Claude Code 自身的权限系统提供兜底保护。即使前两层配置有误：

- AI 尝试使用被权限系统保护的操作时，需要用户确认
- `claude -p` 非交互模式下，未预批准的操作自动拒绝
- `.claude` 目录有特殊保护，`--permission-mode auto` 也不放行写入
- 只有 `--dangerously-skip-permissions` 才能完全绕过（recruit 不使用此参数）

## 网络隔离（可选能力）

### 机制

SRT 提供基于代理的网络域名白名单：

1. bwrap 使用 `--unshare-net` 完全隔离网络命名空间
2. SRT 启动 HTTP/SOCKS 代理，通过 socat 桥接 Unix socket
3. 沙箱内设置 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量指向代理
4. 代理只转发白名单域名的请求，其余拒绝

### 配置方式

```javascript
// sandbox.js — networkConfig()
network: {
  allowedDomains: [
    'api.anthropic.com',
    'api.openai.com',
    'generativelanguage.googleapis.com',
    '*.googleapis.com',
  ],
  deniedDomains: [
    'metadata.google.internal',
    '169.254.169.254',   // GCP metadata endpoint — 防止 SSRF
    '127.0.0.1',
    'localhost',
  ],
}
```

### 当前状态

**zylos-recruit 当前未启用网络隔离**（2026-05-03 决策）。原因：面试场景需要 WebFetch 访问候选人的任意 URL（GitHub、博客、JD 链接等），域名白名单无法覆盖所有可能的候选人链接。

安全由 Layer 1（文件系统隔离，AI 无法读取敏感文件用于外泄）和 Layer 2（工具限制，Bash 不可用）保障。

### 启用网络隔离

在 `buildSandboxRuntimeConfig()` 返回值中加入 `network` 字段即可启用：

```javascript
return {
  network: networkConfig(sandbox.network),  // 取消注释即可启用
  filesystem: { ... },
  ...
};
```

或在 `config.json` 中配置：

```json
{
  "ai": {
    "sandbox": {
      "network": {
        "allowedDomains": ["api.anthropic.com", "api.openai.com"]
      }
    }
  }
}
```

**适用场景**：不需要访问外部网站的 AI 调用（如纯文本生成、内部数据分析）。对于 zylos-cutie 等面向外部的组件，如果 AI 不需要 web 访问，应启用网络隔离。

### SRT 网络隔离触发条件

```javascript
// SRT sandbox-manager.js
const hasNetworkConfig = customConfig?.network?.allowedDomains !== undefined;
const needsNetworkRestriction = hasNetworkConfig;
```

只要 `allowedDomains` 字段存在（即使为空数组 = 阻断所有网络），就会启用 `--unshare-net`。不配置该字段 = 不隔离网络。

## Per-Scenario 配置矩阵

| 场景 | 文件访问 | 工具 | 网络 | Session Resume |
|------|---------|------|------|----------------|
| chat（面试对话） | 无（仅 ~/.claude 可写） | Read, WebFetch | 开放 | ✅ 需要 |
| chat_summary | 无 | Read, WebFetch | 开放 | ❌ |
| portrait | 无 | Read, WebFetch | 开放 | ❌ |
| resume_eval | 简历文件只读 | Read, WebFetch | 开放 | ❌ |
| auto_match | 简历文件只读 | Read, WebFetch | 开放 | ❌ |
| interview_questions | knowledge/ 只读 | Read, WebFetch | 开放 | ❌ |

所有场景共享同一 DISALLOWED_TOOLS 列表。文件访问通过 `readOnlyPaths` 参数 per-scenario 配置。

## 代码结构

```
src/lib/runtimes/
├── sandbox.js          # SRT 集成层：文件系统策略构建、spawnSandboxed()
├── claude.js           # Claude CLI 适配器：工具权限配置（ALLOWED/DISALLOWED_TOOLS）
├── codex.js            # Codex CLI 适配器
├── gemini.js           # Gemini CLI 适配器
├── chatgpt.js          # ChatGPT HTTP 适配器（无沙箱，API 调用）
└── sandbox-runner.js   # SRT 进程兼容层（shell 命令包装、信号转发、清理）
```

## 添加新场景

1. 在 `config.js` 的 scenarios 中注册新场景名
2. 在调用 `gwCall()` / `gwStream()` 时传入 `scenario` 和 `readOnlyPaths`
3. 如果需要读取文件：`required: ['text', 'read_file']`，并传 `readOnlyBinds: [精确文件路径]`
4. 如果是纯文本：`required: ['text']`，不传 readOnlyBinds
5. 工具权限自动应用（ALLOWED_TOOLS / DISALLOWED_TOOLS）
6. 文件系统策略自动构建（deny-default + scenario readOnlyPaths）

## 验证清单

- [ ] 面试对话中执行 `cat ~/zylos/memory/state.md` → 文件不可见
- [ ] 面试对话中执行 `ls $HOME` → 只看到 re-bind 的空目录名
- [ ] 面试对话中尝试使用 Bash → AI 工具列表中无 Bash
- [ ] 面试对话中尝试使用 WebFetch → 成功访问外部 URL
- [ ] 简历评估中读取指定简历 → 成功
- [ ] 简历评估中读取其他文件 → 失败
- [ ] 多轮对话 session resume → 成功
- [ ] 服务重启后功能正常

## 参考

- SRT 源码：`node_modules/@anthropic-ai/sandbox-runtime/`
- Phase 2 设计文档：`docs/srt-sandbox-runtime-design.md`
- bwrap 文档：https://github.com/containers/bubblewrap
- 决策记录：`~/zylos/memory/reference/decisions.md` — "zylos-recruit Sandbox" 条目
