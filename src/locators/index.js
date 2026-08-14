const { IDE_LOCATORS_SCRIPT } = require('./ide_locators');
const { STANDALONE_LOCATORS_SCRIPT } = require('./standalone_locators');

/**
 * Returns the locator script specifically for the given app type.
 * @param {string} appType 'ide' or 'agent'
 * @returns {string} The javascript string to be evaluated via CDP.
 */
function getLocatorsScript(appType) {
    if (appType === 'ide') {
        return IDE_LOCATORS_SCRIPT;
    }
    return STANDALONE_LOCATORS_SCRIPT;
}

module.exports = {
    getLocatorsScript,
    IDE_LOCATORS_SCRIPT,
    STANDALONE_LOCATORS_SCRIPT
};
