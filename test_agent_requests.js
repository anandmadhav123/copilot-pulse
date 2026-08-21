const http = require('http');

function sendReq(model, stream, callback) {
  const payload = JSON.stringify({
    model: model,
    messages: [{ role: "user", content: "list directory" }],
    stream: stream
  });

  const req = http.request("http://127.0.0.1:3456/chat/completions", {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Authorization': 'Bearer fake-token'
    }
  }, (res) => {
    let body = "";
    res.on("data", chunk => body += chunk);
    res.on("end", () => {
      console.log(`\n--- Response for model=${model}, stream=${stream} ---`);
      console.log(`Status: ${res.statusCode}`);
      console.log(`Headers: ${JSON.stringify(res.headers)}`);
      console.log(`Body:\n${body}`);
      callback();
    });
  });
  req.on('error', err => console.error("Error:", err));
  req.write(payload);
  req.end();
}

console.log("Testing Agent requests against proxy...");
sendReq("copilot-pulse", true, () => {
  sendReq("copilot-utility-small", false, () => {
    sendReq("copilot-utility-small", true, () => {
      console.log("Done.");
    });
  });
});
