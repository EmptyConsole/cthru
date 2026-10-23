import type { NextConfig } from "next";

// GitHub Actions sets GITHUB_ACTIONS. Project sites are served from
// https://<user>.github.io/<repo>/, so the static export needs that prefix.
// A user site (<user>.github.io) is served from /, and local `next dev` is too.
const pages = process.env.GITHUB_ACTIONS === "true";
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const basePath =
  pages && repo && !repo.endsWith(".github.io") ? `/${repo}` : "";

const nextConfig: NextConfig = {
  // Let phones on the local network load the dev server (see `npm run dev:phone`).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
  // Cache Components turns on partial prerendering, which static export rejects.
  // Local dev and `next start` keep it; the GitHub Pages build does not.
  ...(!pages ? { cacheComponents: true, partialPrefetching: true } : {}),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  ...(pages
    ? {
        output: "export" as const,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
  ...(basePath ? { basePath } : {}),
};

export default nextConfig;
