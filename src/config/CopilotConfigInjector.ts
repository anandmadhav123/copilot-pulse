import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Injects the Copilot Pulse proxy as a BYOK model into VS Code's configuration
 * so it appears in the model picker and works in both Chat and Agent modes.
 *
 * Injection targets (all are written):
 *   1. chatLanguageModels.json  — modern VS Code (1.99+) custom-endpoint format.
 *   2. byok.json                — legacy ~/.config/github-copilot format.
 *   3. settings.json            — VS Code user settings (customModels.enabled, byokModels.enabled).
 */
export class CopilotConfigInjector {
  // ── Legacy byok.json constants ────────────────────────────────────────
  private static readonly PROVIDER_ID = "OpenRouter";
  private static readonly PROXY_URL = "http://127.0.0.1:3456";
  private static readonly MODEL_ID = "copilot-pulse";

  // ── Modern chatLanguageModels.json constants ──────────────────────────
  private static readonly CLM_VENDOR = "customendpoint";
  private static readonly CLM_PROVIDER_NAME = "Copilot Pulse";
  /** Marker so we can find & update our entry in the array. */
  private static readonly CLM_PROVIDER_MARKER = "copilot-pulse-local-proxy";

  // =====================================================================
  //  Public entry point
  // =====================================================================

  /**
   * Writes (or removes) the BYOK model registration.
   *
   * @param byokConfigured whether `copilotPulse.baseUrl` AND `copilotPulse.apiKey`
   *        are both set.
   *
   * The BYOK models forward to the local proxy, which in turn needs an upstream
   * endpoint + key. With no key configured they are dead entries: selecting
   * "Copilot Pulse (Smart Router)" in the model picker yields
   * "Copilot Pulse is not configured…" on every prompt.
   *
   * Advertising a model that cannot answer is worse than not advertising it, so
   * we only register when it will actually work, and actively clean up stale
   * entries when it won't. Registration returns automatically as soon as the
   * user sets an API key.
   */
  public static injectConfig(byokConfigured: boolean = true): boolean {
    if (!byokConfigured) {
      const removed = this.removeChatLanguageModels();
      console.log(
        "[Copilot Pulse] No baseUrl/apiKey configured — BYOK models are not registered. " +
          "Use @copilotpulse (routes across your Copilot subscription) or set " +
          "copilotPulse.apiKey to enable the model-picker entries."
      );
      // settings.json flags are harmless and needed the moment a key is added.
      this.injectSettingsJson();
      return removed;
    }

    const a = this.injectChatLanguageModels();
    const b = this.injectByokJson();
    const c = this.injectSettingsJson();
    return a || b || c;
  }

  /**
   * Removes our entries from chatLanguageModels.json so the non-functional
   * models disappear from the picker. Leaves every other provider untouched.
   */
  private static removeChatLanguageModels(): boolean {
    try {
      const filePath = this.getChatLanguageModelsPath();
      if (!fs.existsSync(filePath)) return false;

      const raw = fs.readFileSync(filePath, "utf-8").trim();
      const parsed = JSON.parse(raw || "[]");
      if (!Array.isArray(parsed)) return false;

      const remaining = parsed.filter(
        (p: any) =>
          p?._copilotPulseMarker !== this.CLM_PROVIDER_MARKER &&
          !(p?.name === this.CLM_PROVIDER_NAME && p?.vendor === this.CLM_VENDOR)
      );

      if (remaining.length === parsed.length) return false; // nothing of ours present

      fs.writeFileSync(filePath, JSON.stringify(remaining, null, 2), "utf-8");
      console.log("[Copilot Pulse] Removed unconfigured BYOK models from the model picker.");
      return true;
    } catch (e: any) {
      console.warn("[Copilot Pulse] Could not clean chatLanguageModels.json:", e?.message || e);
      return false;
    }
  }

  /**
   * Programmatically enable settings required for BYOK in Agent mode.
   * Must be called from the extension activate() where `vscode` is available.
   */
  public static async enableAgentHostSettings(vscodeApi: any): Promise<void> {
    try {
      const config = vscodeApi.workspace.getConfiguration("chat");
      const current = config.inspect("agentHost.byokModels.enabled");
      if (!current?.globalValue) {
        await config.update("agentHost.byokModels.enabled", true, vscodeApi.ConfigurationTarget.Global);
        console.log("[Copilot Pulse] Enabled chat.agentHost.byokModels.enabled");
      }
    } catch (e: any) {
      console.warn("[Copilot Pulse] Could not enable agentHost.byokModels via API:", e?.message || e);
    }
  }

  // =====================================================================
  //  settings.json (User Settings)
  // =====================================================================

  private static getSettingsPath(): string {
    const home = os.homedir();
    if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Code", "User", "settings.json");
    } else if (process.platform === "win32") {
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "settings.json");
    } else {
      return path.join(home, ".config", "Code", "User", "settings.json");
    }
  }

  private static injectSettingsJson(): boolean {
    try {
      const filePath = this.getSettingsPath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let settings: any = {};
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, "utf-8").trim();
          if (raw.startsWith('"') && !raw.startsWith('{')) {
            settings = JSON.parse(`{${raw}}`);
          } else {
            settings = JSON.parse(raw || "{}");
          }
        } catch {
          settings = {};
        }
      }

      settings["github.copilot.advanced"] = {
        ...(settings["github.copilot.advanced"] || {}),
        "debug.overrideChatEngine": "gpt-4",
        "debug.overrideProxyUrl": this.PROXY_URL,
        "customModels.enabled": true
      };
      settings["chat.agentHost.byokModels.enabled"] = true;

      fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
      console.log(`[Copilot Pulse] Updated settings in ${filePath}`);
      return true;
    } catch (e: any) {
      console.error("[Copilot Pulse] Failed to inject settings.json:", e?.message || e);
      return false;
    }
  }

  // =====================================================================
  //  chatLanguageModels.json (modern — Agent-mode compatible)
  // =====================================================================

  private static getChatLanguageModelsPath(): string {
    const home = os.homedir();
    if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
    } else if (process.platform === "win32") {
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "chatLanguageModels.json");
    } else {
      return path.join(home, ".config", "Code", "User", "chatLanguageModels.json");
    }
  }

  private static injectChatLanguageModels(): boolean {
    try {
      const filePath = this.getChatLanguageModelsPath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let providers: any[] = [];
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, "utf-8").trim();
          const parsed = JSON.parse(raw || "[]");
          providers = Array.isArray(parsed) ? parsed : [];
        } catch {
          providers = [];
        }
      }

      // Remove any existing Copilot Pulse entry
      providers = providers.filter(
        (p: any) =>
          p?._copilotPulseMarker !== this.CLM_PROVIDER_MARKER &&
          !(p?.name === this.CLM_PROVIDER_NAME && p?.vendor === this.CLM_VENDOR)
      );

      // Build the new entry
      const entry: any = {
        _copilotPulseMarker: this.CLM_PROVIDER_MARKER,
        name: this.CLM_PROVIDER_NAME,
        vendor: this.CLM_VENDOR,
        apiKey: "copilot-pulse",
        apiType: "chat-completions",
        models: [
          {
            id: "copilot-pulse",
            name: "Copilot Pulse (Smart Router)",
            url: `${this.PROXY_URL}/v1/chat/completions`,
            toolCalling: true,
            vision: true,
            maxInputTokens: 128000,
            maxOutputTokens: 16384
          },
          {
            id: "copilot-pulse-agent",
            name: "Copilot Pulse Agent",
            url: `${this.PROXY_URL}/v1/chat/completions`,
            toolCalling: true,
            vision: true,
            maxInputTokens: 128000,
            maxOutputTokens: 16384
          },
          {
            id: "copilot-pulse-router",
            name: "Copilot Pulse Router",
            url: `${this.PROXY_URL}/v1/chat/completions`,
            toolCalling: true,
            vision: true,
            maxInputTokens: 128000,
            maxOutputTokens: 16384
          }
        ]
      };

      providers.push(entry);
      fs.writeFileSync(filePath, JSON.stringify(providers, null, 2), "utf-8");
      console.log(`[Copilot Pulse] Registered in ${filePath}`);
      return true;
    } catch (e: any) {
      console.error("[Copilot Pulse] Failed to inject chatLanguageModels.json:", e?.message || e);
      return false;
    }
  }

  // =====================================================================
  //  byok.json (legacy fallback)
  // =====================================================================

  private static injectByokJson(): boolean {
    try {
      const userHome = os.homedir();
      const byokFile = path.join(userHome, ".config", "github-copilot", "byok.json");

      const dir = path.dirname(byokFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let jsonObj: any = {};
      if (fs.existsSync(byokFile)) {
        try {
          const content = fs.readFileSync(byokFile, "utf-8");
          jsonObj = JSON.parse(content);
        } catch {
          jsonObj = {};
        }
      }

      const modelsConfig: any = {
        [this.MODEL_ID]: {
          isRegistered: true,
          isCustomModel: true,
          modelCapabilities: {
            name: "Copilot Pulse (Smart Router)",
            toolCalling: true,
            vision: true
          }
        },
        "copilot-pulse-agent": {
          isRegistered: true,
          isCustomModel: true,
          modelCapabilities: {
            name: "Copilot Pulse Agent",
            toolCalling: true,
            vision: true
          }
        },
        "copilot-pulse-router": {
          isRegistered: true,
          isCustomModel: true,
          modelCapabilities: {
            name: "Copilot Pulse Router",
            toolCalling: true,
            vision: true
          }
        }
      };

      // Inject provider & custom models for OpenRouter, OpenAI, and custom ID
      jsonObj[`${this.PROVIDER_ID}-baseUrl`] = this.PROXY_URL;
      jsonObj[`${this.PROVIDER_ID}-api-key`] = "copilot-pulse";
      jsonObj[`${this.PROVIDER_ID}-models-config`] = modelsConfig;

      jsonObj["OpenAI-baseUrl"] = this.PROXY_URL;
      jsonObj["OpenAI-api-key"] = "copilot-pulse";
      jsonObj["OpenAI-models-config"] = modelsConfig;

      fs.writeFileSync(byokFile, JSON.stringify(jsonObj, null, 2), "utf-8");
      console.log("[Copilot Pulse] Registered Copilot Pulse models in ~/.config/github-copilot/byok.json");
      return true;
    } catch (e: any) {
      console.error("[Copilot Pulse] Failed to inject Copilot BYOK configuration:", e);
      return false;
    }
  }
}
