#!/usr/bin/env node
/**
 * ⚡ COPILOT PULSE — PROXY HTTP ROBUSTNESS (pre-release)
 *
 * Drives the REAL LocalProxyServer over HTTP with malformed / hostile
 * payloads and verifies it never crashes the extension host and always
 * returns a well-formed response.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const moduleLib = require('module');
const mockVscode = {
  window: { showErrorMessage: () => {} },
  workspace: { getConfiguration: () => ({ get: () => '' }) },
  StatusBarAlignment: { Right: 1, Left: 2 },
  authentication: { getSession: async () => ({ accessToken: 'fake' }) }
};
moduleLib._cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: mockVscode };
const originalRequire = moduleLib.prototype.require;
moduleLib.prototype.require = function (request) {
  if (request === 'vscode') return mockVscode;
  return originalRequire.apply(this, arguments);
};

const { LocalProxyServer } = require('./out/proxy/LocalProxyServer.js');

const PORT = 13811;

function raw(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      }
    );
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

describe('Proxy HTTP robustness', () => {
  let proxy;

  before(async () => {
    const cfg = () => ({
      baseUrl: '', apiKey: '', // unconfigured on purpose → must return graceful config error
      cheapModel: 'gpt-4o-mini', strongModel: 'o1',
      useDynamicTiers: true, threshold: 6.5, lowThreshold: 4.0,
      availableModels: ['gpt-4o-mini', 'gpt-4o', 'o1']
    });
    proxy = LocalProxyServer.getInstance(cfg);
    proxy.PORT = PORT;
    proxy.nativeRouteCallback = undefined;
    await proxy.start();
  });

  after(() => proxy.stop());

  it('rejects invalid JSON without crashing', async () => {
    const r = await raw('POST', '/v1/chat/completions', '{not valid json', { 'Content-Type': 'application/json' });
    assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
    assert.ok(r.data.length > 0, 'must return a body');
  });

  it('handles an empty body', async () => {
    const r = await raw('POST', '/v1/chat/completions', '', { 'Content-Type': 'application/json' });
    assert.ok(r.status >= 400, 'empty body must be a client error');
  });

  it('handles a JSON body with no messages array', async () => {
    const r = await raw('POST', '/v1/chat/completions', JSON.stringify({ model: 'copilot-pulse' }), { 'Content-Type': 'application/json' });
    // Unconfigured → should stream a graceful "not configured" message, not crash.
    assert.ok(r.status === 200 || r.status >= 400, `unexpected status ${r.status}`);
    assert.ok(r.data.length > 0);
  });

  it('handles messages with null / malformed entries', async () => {
    const body = JSON.stringify({
      model: 'copilot-pulse',
      messages: [null, 42, { role: 'user' }, { content: null }, { role: 'user', content: [{ nope: true }] }],
      stream: true
    });
    const r = await raw('POST', '/v1/chat/completions', body, { 'Content-Type': 'application/json' });
    assert.ok(r.status === 200 || r.status >= 400, `status ${r.status}`);
  });

  it('handles a huge message payload', async () => {
    const body = JSON.stringify({
      model: 'copilot-pulse',
      messages: [{ role: 'user', content: 'x'.repeat(500000) }],
      stream: true
    });
    const r = await raw('POST', '/v1/chat/completions', body, { 'Content-Type': 'application/json' });
    assert.ok(r.status === 200 || r.status >= 400);
  });

  it('answers CORS preflight (OPTIONS)', async () => {
    const r = await raw('OPTIONS', '/v1/chat/completions', null);
    assert.ok(r.status === 204 || r.status === 200, `preflight status ${r.status}`);
    assert.equal(r.headers['access-control-allow-origin'], '*');
  });

  it('unconfigured streaming request returns a clean SSE termination', async () => {
    const body = JSON.stringify({ model: 'copilot-pulse', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const r = await raw('POST', '/v1/chat/completions', body, { 'Content-Type': 'application/json' });
    assert.equal(r.status, 200);
    assert.ok(r.data.includes('data: [DONE]'), 'SSE stream must terminate with [DONE]');
    assert.ok(/Configuration Required|not configured/i.test(r.data), 'must explain it is unconfigured');
  });

  it('serves /metrics as JSON', async () => {
    const r = await raw('GET', '/metrics', null);
    assert.equal(r.status, 200);
    assert.doesNotThrow(() => JSON.parse(r.data), 'metrics must be valid JSON');
  });

  it('serves the dashboard HTML', async () => {
    const r = await raw('GET', '/', null);
    assert.equal(r.status, 200);
    assert.ok(/<html|<!DOCTYPE/i.test(r.data), 'dashboard must be HTML');
  });

  it('serves the model list', async () => {
    const r = await raw('GET', '/v1/models', null);
    assert.equal(r.status, 200);
    const j = JSON.parse(r.data);
    assert.ok(Array.isArray(j.data), 'models endpoint must return { data: [...] }');
  });

  it('returns 404 for unknown routes (no crash)', async () => {
    const r = await raw('GET', '/nope/nowhere', null);
    assert.equal(r.status, 404);
  });

  it('survives 30 rapid malformed requests without dying', async () => {
    for (let i = 0; i < 30; i++) {
      await raw('POST', '/v1/chat/completions', '{bad' + i, { 'Content-Type': 'application/json' });
    }
    // If it survived, a valid follow-up still works.
    const r = await raw('GET', '/metrics', null);
    assert.equal(r.status, 200);
  });
});

