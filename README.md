# أخبار النمسا بالعربية — ORF Arabisch

Automatisiertes Projekt, das aktuelle österreichische Nachrichten (ORF-RSS-Feed)
abruft, mit Claude natürlich ins Arabische übersetzt und auf einer modernen,
RTL-fähigen Webseite mit Kategoriefilter anzeigt — vollautomatisch aktualisiert.

## Architektur & Technologieentscheidungen

| Bereich | Wahl | Warum |
|---|---|---|
| Datenquelle | ORF RSS (`rss.orf.at/news.xml`) | offizieller, kostenloser, stabiler Feed österreichischer Nachrichten |
| Fetch/Übersetzung | Node.js-Skript (`scripts/translate.mjs`) | RSS-Parsing und HTTP-Calls sind in Node simpel; läuft ohne Server, ideal für CI |
| Übersetzung | Claude API (`@anthropic-ai/sdk`, Modell `claude-haiku-4-5`) | erzeugt journalistisch-natürliche statt wörtliche Übersetzungen; günstig/schnell genug für kurze Schlagzeilen; Modell per Env austauschbar |
| Speicherung | `public/data/news.json` | einfaches, versioniertes, diff-bares Format ohne Datenbank-Overhead; wird inkrementell gemergt, damit bereits übersetzte Titel nicht erneut (kostenpflichtig) übersetzt werden |
| Website | statisches HTML/CSS/Vanilla-JS | kein Build-Schritt nötig, minimale Angriffsfläche, lädt `data/news.json` per `fetch()`; RTL nativ über `dir="rtl"` |
| Automatisierung | GitHub Actions (Cron alle 3 Std. + `workflow_dispatch`) | läuft ohne eigenen Server/Account, Secrets bleiben sicher in GitHub gespeichert |
| Hosting | GitHub Pages (via `actions/deploy-pages`) | kostenlos, direkt im selben Repo integriert, kein zusätzlicher Account/Dienst nötig |

## Projektstruktur

```
scripts/translate.mjs      RSS holen, neue Titel übersetzen, news.json schreiben
public/index.html/.css/.js Webseite (liest public/data/news.json)
public/data/news.json      gespeicherte, übersetzte Nachrichten (wird automatisch aktualisiert)
.github/workflows/         Cron-Job: übersetzen → committen → auf Pages deployen
```

## Lokal einrichten

Voraussetzung: Node.js ≥ 20.

```bash
npm install
cp .env.example .env
# .env öffnen und ANTHROPIC_API_KEY eintragen (siehe unten)
npm run translate     # holt Nachrichten & übersetzt, schreibt public/data/news.json
npm run dev           # startet einen lokalen Server für public/ (http://localhost:3000)
```

`.env` wird durch `.gitignore` **niemals** committet.

### Anthropic-API-Key erstellen

1. Account auf https://console.anthropic.com anlegen.
2. Unter **Settings → API Keys** einen neuen Key erzeugen.
3. Guthaben/Billing hinterlegen (Übersetzung von ~60 kurzen Titeln kostet Cent-Beträge pro Lauf mit Haiku).
4. Key in `.env` als `ANTHROPIC_API_KEY` eintragen (lokal) bzw. als GitHub Secret hinterlegen (siehe nächster Schritt).

## Automatisierung & Hosting einrichten (GitHub)

1. **Repository-Secret anlegen**: GitHub-Repo → *Settings → Secrets and variables → Actions →
   New repository secret* → Name `ANTHROPIC_API_KEY`, Wert = dein Key.
2. **GitHub Pages aktivieren**: *Settings → Pages → Build and deployment → Source* auf
   **„GitHub Actions“** stellen.
3. Der Workflow `.github/workflows/update-and-deploy.yml` läuft automatisch auf dem
   Default-Branch des Repos:
   - alle 3 Stunden (Cron),
   - bei jedem Push, der `public/` oder `scripts/` ändert,
   - manuell über den Tab **Actions → Run workflow**.
4. Nach dem ersten erfolgreichen Lauf ist die Seite unter der von GitHub
   angezeigten Pages-URL erreichbar (**Settings → Pages** zeigt den Link,
   i. d. R. `https://<user>.github.io/<repo>/`).

Kein API-Key landet dabei im Code oder im öffentlichen Repo — er existiert
ausschließlich als verschlüsseltes GitHub-Secret bzw. lokal in der
ignorierten `.env`.

## Funktionsweise des Update-Workflows

1. `scripts/translate.mjs` lädt den RSS-Feed, berechnet für jeden Eintrag
   eine stabile ID (SHA-1 des Links).
2. Bereits vorhandene, übersetzte Einträge aus `public/data/news.json`
   werden wiederverwendet — es wird nur **neu erschienenen** Schlagzeilen
   übersetzt (spart API-Kosten und Zeit).
3. Claude übersetzt Titel batchweise (bis zu 20 pro Anfrage) mit einem
   Prompt, der explizit natürliche, journalistische Formulierung statt
   wörtlicher Übersetzung verlangt.
4. Ergebnis wird nach Datum sortiert, auf die neuesten `MAX_ITEMS` (Standard 60)
   gekürzt und als JSON gespeichert.
5. Der Workflow committet die aktualisierte `news.json` zurück ins Repo und
   deployed `public/` auf GitHub Pages.

## Anpassungen

- Andere Quelle: `ORF_RSS_URL` in `.env` bzw. als Workflow-Env setzen
  (z. B. ein anderer österreichischer RSS-Feed).
- Anderes Modell: `ANTHROPIC_MODEL` setzen.
- Mehr/weniger Nachrichten: `MAX_ITEMS` setzen.
- Update-Frequenz: Cron-Ausdruck in `.github/workflows/update-and-deploy.yml` ändern.
