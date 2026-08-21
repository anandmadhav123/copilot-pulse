# ⚡ Copilot Pulse — Intelligent Model Router for GitHub Copilot

**Stop overpaying for simple prompts.** Copilot Pulse analyzes every request and automatically routes it to the *right* model in your GitHub Copilot subscription — a lightweight model for trivial asks, a heavyweight model for hard problems — and **auto-escalates** to a stronger model when a cheaper one gets stuck.

One agent. Every tier. Zero manual model-switching.

---

## Why Copilot Pulse?

GitHub Copilot gives you access to many models — from fast, cheap ones to powerful, premium ones. But you have to pick manually, and most people just leave it on one model: either overpaying premium credits for *"rename this variable"*, or under-powering a *"design a distributed system"* request.

Copilot Pulse fixes that:

- 🎯 **Automatic routing** — scores each prompt's complexity (0–10) and picks the optimal tier.
- ⬆️ **Auto-escalation** — if a lighter model loops, errors, or gives up, Pulse retries on a stronger model automatically. You don't have to notice or intervene.
- 💰 **Real savings** — trivial prompts stay on cheap models, so premium credits are spent only where they matter.
- 📊 **Live dashboard** — see every routing decision, your savings rate, and credit usage in real time.

---

## Features

### 🧠 Context-aware complexity scoring
Pulse doesn't just keyword-match. It weighs:
- **Intent** — architecture vs. debugging vs. lookup vs. boilerplate
- **Structure** — multi-part requirements, code blocks, stack traces, diffs
- **Context** — attached files, cross-file references, workspace size
- **Conversation history** — a follow-up like *"now fix it"* inherits the depth of the conversation instead of collapsing to the cheapest model
- **Tool surface** — agent turns are routed to models that reliably emit tool calls

Every decision comes with an **explainable score breakdown** in the dashboard.

### ⬆️ Automatic tier escalation
The headline feature. When the selected model can't finish the job, Pulse detects it and moves up a tier — `Light → Medium → Heavy` — carrying the full conversation forward. Triggers include:
- Repeating the same tool call without progress (stuck loops)
- Repeated tool failures
- Context-window overflow (auto-shrinks the request, then upgrades)
- Empty or malformed responses
- The model explicitly saying it can't do the task
- You replying *"that's still wrong"*

Escalation is capped per conversation so it never runs away on cost.

### 📊 Live routing dashboard
A dedicated side-panel view showing:
- Total queries routed & **savings rate**
- Premium credits used vs. saved
- Tier / model / task-type distribution
- A live log of recent routing decisions with the score breakdown behind each one

### 🛡️ Robust by design
- Streams never stop mid-answer — interrupted responses recover gracefully.
- Malformed or oversized prompts degrade cleanly instead of crashing.
- Long multi-step agent tasks run to completion (up to a configurable turn budget).

---

## Getting started

1. **Install** Copilot Pulse (you'll need GitHub Copilot Chat installed and signed in).
2. Open the **Chat** view, choose the **`Copilot Pulse Agent`** chat mode.
3. Type **`@copilotpulse`** once at the start of your conversation, then chat normally.

That's it. Pulse routes across the models already in your Copilot subscription — **no API key required**. The `@copilotpulse` participant is *sticky*, so follow-up messages route automatically without re-typing it.

> 💡 Run **`Copilot Pulse: Show Supported Models`** from the Command Palette to see which of your subscription models landed in each tier.

---

## Usage modes

| Mode | How | Uses | Notes |
|------|-----|------|-------|
| **Chat participant** *(recommended)* | Type `@copilotpulse` | Your **GitHub Copilot subscription** models | No API key. Works on stable VS Code. |
| **BYOK model picker** | Select *"Copilot Pulse (Smart Router)"* | **Your own** OpenAI-compatible endpoint | Requires `copilotPulse.baseUrl` + `copilotPulse.apiKey`, and the `languageModelChatProvider` proposed API (VS Code Insiders / dev host). |

The BYOK picker entries only appear once you've configured an endpoint — so you'll never see a model in the picker that can't answer.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotPulse.threshold` | `6.5` | Score at/above which a prompt routes to the **Heavy** tier. |
| `copilotPulse.lowThreshold` | `4.0` | Score below which a prompt routes to the **Light** tier. |
| `copilotPulse.routing.v2` | `true` | Context-aware routing engine. Disable for the legacy keyword-only scorer. |
| `copilotPulse.routing.stickiness` | `2.5` | How much complexity a conversation may shed per turn (~one tier). |
| `copilotPulse.maxAgentTurns` | `25` | Max tool round-trips before the agent pauses and asks to continue. |
| `copilotPulse.escalation.enabled` | `true` | Auto-retry on a stronger model when the current one can't finish. |
| `copilotPulse.escalation.maxEscalationsPerConversation` | `2` | Cost guard on escalations. |
| `copilotPulse.escalation.triggers` | *(all)* | Which failure signals may trigger an escalation. |
| `copilotPulse.baseUrl` / `copilotPulse.apiKey` | — | Optional OpenAI-compatible endpoint for BYOK mode. |

---

## Commands

- **Copilot Pulse: Open Dashboard** — the live routing view.
- **Copilot Pulse: Show Supported Models** — your discovered models grouped into tiers.
- **Copilot Pulse: Test Connection** — verify a configured BYOK endpoint.

---

## Requirements

- **VS Code 1.95.0** or newer.
- **GitHub Copilot** + **GitHub Copilot Chat**, signed in.
- BYOK model-picker entries additionally require the `languageModelChatProvider` proposed API (VS Code Insiders or an extension dev host).

---

## Privacy

Copilot Pulse runs **entirely locally**. Prompt scoring and routing happen on your machine; your prompts are sent only to the model provider you're already using (your Copilot subscription, or your own configured endpoint). Pulse adds no telemetry and no third-party servers.

---

## Known limitations

- The BYOK model-picker entries depend on a VS Code **proposed API** and won't appear on stable builds — use the `@copilotpulse` participant there instead.
- Model tiering is inferred from model names/families; brand-new models may need a release to be classified optimally.

---

## License

[MIT](./LICENSE) © 2026 Copilot Pulse

