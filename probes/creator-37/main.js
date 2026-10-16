'use strict';

const { collectProbe } = require('./probe');

exports.load = function () {};
exports.unload = function () {};
exports.methods = {
  async runProbe() {
    const report = await collectProbe(Editor);
    console.log('[cocos-37-compat-probe]\n' + JSON.stringify(report, null, 2));
    return report;
  },
};
