import * as vscode from "vscode";
import * as https from "https";

export class CopilotAuth {
  private static cachedToken: string | undefined = undefined;
  private static tokenExpiresAt: number = 0;

  /**
   * Silently gets a Copilot Token using the user's active GitHub session.
   * If the token is cached and valid, it returns the cached token.
   */
  public static async getCopilotToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    // 1. Get the standard GitHub session token. We ask for read:user which Copilot uses.
    // createIfNone: true will prompt the user to grant Copilot Pulse access if they haven't yet.
    let session = await (vscode as any).authentication.getSession("github", ["read:user"], { createIfNone: true });
    if (!session) {
      // Try again without scopes, sometimes the session is just "github"
      session = await (vscode as any).authentication.getSession("github", [], { createIfNone: true });
    }

    if (!session) {
      throw new Error("You are not signed in to GitHub in VS Code. Please sign in to use native Copilot routing without an API key.");
    }

    const githubToken = session.accessToken;

    // 2. Exchange it for a Copilot internal token
    const copilotTokenData = await this.exchangeForCopilotToken(githubToken);
    
    this.cachedToken = copilotTokenData.token;
    // Buffer expiration by 5 minutes
    this.tokenExpiresAt = (copilotTokenData.expires_at * 1000) - (5 * 60 * 1000);
    
    return this.cachedToken;
  }

  private static exchangeForCopilotToken(githubToken: string): Promise<{ token: string, expires_at: number }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        "https://api.github.com/copilot_internal/v2/token",
        {
          method: "GET",
          headers: {
            "Authorization": `token ${githubToken}`,
            "User-Agent": "CopilotPulse/1.0.0",
            "Accept": "application/json"
          }
        },
        (res: any) => {
          let data = "";
          res.on("data", (chunk: any) => data += chunk);
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const json = JSON.parse(data);
                resolve(json);
              } catch (e) {
                reject(new Error("Failed to parse Copilot token response"));
              }
            } else {
              reject(new Error(`Failed to get Copilot token: ${res.statusCode} ${data}`));
            }
          });
        }
      );
      req.on("error", (e: any) => reject(e));
      req.end();
    });
  }

  /**
   * Fetches the dynamically available models directly from the GitHub Copilot API
   * using the internal copilot token.
   */
  public static fetchAvailableModels(copilotToken: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        "https://api.githubcopilot.com/models",
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${copilotToken}`,
            "User-Agent": "CopilotPulse/1.0.0",
            "Accept": "application/json",
            "Editor-Version": "vscode/1.80.0",
            "Editor-Plugin-Version": "copilot-chat/0.1.0"
          }
        },
        (res: any) => {
          let data = "";
          res.on("data", (chunk: any) => data += chunk);
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const json = JSON.parse(data);
                let modelIds: string[] = [];
                if (Array.isArray(json.data)) {
                  modelIds = json.data.map((item: any) => typeof item === "string" ? item : item.id).filter(Boolean);
                } else if (Array.isArray(json)) {
                  modelIds = json.map((item: any) => typeof item === "string" ? item : item.id).filter(Boolean);
                }
                resolve(modelIds);
              } catch (e) {
                reject(new Error("Failed to parse Copilot models response"));
              }
            } else {
              reject(new Error(`Failed to get Copilot models: ${res.statusCode} ${data}`));
            }
          });
        }
      );
      req.on("error", (e: any) => reject(e));
      req.end();
    });
  }
}
