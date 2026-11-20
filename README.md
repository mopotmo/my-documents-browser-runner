# my-documents-browser-runner

Deterministische Browser-Automatisierung mit [Playwright](https://playwright.dev) für Portale ohne API.
Wird aus n8n (MyDocuments-Instanz) per HTTP aufgerufen und ersetzt die früheren Airtop-Workflows.

- **Betrieb:** Coolify, Projekt „My Documents“, Build Pack „Docker Compose“ (`docker-compose.yml`), **keine Domain** – nur im Docker-Netz der n8n-Instanz erreichbar als `http://browser-runner:8080`.
- **Daten:** Volume `/data` mit `profiles/<portal>` (persistente Browser-Profile inkl. Cookies) und `traces/`.
- **Auth:** Header `x-api-key: <RUNNER_API_TOKEN>` bei allen Endpunkten außer `/health`.

## API

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| GET | `/health` | – | `{status:"ok"}` |
| POST | `/addison/documents` | – | `{status:"ok", tenant, documents:[{name,type,period}]}` oder `{status:"2fa_required", requestedAt}` |
| POST | `/addison/download` | `{name}` | PDF (Dateiname im Header `content-disposition` / `x-filename`) oder `{status:"2fa_required"}` |
| POST | `/addison/2fa` | `{code}` | `{status:"ok"}` |
| GET | `/traces` | – | Liste der gespeicherten Traces |
| GET | `/traces/<datei>` | – | Trace-ZIP |

Fehler: HTTP 4xx/5xx mit `{status:"error", code, message, trace}`.

### 2FA-Ablauf (ADDISON)

1. `POST /addison/documents` → `2fa_required` (Code-Mail wurde verschickt).
2. n8n liest die Mail von `noreply@portal-bereich.de` („Sicherheitscode für ADDISON Direkt“), die nach `requestedAt` eingegangen ist, und extrahiert den 6-stelligen Code.
3. `POST /addison/2fa {code}` – hakt „Diesen Browser merken“ an. Das Cookie liegt im persistenten Profil, 2FA kommt danach nur noch selten.
4. `POST /addison/documents` erneut aufrufen.

Der Browser bleibt nach jeder Anfrage `IDLE_CLOSE_MS` (Standard 5 min) offen, damit Schritt 3 die offene 2FA-Seite vorfindet.

Chromium schreibt Cookies nur verzögert auf die Platte. Der Runner sichert sie deshalb nach jeder erfolgreichen Anfrage zusätzlich nach `/data/profiles/<portal>.cookies.json` – so überlebt „Browser merken“ auch einen harten Neustart.

## Debugging

Bei jedem Fehler wird ein Playwright-Trace gespeichert (Screenshots, DOM-Snapshots, Netzwerk, Konsole pro Schritt).
Der Dateiname steht in der Fehlerantwort (`trace`).

```bash
# Trace über n8n/HTTP holen (GET /traces/<datei>) und lokal öffnen:
npx playwright show-trace <datei>.zip
```

`TRACE_ALWAYS=true` speichert auch erfolgreiche Läufe. Traces älter als `TRACE_RETENTION_DAYS` werden beim Start gelöscht.
**Achtung:** Traces enthalten Screenshots der Portale (z. B. Lohnabrechnungen) – nicht weitergeben.

## Lokal entwickeln

```bash
npm install            # erzeugt package-lock.json – bitte committen
npx playwright install chromium
cp .env.example .env   # Werte eintragen
set -a; source .env; set +a
npm run dev            # sichtbarer Browser, Profile unter ./data
```

Neue Klickpfade aufzeichnen: `npx playwright codegen <url>` – die erzeugten Locators (`getByRole`, `getByLabel`, …) übernehmen.

## Neues Portal anlegen

1. `src/portals/<portal>.ts` anlegen (Vorlage: `addison.ts`): eigene `PortalBrowser`-Instanz, Locators im `ui`-Objekt sammeln.
2. Routen in `src/server.ts` ergänzen.
3. Zugangsdaten als `<PORTAL>_USERNAME` / `<PORTAL>_PASSWORD` in Coolify hinterlegen (und in `docker-compose.yml` durchreichen).

Robuste Locators: Rolle + sichtbarer Text (`getByRole('button', { name: 'Anmelden' })`) statt CSS-Klassen.
