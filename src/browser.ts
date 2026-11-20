import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';

/** Fehler mit HTTP-Status und optionalem Trace-Dateinamen für die API-Antwort. */
export class PortalError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code = 'PORTAL_ERROR',
    public trace?: string,
  ) {
    super(message);
  }

  /** Seitenzustand beim Fehler (URL + Accessibility-Baum), wenn DEBUG_SNAPSHOT aktiv ist. */
  page?: { url: string; snapshot?: string };
}

/** URL + ARIA-Snapshot der aktuellen Seite – zeigt Rollen/Namen, also genau das, was Locators sehen. */
async function capturePage(page: Page) {
  if (!config.debugSnapshot) return undefined;
  const url = page.url();
  const snapshot = await page
    .locator('body')
    .ariaSnapshot({ timeout: 5_000 })
    .then(redactSnapshot)
    .catch(() => undefined);
  return { url, snapshot };
}

/**
 * Lange Textknoten (z. B. Textebene einer geöffneten Lohnabrechnung im PDF-Viewer) werden
 * entfernt – der Snapshot soll Struktur und Bedienelemente zeigen, keine Dokumentinhalte.
 */
export function redactSnapshot(snapshot: string): string {
  const MAX_LINE = 160;
  const redacted = snapshot
    .split('\n')
    .map((line) =>
      line.length > MAX_LINE
        ? `${line.slice(0, line.indexOf(':') + 1 || 40)} «${line.length} Zeichen entfernt»`
        : line,
    )
    .join('\n');
  return redacted.length > 20_000 ? `${redacted.slice(0, 20_000)}\n…(gekürzt)` : redacted;
}

export const tracesDir = () => path.join(config.dataDir, 'traces');

/**
 * Ein persistentes Browser-Profil pro Portal.
 *
 * - Cookies (z. B. "Diesen Browser merken") überleben Neustarts, weil das Profil auf dem Volume liegt.
 * - Anfragen pro Portal laufen strikt nacheinander (ein Profil kann nur von einem Browser genutzt werden).
 * - Der Browser bleibt nach einer Anfrage `idleCloseMs` offen. So kann eine offene 2FA-Abfrage
 *   mit einem zweiten Aufruf (Code) fortgesetzt werden.
 * - Jede Anfrage ist ein eigener Trace-Chunk. Bei Fehlern wird er unter /data/traces gespeichert.
 */
export class PortalBrowser {
  private context?: BrowserContext;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;

  constructor(readonly name: string) {}

  run<T>(action: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const job = this.queue.then(() => this.exec(action, fn));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async exec<T>(action: string, fn: (page: Page) => Promise<T>): Promise<T> {
    clearTimeout(this.idleTimer);
    const context = await this.open();
    const page = context.pages()[0] ?? (await context.newPage());
    await context.tracing.startChunk({ title: `${this.name}: ${action}` });

    let result: T;
    try {
      result = await fn(page);
    } catch (err) {
      const pageState = await capturePage(page);
      const trace = await this.stopTrace(action, 'error');
      const error =
        err instanceof PortalError
          ? err
          : new PortalError(err instanceof Error ? err.message : String(err));
      error.trace = trace;
      error.page = pageState;
      this.scheduleIdleClose();
      throw error;
    }

    await this.stopTrace(action, config.traceAlways ? 'ok' : undefined);
    await this.saveCookies(context);
    this.scheduleIdleClose();
    return result;
  }

  private async open(): Promise<BrowserContext> {
    if (this.context) return this.context;

    const profileDir = path.join(config.dataDir, 'profiles', this.name);
    await fs.mkdir(profileDir, { recursive: true });
    // Nach einem harten Container-Neustart bleiben Chromium-Lockfiles liegen.
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      await fs.rm(path.join(profileDir, lock), { force: true });
    }

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      executablePath: config.executablePath,
      acceptDownloads: true,
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1440, height: 900 },
    });
    context.setDefaultTimeout(30_000);
    await this.restoreCookies(context);
    await context.tracing.start({ screenshots: true, snapshots: true });
    context.on('close', () => {
      if (this.context === context) this.context = undefined;
    });
    this.context = context;
    return context;
  }

  private async stopTrace(action: string, outcome?: 'ok' | 'error'): Promise<string | undefined> {
    const context = this.context;
    if (!context) return undefined;
    try {
      if (!outcome) {
        await context.tracing.stopChunk();
        return undefined;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `${stamp}_${this.name}_${action}_${outcome}.zip`;
      await fs.mkdir(tracesDir(), { recursive: true });
      await context.tracing.stopChunk({ path: path.join(tracesDir(), file) });
      return file;
    } catch {
      return undefined;
    }
  }

  private scheduleIdleClose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), config.idleCloseMs);
  }

  async close() {
    clearTimeout(this.idleTimer);
    const context = this.context;
    this.context = undefined;
    if (!context) return;
    await this.saveCookies(context);
    await context.tracing.stop().catch(() => undefined);
    await context.close().catch(() => undefined);
  }

  private cookieFile() {
    return path.join(config.dataDir, 'profiles', `${this.name}.cookies.json`);
  }

  /**
   * Chromium schreibt Cookies nur verzögert auf die Platte. Damit z. B. "Diesen Browser merken"
   * auch einen harten Neustart (Redeploy, SIGKILL) überlebt, sichern wir die Cookies nach jeder
   * Anfrage zusätzlich als JSON und spielen sie beim Öffnen wieder ein.
   */
  private async saveCookies(context: BrowserContext) {
    try {
      const cookies = await context.cookies();
      const file = this.cookieFile();
      await fs.writeFile(`${file}.tmp`, JSON.stringify(cookies), { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    } catch {
      // Best effort – das Profil selbst enthält die Cookies ebenfalls.
    }
  }

  private async restoreCookies(context: BrowserContext) {
    try {
      const cookies = JSON.parse(await fs.readFile(this.cookieFile(), 'utf8'));
      const now = Date.now() / 1000;
      await context.addCookies(
        cookies.filter((c: { expires: number }) => c.expires === -1 || c.expires > now),
      );
    } catch {
      // keine gesicherten Cookies
    }
  }
}

/** Löscht alte Traces (Aufruf beim Start). */
export async function pruneTraces() {
  const cutoff = Date.now() - config.traceRetentionDays * 24 * 60 * 60 * 1000;
  const entries = await fs.readdir(tracesDir()).catch(() => [] as string[]);
  for (const entry of entries) {
    const file = path.join(tracesDir(), entry);
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true });
  }
}

/** Liefert den Namen des ersten Zustands, der eintritt (z. B. Login-Formular vs. App). */
export async function firstState<T extends string>(
  candidates: Record<T, Promise<unknown>>,
  description: string,
): Promise<T> {
  const entries = Object.entries(candidates) as [T, Promise<unknown>][];
  try {
    return await Promise.any(entries.map(([name, promise]) => promise.then(() => name)));
  } catch {
    throw new PortalError(`Seitenzustand nicht erkannt: ${description}`, 502, 'UNKNOWN_STATE');
  }
}

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
