const BaseDriver = require('./base_driver');
const { getLocatorsScript } = require('../locators');

class IDEDriver extends BaseDriver {
    constructor() {
        super('ide', 'antigravity-ide', 9222);
    }

    getLocatorsScript() {
        return getLocatorsScript('ide');
    }

    getActiveThreadInfoScript() {
        return `(() => {
            let name = null;
            let nameSource = 'none';
            let threadIdVal = null;
            
            const titleEl = document.querySelector("svg.lucide-history")?.closest("div")?.parentElement?.querySelector("div.whitespace-nowrap");
            if (titleEl) {
                name = titleEl.textContent.trim();
                nameSource = 'history-icon';
            } else {
                const all = document.querySelectorAll('[data-testid^="convo-pill-"]');
                for (let el of all) {
                    const row = el.closest('[role="button"]');
                    if (row && row.classList.contains('bg-list-hover')) {
                        name = el.textContent.trim();
                        nameSource = 'convo-pill';
                        break;
                    }
                }
            }
            
            let workspace = null;
            let activeEl = null;
            try {
                const url = window.location.href;
                const uuidMatch = url.match(/\\/c\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                const activeUuid = uuidMatch ? uuidMatch[1] : null;
                
                if (activeUuid) {
                    activeEl = document.querySelector('[data-testid*="' + activeUuid + '"]') || 
                               Array.from(document.querySelectorAll('div[role="button"]')).find(el => {
                                   const tid = el.getAttribute('data-testid') || '';
                                   return tid.indexOf(activeUuid) !== -1;
                               });
                }

                if (!activeEl) {
                    activeEl = document.querySelector('.bg-sidebar-secondary');
                }
                
                if (activeEl) {
                    let current = activeEl;
                    let steps = 0;
                    while (current && steps < 15) {
                        if (current.className && typeof current.className === 'string' && current.className.includes('group/section')) {
                            const card = current.querySelector('[data-project-card="true"], [data-workspace-card="true"], [data-project-card], [data-workspace-card]');
                            if (card) {
                                const cloned = card.cloneNode(true);
                                cloned.querySelectorAll('svg').forEach(el => el.remove());
                                workspace = cloned.textContent.trim().replace(/\\s+\\d+$/, '');
                                break;
                            }
                        }
                        current = current.parentElement;
                        steps++;
                    }
                }
            } catch (err) {}
            
            if (!workspace) {
                const wsEl = document.querySelector('div.text-sm.font-medium.truncate');
                if (wsEl) {
                    workspace = wsEl.textContent.trim();
                } else {
                    workspace = document.title;
                }
            }

            const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
            
            try {
                const url = window.location.href;
                const urlMatch = url.match(/\\/c\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                if (urlMatch) threadIdVal = urlMatch[1];
            } catch (e) {}

            if (!threadIdVal) {
                const labels = Array.from(document.querySelectorAll('[aria-label*="brain/"], .monaco-icon-label'));
                for (let el of labels) {
                    const aria = el.getAttribute('aria-label') || '';
                    if (aria.includes('brain/')) {
                        const match = aria.match(uuidRegex);
                        if (match) {
                            threadIdVal = match[0];
                            break;
                        }
                    }
                }
            }
            return { name, workspace, threadId: threadIdVal, nameSource };
        })()`;
    }

    getSwitchThreadScript(threadNameStr, targetWsNameStr) {
        return `(() => {
            const existing = document.querySelector('input[placeholder*="Search all"], input[placeholder="Select a conversation"], input[placeholder*="convo"]');
            if (existing) return "already-open";
            const icon = document.querySelector("svg.lucide-history");
            if (!icon) return "no-icon";
            (icon.closest("button") || icon.parentElement).click();
            return "opened";
        })()`;
    }
    
    // Additional quickpick interaction script specific to IDE
    getSwitchThreadQuickpickScript(threadNameStr) {
        return `(async () => {
            const input = document.querySelector('input[placeholder*="Search all"], input[placeholder="Select a conversation"], input[placeholder*="convo"]');
            if (!input) return false;
            let container = input;
            for (let i = 0; i < 15; i++) { if (container.parentElement) container = container.parentElement; }
            
            let target = null;
            for (let retry = 0; retry < 10; retry++) {
                const rows = Array.from(container.querySelectorAll('div.cursor-pointer')).filter(r => r.className.includes('px-2.5'));
                target = rows.find(row => {
                    const nameEl = row.querySelector('span.truncate, span.text-sm span');
                    const name = nameEl ? nameEl.textContent.trim() : '';
                    return name === ${threadNameStr} || (name.length > 10 && ${threadNameStr}.startsWith(name.replace('...', '')));
                });
                if (target) break;
                await new Promise(r => setTimeout(r, 300));
            }
            
            if (target) {
                target.scrollIntoView();
                target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                target.click(); 
                return true; 
            }
            
            // If not found, close the popup so it doesn't get stuck
            document.body.click();
            const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
            input.dispatchEvent(esc);
            document.dispatchEvent(esc);
            return false;
        })()`;
    }

    getListAgentThreadsScript() {
        return `(() => {
            const activeWsName = (() => {
                const sidePanelWs = document.querySelector(".antigravity-agent-side-panel div.text-lg.font-medium")?.textContent.trim();
                if (sidePanelWs) return sidePanelWs;
                const title = document.title || '';
                if (title.includes(' - ')) return title.split(' - ')[0].trim();
                return 'IDE';
            })();

            const input = document.querySelector('input[placeholder*="Search all"], input[placeholder="Select a conversation"], input[placeholder*="convo"], input[placeholder*="Search"]');
            let container = document.body;
            if (input) { container = input; for (let i = 0; i < 15; i++) { if (container.parentElement) container = container.parentElement; } }
            
            const allDivs = Array.from(container.querySelectorAll('div'));
            const sectionHeaders = allDivs.filter(d =>
                d.className && typeof d.className === 'string' &&
                (d.className.includes('opacity-50') || d.className.includes('text-muted-foreground')) &&
                d.className.includes('px-2.5') && d.className.includes('pt-4') &&
                d.childNodes.length === 1 && d.childNodes[0].nodeType === 3
            );
            
            const rows = allDivs.filter(d =>
                d.className && typeof d.className === 'string' &&
                d.className.includes('px-2.5') && d.className.includes('cursor-pointer') && d.querySelector('span')
            );
            
            const workspaces = [];
            for (const row of rows) {
                const nameEl = row.querySelector('span.truncate, span.text-sm span');
                const timeEl = row.querySelector('span.text-xs.opacity-50.ml-4');
                const wsEl = row.querySelector('span.text-xs.min-w-0.opacity-50.truncate');
                const name = nameEl ? nameEl.textContent.trim() : '';
                const time = timeEl ? timeEl.textContent.trim() : '';
                
                if (!name || /^show\\s+\\d+\\s+more/i.test(name)) continue;
                if (/^(Ran|Worked for|Explored)\\b/i.test(name)) continue;
                
                let wsName = '';
                if (wsEl) wsName = wsEl.textContent.trim();
                
                wsName = wsName.replace(/[\\u0000-\\u001F\\u007F-\\u009F]/g, '').trim();
                
                if (wsName.includes('file:///')) {
                    const parts = wsName.split('/');
                    const folder = parts.filter(p => p && !p.startsWith('file:')).pop();
                    if (folder) wsName = folder.replace(/[\\"\\'@]/g, '').replace(/(\\.git)?(main|master)$/, '').trim();
                }
                wsName = wsName.replace(/(\\.git)?(main|master)$/, '').trim();

                if (!wsName) {
                    let section = '';
                    for (const h of sectionHeaders) {
                        if (row.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) section = h.textContent.trim();
                    }
                    if (section.startsWith('Recent in ')) wsName = section.replace('Recent in ', '');
                    else wsName = activeWsName;
                }
                
                let group = workspaces.find(w => w.workspace === wsName);
                if (!group) { group = { workspace: wsName, threads: [] }; workspaces.push(group); }
                if (!group.threads.some(t => t.name === name)) {
                    group.threads.push({ name, time });
                }
            }
            return JSON.stringify(workspaces);
        })()`;
    }
}

module.exports = IDEDriver;
