import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { Router } from "express";
import type { Audit } from "./security/audit.js";

class PolicyDenied extends Error {}

export interface Policy {
  agent?(userId: string, deviceId: string, pointId: string): Promise<void>;
  viewer?(
    userId: string,
    sessionId: string,
    pointId: string,
    viewerId: string,
  ): Promise<boolean>;
  media?(userId: string, bytes: number): Promise<boolean>;
}
export interface PluginContext {
  apiVersion: 1;
  deny: (message: string) => never;
  pool: Pool;
  audit: Audit;
  router: Router;
  policies: Policy[];
  requireIdentity: import("express").RequestHandler;
}
export class Plugins {
  readonly policies: Policy[] = [];
  readonly loaded: string[] = [];
  private disposers: Array<() => Promise<void>> = [];
  async load(context: Omit<PluginContext, "apiVersion" | "policies" | "deny">) {
    for (const name of (process.env.EXCHANGE_PLUGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || this.loaded.includes(name))
        throw new Error("Invalid or duplicate plugin name");
      const path = new URL(
        `../../../private-plugins/${name}/index.mjs`,
        import.meta.url,
      );
      const plugin = await import(fileURLToPath(path));
      if (plugin.apiVersion !== 1 || typeof plugin.register !== "function")
        throw new Error(`Incompatible plugin: ${name}`);
      const dispose = await plugin.register({
        ...context,
        apiVersion: 1,
        deny: (message: string) => {
          throw new PolicyDenied(message);
        },
        policies: this.policies,
      });
      if (dispose) this.disposers.push(dispose);
      this.loaded.push(name);
    }
  }
  isDenied(error: unknown) {
    return error instanceof PolicyDenied;
  }
  async agent(userId: string, deviceId: string, pointId: string) {
    for (const policy of this.policies)
      await policy.agent?.(userId, deviceId, pointId);
  }
  async viewer(
    userId: string,
    sessionId: string,
    pointId: string,
    viewerId: string,
  ) {
    for (const policy of this.policies)
      if (
        policy.viewer &&
        !(await policy.viewer(userId, sessionId, pointId, viewerId))
      )
        return false;
    return true;
  }
  async media(userId: string, bytes: number) {
    for (const policy of this.policies)
      if (policy.media && !(await policy.media(userId, bytes))) return false;
    return true;
  }
  async close() {
    for (const dispose of this.disposers.reverse()) await dispose();
  }
}
