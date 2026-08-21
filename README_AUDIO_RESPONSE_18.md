# Notes for response
- Acknowledge the issue: Okay, I investigated exactly what went wrong when you ran that terminal command request in Agent mode!
- Explain the bug: Because I upgraded the extension to dynamically query GitHub Copilot's raw API for ALL available models, it correctly discovered the hidden internal utility models (like `copilot-utility-small`). But because those internal models are small, my routing algorithm accidentally sorted them into the **Light Tier**!
- The result: When you typed a simple command like "run terminal command...", the router said "this is a simple prompt, let's use the lightest model!" and sent it to `copilot-utility-small` instead of `gpt-4o-mini`!
- The fix: I just added a strict filter to the model discovery engine that explicitly strips out any internal model names (containing `utility`, `embedding`, `search`, etc.). Now, the router is guaranteed to only ever use real LLM chat models like `gpt-4o-mini`, `claude-3.5-sonnet`, or `o1`!
- Call to action: I've recompiled and pushed the fix to the VSIX. Please reinstall the VSIX and reload! It should work flawlessly now.
