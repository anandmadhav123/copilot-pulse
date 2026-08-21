const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Hack to mock vscode since it's an external module injected by the host
const moduleLib = require('module');
const mockVscode = {
  window: { showErrorMessage: () => {} },
  workspace: { getConfiguration: () => ({ get: () => '' }) },
  StatusBarAlignment: { Right: 1, Left: 2 },
  authentication: { getSession: async () => ({ accessToken: 'fake' }) }
};
moduleLib._cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: mockVscode };
const originalRequire = moduleLib.prototype.require;
moduleLib.prototype.require = function(request) {
  if (request === 'vscode') return mockVscode;
  return originalRequire.apply(this, arguments);
};

const { LocalProxyServer } = require('./out/proxy/LocalProxyServer.js');

describe("SSE Fragmentation Resilience (Agent Mode Chunking)", () => {
  let mockUpstreamServer;
  let proxyServer;
  let upstreamPort;
  
  before(async () => {
    // 1. Start a mock upstream provider that sends maliciously fragmented SSE chunks
    mockUpstreamServer = http.createServer((req, res) => {
      if (req.url === "/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        
        // Send a perfectly valid chunk first
        res.write(`data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n`);
        
        // Send an OpenRouter-style metadata chunk (no choices)
        res.write(`data: {"id":"gen-123","model":"upstream-model"}\n\n`);
        
        // Send a maliciously chunked Agent Mode Tool Call!
        // This simulates a large tool payload that gets split across multiple SSE data chunks
        res.write(`data: {"id":"2","choices":[{"delta":`);
        res.write(`{"tool_calls":[{"function":{"arguments":"{\\n`);
        res.write(`\\"code\\": \\"print('hello')\\"\\n}"}}]}}]}\n\n`);
        
        // Send DONE
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => {
      mockUpstreamServer.listen(0, "127.0.0.1", () => {
        upstreamPort = mockUpstreamServer.address().port;
        resolve();
      });
    });

    // 2. Start the LocalProxyServer pointing to our mock upstream
    const mockConfigGetter = () => ({
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key",
      cheapModel: "test-model",
      strongModel: "test-model",
      useDynamicTiers: false,
      threshold: 6.5,
      lowThreshold: 4.0,
      availableModels: ["test-model"]
    });

    proxyServer = LocalProxyServer.getInstance(mockConfigGetter);
    proxyServer.PORT = 13459; // use custom port
    proxyServer.nativeRouteCallback = undefined; // Force OpenAiClient HTTP proxy mode
    await proxyServer.start();
  });

  after(() => {
    mockUpstreamServer.close();
    proxyServer.stop();
  });

  it("should flawlessly reconstruct and rewrite highly fragmented SSE streams", () => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: 13459,
          path: "/v1/chat/completions",
          method: "POST",
          headers: { "Content-Type": "application/json" }
        },
        (res) => {
          let data = "";
          res.on("data", chunk => {
            data += chunk.toString("utf-8");
          });
          res.on("end", () => {
            try {
              // The proxy should have rewritten the model correctly
              // and most importantly, it MUST NOT have dropped the fragmented tool call chunk!
              
              // 1. Verify the first valid chunk is present and rewritten
              assert.ok(data.includes('"model":"copilot-pulse"'), "Should rewrite model in valid chunk");
              
              // 2. Verify the metadata chunk was SAFELY SKIPPED (because it lacks choices)
              assert.ok(!data.includes('"id":"gen-123"'), "Should safely skip chunks without choices");
              
              // 3. Verify the fragmented tool call was RECONSTRUCTED successfully
              assert.ok(data.includes('"id":"2"'), "Tool call chunk MUST be present and not dropped!");
              assert.ok(data.includes('print(\'hello\')'), "Tool call arguments MUST be intact");
              
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      
      req.on("error", reject);
      
      // Simulate an Agent Mode request
      req.write(JSON.stringify({
        model: "copilot-pulse",
        messages: [{ role: "user", content: "Write a python script" }],
        tools: [{ type: "function", function: { name: "test" } }]
      }));
      req.end();
    });
  });
});
