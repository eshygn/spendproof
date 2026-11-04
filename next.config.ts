import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // z3-solver ships a threaded WASM build and better-sqlite3 is a native addon:
  // both must be loaded by Node at runtime, never bundled.
  serverExternalPackages: ["z3-solver", "better-sqlite3"],
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
};

export default nextConfig;
