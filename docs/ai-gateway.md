# AI Gateway 技术文档

## 简介

AI Gateway 是一个运行时调度层，将 AI 调用场景（要问什么）与具体运行时（怎么调）解耦。应用只需声明"我要做简历评估"，Gateway 自动解析配置、选择运行时、检查能力、派发调用。

核心价值：
- **运行时无关**：同一场景可以跑 Claude、Codex、Gemini、HTTP API，切换只需改配置
- **能力检查**：派发前自动验证运行时是否支持场景所需能力（如 `read_file`、`web_search`）
- **统一接口**：`call()` / `stream()` 两个入口覆盖所有场景，上层无需关心运行时差异
- **可移植**：设计为独立模块，可迁移到任何需要调度多种 AI 运行时的项目

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                      应用层                              │
│  resume_eval / chat / portrait / auto_match / ...       │
└───────���────────────────┬────────────────────────────────┘
                         ��� call(scenario, prompt, opts)
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    AI Gateway                            │
│  resolve(scenario) → adapter + model + effort           │
│  checkCapability(adapter, required)                     │
│  dispatch → adapter.call() / adapter.stream()           │
└────────────────────────┬────────────────────────────────┘
                         │
          ┌──────────────┼���─────────────┬─────────────┐
          ▼              ▼              ▼             ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐
    │  Claude  │  │  Codex   │  │  Gemini  │  │ Codex API │
    │  CLI     │  │  CLI     │  │  CLI     │  │  (HTTP)   │
    └──────────┘  └──────────┘  └──────────┘  └───────────┘
```

## 技术原理

### 1. 适配器注册

每个运行时适配器是一个对象，声明自己的名称、能力、模型列表和调用方法：

```javascript
export default {
  name: 'claude',
  capabilities: ['text', 'read_file'],
  models: ['opus', 'sonnet', 'haiku'],
  defaultModel: 'sonnet',
  isAvailable() { /* 检查 CLI 是否存在 */ },
  async call(prompt, opts) { /* ... */ },
  async *stream(prompt, opts) { /* ... */ },
};
```

Gateway 启动时将所有适配器注册到 `adapters` map 中。支持别名（如 `chatgpt` → `codex-api`）。

### 2. 配置解析

每次调��时，Gateway 通过 `resolve(scenario)` 解析运行时配置：

```
config.json
├── ai.default: { runtime, model, effort }     ← 全局默认
└── ai.<scenario>: { runtime, model, effort }  ← 场景覆盖（可选）
```

解析优先级：`overrides 参数` > `ai.<scenario>` > `ai.default`

`runtime: 'auto'` 时读取 `ZYLOS_RUNTIME` 环境变量（默认 `claude`）。
`model: 'auto'` 时使用适配器的 `defaultModel`。

### 3. 能力检查

场景声明所需能力（`required`），Gateway 在派发前验证：

```javascript
checkCapability(adapter, ['text', 'read_file']);
// → 如果 adapter.capabilities 不包含 'read_file'，抛出 Error
```

当前定义的能力：
| 能力 | 含义 | 支持的运行时 |
|------|------|-------------|
| `text` | 文本生成 | 全部 |
| `read_file` | 读取本地文��� | claude, codex, gemini |
| `web_search` | 网络搜索 | codex-api |
| `web_fetch` | 获取网页内容 | codex-api |

### 4. 调用派发

两种模式：

- **`call()`**：完整调用，等待 AI 返回全部文本。返回 `{ text, runtime, model, effort, sessionId }`
- **`stream()`**：流式调用，`AsyncGenerator` 逐块 yield 文本

两者接受相同参数：
```javascript
await call(scenario, prompt, {
  required: ['text', 'read_file'],  // 能力要求
  overrides: { runtime, model, effort },  // 绕过配置
  sessionId: '...',  // 会话恢复（多轮对话）
  readOnlyBinds: ['/path/to/file'],  // 沙箱内额外可读路径
  conversation: { systemPrompt, messages },  // HTTP 运行时多轮对话
});
```

### 5. 运行时探测

`detectRuntimes()` 遍历所有注册适配器，调用 `isAvailable()` 检查 CLI 是否存在（通过 `which` 命���）或凭证是否���效（HTTP 运行时），返回当前系统可用的运行时列表。

### 6. 会话恢复（Session Resume）

CLI 运行时支持通过 session ID 恢复上下文，实现多轮对话复用 KV 缓存：
- Claude: `--resume <session_id>`（JSON output 捕获 `session_id`）
- Codex: `codex exec resume <thread_id>`（JSONL output 捕获 `thread_id`）
- Gemini: `--resume <session_id>`（JSON output 捕获 `session_id`）

HTTP 运行时（codex-api）无状态，通过 `conversation` 参数传递完整对话历史。

## 适配器类型

### CLI 适配��

通过子进程调用本地安装的 AI CLI 工具。特点：
- 利用用户已有的 CLI 订阅（无额外 API 费用）
- 通过 SRT 沙箱隔离文件系统
- 支持 session resume 减少 token 消耗
- 需要本地安装对应 CLI

| 适配器 | CLI | 认证方式 | 默认模型 |
|--------|-----|---------|---------|
| claude | `claude -p` | Max 订阅 OAuth (~/.claude/) | sonnet |
| codex | `codex exec` | OAuth (~/.codex/) 或 OPENAI_API_KEY | gpt-5.4 |
| gemini | `gemini -p` | GEMINI_API_KEY | gemini-2.5-flash |

### HTTP 适配器

直接调用 API，不依赖本地 CLI。特点：
- 无需本地 CLI 安装
- 无文件系统访问能力（天然安全，不需要沙箱）
- 支持服务端工具（web_search）
- 适合纯文本生成和网络搜索场景

| 适配器 | 端点 | 认证方式 | 默认模型 |
|--------|------|---------|---------|
| codex-api | chatgpt.com/backend-api/codex/responses | Codex OAuth token (Pro 订阅) | gpt-5.4 |

## 迁移到其他项目的技术规范

### 最小实现

迁移 AI Gateway 到新项目需要以下组件：

```
src/lib/
├── ai-gateway.js       # 核心调度器（~120 行）
├── config.js           # 配置加载（resolveAiConfig 函数）
└── runtimes/
    └── <adapter>.js    # 至少一个运行时适配器
```

### 适配器接口规范

每个运行��适配器必须实现以下接口：

```javascript
export default {
  // 必需属性
  name: string,                    // 唯一标识符
  capabilities: string[],          // 支持的能力列表
  models: string[],                // 可用模型列表
  defaultModel: string,            // 默认模型

  // 必需方法
  isAvailable(): boolean,          // 检查运行时是否可用
  async call(prompt, opts): { text: string, sessionId?: string },
  async *stream(prompt, opts): AsyncGenerator<string>,
};
```

`opts` 参数结构：
```javascript
{
  model: string,          // 使用的模型
  effort: string,         // 推理力度
  capabilities: string[], // 场景要求的能力
  sessionId?: string,     // 会话恢复 ID
  readOnlyBinds?: string[], // 沙箱内可读路径（仅 CLI 适配器）
  conversation?: object,  // 多轮对话（仅 HTTP 适配器）
  scenario?: string,      // 场景名称（用于工具/安全策略选择）
}
```

### 配置格式规范

```json
{
  "ai": {
    "default": {
      "runtime": "auto",
      "model": "auto",
      "effort": "medium"
    },
    "scenario_name": {
      "runtime": "claude",
      "model": "opus",
      "effort": "high"
    }
  }
}
```

- `runtime: "auto"` 从环境变量 `ZYLOS_RUNTIME` 读取（可自定义变量名）
- `model: "auto"` 使用适配器 `defaultModel`
- 场景覆盖是可选的；未配置的场景使用 `default`

### 迁移步骤

1. **复制核心文件**：`ai-gateway.js` + 所需适配器
2. **实现 `resolveAiConfig()`**：按你的配置格式解析场景→运行时映射
3. **选择适配器**：只保留项目需要的运行时（如只用 Claude 则只需 `claude.js`）
4. **定义场景**：在配置文件中注册项目的 AI 使用场景
5. **（可选）集成沙箱**：如果 CLI 适配器需要文件系统隔离，引入 SRT 层（见 SRT 文��）

### 设计原则

1. **场景驱动**：以场景为中心组织代码，不以运行时为中心
2. **能力声明**：场景声明需求��Gateway 负责匹配，而非场景指定运行时
3. **配置热切换**：运行时选择由配置决定，代码不硬编码
4. **安全内聚**：沙箱/工具限制在适配器内部实现，Gateway 不关心安全细节
5. **失败快速**：能力不匹配、运行时不可用时立即抛错，不静默降级

### CLI 适配器的工具安全

每个 CLI 适配器根据场景限制 AI 可用的工具（最小权限原则）：

| 运行时 | 机制 | 示例 |
|--------|------|------|
| Claude | `--tools "ToolA,ToolB"` 白名单 | `--tools "Read,WebFetch"` |
| Codex | `--disable <feature>` 黑名单 | `--disable shell_tool` |
| Gemini | TOML admin-policy deny 规则 | `toolName = "run_shell_command"` |

工具策略应按场景定义，纯对话场景禁用所有工具，文件读取场景只开放 Read。
