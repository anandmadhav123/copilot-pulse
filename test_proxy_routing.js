const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const moduleLib = require('module');

const mockVscode = {
  window: { showErrorMessage: () => {} },
  workspace: { getConfiguration: () => ({ get: () => '' }) },
  StatusBarAlignment: { Right: 1, Left: 2 },
  authentication: { getSession: async () => ({ accessToken: 'fake' }) }
};
// Hack to mock vscode since it's an external module injected by the host
moduleLib._cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: mockVscode
};
// Patch require to resolve 'vscode' to our mock
const originalRequire = moduleLib.prototype.require;
moduleLib.prototype.require = function(request) {
  if (request === 'vscode') return mockVscode;
  return originalRequire.apply(this, arguments);
};

const { LocalProxyServer } = require('./out/proxy/LocalProxyServer.js');
const { RouterLogic } = require('./out/proxy/RouterLogic.js');
const { CopilotAuth } = require('./out/proxy/CopilotAuth.js');

// Mock CopilotAuth and fetch for fast, offline testing
CopilotAuth.getCopilotToken = async () => 'mock-copilot-token';
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  body: {
    getReader: () => {
      let sent = false;
      return {
        read: async () => {
          if (!sent) {
            sent = true;
            return {
              done: false,
              value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"mock answer"}}]}\n\ndata: [DONE]\n\n')
            };
          }
          return { done: true };
        }
      };
    }
  }
});

// Mock Config Getter simulating the Native Bridge setup
const mockConfigGetter = () => ({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "",
  cheapModel: "openai/gpt-4o-mini",
  strongModel: "openai/gpt-4o",
  useDynamicTiers: true,
  threshold: 6.5,
  lowThreshold: 4.0,
  availableModels: ["gpt-4o-mini", "gpt-4o", "claude-3.5-sonnet", "o3-mini", "o1"]
});

async function runTests() {
  console.log("Starting Test Suite: Proxy Router & Status Bar Validation\n");
  
  let passed = 0;
  let failed = 0;
  
  const proxy = LocalProxyServer.getInstance(mockConfigGetter);
  proxy.port = 3457; // Use different port for testing
  proxy.nativeRouteCallback = async () => {};
  
  proxy.server = http.createServer((req, res) => {
    if (req.url === "/models" || req.url === "/v1/models") {
      proxy.handleModels(req, res);
    } else if (req.url === "/chat/completions" || req.url === "/v1/chat/completions") {
      proxy.handleChatCompletions(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => {
    proxy.server.listen(proxy.port, '127.0.0.1', () => resolve());
  });
  console.log(`[Setup] Local Proxy Server started on port ${proxy.port}`);

  function sendMockRequest(payload) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: proxy.port,
        path: '/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  async function expectRoute(testName, payload, expectedModelRegex, expectedTier) {
    console.log(`Running Test: ${testName}`);
    try {
      await sendMockRequest(payload);
      
      const metrics = proxy.getMetrics();
      const latest = metrics[0];
      
      assert.ok(latest, "No metric record was generated (Status Bar would not update)");
      assert.ok(
        expectedModelRegex.test(latest.routedModel), 
        `Expected model to match ${expectedModelRegex}, but got ${latest.routedModel}`
      );
      if (expectedTier) {
        assert.ok(
          latest.tier.includes(expectedTier), 
          `Expected tier ${expectedTier}, got ${latest.tier}`
        );
      }
      
      console.log(`  ✅ Passed! (Routed to ${latest.routedModel}, Tier: ${latest.tier})`);
      passed++;
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
      failed++;
    }
  }

  // --- Test 1: Light Tier ---
  await expectRoute(
    "Light Tier Routing (Simple Question)",
    { messages: [{ role: "user", content: "how do I run a python file?" }] },
    /gpt-4o-mini/,
    "Light"
  );

  // --- Test 2: Medium Tier ---
  await expectRoute(
    "Medium Tier Routing (Code Debugging)",
    { messages: [{ role: "user", content: "fix this bug: Traceback (most recent call last): File 'main.py', line 10" }] },
    /(gpt-4o|claude|o3-mini)/,
    "Medium"
  );

  // --- Test 3: Heavy Tier ---
  await expectRoute(
    "Heavy Tier Routing (Architecture)",
    { messages: [{ role: "user", content: "design a highly scalable microservice architecture with load balancers and message queues" }] },
    /o1|o3/,
    "Heavy"
  );

  // --- Test 4: Copilot Agent Mode Payload Parsing ---
  // Agent mode sends content as an array of objects
  await expectRoute(
    "Agent Mode Payload Parsing",
    {
      messages: [{ 
        role: "user", 
        content: [
          { type: "text", text: "evaluate the time complexity of this recursive algorithm and optimize it to O(n) " }
        ] 
      }]
    },
    /o1|o3/,
    "Heavy"
  );

  // --- Test 5: Empty Prompt Routing ---
  await expectRoute(
    "Empty User Prompt with Router Model",
    { messages: [{ role: "user", content: "" }], model: "copilot-pulse" },
    /gpt-4o-mini/,
    "Light"
  );

  // --- Test 6: Internal Utility Bypass ---
  // When model is copilot-utility, proxy bypasses routing and does not record metric
  console.log("Running Test: Internal Utility Request Bypass");
  const metricsBefore = proxy.getMetrics().length;
  await sendMockRequest({ messages: [{ role: "user", content: "generate title" }], model: "copilot-utility" });
  const metricsAfter = proxy.getMetrics().length;
  assert.strictEqual(metricsBefore, metricsAfter, "Utility request should bypass metrics recording");
  console.log("  ✅ Passed! (Internal utility request bypassed successfully without metric pollution)");
  passed++;

  proxy.stop();
  console.log(`\nTest Suite Complete. Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Test Suite Crashed:", err);
  process.exit(1);
});
