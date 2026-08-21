/**
 * Regression tests for the "extension stops abruptly in between" bug.
 *
 * Root causes covered here:
 *  1. Upstream ends the SSE stream WITHOUT `finish_reason` and WITHOUT `[DONE]`
 *     → VS Code's Copilot client saw the response simply stop. The proxy must
 *       now synthesize both terminators.
 *  2. Upstream destroys the socket MID-chunk (Zscaler / proxy reset)
 *     → the client must still receive an error notice + a proper terminator
 *       instead of a dangling connection.
 *  3. Upstream returns a 500 mid-conversation
 *     → the stream must be closed cleanly, never left hanging.
 *  4. A stream that already delivered data must NOT be silently retried
 *     (that used to duplicate the answer).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ── Mock the `vscode` module (injected by the extension host at runtime) ──
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

const PROXY_PORT = 13471;

/** Behaviour of the mock upstream for the next request. */
let upstreamMode = 'truncated';
/** How many times the upstream was hit (detects unwanted retries). */
let upstreamHits = 0;

function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PROXY_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString('utf-8')));
        res.on('end', () => resolve({ status: res.statusCode, data }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Abrupt stop resilience (stream termination guarantees)', () => {
  let upstream;
  let proxy;
  let upstreamPort;

  before(async () => {
    upstream = http.createServer((req, res) => {
      if (req.url !== '/chat/completions' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      upstreamHits++;

      if (upstreamMode === 'http500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream exploded' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (upstreamMode === 'truncated') {
        // Content, then the provider just stops. No finish_reason. No [DONE].
        res.write(`data: {"id":"1","choices":[{"delta":{"content":"Partial answer"}}]}\n\n`);
        res.end();
        return;
      }

      if (upstreamMode === 'reset') {
        // Deliver some content, then kill the socket mid-chunk.
        res.write(`data: {"id":"1","choices":[{"delta":{"content":"Before the reset"}}]}\n\n`);
        res.write(`data: {"id":"2","choices":[{"delta":{"cont`);
        setTimeout(() => res.socket.destroy(), 20);
        return;
      }

      if (upstreamMode === 'complete') {
        res.write(`data: {"id":"1","choices":[{"delta":{"content":"All good"}}]}\n\n`);
        res.write(`data: {"id":"2","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    });

    await new Promise((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        upstreamPort = upstream.address().port;
        resolve();
      });
    });

    const configGetter = () => ({
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: 'test-key',
      cheapModel: 'test-model',
      strongModel: 'test-model',
      useDynamicTiers: false,
      threshold: 6.5,
      lowThreshold: 4.0,
      availableModels: ['test-model']
    });

    proxy = LocalProxyServer.getInstance(configGetter);
    proxy.PORT = PROXY_PORT;
    proxy.nativeRouteCallback = undefined; // force the OpenAiClient HTTP path
    await proxy.start();
  });

  after(() => {
    upstream.close();
    proxy.stop();
  });

  it('BUG 1: a truncated upstream stream is still terminated with finish_reason + [DONE]', async () => {
    upstreamMode = 'truncated';
    const { data } = await post({
      model: 'copilot-pulse',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.ok(data.includes('Partial answer'), 'content produced before the cut must be preserved');
    assert.ok(
      /"finish_reason"\s*:\s*"stop"/.test(data),
      'proxy MUST synthesize a finish_reason chunk when the provider omits it'
    );
    assert.ok(data.includes('data: [DONE]'), 'proxy MUST synthesize the [DONE] sentinel');
  });

  it('BUG 2: a mid-chunk socket reset yields an error notice AND a clean terminator', async () => {
    upstreamMode = 'reset';
    upstreamHits = 0;
    const { data } = await post({
      model: 'copilot-pulse',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.ok(data.includes('Before the reset'), 'already-streamed content must survive');
    assert.ok(data.includes('data: [DONE]'), 'stream must be closed with [DONE], never left hanging');
    assert.ok(
      /"finish_reason"\s*:\s*"stop"/.test(data),
      'stream must carry a finish_reason so the agent knows the turn ended'
    );
    assert.equal(
      upstreamHits,
      1,
      'must NOT replay the request after data was already delivered (that duplicated output)'
    );
  });

  it('BUG 3: an upstream HTTP 500 closes the stream cleanly instead of hanging', async () => {
    upstreamMode = 'http500';
    const { data } = await post({
      model: 'copilot-pulse',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.ok(data.includes('Copilot Pulse Error'), 'the error must be surfaced to the user');
    assert.ok(data.includes('data: [DONE]'), 'the stream must still be terminated');
  });

  it('BUG 4: a well-formed upstream stream is NOT double-terminated', async () => {
    upstreamMode = 'complete';
    const { data } = await post({
      model: 'copilot-pulse',
      messages: [{ role: 'user', content: 'hello' }]
    });

    const doneCount = (data.match(/data: \[DONE\]/g) || []).length;
    const finishCount = (data.match(/"finish_reason"\s*:\s*"stop"/g) || []).length;

    assert.ok(data.includes('All good'), 'content must pass through');
    assert.equal(doneCount, 1, 'exactly one [DONE] must be emitted');
    assert.equal(finishCount, 1, 'exactly one finish_reason must be emitted');
  });
});

