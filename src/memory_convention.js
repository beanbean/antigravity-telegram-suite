// Opt-in: on workspace switch, ensure the project has a lightweight, agent-agnostic
// memory convention block — no MCP server, no vector DB, just a markdown section
// agents edit directly. Enable with AUTO_MEMORY_CONVENTION=true in .env.

const fs = require('fs');
const path = require('path');

const MARKER_START = '<!-- agts-memory:v1 -->';
const MARKER_END = '<!-- /agts-memory -->';

const POINTER_START = '<!-- agts-pointer:v1 -->';
const POINTER_END = '<!-- /agts-pointer -->';

// Files that should point to AGENT.md if they exist
const POINTER_FILES = ['CLAUDE.md', 'GEMINI.md', '.cursorrules', '.windsurfrules'];
const DEFAULT_FILE = 'AGENT.md';

const POINTER_BLOCK = `${POINTER_START}
> [!IMPORTANT]
> **The source of truth for this project is \`AGENT.md\`. Read it first.**
> Do not add new rules or memory to this file — write them in \`AGENT.md\`.
>
> Anything below this line is **legacy** and may be stale or contradict
> \`AGENT.md\`. When the two disagree, \`AGENT.md\` wins. If you rely on
> something from below, move it into \`AGENT.md\` first so the next agent
> finds it in the right place.
${POINTER_END}
`;

const BLOCK = `${MARKER_START}
## Project Memory

> [!IMPORTANT]
> **MANDATORY AGENT ROUTINE**: Every time you complete a task that involves modifying code, you MUST update this file (\`AGENT.md\`) before ending your turn. Do NOT ask for permission.
> 1. **Decisions**: Add non-obvious design choices.
> 2. **Gotchas**: Add framework quirks, API weirdness, or system limits you discovered.
> 3. **Fixes**: Briefly summarize the root cause of hard-to-solve bugs.

> [!WARNING]
> **WHERE to write — this is the rule agents get wrong.**
> Write **INSIDE this block**, under the matching \`###\` heading below.
> Do **NOT** append to the end of the file. Anything placed after
> \`${MARKER_END}\` sits outside the managed region: tooling that reads this
> block will not see it, and the headings below will keep claiming they are
> empty while content piles up underneath.
> If you find stray entries after the end marker, **move them into the right
> section** as part of your turn.

**How to write an entry**
- One line per entry, prefixed with the date: \`- (YYYY-MM-DD) ...\`.
  Without a date nobody can tell what is stale, and the pruning rule below
  becomes unenforceable.
- Write the **rule**, not the story. "Do X because Y fails" beats "on Tuesday
  we discovered that...". A diary costs context on every single load; a rule
  earns it.
- Prefer **editing** an existing line over adding a near-duplicate.
- If code comments cite this file (\`see AGENT.md\`), make sure the rule they
  cite actually exists here. A dangling citation is worse than no citation:
  the reader trusts it and finds nothing.

**Context Window Management**
This file is loaded in full at the start of every session — every line is paid
for on every task. Routinely prune outdated info, consolidate long sections,
and delete anything already enforced by code or tests.

### Decisions

### Conventions

### Gotchas

### Fixes
${MARKER_END}
`;

// Idempotent: no-op if disabled, path invalid. Injects memory block into AGENT.md
// and pointer blocks into any existing AI config files.
function ensureMemoryConvention(wsPath) {
    if (process.env.AUTO_MEMORY_CONVENTION !== 'true') return false;
    if (!wsPath) return false;

    try {
        if (!fs.statSync(wsPath).isDirectory()) return false;
    } catch (e) {
        return false;
    }

    // 1. Ensure AGENT.md has the main block
    const target = path.join(wsPath, DEFAULT_FILE);
    let existing = '';
    if (fs.existsSync(target)) {
        existing = fs.readFileSync(target, 'utf8');
    }
    
    if (!existing.includes(MARKER_START)) {
        const separator = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
        fs.appendFileSync(target, separator + BLOCK);
    }

    // 2. Ensure other existing agent files have the pointer
    for (const name of POINTER_FILES) {
        const p = path.join(wsPath, name);
        if (fs.existsSync(p)) {
            const content = fs.readFileSync(p, 'utf8');
            if (!content.includes(POINTER_START)) {
                // PREPEND, append DEGIL. Bu dosyalar genelde eski kurallarla
                // dolu; isaretci sona eklenirse ajan once o eski icerigi
                // okuyor, "asil kaynak AGENT.md" uyarisini EN SON goruyor.
                // Yonlendirmenin ise yaramasi icin ilk satirda olmasi gerekir.
                fs.writeFileSync(p, POINTER_BLOCK + '\n' + content);
            }
        }
    }

    return true;
}

// Ensure CANDIDATE_FILES is exported for the /memory command
const CANDIDATE_FILES = [DEFAULT_FILE, ...POINTER_FILES];

module.exports = { ensureMemoryConvention, MARKER_START, MARKER_END, CANDIDATE_FILES };
