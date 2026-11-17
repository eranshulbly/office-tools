import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server Actions are enabled by default in Next 15; keep body limit sane.
    // Raised from 2mb for resume uploads (capped at 5mb in the interviews
    // action). Below this, Next rejects the request before our own size check
    // runs, so the user gets an opaque failure instead of a clear message.
    serverActions: {
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
