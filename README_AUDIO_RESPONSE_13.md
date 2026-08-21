# Notes for response
- Can we build the UI? **Yes, absolutely.** We can use the official `VS Code Webview UI Toolkit` (React/WebComponents) to build a sidebar that looks 100% identical to Copilot Chat, down to the exact fonts, colors, and animations.
- But will it work as smoothly as Agent Mode? **No, not without months of engineering.**
- Explain why: The UI is just the tip of the iceberg. The real magic of Copilot Agent Mode is its hidden context engine. When you type in Copilot, it secretly reads your open tabs, parses your terminal output, indexes your workspace symbols, and seamlessly applies diffs to your code.
- If we build our own UI, we lose access to Copilot's proprietary context engine. We would have to build our own AI Agent from scratch to read files, run terminal commands, and apply code edits.
- This is exactly what tools like **Cline, Cursor, and Aider** have spent years and millions of dollars building. 
- Conclusion: If you want the raw power and native smoothness of Copilot's context-awareness, sticking with the **Status Bar** proxy approach is the absolute best way to get Dynamic Tiering without having to rebuild a multi-million dollar AI infrastructure from scratch!
