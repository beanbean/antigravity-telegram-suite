<!-- agts-memory:v1 -->
## Project Memory

> [!IMPORTANT]
> **MANDATORY AGENT ROUTINE**: Every time you complete a task that involves modifying code, you MUST update this file (\`AGENT.md\`) before ending your turn. Do NOT ask for permission.
> 1. **Decisions**: Add non-obvious design choices.
> 2. **Gotchas**: Add framework quirks, API weirdness, or system limits you discovered.
> 3. **Fixes**: Briefly summarize the root cause of hard-to-solve bugs.

**Context Window Management**
To keep this file effective, routinely prune outdated info. Edit existing lines instead of adding duplicates. Consolidate long sections.

### Decisions
- Migrated from Mindsync MCP to File-based `AGENT.md` memory convention (`src/memory_convention.js`) for keeping cross-agent project memory in sync.
- Formulated full architecture plan to decouple Standalone Agent (2.0) and Classic IDE into separate Drivers (`IDEDriver` & `StandaloneDriver`) and Locators to eliminate regression side-effects.


### Conventions

### Gotchas
- ⚠️ **Gotcha: Task Watcher & Telegraph Misses Background Artifacts in Multi-Tab IDE** — CRITICAL: The Telegram Bot's `TaskWatcher` dynamically attaches `fs.watch` ONLY to the active conversation tab in the IDE (resolved via `CDP`). If a user switches to a different tab while an AI agent is generating an artifact in the background for the previous tab, the `TaskWatcher` will NOT see the file creation. Consequently, the artifact won't be pushed to Telegraph automatically. **Workaround**: Tell the user to bring the tab back into focus, or manually invoke the Telegraph publisher.

### Fixes
- Added safe process termination (`killIDE()`) for the non-selected application when the preferred app is switched via the Telegram menu to prevent zombie processes blocking CDP endpoints.
- Fixed 90-second delay during Google OAuth login on Mac (Safari/Chrome keep-alive behavior) by forcing `server.closeAllConnections()` in `src/account_manager.js`.
- Fixed `/agents` command silent failure by safely escaping HTML characters (`<`, `>`, `&`), truncating long titles, and auto-chunking messages under Telegram's 4096-char limit (`renderAndSendAgentThreads` in `src/index.js`).
<!-- /agts-memory -->
