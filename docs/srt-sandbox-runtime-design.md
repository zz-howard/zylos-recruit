# SRT Sandbox Runtime Design

This document is the Phase 2 design for replacing the current Linux-only
`src/lib/runtimes/sandbox.js` bwrap wrapper with
`@anthropic-ai/sandbox-runtime`.

The goal is to protect external-facing interview AI calls from prompt injection
that tries to read Zylos memory, configuration, credentials, component data, or
other host files.

## Requirements

- Deny by default. A sandboxed subprocess should see no Recruit or Zylos data
  unless the specific scenario explicitly allows it.
- Use per-scenario file policy. `spawnSandboxed()` already accepts a per-call
  `sandbox` object; callers must pass the minimal file access needed for that
  scenario.
- Fail closed. If a sandbox is required and dependencies are missing, refuse to
  run the subprocess. Silent fallback to unsandboxed spawn is not acceptable for
  interview AI.
- Support Linux and macOS. Linux uses bwrap through SRT. macOS uses Seatbelt via
  `sandbox-exec`; this is policy enforcement, not namespace or mount isolation.
- Restrict network egress to AI provider endpoints and explicitly deny local
  metadata endpoints.
- Preserve the existing `spawnSandboxed(cmd, args, opts, sandbox)` call shape
  for Claude, Codex, and Gemini runtime adapters.
- Treat SRT's shell-wrapped command string as an integration risk. The
  compatibility layer must handle argv quoting, stdio/env passthrough,
  exit/signal behavior, kill/abort behavior, and cleanup timing explicitly.

## Threat Model

Prompt content may contain hostile instructions. The model/CLI may call tools or
read files if the runtime permits it. The sandbox must assume the CLI runtime
can be tricked and must enforce the final boundary below the CLI.

Protected data includes:

- `~/zylos/memory/`
- `~/zylos/.env`
- `~/zylos/components/*/config.json`
- `~/zylos/components/*` data outside the exact scenario input
- shell, SSH, GitHub, cloud, and local agent credentials
- other component data and logs not explicitly needed by Recruit

The sandbox does not attempt to protect data that is already in the prompt.
For interview chat, company context is prompt-provided and no file access is
needed.

## Scenario Policies

All policies share the same network allowlist and dependency behavior. File
policy is selected by the caller's scenario.

| Scenario | Required file access | Policy |
| --- | --- | --- |
| `chat` / interview chat | None | No read access to `~/zylos`. Runtime auth/state only. |
| `chat_summary` | None | Same as chat; summaries are prompt-provided. |
| `portrait` | None | Same as chat; source summaries are prompt-provided. |
| `resume_eval` | Specific resume file only | Read-only access to that absolute resume file. |
| `auto_match` | Specific resume file only | Same as resume evaluation. |
| `interview_questions` | Knowledge directory only, plus specific resume file only if the prompt asks the runtime to read a resume | Read-only access to `knowledge/` when configured, and to the exact resume file when present. |

Existing code currently passes `RESUMES_DIR` for resume-related scenarios. The
implementation should narrow that to the exact resume file where possible. If a
runtime cannot read a single file because it needs parent directory traversal,
allow the parent directory for metadata traversal but deny reads of all sibling
files. On macOS, Seatbelt directory name visibility is acceptable; file content
read is not.

## Sandbox Config Shape

Keep `spawnSandboxed(cmd, args, opts, sandbox)` but make `sandbox` explicit:

```js
{
  scenario: 'chat' | 'resume_eval' | 'auto_match' | 'chat_summary' | 'portrait' | 'interview_questions',
  runtime: 'claude' | 'codex' | 'gemini',
  authStatePaths: ['/Users/howard/.claude'],
  readOnlyPaths: ['/Users/howard/zylos/components/recruit/resumes/file.pdf'],
  allowUnsandboxed: false,
  network: {
    allowedDomains: ['api.anthropic.com', 'api.openai.com'],
    deniedDomains: ['metadata.google.internal', '169.254.169.254']
  }
}
```

Backward compatibility fields (`rwBinds`, `roBinds`, `minimalFS`) can be
accepted temporarily and mapped internally:

- `rwBinds` becomes `authStatePaths`
- `roBinds` becomes `readOnlyPaths`
- `minimalFS` is ignored because SRT policy is always deny-default in this
  integration

Adapters should move to the explicit fields during the implementation PR.

## File Policy Construction

The SRT read model is deny-list plus allow-back, so the Recruit integration must
generate a deny-default policy:

```js
filesystem: {
  denyRead: [HOME, '/Users/howard/zylos'],
  allowRead: [
    runtime binary/support paths,
    runtime authStatePaths,
    ...scenario readOnlyPaths
  ],
  allowWrite: [
    runtime authStatePaths,
    recruit-owned temp/output paths
  ],
  denyWrite: [],
  allowGitConfig: false
}
```

The deny roots should be broad and stable: deny `$HOME` and `~/zylos`, then
allow back only what the runtime needs. This avoids a blacklist that misses new
component directories as Zylos evolves.

`denyWrite` should not repeat `$HOME` or `~/zylos` in this integration. SRT's
write policy is already allow-only once `allowWrite` is present, and broad
write denies can block runtime auth/state paths that are intentionally allowed
back under the denied home directory. SRT still adds its mandatory dangerous
write denies internally.

Runtime support paths are platform-specific and should be minimal:

- Node/npm cache and global binaries only if required by the CLI
- CLI-specific auth/state directories:
  - Claude: `~/.claude`
  - Codex: `~/.codex`
  - Gemini: `~/.gemini`
- temporary directories needed for process execution and logs

The implementation should log the scenario and high-level policy shape, but not
dump sensitive absolute path lists in UI-facing responses.

## Platform Behavior

### Linux

SRT uses bwrap and requires `bwrap`, `socat`, and `rg`. With network
restrictions enabled, it uses `--unshare-net` and bridges allowed egress through
local HTTP/SOCKS proxies. This is stronger than the current `--share-net`
wrapper.

Secure mode should be the default:

- `--unshare-pid` with fresh `/proc`
- read/write restrictions from the generated policy
- optional bundled `apply-seccomp` for AF_UNIX socket creation blocking when
  available

If SRT reports missing Linux dependencies, interview AI subprocess execution
fails unless `allowUnsandboxed` is explicitly true.

### macOS

SRT uses `sandbox-exec` and generated Seatbelt profiles.

Expected behavior:

- deny default profile
- deny reads from `$HOME` and `~/zylos`
- allow reads only for runtime support/auth paths and scenario input paths
- allow writes only for runtime auth/state and temp paths
- route network through SRT proxy ports

Known limitation: macOS Seatbelt cannot create a private mount namespace, fake
empty home, read-only bind mount view, private `/dev`, or PID namespace.
Implementation logs and documentation should describe this as "macOS Seatbelt
sandbox" rather than "bwrap-equivalent sandbox."

`enableWeakerNetworkIsolation` should remain false unless a specific Go-based
tool failure is accepted as a security tradeoff.

## Network Policy

Network access should be allow-only. Default allowlist:

- `api.anthropic.com`
- `console.anthropic.com` only if the Claude CLI needs it for subscription auth
- `api.openai.com`
- `chatgpt.com`
- `auth.openai.com`
- `generativelanguage.googleapis.com`
- `*.googleapis.com` only if needed by Gemini CLI

Default denylist:

- `metadata.google.internal`
- `169.254.169.254`
- `127.0.0.1`
- `localhost`
- private RFC1918 ranges where SRT supports host matching

SRT validates hostnames and routes HTTP/SOCKS traffic through its proxy. On
Linux, direct egress is blocked by `--unshare-net`. On macOS, direct egress is
blocked by Seatbelt network rules. Tools that ignore proxy environment variables
should fail closed.

The implementation can make this list configurable under `ai.sandbox.network`,
but the built-in defaults must be safe.

## `spawnSandboxed()` Compatibility Layer

SRT's library does not spawn directly; it returns a shell-quoted command string.
The compatibility layer should:

1. Build the raw command using `shell-quote.quote([cmd, ...args])`.
2. Initialize SRT once per process or per config generation.
3. Call `SandboxManager.wrapWithSandbox(command, shellName, customConfig)`.
4. Spawn the returned command with `{ shell: true, env, stdio }`.
5. Attach cleanup so `SandboxManager.cleanupAfterCommand()` runs on `close`,
   `error`, and timeout/kill paths.
6. Preserve the existing child process surface used by adapters:
   `stdout`, `stderr`, `on('error')`, `on('close')`, and `kill(signal)`.

Quoting requirements:

- arguments are never concatenated manually
- prompts with spaces, quotes, newlines, dollar signs, semicolons, backticks,
  and Unicode are passed as a single argv item to the target CLI
- model config arguments such as `-c model="gpt-5.4"` are preserved exactly

Signal behavior:

- adapter timeouts call `child.kill('SIGTERM')`
- the compatibility child should forward the signal to the shell process
- the close event should expose the same code/signal shape as Node spawn
- if a timeout rejects first, a later close should not reject again

Stdio/env behavior:

- pass caller-provided `stdio` through unchanged
- pass caller-provided `env` through, after removing provider API keys where
  adapters already do that
- SRT adds proxy env vars inside the sandboxed command; callers should not
  depend on host proxy env leaking through

Cleanup:

- call `cleanupAfterCommand()` exactly once per spawned command
- call `reset()` only during process shutdown or tests, not after every command,
  because proxy servers can be reused

## Fail-Closed and Dev Escape Hatch

Default behavior:

- unsupported platform: throw
- missing `sandbox-exec` on macOS: throw
- missing `bwrap`, `socat`, or `rg` on Linux: throw
- SRT initialization failure: throw

Optional dev/test behavior:

```json
{
  "ai": {
    "sandbox": {
      "allowUnsandboxed": false
    }
  }
}
```

If `allowUnsandboxed` is true, the code may spawn without SRT but must log a
clear warning containing scenario, runtime, and platform. This flag should not
be enabled by post-install defaults.

## Dependency and Install Changes

Add npm dependency:

```json
"@anthropic-ai/sandbox-runtime": "0.0.49"
```

Post-install should no longer suggest Homebrew bwrap on macOS. It should:

- check `sandbox-exec` on macOS and warn if missing
- check `bwrap`, `socat`, and `rg` on Linux
- explain that interview AI will fail closed until required dependencies are
  installed
- keep Linux bwrap messaging, but mention that SRT is the wrapper that uses it

## Testing Plan

Unit or focused integration tests should cover:

- `buildSandboxPolicy('chat')` denies `$HOME`/`~/zylos` and has no scenario
  read paths
- `resume_eval` allows only the exact resume file
- `interview_questions` allows only configured knowledge paths and exact resume
  file when present
- missing dependencies throw when `allowUnsandboxed` is false
- missing dependencies spawn unsandboxed with a warning when
  `allowUnsandboxed` is true
- command quoting preserves argv containing spaces, quotes, newlines, `$`,
  semicolons, and backticks
- stdout/stderr streaming still works for Claude/Codex/Gemini adapters
- non-zero exit code and signal/timeout behavior match current adapter
  expectations
- `cleanupAfterCommand()` is called once per command

Manual checks:

- Linux: try to read `~/zylos/memory/state.md` from a chat scenario and verify
  denial
- macOS: same read denial under Seatbelt
- resume evaluation: verify the selected resume file can be read and a sibling
  resume cannot
- network: allowed AI endpoint succeeds; `metadata.google.internal` and
  `169.254.169.254` fail

## Implementation Order

1. Add SRT dependency and sandbox config helpers.
2. Replace `sandbox.js` internals with SRT-backed compatibility wrapper while
   preserving exported `spawnSandboxed()`.
3. Update runtime adapters to pass explicit scenario/runtime/auth/read policy.
4. Narrow resume-related call sites from `RESUMES_DIR` to exact resume file when
   possible.
5. Update post-install dependency diagnostics.
6. Add tests for policy generation and command wrapping.
7. Run `npm test`, syntax checks, and targeted manual sandbox checks.
