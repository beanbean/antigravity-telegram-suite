const IDEDriver = require('./ide_driver');
const StandaloneDriver = require('./standalone_driver');

class DriverFactory {
    static getDriver(appType = null) {
        if (!appType) {
            appType = (process.env.ANTIGRAVITY_PREFERRED_APP || 'agent').toLowerCase();
        }
        if (appType === 'ide') {
            return new IDEDriver();
        }
        return new StandaloneDriver();
    }
}

module.exports = DriverFactory;
