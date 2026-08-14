const IDE_LOCATORS_SCRIPT = `
    var AG_UI = {
        openHistoryPopup: () => {
            const existing = document.querySelector('input[placeholder*="Search all"], input[placeholder="Select a conversation"], input[placeholder*="convo"]');
            if (existing) return "already-open";
            
            const icon = document.querySelector("svg.lucide-history, .codicon-history, [title*='Recent Sessions' i]");
            if (!icon) return "no-icon";
            (icon.closest("button") || icon.closest("a") || icon.parentElement).click();
            return "opened";
        },
        clickShowMoreInPopup: () => {
            const showMoreEls = Array.from(document.querySelectorAll('[id^="fastpick-show-more-"], [id*="show-more"]'));
            if (showMoreEls.length === 0) {
                const textMatches = Array.from(document.querySelectorAll('div')).filter(d => /^show\\s+\\d+\\s+more/i.test(d.textContent.trim()));
                textMatches.forEach(el => el.click());
            } else {
                showMoreEls.forEach(el => el.click());
            }
        },
        closeHistoryPopup: () => {
            document.body.click();
            const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
            document.activeElement.dispatchEvent(esc);
            document.dispatchEvent(esc);
        },
        checkForQuestion: () => {
            const container = document.querySelector('.modal, [role="dialog"], .interactive-session, [data-testid="interactive-modal"]');
            if (!container) return null;
            
            const isModal = !!container.querySelector('textarea, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], select, button');
            if (!isModal) return null;
            
            let headerEl = container.querySelector('.modal-header, [data-testid="interactive-modal"] h2, h3.font-medium, fieldset legend, h2, h3, p.text-base, p.mb-4, p.text-sm');
            let header = (headerEl && headerEl.textContent.trim());
            
            const labels = Array.from(container.querySelectorAll('label'));
            let options = labels.map(l => (l.innerText || l.textContent).trim().replace(/^\\d+\\s*\\n?/, '')).filter(t => t && !t.match(/^(Other|Other \\(write your answer\\)|\\d+)$/i));
            if (options.length === 0) {
                const items = Array.from(container.querySelectorAll('[role="radio"], [role="checkbox"]'));
                options = items.map(i => i.textContent.trim()).filter(t => t && !t.match(/^(Other|Other \\(write your answer\\)|\\d+)$/i));
            }
            if (options.length === 0) {
                const firstLabel = container.querySelector('label, [role="radio"], [role="checkbox"]');
                if (firstLabel) {
                    const p = firstLabel.parentElement;
                    if (p) {
                        options = Array.from(p.children).map(c => c.textContent.trim()).filter(t => t && t.length > 0 && !t.match(/^(Other|Other \\(write your answer\\)|\\d+)$/i));
                    }
                }
            }
            
            const writeInEl = container.querySelector('textarea:not([disabled]), input[type="text"]:not([disabled])');
            const hasWriteIn = !!writeInEl;
            
            if (options.length === 0 && !hasWriteIn) {
                if (!header) {
                    const pTags = Array.from(container.querySelectorAll('p, .text-sm, .text-base'));
                    if (pTags.length > 0) {
                        header = pTags.map(p => p.textContent.trim()).filter(Boolean).join('\\n');
                    }
                }
                if (!header) return null;
            }
            
            return { header, options, hasWriteIn };
        },

        isClassicIDE: () => true,

        getVisibleChatContainer: () => {
            const input = AG_UI.getChatInput();
            if (input) {
                let el = input;
                while (el) {
                    if (el.id === 'conversation' || 
                        el.classList.contains('interactive-session') || 
                        el.classList.contains('chat-container') ||
                        el.id === 'chat') {
                        return el;
                    }
                    el = el.parentElement;
                }
            }

            const candidates = [
                '#conversation', 
                '.interactive-session',
                '.chat-container',
                '#chat'
            ];
            
            const containers = Array.from(document.querySelectorAll(candidates.join(', ')));
            return containers.find(c => {
                let isVisible = true;
                let el = c;
                while (el) {
                    if (window.getComputedStyle(el).display === 'none') {
                        isVisible = false;
                        break;
                    }
                    el = el.parentElement;
                }
                return isVisible;
            }) || containers[0] || null;
        },

        getChatInput: () => {
            const candidates = [
                '.interactive-input-editor textarea',
                '#conversation textarea',
                '#chat textarea',
                '.chat-input textarea',
                '.chat-input [contenteditable="true"]',
                '[aria-label*="chat input" i] textarea',
                '[aria-label*="chat input" i] [contenteditable="true"]',
                '[aria-label*="message input" i]',
                '[aria-label*="message input" i] [contenteditable="true"]',
                '[placeholder*="Ask" i] textarea',
                '[placeholder*="Ask" i] [contenteditable="true"]',
                '[placeholder*="Sohbet" i] textarea',
                '[placeholder*="Sohbet" i] [contenteditable="true"]'
            ];

            const editors = [...document.querySelectorAll(candidates.join(', '))]
                .filter(el => {
                    if (el.className && typeof el.className === 'string' && el.className.includes('xterm')) return false;
                    return AG_UI.isVisible(el);
                });

            return editors.at(-1) || null;
        },

        getStopButton: () => {
            const chatArea = AG_UI.getVisibleChatContainer() || document;
            
            const stopIcon = chatArea.querySelector(
                "svg.lucide-square, [data-tooltip-id*='cancel'], [aria-label*='Stop'], [title*='Stop'], [aria-label*='Cancel'], [aria-label*='Durdur'], [title*='Durdur']"
            );
            if (stopIcon) return stopIcon.closest('button') || stopIcon;
            
            const allBtns = Array.from(chatArea.querySelectorAll('button'));
            return allBtns.find(b => {
                if (b.querySelector('svg.lucide-square')) return true;
                const t = (b.textContent || '').trim().toLowerCase();
                return t === 'stop' || t === 'cancel' || t === 'durdur' || t === 'iptal';
            }) || null;
        },

        isLoading: () => {
            const selectors = [
                '.codicon-loading', 
                '.loading', 
                '[class*="animate-spin"]', 
                '[class*="spinner"]', 
                '[class*="loader"]',
                '.thinking-indicator'
            ];
            
            return Array.from(document.querySelectorAll(selectors.join(', '))).some(el => {
                if (!AG_UI.isVisible(el)) return false;
                if (el.className && typeof el.className === 'string') {
                    if (el.className.includes('h-3') && el.className.includes('w-3')) return false;
                }
                const parent = el.parentElement;
                if (parent && parent.className && typeof parent.className === 'string') {
                    if (parent.className.includes('opacity-') || parent.className.includes('hidden')) return false;
                }
                return true;
            });
        },

        getNewChatButton: () => {
            const svgPath = document.querySelector('path[d="M12 4.5v15m7.5-7.5h-15"]');
            if (svgPath) {
                const btn = svgPath.closest('button, a, [role="button"]');
                if (btn) return btn;
            }
            
            const iconSelectors = 'svg.lucide-plus, svg.lucide-square-pen, svg.lucide-message-square-plus';
            const icon = document.querySelector(iconSelectors);
            if (icon) {
                const btn = icon.closest('button, a, [role="button"]');
                if (btn) return btn;
            }
            
            const selectors = [
                '[aria-label*="New Chat" i]',
                '[title*="New Chat" i]',
                '[aria-label*="Yeni Sohbet" i]',
                '[title*="Yeni Sohbet" i]',
                '[aria-label*="New Conversation" i]',
                '[title*="New Conversation" i]',
                '[class*="new-chat"]',
                '[aria-label*="New Task" i]',
                '[title*="New Task" i]',
                '[data-tooltip-id*="new-conversation" i]'
            ];
            let btn = document.querySelector(selectors.join(', '));
            if (btn) return btn;
            
            const allBtns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
            return allBtns.find(b => {
                const text = (b.textContent || '').trim().toLowerCase();
                return text === 'new chat' || text === 'new conversation' || text === 'yeni sohbet';
            }) || null;
        },

        getModelSelectorButton: () => {
            const isFile = (str) => /\\.(js|jsx|ts|tsx|md|json|py|html|css|txt|sh)$/i.test((str || '').trim());

            const explicit = Array.from(document.querySelectorAll(
                '[aria-label*="Select model" i], [title*="Select model" i], [aria-label*="选择模型" i], [title*="选择模型" i], [aria-label*="current:" i], [aria-label*="当前" i], [data-testid*="model-select" i]'
            )).filter(AG_UI.isVisible);

            const validExplicit = explicit.filter(el => {
                if (el.closest('.monaco-tree-view, .explorer-viewlet, .tabs-container, .monaco-editor, .monaco-list, .monaco-list-rows')) return false;
                const text = (el.textContent || '').trim();
                const label = (el.getAttribute('aria-label') || '').trim();
                if (isFile(text) || isFile(label)) return false;
                return true;
            });

            if (validExplicit.length > 0) return validExplicit[0];

            const modelKeywords = ['gemini', 'claude', 'gpt', 'opus', 'sonnet', 'flash', 'llama', 'mistral', 'deepseek'];
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(el => {
                if (!AG_UI.isVisible(el)) return false;
                if (el.closest('.monaco-tree-view, .explorer-viewlet, .tabs-container, .monaco-editor, .monaco-list, .monaco-list-rows')) return false;
                const inMenu = el.closest('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], div[class*="popover"], div[class*="dropdown-content"]');
                if (inMenu) return false;
                
                const text = (el.textContent || '').trim();
                const label = (el.getAttribute('aria-label') || '').trim();
                if (isFile(text) || isFile(label)) return false;
                return true;
            });

            return allButtons.find(el => {
                const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '')).toLowerCase();
                return label.includes('选择模型') ||
                    label.includes('select model') ||
                    label.includes('current:') ||
                    modelKeywords.some(k => label.includes(k));
            }) || null;
        },

        getModelOptions: () => {
            const isFile = (str) => /\\.(js|jsx|ts|tsx|md|json|py|html|css|txt|sh)$/i.test((str || '').trim());
            const modelKeywords = ['gemini', 'claude', 'gpt', 'opus', 'sonnet', 'flash', 'llama', 'mistral', 'deepseek'];
            
            const selectorBtn = AG_UI.getModelSelectorButton();
            const ariaControlsId = selectorBtn ? selectorBtn.getAttribute('aria-controls') : null;
            const controlledContainer = ariaControlsId ? document.getElementById(ariaControlsId) : null;

            const menuContainers = Array.from(document.querySelectorAll(
                '[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], div[class*="popover"], div[class*="dropdown-content"], div[class*="select-content"], div[class*="menu"], div[class*="animate-slideIn"]'
            )).filter(AG_UI.isVisible);

            if (controlledContainer && AG_UI.isVisible(controlledContainer) && !menuContainers.includes(controlledContainer)) {
                menuContainers.push(controlledContainer);
            }

            let candidates = [];
            if (menuContainers.length > 0) {
                menuContainers.forEach(container => {
                    const items = Array.from(container.querySelectorAll(
                        'button, [role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], .model-option, .main-row-trigger, [data-radix-collection-item], [data-radix-select-item]'
                    ));
                    candidates.push(...items);
                });
            } else {
                candidates = Array.from(document.querySelectorAll(
                    '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], .model-option, .main-row-trigger, [data-radix-collection-item], [data-radix-select-item]'
                ));
            }

            return candidates.filter(el => {
                if (!AG_UI.isVisible(el)) return false;
                if (el.closest('.monaco-tree-view, .explorer-viewlet, .tabs-container, .monaco-editor, .monaco-list, .monaco-list-rows')) return false;
                const text = (el.textContent || '').trim();
                const label = (el.getAttribute('aria-label') || '').trim();
                
                if (isFile(text) || isFile(label)) return false;
                
                if (text.length < 3 || text.length > 80) return false;
                if (text.includes('\\n') && text.split('\\n').length > 2) return false;
                
                const lower = text.toLowerCase();
                return modelKeywords.some(k => lower.includes(k));
            });
        },

        getWorkspaceCards: () => {
            return []; // IDE does not have in-app workspace cards like standalone
        },

        getChatThreadPills: (container = document) => {
            return Array.from(container.querySelectorAll('[data-testid^="convo-pill-"], .convo-pill, [class*="conversation-pill"]'));
        },
        
        isVisible: (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length > 0));
        },

        removeThoughtBlocks: (clone) => {
            const btns = Array.from(clone.querySelectorAll('button')).filter(b => b.innerText && b.innerText.includes('Thought for'));
            btns.forEach(btn => {
                if (btn.parentElement) btn.parentElement.remove();
            });
            const modernThoughts = Array.from(clone.querySelectorAll('.thought-block, [class*="thought-"], details.thought, thought'));
            modernThoughts.forEach(el => el.remove());
            const toolBlocks = Array.from(clone.querySelectorAll('[class*="group/run-command"], [class*="group/file-change"], [class*="group/tool-"], [class*="group/edit-file"]'));
            toolBlocks.forEach(el => el.remove());
        }
    };
`;

module.exports = { IDE_LOCATORS_SCRIPT };
