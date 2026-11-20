/**
 * ADDISON OneClick / ADDISON Direkt (Lohndokumente vom Steuerberater).
 *
 * Login: E-Mail + Passwort, danach ggf. 2FA-Code per Mail
 * (Absender noreply@portal-bereich.de, Betreff "Sicherheitscode für ADDISON Direkt").
 * Beim 2FA-Schritt wird "Diesen Browser merken" angehakt; das Cookie liegt im persistenten Profil.
 */
import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright';
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
  downloadButton: (p: Page) => p.getByRole('button', { name: 'Herunterladen', exact: true }),
};

type LoginResult = { status: 'ok' } | { status: '2fa_required'; requestedAt: string };

function detectLoginState(page: Page, timeout = 30_000) {
  return firstState(
    {
      app: ui.tenantName(page).waitFor({ timeout }),
      login: ui.username(page).waitFor({ timeout }),
      twoFactor: ui.code(page).waitFor({ timeout }),
    },
    'weder Login-Formular, 2FA-Abfrage noch Portal sichtbar',
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
  await ui.tenantTile(page).click();
  await ui.documentCells(page).first().waitFor();
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
    await ui.rememberBrowser(page).check();
    await ui.sendCode(page).click();
    await ui.code(page)
      .waitFor({ state: 'hidden', timeout: 20_000 })
      .catch(() => {
        throw new PortalError('2FA-Code abgelehnt oder abgelaufen', 401, 'CODE_REJECTED');
      });
    await page.goto(dashboardUrl);
    await ui.tenantName(page).waitFor();
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
    await cell.click();
    const downloadPromise = page.waitForEvent('download');
    await ui.downloadButton(page).click();
    const download = await downloadPromise;
    const content = await readFile(await download.path());
    await download.delete();
    return {
      status: 'file' as const,
      filename: download.suggestedFilename(),
      content,
    };
  });
}
