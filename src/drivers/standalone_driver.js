const BaseDriver = require('./base_driver');
const { getLocatorsScript } = require('../locators');

class StandaloneDriver extends BaseDriver {
    constructor() {
        super('agent', 'antigravity', 9333);
    }

    getLocatorsScript() {
        return getLocatorsScript('agent');
    }

    getActiveThreadInfoScript() {
        return `(() => {
            let name = null;
            let nameSource = 'none';
            let threadIdVal = null;
            
            const title = document.title;
            if (title) {
                name = title;
                nameSource = 'document-title';
            }
            
            let workspace = null;
            const panel = document.querySelector(".antigravity-agent-side-panel");
            const wsEl2 = panel ? panel.querySelector("div.text-lg.font-medium") : null;
            if (wsEl2) {
                workspace = wsEl2.textContent.trim();
            }
            
            try {
                const url = window.location.href;
                const urlMatch = url.match(/\\/c\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                if (urlMatch) threadIdVal = urlMatch[1];
            } catch (e) {}

            return { name, workspace, threadId: threadIdVal, nameSource };
        })()`;
    }

    getSwitchThreadScript(threadNameStr, targetWsNameStr) {
        return `(async () => {
            if (document.title.trim() === ${threadNameStr}) {
                return 'already-active';
            }
            
            const cards = Array.from(document.querySelectorAll('[data-project-card="true"], [data-workspace-card="true"], [data-project-card], [data-workspace-card]'));
            if (cards.length === 0) return 'no-card';
            
            // Expand the target workspace card if it is collapsed
            for (const card of cards) {
                let inTargetWs = true;
                if (${targetWsNameStr}) {
                    const cloned = card.cloneNode(true);
                    cloned.querySelectorAll('svg').forEach(el => el.remove());
                    const wsName = cloned.textContent.trim().replace(/\\s+\\d+$/, '').toLowerCase();
                    inTargetWs = (wsName === ${targetWsNameStr} || wsName.includes(${targetWsNameStr}) || ${targetWsNameStr}.includes(wsName));
                }
                if (inTargetWs && card.getAttribute('aria-expanded') !== 'true') {
                    card.click();
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            
            let foundSib = null;
            for (const card of cards) {
                // Check if this card's workspace matches targetWsName
                let inTargetWs = true;
                if (${targetWsNameStr}) {
                    const cloned = card.cloneNode(true);
                    cloned.querySelectorAll('svg').forEach(el => el.remove());
                    const wsName = cloned.textContent.trim().replace(/\\s+\\d+$/, '').toLowerCase();
                    inTargetWs = (wsName === ${targetWsNameStr} || wsName.includes(${targetWsNameStr}) || ${targetWsNameStr}.includes(wsName));
                }
                
                if (!inTargetWs) continue;
                
                let section = card;
                for (let i = 0; i < 3; i++) {
                    if (section.parentElement && section.parentElement.className && typeof section.parentElement.className === 'string' && section.parentElement.className.includes('group/section')) {
                        section = section.parentElement;
                        break;
                    } else if (section.parentElement) {
                        section = section.parentElement;
                    }
                }
                
                const threadRows = Array.from(section.querySelectorAll('a, [role="button"]'));
                for (const row of threadRows) {
                    if (row.contains(card) || row === card) continue;
                    let title = row.getAttribute('aria-label');
                    if (!title) {
                        const titleEl = row.querySelector('span.truncate, span.text-sm span, div.truncate') || row.querySelector('span');
                        if (titleEl) title = titleEl.textContent;
                    }
                    if (title && title.trim() === ${threadNameStr}) {
                        foundSib = row;
                        break;
                    }
                }
                if (foundSib) break;
            }
            
            if (!foundSib) return 'not-found';
            
            // Find the closest clickable ancestor or use the element itself
            const clickable = foundSib.closest('a[href]') || 
                              foundSib.closest('[role="button"]') ||
                              foundSib.querySelector('a[href]') || 
                              foundSib.querySelector('[role="button"]') ||
                              foundSib;
            
            // Dispatch synthetic mouse events for React/framework listeners
            try { clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch(e) {}
            try { clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch(e) {}
            try { clickable.click(); } catch(e) {}
            
            return 'clicked';
        })()`;
    }

    getListAgentThreadsScript() {
        return `(() => {
            const panel = document.querySelector(".antigravity-agent-side-panel");
            if (!panel) return JSON.stringify([]);
            const wsEl = panel.querySelector("div.text-lg.font-medium");
            const currentWsName = wsEl ? wsEl.textContent.trim() : "";
            if (!currentWsName) return JSON.stringify([]);
            
            const workspacesMap = {};
            const btns = Array.from(panel.querySelectorAll("button.group.cursor-pointer, a.group"));
            
            for (const item of btns) {
                if (item.tagName.toLowerCase() === 'button') {
                    const nameEl = item.querySelector("div.truncate");
                    const timeEl = item.querySelector("p.text-muted-foreground");
                    const name = nameEl ? nameEl.textContent.trim() : "";
                    const time = timeEl ? timeEl.textContent.trim() : "";
                    if (name) {
                        if (!workspacesMap[currentWsName]) workspacesMap[currentWsName] = { workspace: currentWsName, threads: [] };
                        if (!workspacesMap[currentWsName].threads.find(t => t.name === name)) {
                            workspacesMap[currentWsName].threads.push({ name, time });
                        }
                    }
                } else if (item.tagName.toLowerCase() === 'a' && item.getAttribute('href').startsWith('/c/')) {
                    let threadName = item.getAttribute('aria-label') || '';
                    let time = '';
                    let row = item.parentElement;
                    while(row && !row.textContent.trim() && row !== document.body) {
                        row = row.parentElement;
                    }
                    if (row) {
                        if (!threadName) {
                            const titleEl = row.querySelector('span.truncate, div.truncate');
                            if (titleEl) threadName = titleEl.textContent.trim();
                        }
                        const allSpans = Array.from(row.querySelectorAll('span, p, div'));
                        const timeSpan = allSpans.find(s => s.textContent !== threadName && /^(\\d+[smhd]|\\d+:\\d+|\\d+ (min|hour|day|sec|mo))/.test(s.textContent.trim()));
                        time = timeSpan ? timeSpan.textContent.trim() : '';
                    }

                    if (threadName && !/^(Projects|Conversations|No conversations yet|Settings|New Conversation|Conversation History|Scheduled Tasks|Show \\d+ more)/i.test(threadName)) {
                        if (!workspacesMap[currentWsName]) workspacesMap[currentWsName] = { workspace: currentWsName, threads: [] };
                        if (!workspacesMap[currentWsName].threads.find(t => t.name === threadName)) {
                            workspacesMap[currentWsName].threads.push({ name: threadName, time });
                        }
                    }
                }
            }
            return JSON.stringify(Object.values(workspacesMap));
        })()`;
    }
}

module.exports = StandaloneDriver;
