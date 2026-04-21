// Tegata dogfooding hook — classification logic.
//
// Pure functions that map a Claude Code tool call (tool_name + tool_input)
// to a Tegata Action (ActionType string + riskScore). Extracted out of
// `tools/claude-code-hook.mjs` so the heuristics can be unit-tested without
// spinning up a process / importing Tegata's `dist/`.
//
// No side effects, no IO, no imports. Deliberately dependency-free so the
// module can be reused by other harness adapters (LangGraph, OpenAI Agents
// SDK, custom code) later.

/**
 * Classify a Bash command string.
 *
 * @param {string | undefined | null} cmd
 * @returns {{ type: string, riskScore: number }}
 */
export const classifyBash = (cmd) => {
  const c = (cmd ?? "").trim();
  if (/^git\s+push\b.*(--force|-f\b|--force-with-lease)/.test(c))
    return { type: "shell:git:push-force", riskScore: 95 };
  // 71 (not 70) so the default `escalateAbove: 70` — which uses strict `>` —
  // actually trips on a plain `git push`. See PR #15 review.
  if (/^git\s+push\b/.test(c)) return { type: "shell:git:push", riskScore: 71 };
  if (/^git\s+reset\s+--hard\b/.test(c))
    return { type: "shell:git:reset-hard", riskScore: 85 };
  // `git clean` is destructive only when force is present AND dry-run is not.
  // Accept both short `-f` (possibly clustered, e.g. `-fd`, `-fdx`) and long
  // `--force`. Suppress classification when `-n` / `--dry-run` is present —
  // those are preview-only and must not escalate in enforce mode.
  if (
    /^git\s+branch\s+-D\b/.test(c) ||
    (/^git\s+clean\b/.test(c) &&
      /(?:^|\s)(?:--force\b|-[a-z]*f[a-z]*)/.test(c) &&
      !/(?:^|\s)(?:--dry-run\b|-[a-z]*n[a-z]*)/.test(c))
  )
    return { type: "shell:git:destructive", riskScore: 75 };
  if (
    /^git\s+(status|log|diff|show|branch(\s|$)|blame|config\s+--get|remote\s+-v|rev-parse)/.test(
      c,
    )
  )
    return { type: "shell:git:read", riskScore: 5 };
  if (
    /^git\s+(commit|add|checkout|merge|rebase|stash|tag|fetch|pull)\b/.test(c)
  )
    return { type: "shell:git:write", riskScore: 40 };
  // Anchored to start to avoid matching `rm -rf` inside a commit message etc.
  // Handles any number of flag blocks in any order: `rm -rf`, `rm -fr`,
  // `rm -rfv`, `rm -r -f`, `rm -f -v -r`, `rm --recursive`, `sudo rm -rf`.
  // Accept both lowercase `-r` and uppercase `-R` (POSIX recognizes both).
  if (
    /^(?:sudo\s+)?rm\s+(?:-[A-Za-z]+\s+)*(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?:\s|$)/.test(
      c,
    )
  )
    return { type: "shell:fs:delete-recursive", riskScore: 85 };
  if (
    /^(ls|cat|head|tail|pwd|echo|which|whoami|hostname|uname|date|env|wc|file)\b/.test(
      c,
    ) &&
    // Bail out if the command contains shell output redirection — `echo x >
    // ~/.bashrc` writes to disk, so it's not a read. Covers `>`, `>>`, `&>`,
    // `2>`, `2>>`. Accepts false positives (`ls | grep >file` etc. fall to
    // generic) in exchange for never mislabeling a write as a read.
    !/(?:^|[^0-9])(?:&>|[0-9]*>)/.test(c) &&
    // Also bail out on any shell composition — `&&`, `||`, `;`, `|`, single
    // background `&`, command / process substitution (`$(...)`, `<(...)`,
    // backticks), or newlines. `cat x && rm y` has a read prefix but is not
    // safe to classify as a read; fall through to generic so the riskScore
    // stays at 30 rather than 5.
    !/(?:&&|\|\||;|\|)/.test(c) &&
    // Single `&` (background) — but not `&&` or `&>`/`&>>` redirection
    // which are handled above. `(?:^|[^&])&(?![>&])` matches a bare `&`.
    !/(?:^|[^&])&(?![>&])/.test(c) &&
    !/(?:\$\(|<\(|`|\n)/.test(c)
  )
    return { type: "shell:read:query", riskScore: 5 };
  if (/^(npm|pnpm|yarn|npx)\s+(run\s+)?(test|typecheck|lint|build)\b/.test(c))
    return { type: "shell:test:run", riskScore: 10 };
  if (
    /^(npm|pnpm|yarn)\s+(publish|install|i\b|ci\b|add|uninstall|remove)\b/.test(
      c,
    )
  )
    return { type: "shell:pkg:mutate", riskScore: 55 };
  if (/^gh\s+(pr\s+create|pr\s+merge|release\s+create)\b/.test(c))
    return { type: "shell:gh:write", riskScore: 50 };
  // `gh api` with a mutating method or field flag is a write, not a read.
  // Must run before the generic `gh api` read rule below.
  if (
    /^gh\s+api\b/.test(c) &&
    /(?:\s(?:-X|--method)\s+(?!GET\b)\w+|\s(?:-f|-F|--field|--raw-field)\b)/i.test(
      c,
    )
  )
    return { type: "shell:gh:write", riskScore: 50 };
  if (
    /^gh\s+(pr\s+view|pr\s+list|pr\s+diff|run\s+view|issue\s+view|api\s+)/.test(
      c,
    )
  )
    return { type: "shell:gh:read", riskScore: 10 };
  if (/^(curl|wget)\b/.test(c))
    return { type: "shell:net:curl", riskScore: 30 };
  return { type: "shell:exec:generic", riskScore: 30 };
};

/**
 * Classify an MCP tool name (`mcp__<server>__<operation>`).
 *
 * @param {string} toolName
 * @returns {{ type: string, riskScore: number }}
 */
export const classifyMcp = (toolName) => {
  const parts = toolName.split("__");
  const server = parts[1] ?? "unknown";
  const op = parts.slice(2).join("_") || "unknown";
  // Negative lookahead `(?![a-z])` prevents `list` matching `listen` or
  // `find` matching `findAndReplace` (camelCase / snake_case boundary is OK
  // — `_`, `-`, uppercase all fall outside `[a-z]`). No `/i` flag: under
  // case-insensitive matching `[a-z]` would also match uppercase, which
  // would reject `getBoard` / `findAndReplace`. MCP ops use lowercase-
  // initial verbs by convention, so dropping `/i` is safe.
  const isRead = /^(read|list|search|fetch|get|ls|find)(?![a-z])/.test(op);
  return {
    type: `mcp:${server}:${isRead ? "read" : "write"}`,
    riskScore: isRead ? 10 : 40,
  };
};

/**
 * Classify any Claude Code tool call.
 *
 * @param {string | undefined | null} toolName
 * @param {Record<string, unknown> | undefined | null} toolInput
 * @returns {{ type: string, riskScore: number }}
 */
export const classify = (toolName, toolInput) => {
  switch (toolName) {
    case "Read":
    case "Glob":
    case "Grep":
      return { type: `read:fs:${toolName.toLowerCase()}`, riskScore: 5 };
    case "Edit":
    case "MultiEdit":
      return { type: "write:fs:edit", riskScore: 40 };
    case "Write":
      return { type: "write:fs:write", riskScore: 45 };
    case "NotebookEdit":
      return { type: "write:fs:notebook", riskScore: 40 };
    case "Bash":
      return classifyBash(
        /** @type {string | undefined} */ (toolInput?.["command"]),
      );
    case "WebFetch":
    case "WebSearch":
      return { type: `web:${toolName.toLowerCase()}:request`, riskScore: 20 };
    case "Task":
    case "Agent":
      return { type: "agent:subagent:spawn", riskScore: 30 };
    case "TodoWrite":
      return { type: "meta:todo:write", riskScore: 5 };
    case "Skill":
      return { type: "meta:skill:invoke", riskScore: 15 };
    default:
      if (toolName?.startsWith("mcp__")) return classifyMcp(toolName);
      return { type: `unknown:${toolName ?? "null"}:exec`, riskScore: 30 };
  }
};
