import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let psScriptCounter = 0;

/**
 * PowerShell komutunu geçici bir `.ps1` dosyası üzerinden çalıştırır.
 * `-Command "..."` biçiminde iç içe tırnaklar Windows'ta bozulduğu için dosya yolu tercih edilir.
 */
function runPowerShell(script: string): void {
  if (process.platform !== "win32") return;

  const file = path.join(os.tmpdir(), `trendyol-pg-${process.pid}-${psScriptCounter++}.ps1`);
  try {
    fs.writeFileSync(file, script, "utf8");
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`, { stdio: "ignore" });
  } catch {
    // yut: temizlik en iyi çabadır
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // yut
    }
  }
}

export interface LocalPgConfig {
  port: number;
  databaseDir: string;
  database: string;
  user: string;
  password: string;
}

export const DEV_PG: LocalPgConfig = {
  port: Number(process.env.LOCAL_PG_PORT ?? 55432),
  databaseDir: path.resolve(process.cwd(), ".pgdata/dev"),
  database: "trendyol_dev",
  user: "postgres",
  password: "postgres",
};

export const TEST_PG: LocalPgConfig = {
  port: Number(process.env.LOCAL_PG_TEST_PORT ?? 55433),
  databaseDir: path.resolve(process.cwd(), ".pgdata/test"),
  database: "trendyol_test",
  user: "postgres",
  password: "postgres",
};

export function connectionUrl(cfg: LocalPgConfig): string {
  return `postgresql://${cfg.user}:${cfg.password}@127.0.0.1:${cfg.port}/${cfg.database}?schema=public`;
}

/**
 * Yetim kalmış postgres.exe süreçlerini sonlandırır (üst süreci artık yaşamıyorsa).
 * Windows'ta postmaster kapansa bile `io_worker` gibi alt süreçler paylaşılan belleği
 * tutabildiği için yeni küme "pre-existing shared memory block is still in use"
 * hatasıyla başlamaz. Canlı bir kümenin süreçleri (üst süreç yaşıyor) KORUNUR.
 */
export function killOrphanPostgresProcesses(): void {
  if (process.platform !== "win32") return;

  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | ForEach-Object {",
    "  $parentAlive = Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue",
    "  if (-not $parentAlive) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "}",
  ].join("\n");

  runPowerShell(script);
}

/**
 * Bu projeye ait postgres.exe süreçlerini (veri dizini eşleşmesiyle) sonlandırır.
 * Windows'ta postmaster kapansa bile `io_worker` gibi alt süreçler paylaşılan
 * belleği tutabildiği için yeni küme "pre-existing shared memory block is still
 * in use" hatasıyla başlamaz.
 */
export function killProjectPostgresProcesses(dataDir: string): void {
  if (process.platform !== "win32") return;

  const variants = [dataDir, dataDir.replace(/\\/g, "/"), dataDir.replace(/\//g, "\\")]
    .map((value) => value.replace(/'/g, "''"))
    .filter((value, index, list) => list.indexOf(value) === index);

  const condition = variants.map((value) => `$_.CommandLine -like '*${value}*'`).join(" -or ");
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" |",
    `Where-Object { ${condition} } |`,
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("\n");

  runPowerShell(script);
}

/** Verilen portu dinleyen süreçleri sonlandırır (test/geliştirme portları bu projeye aittir). */
export function killListenersOnPort(port: number): void {
  try {
    const output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
    const pids = new Set<string>();

    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
    }

    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      } catch {
        // süreç zaten kapanmış olabilir
      }
    }
  } catch {
    // netstat yoksa (Windows dışı) sessizce geç
  }
}

/** Geliştirme/test için gömülü (embedded) PostgreSQL başlatır. Docker veya kurulum gerekmez. */
export async function startEmbeddedPostgres(
  cfg: LocalPgConfig,
  opts: { createDatabase?: boolean; quiet?: boolean } = {},
): Promise<EmbeddedPostgres> {
  const log = opts.quiet ? () => {} : undefined;
  const pg = new EmbeddedPostgres({
    databaseDir: cfg.databaseDir,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    persistent: true,
    autoRehydrateSymlinks: true,
    // Windows'ta varsayılan yerel ayar (tr-TR) initdb tarafından reddedilir.
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    ...(log ? { onLog: log, onError: log } : {}),
  });

  // Önceki çalıştırmadan kalan postgres süreçlerini temizle.
  killOrphanPostgresProcesses();
  killProjectPostgresProcesses(cfg.databaseDir);
  killListenersOnPort(cfg.port);
  const pidFile = path.join(cfg.databaseDir, "postmaster.pid");
  if (fs.existsSync(pidFile)) fs.rmSync(pidFile, { force: true });

  // Daha önce başlatılmış bir küme varsa initdb tekrar çalıştırılmaz.
  const alreadyInitialised = fs.existsSync(path.join(cfg.databaseDir, "PG_VERSION"));
  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();

  if (opts.createDatabase !== false) {
    try {
      await pg.createDatabase(cfg.database);
    } catch (err) {
      // Zaten varsa sorun değil.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    }
  }

  return pg;
}

/**
 * Kümeyi kapatır. Windows'ta `stop()` bazen süreci arkada bırakabildiği için
 * postmaster.pid üzerinden zorla sonlandırma da denenir.
 */
export async function stopEmbeddedPostgres(
  pg: EmbeddedPostgres,
  cfg: LocalPgConfig,
): Promise<void> {
  try {
    // Graceful shutdown bazen Windows'ta asılı kalır: 5 sn sonra zorla kapatılır.
    await Promise.race([
      pg.stop().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  } catch {
    // yut: aşağıdaki zorla kapatma devreye girer
  }

  const pidFile = path.join(cfg.databaseDir, "postmaster.pid");
  if (fs.existsSync(pidFile)) {
    const pid = fs.readFileSync(pidFile, "utf8").split(/\r?\n/)[0]?.trim();
    if (pid && /^\d+$/.test(pid)) {
      try {
        process.kill(Number(pid));
      } catch {
        // süreç zaten kapanmış olabilir
      }
    }

    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      // yut
    }
  }

  // Portu hâlâ dinleyen bir süreç kaldıysa zorla sonlandır.
  killListenersOnPort(cfg.port);
  killProjectPostgresProcesses(cfg.databaseDir);
  killOrphanPostgresProcesses();
}
