import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "./env";

/**
 * Prisma 7 sürücü adaptörü kullanır: bağlantı PostgreSQL'e node-postgres üzerinden gider.
 * İstemci tembel (lazy) oluşturulur; böylece `next build` sırasında ortam değişkeni
 * zorunlu olmaz ve testler kendi veritabanına bağlanabilir.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

type GlobalWithPrisma = typeof globalThis & { __trendyolPrisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  const globalRef = globalThis as GlobalWithPrisma;
  if (!globalRef.__trendyolPrisma) {
    globalRef.__trendyolPrisma = createPrismaClient(getEnv().DATABASE_URL);
  }
  return globalRef.__trendyolPrisma;
}

/** Testlerde / komut satırı betiklerinde bağlantıyı kapatmak için. */
export async function disconnectPrisma(): Promise<void> {
  const globalRef = globalThis as GlobalWithPrisma;
  if (globalRef.__trendyolPrisma) {
    await globalRef.__trendyolPrisma.$disconnect();
    delete globalRef.__trendyolPrisma;
  }
}
