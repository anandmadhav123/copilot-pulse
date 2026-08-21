# Changelog

All notable changes to **Copilot Pulse** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-21

### Added
- **Intelligent model router** — scores each prompt's complexity (0–10) and routes
  it across the Light / Medium / Heavy tiers built dynamically from your GitHub
  Copilot subscription models.
- **Automatic tier escalation** — when the selected model can't finish a task
  (stuck tool loops, repeated tool errors, empty or malformed responses,
  self-declared incapacity, or user dissatisfaction), Pulse automatically retries
  on a stronger model, capped per conversation.
- **Context-aware scoring (routing v2)** — conversation stickiness, attachment and
  structure signals, and tool-aware tiering, with an explainable per-signal
  breakdown surfaced in the dashboard.
- **Context-overflow recovery** — oversized prompts are progressively shrunk
  (escalate → drop history → drop tools) instead of failing.
- **Live routing dashboard** — savings rate, credit usage, tier/model/task
  distributions, and a live decision log.
- **`@copilotpulse` chat participant** — sticky, routes across your Copilot
  subscription with no API key required.
- **BYOK model-picker integration** — optional routing through your own
  OpenAI-compatible endpoint (requires the `languageModelChatProvider` proposed API).
- Commands: **Open Dashboard**, **Show Supported Models**, **Test Connection**.
- Configuration for thresholds, stickiness, agent turn budget, and escalation
  behaviour.

### Security
- All dynamic values rendered in the dashboard webview are HTML-escaped,
  including model and tier names (which can originate from workspace settings).

[1.0.0]: https://github.com/your-org/copilot-pulse-vscode/releases/tag/v1.0.0

