const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const DriverFactory = require('./drivers');

const instances = {};

function getAppDataName() {
    return DriverFactory.getDriver().appDataName;
}

function getInstance() {
    const name = getAppDataName();
    if (!instances[name]) {
        instances[name] = {
            accessToken: null,
            pageMappings: {}
        };
    }
    return instances[name];
}

function getTelegraphDir() {
    return path.join(os.homedir(), '.gemini', getAppDataName());
}

function getAccountFile() {
    return path.join(getTelegraphDir(), 'telegraph_account.json');
}

function getPagesFile() {
    return path.join(getTelegraphDir(), 'telegraph_pages.json');
}

// api.graph.org is the community mirror of api.telegra.ph — used because the .ph TLD
// is blocked on many networks/hosting providers. Configurable via TELEGRAPH_API_HOST env var.
const TELEGRAPH_API_HOST = process.env.TELEGRAPH_API_HOST || 'api.graph.org';

// Helper to make HTTPS requests to the Telegraph API
function makeRequest(endpoint, payload) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);

        // Use explicit options instead of a URL string for reliability across Node.js versions
        const options = {
            hostname: TELEGRAPH_API_HOST,
            path: `/${endpoint}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            },
            timeout: 15000
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed.ok) {
                        resolve(parsed.result);
                    } else {
                        reject(new Error(parsed.error || 'Telegraph API error'));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${e.message}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Telegraph request timeout'));
        });

        req.write(data);
        req.end();
    });
}

async function makeRequestWithRetry(endpoint, payload, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await makeRequest(endpoint, payload);
        } catch (error) {
            const isRateLimit = error.message.includes('FLOOD_WAIT');
            let waitMs = 2000 * Math.pow(2, attempt - 1);

            if (isRateLimit) {
                const match = error.message.match(/FLOOD_WAIT_(\d+)/);
                if (match) {
                    waitMs = parseInt(match[1], 10) * 1000;
                }
            }

            if (attempt === maxRetries) {
                throw error;
            }

            console.warn(`[Telegraph] API error on attempt ${attempt}/${maxRetries} (${error.message}). Retrying in ${waitMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
}

// 1. Account registration and token persistence
async function init() {
    try {
        const tDir = getTelegraphDir();
        if (!fs.existsSync(tDir)) {
            fs.mkdirSync(tDir, { recursive: true });
        }

        const instance = getInstance();

        // Load account access token
        const aFile = getAccountFile();
        if (fs.existsSync(aFile)) {
            const accData = JSON.parse(fs.readFileSync(aFile, 'utf-8'));
            instance.accessToken = accData.access_token;
            console.log(`[Telegraph][${getAppDataName()}] Loaded existing account access token.`);
        } else {
            console.log(`[Telegraph][${getAppDataName()}] Creating new Telegraph account...`);
            const account = await makeRequestWithRetry('createAccount', {
                short_name: 'Antigravity',
                author_name: 'Antigravity Agent'
            });
            instance.accessToken = account.access_token;
            fs.writeFileSync(aFile, JSON.stringify({ access_token: instance.accessToken }, null, 2));
            console.log(`[Telegraph][${getAppDataName()}] Created and saved new Telegraph account token.`);
        }

        // Load page mappings
        const pFile = getPagesFile();
        if (fs.existsSync(pFile)) {
            instance.pageMappings = JSON.parse(fs.readFileSync(pFile, 'utf-8'));
        }
    } catch (err) {
        console.error(`[Telegraph][${getAppDataName()}] Initialization failed:`, err.message);
    }
}

// 2. Markdown-to-Telegraph Node parser
function parseInline(text) {
    let tokens = [text];

    function processRegex(regex, transform) {
        let newTokens = [];
        for (const token of tokens) {
            if (typeof token !== 'string') {
                if (token.children) {
                    token.children = processInlineTokens(token.children, regex, transform);
                }
                newTokens.push(token);
                continue;
            }

            let lastIndex = 0;
            let match;
            regex.lastIndex = 0;
            let matchedAny = false;
            
            while ((match = regex.exec(token)) !== null) {
                matchedAny = true;
                const before = token.substring(lastIndex, match.index);
                if (before) newTokens.push(before);
                newTokens.push(transform(match));
                lastIndex = regex.lastIndex;
            }
            
            if (matchedAny) {
                const after = token.substring(lastIndex);
                if (after) newTokens.push(after);
            } else {
                newTokens.push(token);
            }
        }
        tokens = newTokens;
    }

    function processInlineTokens(subTokens, regex, transform) {
        let newTokens = [];
        for (const token of subTokens) {
            if (typeof token !== 'string') {
                if (token.children) {
                    token.children = processInlineTokens(token.children, regex, transform);
                }
                newTokens.push(token);
                continue;
            }
            let lastIndex = 0;
            let match;
            regex.lastIndex = 0;
            let matchedAny = false;
            
            while ((match = regex.exec(token)) !== null) {
                matchedAny = true;
                const before = token.substring(lastIndex, match.index);
                if (before) newTokens.push(before);
                newTokens.push(transform(match));
                lastIndex = regex.lastIndex;
            }
            if (matchedAny) {
                const after = token.substring(lastIndex);
                if (after) newTokens.push(after);
            } else {
                newTokens.push(token);
            }
        }
        return newTokens;
    }

    // A. Links: [text](url)
    processRegex(/\[([^\]]+)\]\(([^)]+)\)/g, (match) => ({
        tag: 'a',
        attrs: { href: match[2] },
        children: [match[1]]
    }));

    // B. Inline code: `code`
    processRegex(/`([^`]+)`/g, (match) => ({
        tag: 'code',
        children: [match[1]]
    }));

    // C. Bold: **text** or __text__
    processRegex(/\*\*([^*]+)\*\*/g, (match) => ({
        tag: 'strong',
        children: [match[1]]
    }));
    processRegex(/__([^_]+)__/g, (match) => ({
        tag: 'strong',
        children: [match[1]]
    }));

    // D. Italic: *text* or _text_
    processRegex(/\*([^*]+)\*/g, (match) => ({
        tag: 'em',
        children: [match[1]]
    }));
    processRegex(/_([^_]+)_/g, (match) => ({
        tag: 'em',
        children: [match[1]]
    }));

    return tokens;
}

function mdToNodes(mdText) {
    const lines = mdText.split(/\r?\n/);
    const nodes = [];
    let inCodeBlock = false;
    let codeLines = [];
    let inList = null; // 'ul' or 'ol'
    let listItems = [];

    function flushList() {
        if (inList) {
            nodes.push({
                tag: inList,
                children: listItems.map(item => ({
                    tag: 'li',
                    children: parseInline(item)
                }))
            });
            inList = null;
            listItems = [];
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Code block handling
        if (line.trim().startsWith('```')) {
            if (inCodeBlock) {
                nodes.push({
                    tag: 'pre',
                    children: [{
                        tag: 'code',
                        children: [codeLines.join('\n')]
                    }]
                });
                inCodeBlock = false;
                codeLines = [];
            } else {
                flushList();
                inCodeBlock = true;
            }
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(line);
            continue;
        }

        const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
        const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);

        if (ulMatch) {
            if (inList !== 'ul') {
                flushList();
                inList = 'ul';
            }
            let content = ulMatch[2];
            // Format task list checkmarks beautifully
            if (content.startsWith('[ ]')) {
                content = '⬜ ' + content.slice(3).trim();
            } else if (content.startsWith('[x]') || content.startsWith('[X]')) {
                content = '✅ ' + content.slice(3).trim();
            } else if (content.startsWith('[/]')) {
                content = '⏳ ' + content.slice(3).trim();
            }
            listItems.push(content);
            continue;
        }

        if (olMatch) {
            if (inList !== 'ol') {
                flushList();
                inList = 'ol';
            }
            listItems.push(olMatch[2]);
            continue;
        }

        flushList();

        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const titleText = headingMatch[2];
            const tag = level <= 3 ? 'h3' : 'h4';
            nodes.push({
                tag: tag,
                children: parseInline(titleText)
            });
            continue;
        }

        if (trimmed.startsWith('>')) {
            let bContent = trimmed.slice(1).trim();
            const alertMatch = bContent.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
            if (alertMatch) {
                bContent = `⚠️ **[${alertMatch[1].toUpperCase()}]** ` + bContent.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, '').trim();
            }
            nodes.push({
                tag: 'blockquote',
                children: parseInline(bContent)
            });
            continue;
        }

        if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
            nodes.push({ tag: 'hr' });
            continue;
        }

        nodes.push({
            tag: 'p',
            children: parseInline(trimmed)
        });
    }

    flushList();

    // Telegraph pages must not have empty children or empty tags. Wrap if empty.
    if (nodes.length === 0) {
        nodes.push({ tag: 'p', children: ['(Empty content)'] });
    }

    return nodes;
}

// 3. Page creation and editing logic with path mapping
async function publishOrUpdateArtifact(filePath, title) {
    let instance = getInstance();
    if (!instance.accessToken) {
        await init();
        instance = getInstance();
    }
    if (!instance.accessToken) {
        throw new Error('Telegraph accessToken is not initialized');
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const nodes = mdToNodes(content);

    const key = path.normalize(filePath).toLowerCase();
    const existing = instance.pageMappings[key];

    if (existing && existing.path) {
        try {
            console.log(`[Telegraph][${getAppDataName()}] Editing existing page for path: ${existing.path}`);
            // content must be a JSON array (not a string) per the Telegraph API spec
            const result = await makeRequestWithRetry('editPage', {
                access_token: instance.accessToken,
                path: existing.path,
                title: title,
                author_name: 'Antigravity Agent',
                content: nodes
            });
            return result.url;
        } catch (err) {
            console.warn(`[Telegraph][${getAppDataName()}] Edit page failed, falling back to creating new page: ${err.message}`);
        }
    }

    console.log(`[Telegraph][${getAppDataName()}] Creating new page for file: ${filePath}`);
    // content must be a JSON array (not a string) per the Telegraph API spec
    const result = await makeRequestWithRetry('createPage', {
        access_token: instance.accessToken,
        title: title,
        author_name: 'Antigravity Agent',
        content: nodes
    });

    instance.pageMappings[key] = {
        url: result.url,
        path: result.path
    };

    try {
        fs.writeFileSync(getPagesFile(), JSON.stringify(instance.pageMappings, null, 2));
    } catch (e) {
        console.error(`[Telegraph][${getAppDataName()}] Failed to save page mappings:`, e.message);
    }

    return result.url;
}

function getPageMapping(filePath) {
    const key = path.normalize(filePath).toLowerCase();
    const instance = getInstance();
    return instance.pageMappings[key] || null;
}

module.exports = {
    init,
    publishOrUpdateArtifact,
    mdToNodes,
    parseInline,
    getPageMapping
};
