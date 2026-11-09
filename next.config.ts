import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Trendyol API anahtarları yalnızca sunucuda kullanılır; istemciye sızdırılmaz.
  serverExternalPackages: ["@prisma/adapter-pg"],
};

export default nextConfig;
