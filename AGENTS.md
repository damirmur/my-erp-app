# my-erp-app

Low-code ERP system built with Svelte 5 + SvelteKit 2. Offline-first via Dexie/IndexedDB, Supabase for cloud sync.

## Commands

| Command           | Purpose                                |
| ----------------- | -------------------------------------- |
| `npm run dev`     | Dev server at `http://10.66.66.9:5173` |
| `npm run build`   | Production build                       |
| `npm run check`   | Type-check only (`svelte-check`)       |
| `npm run lint`    | Prettier format check                  |
| `npm run format`  | Prettier auto-format                   |
| `npm run prepare` | Run `svelte-kit sync` after install    |

Run `npm run check` before committing. No test suite exists.

## Architecture

- **Metadata-driven**: No hardcoded forms. Components (`DynamicForm`, `DynamicList`, `TabularSection`) render from table/column definitions fetched from IndexedDB.
- **Single route** (`/`): Entire app is an SPA with tabbed workspace managed via `src/lib/state/workspace.svelte.ts` (Svelte 5 runes).
- **Deep links (hash)**: every table/record/ТЧ row has a unique link `#/t/{id|name}`, `#/r/{recordId}`, `#/l/{lineId}`. Parsing/building/resolution in `src/lib/services/deeplink.ts` (`parseHash`, `buildUrl`, `resolveUrl`); `resolveUrl(href)` returns `{ table, columns, record?, lines? }` — record field values live in `record.data[columnName]`. Available to `runCode` as the `link` helper. Active tab is mirrored to the hash via `replaceState` from `$app/navigation`; `hashchange` in `+page.svelte` reopens objects. Changes (saves and deletes only — **opens are not logged**) are recorded in a real system table «История» (`meta_tables.name='history'`, `type='system'`): each operation is a separate `data_records` row via `workspace.recordHistory(tableId, title, link, 'save'|'delete', status?)` with `data = { object_title, link, opened_at, event, event_type }`. Save events fire from `DynamicForm.saveToDb` and `saveRecordWithLines` (runCode `save()`), delete events from `physicalDeleteRecords` (titles captured from the cache before deletion). «Событие» column shows the label; rows sync like any data, capped at 50. Sidebar «🕘 История» opens it as a `DynamicList` whose save rows reopen the linked object (delete rows point to a deleted object). Seeded idempotently by `metadata.ensureSystemTables()` (startup + start of each sync, before `pullMetadata`); `ensureHistoryColumns` adds missing columns to existing installs. See `architecture.md` → Deep Links.
- **Sidebar (main mode)** (`src/lib/components/layout/Sidebar.svelte`, liveQuery-driven): tables grouped by type, «🔗 Открыть ссылку» (paste `#/t/...`/`#/r/...`/`#/l/...` or a bare id → `workspace.openFromLink()`), «🕘 История». Group/table order is editable in Конструктор («🔀 Порядок меню») and persisted in the system table `app_settings` (`src/lib/state/settings.ts`, key `main_nav_order`, synced like data); «Сброс» restores defaults, unset → `preferredTypeOrder` + `sort_order`/`number`.
- **Notifications module** (`src/lib/state/notifications.ts`): seeded idempotently by `ensureNotificationTables()` (called from `metadata.ensureSystemTables()`). Catalog «Сервисы API» (`api_services`) with a `proxy` self-link (via proxy gateway when filled, direct fetch when empty); `notify_channels` (with `service` link → api_services); document «Сообщение» (`notify_messages`); tabular part «Контакты» of counterparties (`contragent_contacts`, parent → `counterparties`, rows: `channel` + `value`); message ТЧ «Получатели» (`notify_message_channels`, rows: `kontragent` → counterparties + optional `channel`). Legacy `notify_recipients` catalog was removed (seed no longer creates it). Seed also adds the «OpenStreetMap — геокодинг (Nominatim)» service (number '8', `base_url` with `${query}`) and reconciles missing default services by `name` via `serviceExists()` (idempotent re-seed for existing installs). Action code `NOTIFY_RUN_CODE` (matches server-side, updated via `RUN_CODE_LEGACY` markers) resolves recipient ids from counterparty contacts, groups by service and sends via `apiCall`. `apiCall(service, params?, body?)` (`src/lib/services/actionRunner.ts`) substitutes `${param}` (URL-encoded) in `base_url`, applies auth (`auth_type` query/header), routes through proxy (`d.proxy` link → proxy service's `base_url` + its `api_key`) with backwards compat `use_proxy === true` → `https://astro3d.ru/api/proxy`. Returns `{ ok, status, data, raw }`.
- **Sync loop**: `src/lib/services/sync.ts` pulls/pushes metadata + data between Supabase and Dexie every 60s and on app start.
- **Offline DB** (`ErpOfflineCache`): 5 Dexie tables — `meta_tables`, `meta_columns`, `print_forms`, `data_records`, `data_lines`.

## Code conventions

- **Svelte 5 runes enforced** (`vite.config.ts`: `compilerOptions.runes: true`). Old Svelte syntax (`export let`, `on:click`) is blocked outside `node_modules`.
- **Prettier only**: tabs, single quotes, no trailing commas, printWidth 100, `prettier-plugin-svelte`. No ESLint.
- All logic in `.svelte.ts` rune files or plain `.ts` services. Components are thin.
- `$lib` alias maps to `src/lib/`.
- Supabase anon key is hardcoded in `src/lib/db/supabase.ts`.

## Generated files

- `.svelte-kit/` — auto-generated by `svelte-kit sync` (run via `prepare` script). Do not edit.
- Type-check requires `svelte-kit sync` to have run first (included automatically in `check` script).

## Quirks

- `engine-strict=true` in `.npmrc` enforces exact Node.js version from lockfile.
- Dev server binds to static LAN IP `10.66.66.9` — won't work on `localhost` without changing `vite.config.ts`.
- Supabase instance at `https://supabase.astro3d.ru` (external, not local).
- `.prettierignore` excludes `package-lock.json`, other lockfiles, and `/static/`.
