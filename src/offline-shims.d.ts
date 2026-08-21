/**
 * OFFLINE BUILD SHIMS
 * -------------------
 * This file only exists so `tsc` can emit JavaScript when the real type
 * packages (`@types/vscode`, `@types/node`) cannot be installed because the
 * npm registry is unreachable (offline / behind proxy).
 *
 * Everything here is typed as `any` — it provides NO real type-safety, it just
 * lets the compiler resolve the `vscode` module and Node builtins.
 *
 * When you build ONLINE (`npm install` pulls @types/vscode + @types/node),
 * DELETE this file and use the normal `npm run compile` for full type-checking.
 */

declare module "vscode" {
  // Types used in annotations / implements clauses.
  export type ExtensionContext = any;
  export type ChatRequest = any;
  export type ChatContext = any;
  export type ChatResponseStream = any;
  export type CancellationToken = any;
  export type WebviewView = any;
  export type WebviewViewProvider = any;
  export type WebviewViewResolveContext = any;
  export type Webview = any;
  export type Uri = any;
  export type Disposable = any;

  // Values (namespaces / classes) accessed at runtime.
  export interface WorkspaceConfiguration {
    get<T>(section: string): T | undefined;
    [key: string]: any;
  }
  export const window: any;
  export const workspace: { getConfiguration(section?: string): WorkspaceConfiguration; [key: string]: any };
  export const commands: any;
  export const chat: any;
  export const lm: any;
  export const env: any;
  export const Uri: any;
  export const ThemeIcon: any;
  export const StatusBarAlignment: any;
  export const ProgressLocation: any;
  export const LanguageModelChatMessage: any;
  export const LanguageModelChatMessageRole: any;
  export const LanguageModelTextPart: any;
  export const LanguageModelToolCallPart: any;
  export const LanguageModelToolResultPart: any;
}

declare module "http" {
  export type Server = any;
  export type IncomingMessage = any;
  export type ServerResponse = any;
  export const createServer: any;
  export const request: any;
}

declare module "https" {
  export type RequestOptions = any;
  export const request: any;
}

declare module "url" {
  export const URL: any;
  export type URL = any;
}

declare module "fs";
declare module "path";
declare module "os";
declare module "assert";
declare module "net" {
  export type Socket = any;
}

// Node.js globals used by the proxy/server code.
declare type Buffer = any;
declare var console: any;
declare var Buffer: any;
declare var process: any;
declare var require: any;
declare var module: any;
declare var __dirname: string;
declare var __filename: string;
declare var AbortController: any;
declare type AbortController = any;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function clearInterval(handle: any): void;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function clearTimeout(handle: any): void;




