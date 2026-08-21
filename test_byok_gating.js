/**
 * Copilot Pulse — BYOK registration gating.
 *
 * The model-picker entries proxy to the local server, which needs an upstream
 * baseUrl + apiKey. With no key they are dead entries that answer
 * "Copilot Pulse is not configured…" to every prompt.
 *
 * Advertising a model that cannot answer is worse than not advertising it, so
 * registration must be conditional — and must clean up after itself.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const moduleLib = require('module');
const mockVscode = {
  window: { showErrorMessage: () => {} },
  workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => ({}), update: async () => {} }) },
  authentication: { getSession: async () => ({ accessToken: 'fake' }) }
};
moduleLib._cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: mockVscode };
const originalRequire = moduleLib.prototype.require;
moduleLib.prototype.require = function (request) {
  if (request === 'vscode') return mockVscode;
  return originalRequire.apply(this, arguments);
};

const { CopilotConfigInjector } = require('./out/config/CopilotConfigInjector.js');

function clmPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json');
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'chatLanguageModels.json');
  }
  return path.join(home, '.config', 'Code', 'User', 'chatLanguageModels.json');
}

function readProviders() {
  try {
    const raw = fs.readFileSync(clmPath(), 'utf-8').trim();
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const isPulse = (p) =>
  p && (p._copilotPulseMarker === 'copilot-pulse-local-proxy' ||
        (p.name === 'Copilot Pulse' && p.vendor === 'customendpoint'));

describe('BYOK registration is conditional on configuration', () => {
  let backup = null;
  const file = clmPath();

  beforeEach(() => {
    backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  });

  afterEach(() => {
    // Always restore the developer's real config.
    try {
      if (backup === null) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        fs.writeFileSync(file, backup, 'utf-8');
      }
    } catch { /* best effort */ }
  });

  it('registers the picker models when baseUrl + apiKey ARE configured', () => {
    CopilotConfigInjector.injectConfig(true);
    const providers = readProviders();
    assert.ok(providers.some(isPulse), 'Copilot Pulse provider must be registered');
  });

  it('REMOVES the picker models when configuration is missing', () => {
    CopilotConfigInjector.injectConfig(true);       // first register…
    assert.ok(readProviders().some(isPulse), 'precondition: registered');

    CopilotConfigInjector.injectConfig(false);      // …then unconfigure
    const providers = readProviders();
    assert.ok(
      !providers.some(isPulse),
      'a model that cannot answer must not be offered in the picker'
    );
  });

  it('never disturbs OTHER providers in the file', () => {
    const foreign = { name: 'Some Other Provider', vendor: 'customendpoint', models: [] };
    fs.writeFileSync(file, JSON.stringify([foreign], null, 2), 'utf-8');

    CopilotConfigInjector.injectConfig(true);
    assert.ok(readProviders().some((p) => p.name === 'Some Other Provider'), 'foreign entry survives injection');

    CopilotConfigInjector.injectConfig(false);
    const after = readProviders();
    assert.ok(after.some((p) => p.name === 'Some Other Provider'), 'foreign entry survives removal');
    assert.ok(!after.some(isPulse), 'only our entry is removed');
  });

  it('is idempotent — repeated calls do not duplicate entries', () => {
    CopilotConfigInjector.injectConfig(true);
    CopilotConfigInjector.injectConfig(true);
    CopilotConfigInjector.injectConfig(true);
    assert.equal(readProviders().filter(isPulse).length, 1, 'exactly one Pulse provider entry');
  });

  it('re-registers as soon as configuration returns', () => {
    CopilotConfigInjector.injectConfig(false);
    assert.ok(!readProviders().some(isPulse), 'precondition: removed');

    CopilotConfigInjector.injectConfig(true);
    assert.ok(readProviders().some(isPulse), 'must come back when an API key is set');
  });
});

