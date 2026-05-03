import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/youtube-dl-exec/bin/**/*",
      "./node_modules/ffmpeg-static/**/*"
    ],
  },
  serverExternalPackages: ['youtube-dl-exec', 'ffmpeg-static']
};

export default nextConfig;
