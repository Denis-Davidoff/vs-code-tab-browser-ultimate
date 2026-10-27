import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import type { NextConfig } from "next";
if (existsSync("../../.env")) loadEnvFile("../../.env");
const config: NextConfig = {
  turbopack: { root: fileURLToPath(new URL("../../../", import.meta.url)) },
  async headers() {
    return [{
      source: "/remote-chat/:path*",
      headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
    }];
  },
  async rewrites() {
    return [
      {
        source: "/ws/:path*",
        destination: `${process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001"}/ws/:path*`,
      },
      {
        source: "/api/:path*",
        destination: `${process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001"}/api/:path*`,
      },
    ];
  },
};
export default config;
