const CDP = require('chrome-remote-interface');
const { resolveTargets } = require('./src/cdp_controller');

async function test() {
    const targets = await resolveTargets(9222);
    for (const t of targets) {
        console.log("Checking target:", t.title);
        const client = await CDP({ target: t.webSocketDebuggerUrl });
        const { Runtime } = client;
        await Runtime.enable();
        const res = await Runtime.evaluate({
            expression: `(() => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) return false;
                    if (r.bottom < 0 || r.top > window.innerHeight) return false;
                    if (r.right < 0 || r.left > window.innerWidth) return false;
                    const s = window.getComputedStyle(el);
                    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
                };
                const allContainers = Array.from(document.querySelectorAll('.antigravity-agent-side-panel, .modal, [role="dialog"], .interactive-session'));
                const visibleContainers = allContainers.filter(c => isVisible(c));
                
                const container = visibleContainers.length > 0 ? visibleContainers[0] : document;
                const isModal = container !== document
                    ? !!container.querySelector('textarea[placeholder*="Other" i], textarea[placeholder*="answer" i], input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], select, [data-testid="interactive-modal"]')
                    : false;
                
                let foundElement = null;
                if (container !== document) {
                     const el = container.querySelector('textarea[placeholder*="Other" i], textarea[placeholder*="answer" i], input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], select, [data-testid="interactive-modal"]');
                     foundElement = el ? el.outerHTML.substring(0, 100) : null;
                }
                
                return {
                    visibleContainersCount: visibleContainers.length,
                    containerClasses: container !== document ? container.className : 'document',
                    isModal,
                    foundElement
                };
            })()`,
            returnByValue: true
        });
        console.log(res.result.value);
        await client.close();
    }
}
test().catch(console.error);
