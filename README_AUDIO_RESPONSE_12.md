# Notes for response
- Directly answer the question: **No. There is absolutely no plugin in the VS Code Marketplace that can do this.**
- Explain why: VS Code has extremely strict, sandboxed security boundaries. Extensions are completely isolated from each other and from the core UI. Microsoft explicitly forbids any extension from touching the DOM or modifying the internal state/UI of another extension (like GitHub Copilot).
- There is no public VS Code API to change the Copilot dropdown.
- This is exactly why we had to resort to the "Monkey Patch" (which ultimately failed because macOS Gatekeeper physically blocked it). 
- If such a feature were possible through a normal plugin, we would have just used the official VS Code API instead of trying to hack the binaries!
- Other popular AI coding assistants (like Cline or Aider) bypass this by completely ignoring the Copilot UI and building their own separate sidebars from scratch.
