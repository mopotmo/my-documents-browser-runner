/**
 * ADDISON OneClick / ADDISON Direkt (Lohndokumente vom Steuerberater).
 *
 * Login: E-Mail + Passwort, danach ggf. 2FA-Code per Mail
 * (Absender noreply@portal-bereich.de, Betreff "Sicherheitscode für ADDISON Direkt").
 * Beim 2FA-Schritt wird "Diesen Browser merken" angehakt; das Cookie liegt im persistenten Profil.
 */
import { readFile } from 'node:fs/promises';
import type { Locator, Page } from 'playwright';
import { portalEnv } from '../config.js';
import { PortalBrowser, PortalError, escapeRegExp, firstState } from '../browser.js';

const env = portalEnv('ADDISON');
const portalUrl = env.get('PORTAL_URL', 'https://ccunirent.portal-bereich.de')!.replace(/\/$/, '');
const dashboardUrl = `${portalUrl}/shell/u/dashboard`;
const tenant = env.get('TENANT', 'Choice AG')!;
const documentPattern = new RegExp(
  env.get('DOCUMENT_PATTERN', 'Verdienstabrechnung|Lohnsteuerbescheinigung')!,
  'i',
);

export const addison = new PortalBrowser('addison');

// Locators an einer Stelle, damit Anpassungen nach Portal-Änderungen einfach sind.
const ui = {
  username: (p: Page) => p.getByRole('textbox', { name: /E-Mail-Adresse/ }),
  password: (p: Page) => p.getByRole('textbox', { name: /^Passwort/ }),
  loginButton: (p: Page) => p.getByRole('button', { name: 'Anmelden' }),
  code: (p: Page) => p.getByRole('textbox', { name: 'Sicherheitscode' }),
  rememberBrowser: (p: Page) => p.getByRole('checkbox', { name: 'Diesen Browser merken' }),
  rememberBrowserLabel: (p: Page) => p.getByText('Diesen Browser merken', { exact: true }).first(),
  sendCode: (p: Page) => p.getByRole('button', { name: 'Senden', exact: true }),
  tenantTile: (p: Page) =>
    p.locator('div').filter({ hasText: new RegExp(`^${escapeRegExp(tenant)}$`) }).first(),
  tenantName: (p: Page) => p.getByText(tenant, { exact: true }).first(),
  documentCells: (p: Page) => p.getByRole('gridcell').filter({ hasText: documentPattern }),
  documentCell: (p: Page, name: string) =>
    p
      .getByRole('gridcell')
      .filter({ hasText: new RegExp(`^[^\\p{L}\\p{N}]*${escapeRegExp(name)}\\s*$`, 'u') })
      .first(),
  downloadButtons: (p: Page) => p.getByRole('button', { name: 'Dokument herunterladen', exact: true }),
};

/** Findet den "Dokument herunterladen"-Button in derselben Grid-Zeile wie die Namenszelle. */
async function downloadButtonFor(page: Page, cell: Locator): Promise<Locator> {
  const row = cell.locator('xpath=ancestor::*[@role="row"][1]');
  const rowIndex = await row.getAttribute('row-index');
  if (rowIndex !== null) {
    const button = page
      .locator(`[role="row"][row-index="${rowIndex}"]`)
      .getByRole('button', { name: 'Dokument herunterladen', exact: true });
    if ((await button.count()) === 1) return button;
  }
  // Fallback: gleiche Position in der Reihenfolge der Zeilen
  const names = await ui.documentCells(page).allInnerTexts();
  const target = cleanName(await cell.innerText());
  const position = names.map(cleanName).indexOf(target);
  if (position < 0) throw new PortalError(`Zeile für "${target}" nicht gefunden`, 404, 'DOCUMENT_NOT_FOUND');
  return ui.downloadButtons(page).nth(position);
}

type LoginResult = { status: 'ok' } | { status: '2fa_required'; requestedAt: string };

const portalHost = new URL(portalUrl).host;

/**
 * Login und 2FA laufen auf services.portal-bereich.de, das Portal selbst auf `portalHost`.
 * Achtung: Die Login-Seite zeigt im Banner ebenfalls den Mandantennamen – "eingeloggt" gilt daher
 * nur, wenn wir auf dem Portal-Host sind und das zwei Prüfungen hintereinander so bleibt
 * (die SPA leitet sonst noch kurz nach dem Laden zum Login weiter).
 */
async function detectLoginState(page: Page, timeout = 30_000): Promise<'app' | 'login' | 'twoFactor'> {
  const deadline = Date.now() + timeout;
  let appSeen = 0;
  while (Date.now() < deadline) {
    if (await ui.code(page).isVisible()) return 'twoFactor';
    if (await ui.username(page).isVisible()) return 'login';
    const onPortal = new URL(page.url()).host === portalHost;
    appSeen = onPortal && (await ui.tenantName(page).isVisible()) ? appSeen + 1 : 0;
    if (appSeen >= 2) return 'app';
    await page.waitForTimeout(1_000);
  }
  throw new PortalError(
    'Seitenzustand nicht erkannt: weder Login-Formular, 2FA-Abfrage noch Portal sichtbar',
    502,
    'UNKNOWN_STATE',
  );
}

async function ensureLoggedIn(page: Page): Promise<LoginResult> {
  await page.goto(dashboardUrl);
  let state = await detectLoginState(page);

  if (state === 'login') {
    await ui.username(page).fill(env.required('USERNAME'));
    await ui.password(page).fill(env.required('PASSWORD'));
    const requestedAt = new Date().toISOString();
    await ui.loginButton(page).click();
    await ui.loginButton(page).waitFor({ state: 'hidden' }).catch(() => undefined);
    state = await detectLoginState(page);
    if (state === 'login') {
      throw new PortalError('Login fehlgeschlagen – Zugangsdaten prüfen', 401, 'LOGIN_FAILED');
    }
    if (state === 'twoFactor') return { status: '2fa_required', requestedAt };
  }

  if (state === 'twoFactor') {
    // 2FA-Seite ohne frischen Login (z. B. alte Abfrage noch offen): Code wurde evtl. schon früher verschickt.
    return { status: '2fa_required', requestedAt: new Date().toISOString() };
  }

  return { status: 'ok' };
}

async function openTenant(page: Page) {
  if (!page.url().startsWith(dashboardUrl)) await page.goto(dashboardUrl);
  // Entweder sind die Dokumente schon sichtbar (Mandant aktiv) oder die Mandanten-Kachel muss geklickt werden.
  const state = await firstState(
    {
      documents: ui.documentCells(page).first().waitFor({ timeout: 20_000 }),
      tenantTile: ui.tenantTile(page).waitFor({ timeout: 20_000 }),
    },
    `weder Dokumentliste noch Mandant "${tenant}" gefunden`,
  );
  if (state === 'tenantTile') {
    await ui.tenantTile(page).click();
    await ui.documentCells(page).first().waitFor();
  }
}

const cleanName = (text: string) => text.replace(/^[^\p{L}\p{N}]+/u, '').trim();

function describe(name: string) {
  const month = name.match(/(\d{2})\.(\d{4})/);
  const year = name.match(/\b(20\d{2})\b/);
  return {
    name,
    type: name.split(/\s+/)[0],
    period: month ? `${month[2]}-${month[1]}` : (year?.[1] ?? null),
  };
}

export async function submitCode(code: string) {
  return addison.run('2fa', async (page) => {
    if (!(await ui.code(page).isVisible())) {
      throw new PortalError(
        'Keine offene 2FA-Abfrage – zuerst /addison/documents aufrufen',
        409,
        'NO_PENDING_2FA',
      );
    }
    await ui.code(page).fill(code.trim());
    // Die Checkbox ist gestylt: Das Label-<span> liegt über dem <input> und fängt Klicks ab.
    if (!(await ui.rememberBrowser(page).isChecked())) {
      await ui.rememberBrowserLabel(page).click();
    }
    if (!(await ui.rememberBrowser(page).isChecked())) {
      await ui.rememberBrowser(page).check({ force: true });
    }
    await ui.sendCode(page).click();
    await ui.code(page)
      .waitFor({ state: 'hidden', timeout: 20_000 })
      .catch(() => {
        throw new PortalError('2FA-Code abgelehnt oder abgelaufen', 401, 'CODE_REJECTED');
      });
    await page.goto(dashboardUrl);
    const state = await detectLoginState(page);
    if (state !== 'app') {
      throw new PortalError(`Nach 2FA nicht im Portal (Zustand: ${state})`, 502, 'UNEXPECTED_STATE');
    }
    return { status: 'ok' as const };
  });
}

export async function listDocuments() {
  return addison.run('documents', async (page) => {
    const login = await ensureLoggedIn(page);
    if (login.status !== 'ok') return login;

    await openTenant(page);
    const texts = await ui.documentCells(page).allInnerTexts();
    const names = [...new Set(texts.map(cleanName).filter(Boolean))];
    return { status: 'ok' as const, tenant, documents: names.map(describe) };
  });
}

export async function downloadDocument(name: string) {
  return addison.run('download', async (page) => {
    const login = await ensureLoggedIn(page);
    if (login.status !== 'ok') return login;

    await openTenant(page);
    const cell = ui.documentCell(page, name);
    if ((await cell.count()) === 0) {
      throw new PortalError(`Dokument "${name}" nicht gefunden`, 404, 'DOCUMENT_NOT_FOUND');
    }
    // Die Liste ist ein Grid mit fixierten Spalten: Name links, Aktionen rechts in einem eigenen
    // Zeilenblock. Beide Blöcke teilen sich die Zeilennummer (row-index) bzw. die Reihenfolge.
    const button = await downloadButtonFor(page, cell);
    // Klick und Download-Event gemeinsam abwarten – sonst bleibt bei einem Klick-Fehler
    // ein unbehandeltes waitForEvent-Promise zurück.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      button.click(),
    ]);
    const content = await readFile(await download.path());
    await download.delete();
    return {
      status: 'file' as const,
      filename: download.suggestedFilename(),
      content,
    };
  });
}
