import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type EmbeddedPostgres from "embedded-postgres";

import {
  TEST_PG,
  connectionUrl,
  startEmbeddedPostgres,
  stopEmbeddedPostgres,
} from "../scripts/embedded-pg";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pg: EmbeddedPostgres | undefined;

/**
 * Testler için gömülü PostgreSQL başlatır ve migration'ları uygular.
 * Docker veya harici PostgreSQL kurulumu gerekmez.
 */
export async function setup(): Promise<void> {
  pg = await startEmbeddedPostgres(TEST_PG, { quiet: true });

  const env = { ...process.env, DATABASE_URL: connectionUrl(TEST_PG) };

  execFileSync("node", [path.join(rootDir, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
    cwd: rootDir,
    env,
    stdio: "pipe",
  });
}

export async function teardown(): Promise<void> {
  if (pg) await stopEmbeddedPostgres(pg, TEST_PG);
  pg = undefined;
}
