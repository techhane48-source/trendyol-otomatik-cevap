import path from "node:path";

import { DEV_PG, connectionUrl, startEmbeddedPostgres, stopEmbeddedPostgres } from "./embedded-pg";

/**
 * Geliştirme veritabanı: gömülü PostgreSQL (Docker/kurulum gerekmez).
 * `npm run pg:dev` ile çalıştırılır; Ctrl+C ile durur.
 */
async function main(): Promise<void> {
  const pg = await startEmbeddedPostgres(DEV_PG);

  console.log("Geliştirme PostgreSQL hazır.");
  console.log(`DATABASE_URL=${connectionUrl(DEV_PG)}`);
  console.log(`Veri dizini: ${path.relative(process.cwd(), DEV_PG.databaseDir)}`);
  console.log("Durdurmak için Ctrl+C.");

  const shutdown = async () => {
    console.log("\nPostgreSQL kapatılıyor...");
    await stopEmbeddedPostgres(pg, DEV_PG);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Gömülü PostgreSQL başlatılamadı:", error instanceof Error ? error.message : error);
  process.exit(1);
});
