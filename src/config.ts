import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  /** Token, das n8n im Header `x-api-key` mitschickt. */
  apiToken: required('RUNNER_API_TOKEN'),
  /** Persistente Daten: Browser-Profile und Traces. In Coolify als Volume mounten. */
  dataDir: path.resolve(process.env.DATA_DIR ?? '/data'),
  headless: process.env.HEADLESS !== 'false',
  /** Optional: eigener Chrome/Chromium statt des Playwright-Browsers (z. B. lokal). */
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  /** Nach so vielen ms ohne Anfrage wird der Browser eines Portals geschlossen. */
  idleCloseMs: Number(process.env.IDLE_CLOSE_MS ?? 5 * 60_000),
  /** Traces auch bei erfolgreichen Läufen speichern (sonst nur bei Fehlern). */
  traceAlways: process.env.TRACE_ALWAYS === 'true',
  /** Bei Fehlern URL + ARIA-Snapshot der Seite in der Antwort mitliefern (Standard: an). */
  debugSnapshot: process.env.DEBUG_SNAPSHOT !== 'false',
  /** Traces älter als so viele Tage werden beim Start gelöscht. */
  traceRetentionDays: Number(process.env.TRACE_RETENTION_DAYS ?? 14),
};

export function portalEnv(prefix: string) {
  return {
    get: (name: string, fallback?: string) => process.env[`${prefix}_${name}`] ?? fallback,
    required: (name: string) => required(`${prefix}_${name}`),
  };
}
