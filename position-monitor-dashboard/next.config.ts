import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Anchor the workspace to silence the multi-lockfile warning.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
