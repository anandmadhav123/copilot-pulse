# Notes for response
- **Installation**: Ensure the latest `copilot-pulse-vscode-1.0.0.vsix` is installed via `Extensions: Install from VSIX...` and reload the window.
- **How it works (Invisible Magic)**: You don't have to "do" anything special. You just use GitHub Copilot exactly as you normally would! 
  - Open Copilot Chat (`Cmd+L`) or Inline Chat (`Cmd+I`) and just type your prompt.
  - Make sure your Agent mode dropdown is just set to the standard default Copilot model.
- **How to tell it's working**: 
  - Look at the **bottom right corner** of your VS Code Status Bar.
  - As soon as you hit Enter on a prompt, you will see a lightning bolt icon `⚡` flash with the exact model it dynamically routed you to (e.g., `⚡ gpt-4o-mini` for simple questions, or `⚡ o1` for hard architecture questions).
- **The Dashboard**: You can click the `⚡` lightning bolt icon in the status bar at any time to open the **Copilot Pulse Dashboard**, which shows you real-time analytics, latency, and the exact complexity score it calculated for your recent prompts.
