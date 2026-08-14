const path = require('path');
const os = require('os');

class BaseDriver {
    constructor(appType, appDataName, port) {
        this.appType = appType;
        this.appDataName = appDataName;
        this.port = port;
    }

    get brainPath() {
        return path.join(os.homedir(), '.gemini', this.appDataName, 'brain');
    }

    getConversationDir(conversationId) {
        if (!conversationId) return null;
        return path.join(this.brainPath, conversationId);
    }
    
    getLocatorsScript() {
        throw new Error('Not implemented');
    }

    getActiveThreadInfoScript() {
        throw new Error('Not implemented');
    }
    
    getSwitchThreadScript(threadNameStr, targetWsNameStr) {
        throw new Error('Not implemented');
    }
    
    getListAgentThreadsScript() {
        throw new Error('Not implemented');
    }
}

module.exports = BaseDriver;
