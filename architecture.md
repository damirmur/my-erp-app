# Architecture

## Overview

Offline-first ERP metadata constructor. Inspired by 1С:Предприятие — user defines table types (directories, documents, etc.), columns, tabular sections, statuses, and actions entirely through the UI. All forms and lists render dynamically from metadata.

**Stack**: Svelte 5 (runes) + SvelteKit 2, Dexie/IndexedDB (offline), Supabase (cloud sync).

**Single route** (`/`). Tab-based workspace. Deep links via URL **hash** (`#/t/…`, `#/r/…`, `#/l/…`) — see [Deep Links](#deep-links-unique-references).

---

## File Tree

```
my-erp-app/
├── src/
│   ├── app.html                    # Root HTML shell
│   ├── service-worker.ts           # SW for assets (network-first, cache fallback)
│   ├── routes/
│   │   ├── +layout.svelte          # SW registration, children render
│   │   └── +page.svelte            # Root: sync on mount + every 60s, Sidebar + Workspace
│   └── lib/
│       ├── db/
│       │   ├── indexeddb.ts        # Dexie schema version 5, TS interfaces (5 tables)
│       │   └── supabase.ts         # Supabase client singleton
│       ├── services/
│       │   ├── sync.ts             # Full sync: metadata (version-gated) / push / pull data
│       │   ├── records.ts          # Physical (irreversible) record deletion, server + Dexie
│       │   ├── files.ts            # Attachments: hydrate refs from data_files, externalize before push
│       │   ├── actionRunner.ts     # «Выполнить»: runs user JS (config.runCode) in sandbox; saveRecordWithLines, apiCall
│       │   ├── sandbox.ts          # Sandbox context: base + registered helpers
│       │   ├── sandboxPlugins.ts   # Universal primitives: parsePdf, runCode, parseNum/parseAmount/parseDate
│       │   ├── pdfText.ts          # PDF → text/rows (pdf.js, lazy, browser-only)
│       │   ├── deeplink.ts         # Hash links (#/t/, #/r/, #/l/) + API-mode JSON (listJson/recordJson/execute)
│       │   ├── apiCommand.ts       # API-mode execution (#/...{...}.json → workspace.apiResult)
│       │   ├── flowRunner.ts       # Scenario graph executor (wave-based topological run)
│       │   ├── flowElements.ts     # Node types catalog (constant/get/api/template/find/create/run)
│       │   ├── flowLayout.ts       # SVG layout of a scenario graph (print form «Сценарий»)
│       │   ├── triggers.ts         # Scenario triggers by table event (save/post/unpost/delete)
│       │   ├── printer.ts          # Print forms engine (mustache-like {{}}, summary, preview)
│       │   ├── deliver.ts          # «Отправить»: renders document → creates «Сообщение» (+attachment)
│       │   ├── backup.ts           # Project export/import JSON (all 6 Supabase tables)
│       │   ├── nameAuto.ts         # Field name from synonym (translate via api_services)
│       │   └── numbers.ts          # Auto-fill date/number on save (year-scoped, strip non-digits)
│       ├── state/
│       │   ├── metadata.ts         # ensureSystemTables (history + core/default modules), CRUD meta_tables/columns
│       │   ├── modules.ts          # Module registry (core/default/optional): ensure + seeds
│       │   ├── seed.ts             # Idempotent seed helpers: ensureTable/ensureColumns/seedRecord/hasServerRows
│       │   ├── settings.ts         # app_settings: main_nav_order, translate_service
│       │   ├── printForms.ts       # «Печатные формы» registry (print_forms)
│       │   ├── notifications.ts    # Сервисы API, каналы, «Сообщение» (NOTIFY_RUN_CODE) + seeds
│       │   ├── apiQueries.ts       # «API-запросы» catalog (api_queries)
│       │   ├── flows.ts            # Сценарии (flow_scenarios/nodes/links/elements) + trigger columns
│       │   ├── constants.ts        # «Константы» (constants + periods)
│       │   └── workspace.svelte.ts # Tab manager (Svelte 5 runes)
│       ├── utils/
│       │   └── ruFormat.ts         # parseRuNumber/parseRuAmount/parseRuDate (Russian number/date format)
│       ├── table-types/
│       │   ├── type.ts             # StatusDef, ActionDef, TableTypeModule, features interfaces
│       │   ├── standardActions.ts  # Standard buttons generated from feature flags
│       │   ├── store.ts            # writable store for DB-loaded types
│       │   ├── index.ts            # Registry, helpers, sync/CRUD from Supabase
│       │   ├── directory.ts        # Built-in "Справочник"
│       │   ├── document.ts         # Built-in "Документ"
│       │   ├── constant.ts         # Built-in "Константа" (single record, periodic option)
│       │   ├── tabular.ts          # Built-in "Табличная часть" (sub-table)
│       │   ├── template.ts         # Built-in "Шаблон" (print form registry)
│       │   ├── flow.ts             # Built-in "Сценарий" (graph)
│       │   └── system.ts           # Built-in "Системная" (history etc.)
│       ├── fields/
│       │   ├── field.ts            # FieldTypeModule interface
│       │   ├── index.ts            # Registry (string, textarea, number, boolean, date, datetime,
│       │   │                       #   birth, link, jsonb, file, zip, universal, linelink, select, paramslist)
│       │   ├── *.ts / *.svelte     # Per-type module + editor component
│       │   ├── GroupField.svelte   # Virtual «Группа» field (hierarchy)
│       │   ├── LinkConfig.svelte   # Link target-table picker for Configurator
│       │   └── LinelinkConfig.svelte
│       ├── vendor/
│       │   └── zip.min.js          # Self-contained ESM build of zip.js 2.x (kept out of static/)
│       └── components/
│           ├── ui/
│           │   └── LookupInput.svelte     # Searchable autocomplete (liveQuery) + clear ✕ button
│           ├── layout/
│           │   ├── Sidebar.svelte         # Nav: tables grouped by type + Конструктор tabs
│           │   ├── Workspace.svelte       # Tab bar + dynamic content + hard-refresh (🔄)
│           │   ├── ApiResultModal.svelte  # «API» panel (JSON result, scenario steps)
│           │   └── PrintPreviewModal.svelte # «👁 На экране» print preview
│           └── dynamic/
│               ├── ConfiguratorForm.svelte  # Meta-UI: tables/columns/types/TЧ, field order (▲/▼)
│               ├── DynamicForm.svelte       # Record form (type-driven readOnly/actions)
│               ├── DynamicList.svelte       # Table list (hierarchy, sort, bulk, column visibility)
│               ├── TabularSection.svelte    # Inline editable sub-table (dynamic columns)
│               ├── Toolbar.svelte           # Action buttons + ⋮ menu + ⚙️ column-visibility menu
│               ├── TypeConfiguratorForm.svelte # Type presets editor (statuses/features/fields/actions)
│               ├── PeriodsTable.svelte      # ТЧ «Периоды» (periodic constants)
│               └── InterfaceConfigurator.svelte / InfoBaseConfigurator.svelte / TypesSectionForm.svelte
```

---

## Dexie (IndexedDB) Schema — `version(5)`

| Table          | Key                    | Fields                                                                                  |
| -------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `meta_tables`  | `id`, `&name` (unique) | `title`, `type`, `parent_table_id`, `config?` (JSON)                                    |
| `meta_columns` | `id`                   | `table_id`, `name`, `title`, `type`, `related_table_id?`, `sort_order`, `is_visible`    |
| `data_records` | `id`                   | `table_id`, `status`, `data` (JSON), `parent_id`, `is_folder`, `is_dirty`, `updated_at` |
| `data_lines`   | `id`                   | `record_id`, `table_id`, `data` (JSON), `sort_order`                                    |
| `data_files`   | `id`                   | `record_id`, `column_id`, `name`, `size`, `type`, `content` (base64)                    |

**Binary fields (file / zip)**: the payload lives in `data_files` (a mirror of the server table added by migration `0010`). In `record.data[col]` / line data there is only a **reference** `{ name, size, type, fileId }`; the base64 contents are hydrated on demand (`hydrateFileValue`/`hydrateFilesInObject` in `services/files.ts`) and externalized back to the storage before pushing to the server (`externalizeFilesInObject`). Limit is `MAX_FILE_SIZE = 20 MB`. The old inline base64-in-JSONB storage was removed.

---

## Data Flow

```
┌──────────┐  put  ┌──────────┐  upsert  ┌──────────┐
│   UI     │ ────> │IndexedDB │ ───────> │ Supabase │
│ (state)  │ <──── │ (Dexie)  │ <─────── │ (cloud)  │
└──────────┘  live │          │  pull    │          │
              Query│          │  every   │          │
                  │          │  60s     │          │
                  └──────────┘          └──────────┘
```

### Write path (offline-first)

1. User mutates data in DynamicForm / DynamicList
2. `db.data_records.put()` with `is_dirty: 1`, `updated_at: Date.now()`
3. On next sync tick: `pushLocalChanges()` finds dirty records, upserts to Supabase, sets `is_dirty: 0`

### Physical deletion (`physicalDeleteRecords`)

Irreversible delete used by `delete` and `purgeMarked` actions:

1. `DELETE data_lines` (`.in('record_id')`) and `data_records` (`.in('id')`) on Supabase
2. Single Dexie transaction: `bulkDelete` records + delete their lines
3. Related form tabs are closed via `workspace.closeTabForce(tabId)`
4. Titles of the removed records (captured from the local cache **before** the delete) are written to the «История» change journal as `'delete'` events

### Read path (pull on interval)

1. `pullMetadata()` — version-gated by `meta_version` (a `app_settings` record): skipped when the server version matches the cached one and the local cache is non-empty; otherwise it clears and re-fetches `meta_tables` + `meta_columns` in one transaction. Table types are synced separately by `syncTableTypes()` (`meta_table_types`).
2. `pullDataChanges()` — fetches records with `updated_at > lastSync` (anchor in localStorage), merges into IndexedDB; `data_files` rows of the fetched records are mirrored as well.
3. UI components use `liveQuery()` / direct `db.*` queries — React automatically

### Metadata is pushed directly

ConfiguratorForm calls Supabase `.insert/update/delete` directly, then `syncService.runFullSync()` to refresh local cache. Same pattern for one-off metadata mutations: `metadata.setColumnVisibility()` writes the row to Supabase **and** patches local Dexie immediately — otherwise the periodic `pullMetadata` (which clears + re-fetches `meta_columns`) would revert the local-only change within 60 s.

**Offline guard**: `navigator.onLine` check — logs and returns if offline.

---

## Deep Links (unique references)

Every table, record, and tabular-section row has a **unique hash link** that opens it and exposes its values. Links work offline (hash is client-side, no server round-trip) and survive reload/refresh.

### URL scheme

| Link             | Opens                                                       | Resolved from         |
| ---------------- | ----------------------------------------------------------- | --------------------- |
| `#/t/{tableId}`  | List of a table (accepts id **or** unique `name` slug)      | `meta_tables`         |
| `#/r/{recordId}` | Record form                                                 | `data_records`        |
| `#/l/{lineId}`   | Parent record form with the ТЧ row selected (`focusLineId`) | `data_lines` → record |

The hash mirrors the **active tab**: switching tabs updates the address via `replaceState` from `$app/navigation` (no history spam, no `hashchange`), browser back/forward and manual link pasting work through the `hashchange` listener in `+page.svelte`.

### Getting field values

Record values live in `record.data` (JSONB header; keys = column `name`s); ТЧ rows are in `lines[].data`. Get them from:

**1. `runCode` (action «▶️ Выполнить`)** — the `link` helper is in scope:

```js
const r = await link.get('#/r/d2856fee-e1f1-42a7-a915-be7cf56e4b30');
log(r.table.title); // e.g. «Накладная»
log(r.record.data.number); // field value by column name
log(r.record.data.name);
log(r.columns.map((c) => c.name)); // column names
log(r.lines); // ТЧ rows
```

`link.record(id)` / `link.line(id)` / `link.table(id)` generate links; `await link.get(href)` returns values.

**2. Any app module** (`src/lib/services/deeplink.ts`):

```ts
import { resolveUrl } from '$lib/services/deeplink';
const resolved = await resolveUrl('#/r/d2856fee-e1f1-42a7-a915-be7cf56e4b30');
const value = resolved?.kind === 'record' ? resolved.record.data : null;
```

**3. In the browser** — pasting the link opens the form and shows the fields in the UI.

Result type is `ResolvedLink` (discriminated union: `list` | `record` | `line` — see `deeplink.ts`). Resolution reads **only IndexedDB** (no network). Returns `null` if the object or its table no longer exists.

### Copy-link UI

- `DynamicList` row menu ⋮ → «🔗 Копировать ссылку»
- `DynamicForm` toolbar row → «🔗 Копировать ссылку на запись»
- `TabularSection` → «🔗 Копировать ссылку строки» (on the selected row)

### API mode (JSON by link, no form opened)

Any table/record exposes a «JSON command» that returns data — or executes the table's `runCode` — **without opening a form/list** (all client-side, works offline):

| Link                                           | Result                                                 |
| ---------------------------------------------- | ------------------------------------------------------ |
| `#/t/{tableId}.json`                           | list as JSON (`{ kind, table, columns, records }`)     |
| `#/r/{recordId}.json`                          | record + ТЧ lines as JSON (`record`, `lines`)          |
| `#/r/{recordId}.execute.json`                  | run the table's `runCode` for the record, return value |
| `#/r/{recordId}.execute({city:Orenburg}).json` | same, with input params                                |

- `parseHash` detects the `.json` / `.execute({...}).json` suffixes on the `t`/`r` segment and returns the new `DeepLink` kinds `listJson`/`recordJson`/`execute`. Params literal (`{city:Orenburg}` — unquoted keys/strings, or strict JSON) is parsed **without eval** by `parseParamsLiteral` (small recursive-descent parser in `deeplink.ts`).
- Execution lives in `src/lib/services/apiCommand.ts` (`runApiCommand(link)`): for `execute` it calls `runRecordAction` (`actionRunner.ts` — loads record/table/lines, merges defaults via `mergeParams`, passes `params` into the context, never throws). If the table has no `runCode`, it falls back to a **declarative** call: if the record has a `service` link (catalog «API-запросы») → `apiCall(serviceRecord, params)`; if it **is an API service** (has `base_url`) → `apiCall(record, params)`. So any «API-запрос» or «Сервисы API» row works as an endpoint: `#/r/{id}.execute({...}).json`. For `json` kinds it reuses `resolveLink` and serializes to a clean JSON object. Result → `workspace.apiResult`.
- **API-queries catalog** (`src/lib/state/apiQueries.ts`): system document `api_queries` seeded idempotently via `ensureApiQueryTables()` (from `metadata.ensureSystemTables()`, after notifications) — table only, **no example records** (the «Погода (wttr.in)» seed example was removed together with its wttr service; concrete queries are data, created in the constructor). Each record = `service` link → api_services + `params` jsonb defaults + optional runCode. `mergeParams(record, linkParams)` = `{ ...record.data.params, ...linkParams }` (link wins by key) and is applied in `runRecordAction` and `runAnotherTable`; `DynamicForm`/`DynamicList` `handleRun` now delegate to `runRecordAction` (result → API panel), so ▶️ works for both coded and declarative records.
- `workspace.openFromLink` handles the new kinds and returns them to the caller; `+page.svelte` renders `ApiResultModal.svelte` (pretty-printed JSON, «Копировать URL» / «Копировать JSON», error display).
- `runCode` context gained `params` (params from the link) and `link.execute(recordId, params?)` / `link.recordJson(id)` / `link.listJson(id)` helpers (see `linkApi`). The `return` value of `runCode` is now surfaced in the API panel: `DynamicForm`/`DynamicList` `handleRun` capture it and call `workspace.showApiResult(...)`.
- Building links: `buildExecuteUrl` / `buildRecordJsonUrl` / `buildListJsonUrl`; `buildUrl` emits `#/r/{id}.execute(<JSON.stringify(params)>).json`.

### Action history («🕘 История» — change journal)

History is a **change journal** stored in a real system table (`meta_tables.name = 'history'`, `type = 'system'`, hidden from main-mode groups via `config.hiddenInMain`). It is seeded idempotently by `metadata.ensureSystemTables()` (Supabase + local IndexedDB cache) at app start (`+page.svelte`) and at the beginning of each `runFullSync` cycle, before `pullMetadata`. The «Событие» column is added to existing installs by the same idempotent seed (`ensureHistoryColumns` creates only missing columns).

Only **saves, deletes and scenario runs** are recorded — openings are deliberately not logged:

- `DynamicForm.saveToDb` → `workspace.recordHistory(tableId, title, buildRecordUrl(recordId), 'save', targetStatus)` (fires on save, posting and mark-for-deletion)
- `saveRecordWithLines` (runCode `save()`, `src/lib/services/actionRunner.ts`) → `'save'`
- `physicalDeleteRecords` (`src/lib/services/records.ts`) captures titles from the local cache **before** deletion, then writes `'delete'`
- scenario runs → `workspace.recordFlowRun` (trigger scenarios in `triggers.ts` and manual/API runs via the «API» panel): event «выполнение сценария (ошибка)» / «выполнение сценария», `extra = { failed, description, steps, error, result }` — the link leads to the scenario

Record shape: `data = { object_title, link, opened_at, event, event_type }` (`event` = «сохранение (статус)» / «удаление» / «выполнение сценария…»; `event_type` = `save`/`delete`/`run`). Flow runs add `data.description` (readable per-step resume), `steps`, `error` and `result`. Each operation is its own row (no dedup); system tables themselves are skipped. Capped at 50 rows (`HISTORY_LIMIT`). Rows are ordinary records, so they sync to Supabase like any other data. `workspace.clearHistory()` removes them locally and on the server.

The Sidebar «🕘 История» button (main mode) opens the table as a `DynamicList`. A row click opens the history record itself as a form (`DynamicList.openRecord` treats system tables like any other table; `DynamicForm` forces `readOnly` for `type === 'system'`). The list sorts by `opened_at` descending by default.

---

## Main-mode sidebar

Rendered by `src/lib/components/layout/Sidebar.svelte` (liveQuery-driven):

- **«🔗 Открыть ссылку»** — paste `#/t/...`, `#/r/...`, `#/l/...` (or a bare record id) and press «Открыть»/Enter to open the object via `workspace.openFromLink()`; Esc closes the section, bare ids are normalized to `#/r/{id}`.
- **Group & table ordering** — in Конструктор the «🔀 Порядок меню (основной режим)» panel moves groups (▲/▼ on the type list) and tables within a group; «Сохранить» persists to the system table `app_settings` (key `main_nav_order`) via `src/lib/state/settings.ts` (`saveNavOrder`), «Сброс» restores the default grouping, «Отмена» discards the draft. The main-mode list reads the order reactively (`loadNavOrder` + `liveQuery`); when unset the default is `preferredTypeOrder` plus `sort_order`/`number` within a group.
- **«🕘 История»** — opens the «История» table as a `DynamicList` (see Action history above).

---

## Notifications module & «Сервисы API»

Seeded idempotently by `ensureNotificationTables()` (called from `metadata.ensureSystemTables()` — startup + start of each sync). `src/lib/state/notifications.ts` defines table/column seeds, one-time migrations (`migrateLegacyNotifyProviders`: `notify_providers` → `api_services`; legacy «Получатели» → ТЧ «Контакты» контрагентов: `contragent_contacts` created, message ТЧ switched to `kontragent`+`channel`, `recipient` column dropped, `notify_recipients` removed entirely), and the «Выполнить» code of the «Сообщение» document.

### Tables (all created via the same seed pattern as «История»)

| Table (`meta_tables.name`) | Type      | Purpose                                                                                                                                                              |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_services`             | directory | Каталог внешних endpoints. Колонки: `number, name, base_url, method, auth_type, auth_param, api_key, headers, proxy` (link → api_services), `is_active, description` |
| `notify_channels`          | directory | Канал отправки: `code` (`tg`/`vk`/`email`), `default_recipient`, `service` (link → api_services), `is_active`                                                        |
| `notify_messages`          | document  | «Сообщение»: `subject, message, file, last_result, last_response`                                                                                                    |
| `notify_message_channels`  | tabular   | ТЧ «Получатели» «Сообщения»: `kontragent` (link → counterparties), `channel` (link → notify_channels, опционально)                                                   |
| `contragent_contacts`      | tabular   | ТЧ «Контакты» контрагента (parent → counterparties): `channel` (link → notify_channels), `value` (tg chat id / vk id / email), `comment`                             |

### Proxy gateway & `apiCall`

`apiCall(service, params?, body?)` (`src/lib/services/actionRunner.ts`) is exposed to `runCode`:

1. Loads the service record by id (or accepts the record itself).
2. Substitutes `${param}` tokens in `base_url` with URL-encoded values from `params`.
3. Applies auth: `auth_type=query` → `auth_param=api_key` in query string; `auth_type=header` → in header.
4. **Proxy routing**: if the service has the `proxy` link filled → the request goes to the **proxy service's** `base_url` (the gateway endpoint, e.g. `astro3d.ru/api/proxy`) with the **proxy service's** `api_key` as `notify_key`, wrapping `{ url, method, query, headers, body }`. Empty `proxy` → direct `fetch` from the browser (CORS permitting). Backwards compat: `use_proxy === true` → default `https://astro3d.ru/api/proxy`.
5. Returns `{ ok, status, data, raw }` (JSON parsed, fallback to raw text).

### «Сообщение» dispatch (`NOTIFY_RUN_CODE`)

ТЧ «Получатели» содержит контрагента и (необязательно) канал. Действие для каждой строки читает ТЧ «Контакты» контрагента (`data_lines`, `record_id` = контрагент), берёт значение по каналу (канал не задан — все контакты), группирует строки по `service` канала (fallback: первый активный сервис) и шлёт **один запрос на сервис** с `{ message, file?, channels: [{ type, id }] }`. Результаты — в `last_response` (массив `{ service, ok, status, response }`), `last_result` = `ok`/`fail`. Run-код должен оставаться **побайтово идентичным** серверной копии (маркеры в `RUN_CODE_LEGACY`).

**Seed services**: сид добавляет только сервисы, реализованные на сервере (`astro3d.ru/api`): прокси-шлюз, уведомления, переводчик, Renderer (HTML/SVG → PNG/PDF). Примеры (wttr.in, астрологические, Nominatim) из сида удалены — в старых установках они остаются как данные до ручного удаления.

---

## Modules & seeds («сид vs данные»)

The engine is **universal** — it knows no subject domain (banks, weather, astrology, schedules…). Everything concrete is **data**, not code. The seed (code) contains only what the engine needs to run or references **by name**:

- **Runtime mechanics**: sandbox (`runActionCode`, `sandbox.ts`/`sandboxPlugins.ts`), `flowRunner`/`flowElements`/`triggers`, `printer`, `sync`, `deeplink`, `numbers`, `files`; field/table types (added by SQL migrations at deploy — new DBs get them automatically).
- **System tables referenced by name**: `history`, `app_settings`, `print_forms` (registry — empty, concrete forms are data), `api_services` (only server-implemented services), `flow_scenarios`/`flow_nodes`/`flow_links`/`flow_elements` (tables; scenarios and catalog elements are data), `notify_channels`/`notify_messages` (+ТЧ), `constants`.
- **Universal sandbox primitives** (`sandboxPlugins.ts`): `parsePdf` (PDF → text/rows), `runCode` (run a code string stored in data), `parseNum`/`parseAmount`/`parseDate` (`src/lib/utils/ruFormat.ts`). A primitive is added only if it serves the engine as a whole, not one domain.

Everything else — tables, records, scenarios, print forms, example services — is **data**: delivered to a new DB by project backup (`exportProject`/`importProject`, «Работа с информационной базой») or built in the constructor. Seeds are **idempotent** (tables by `name` via `ensureTable`, columns only missing via `ensureColumns`, records only into an empty catalog via `seedRecord`+`hasServerRows`) and never delete existing rows.

## Scenario engine (`flow`)

A «Сценарий» record is an n8n-like graph: nodes and edges live in ТЧ `flow_nodes`/`flow_links`; the «Элементы сценария» catalog (`flow_elements`) holds reusable node configs (a node may override an element's params/service/code). `flowRunner.flowExecute` runs the graph **wave-based topologically**: a node fires when all its incoming edges are satisfied, ready nodes run in parallel (`Promise.all`), results accumulate into a `context` referenced via `${node_title}` / `${input}` / `${key}`. Node types (`flowElements.runFlowElement`): `constant`, `get`, `api`, `template`, `find`, `create`, `run`; a node with `code` runs it in the sandbox (context gains `input`/`inputs`/`params`), a node with `service` does a declarative `apiCall`. Returns `{ results, last, steps }` — per-node `steps` (ok/error/pending, error text, duration) shown in the «API» panel.

**Scenario triggers** (`triggers.ts`): a scenario declares `trigger_table` + `trigger_event` (save/post/unpost/delete) and fires **synchronously after** the save commits (a trigger failure never rolls back the record). Every run is logged to «История»; recursion guard `isTriggerActive()` prevents saves made inside a trigger from re-firing. Use case: **«Импорт банковской выписки»** — a data scenario bound to `bank_statements` on save that imports operations from the attached PDF on universal primitives (`parsePdf` → `runCode(parser_code)` → normalize/dedup → find-or-create account → `save()`); an empty `params.record.file` returns `{ skipped: true }` and leaves ТЧ untouched.

## Print forms (`print_forms` + `printer.ts`)

«Печатные формы» is a registry (`print_forms`, type `template`, edited in constructor): each record = `target_table` + `template_html` + optional fill `code` (sandbox) + `delivery` ways (print/screen/send/download) + `output_format` html|svg + `summary`. The 🖨️ «Вывод» button is a **delivery menu** (0 forms → hidden; several forms → «форма → способы» submenu). `printerService.renderRecords` renders via a mustache-like engine (`{{doc.field}}`, `{{#each <ТЧ>}}`, `{{sum:}}`, `{{count:}}`, `{{form.*}}` — innermost `{{#each}}` blocks first); the `code` may return an HTML string used as-is or a data object rendered by the template (`output_format='svg'` extracts the `<svg>`). «Отправить» (`deliver.ts`) renders the document and creates a «Сообщение» with a text summary and the source attached (html/svg — the extension tells the gateway how to deliver). `previewTemplate` shows a live preview inside the constructor editor.

---

## Table Types System (Plugin Architecture)

Each table type defines its own:

- **Statuses**: lifecycle states (`StatusDef[]` — value, label, icon, badgeClass, isReadOnly, role `posted|deleted`)
- **Features**: booleans that drive standard buttons:
  `create` ➕, `save` 💾, `post` ✔️, `copy` 📋, `print` 🖨️, `massOperations` (bulk mark/restore/purge),
  `hierarchy` 📁, `tabularSections` (ТЧ), `delete` 🗑️ (physical delete, no mark), `run` ▶️ (user JS code)
- **Actions**: button definitions (`ActionDef[]` — id, label, icon, type `list|form`, variant, show/disabled predicates)

### Standard buttons (`standardActions.ts`)

`standardActionsFor(typeDef, features)` generates standard buttons from feature flags. It is the single source of truth:

| Feature                                  | Buttons generated                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `create`                                 | ➕ Создать (list)                                                         |
| `hierarchy`                              | 📁 Создать группу, ⬆️ На уровень вверх (list)                             |
| `save`                                   | 💾 Записать (form, disabled when read-only)                               |
| `post`                                   | ✔️ Провести / ↩️ Отменить проведение (form), ✔️ Провести выбранные (list) |
| `massOperations`                         | ❌ Пометить на удаление, ↩️ Восстановить (list)                           |
| `massOperations` + status role `deleted` | 🗑️ Удалить помеченные (list — purge of `marked_for_deletion` records)     |
| `copy` / `print`                         | 📋 Копировать / 🖨️ Печать (list + form)                                   |
| `delete`                                 | 🗑️ Удалить (list + form, physical delete without marking)                 |
| `run`                                    | ▶️ Выполнить (list + form, runs `config.runCode`)                         |

`markDelete`/`unmarkDelete` (❌/↩️ in form) appear when statuses contain role `deleted` (1C-style mark for deletion).

### «Выполнить» (feature `run`)

- Button ▶️ Выполнить in list (selected records) and form (current record)
- Code lives in table config: `meta_tables.config.runCode` (editable in ConfiguratorForm textarea)
- Executed **in the browser** by `runActionCode(code, ctx)` (`actionRunner.ts`):
  `new Function(...paramNames, 'return (async () => {...})()')` — code is an async body
- Variables available to user code without prefix: `record` (LocalRecord), `records` (selected), `lines` (ТЧ rows),
  `params` (input params from an API link), `db` (Dexie), `supabase`, `save(record, lines?)` (marks `is_dirty: 1`), `log(...args)` (console),
  `link` (deep-link helpers — `link.get(href)` returns values, `link.record/line/table(id)` generate links),
  `apiCall(service, params?, body?)` (call an external API via the «Сервисы API» catalog — see Notifications section),
  `flow(recordId, params?)` (run a scenario), plus the universal sandbox primitives `parsePdf`, `runCode`, `parseNum`/`parseAmount`/`parseDate`
- Example: `record.data.total_amount = 42; await save(record);`
- After form execution DynamicForm re-reads the record and refreshes `recordData`

### Resolution order

1. `dynamicTypes` writable store (loaded from Supabase `meta_table_types` table)
2. Built-in registry: `directory`, `document`, `template` (hardcoded `.ts` modules in `table-types/`)
3. Unknown types fall back to `document`

### Adding a new type

- **Option A** (code): create `src/lib/table-types/<name>.ts` with a `TableTypeModule` export, add to `builtinRegistry` in `index.ts`
- **Option B** (UI): use Configurator → "Типы таблиц" → "Новый тип" — copies from a base type, saves to `meta_table_types` in Supabase

Built-in types: `directory` (Справочник), `document` (Документ), `constant` (Константа — single auto-created record, optional periodic values via «Периоды» sub-table), `tabular` (Табличная часть), `template` (Шаблон). Custom types (e.g. `HTTP-request`) are stored in `meta_table_types`.

### Deleting a type / changing a table's type

- **Deleting** (`Sidebar.handleDeleteType`): blocked **only while the type has tables with records**. If the type's tables are all empty, they are deleted cascade (`metadata.deleteTableCascade`) together with the type (`deleteTableTypeFromDB`).
- **Changing a table's type** (ConfiguratorForm «Тип таблицы» select; top-level tables only, transitions to/from `constant`/`system`/`tabular` forbidden — those have hardcoded behavior): on save `metadata.updateTableType` writes `meta_tables.type` (server + local cache so the next `pullMetadata` doesn't revert it), the table's `config.features` / `statusReadOnly` overrides are reset to the new type's defaults (otherwise the explicit per-table overrides would hide the change), and `metadata.normalizeRecordStatuses` moves records whose status isn't in the new type to its first status — with a safe fallback to the Postgres `record_status` enum values (`draft`/`posted`/`marked_for_deletion`) only. Skipped when the new type supports all enum statuses.

### Type presets editor (`TypeConfiguratorForm.svelte`)

Shared tab `form_SYSTEM_TYPE_CONFIGURATOR_ID` — opened via `workspace.openTypeConfigurator` (✎ on a type row in the sidebar, or «🗂 Предустановки типа» in the table configurator), rendered by `Workspace.svelte`, excluded from the URL-hash sync. `recordId` holds the current type name; the header `<select>` switches types within the tab (confirm if dirty). It shows/edits a type's **presets**:

- **Statuses**: value/label/icon/badgeClass/isReadOnly/role (`posted`/`deleted`) — add/remove/reorder (▲/▼/✕).
- **Features**: the 10 `FEATURE_KEYS` checkboxes.
- **Fields template**: columns auto-created when a table of this type is created.
- **Custom actions**: read-only list (labels/icons).

Save calls `saveTableTypeDefinitionDB(name, label, definition)` — writes the **raw** definition (actions as-is, so `showWhen`/`showWhenNot`/`disabledWhen` survive), unlike `saveTableTypeToDB` which serializes function predicates. Editing a **built-in** type creates/updates an override row in `meta_table_types` (it wins over the registry via the merge `{...builtinRegistry, ...$dyn}`); deleting that row reverts to the built-in preset.

### `ActionDef` → `ActionDefDB` conversion

Runtime `ActionDef` uses function predicates: `show?: (status) => boolean`. DB serialization uses strings: `showWhen`, `showWhenNot`, `disabledWhen`. Conversion happens in `syncTableTypes()`.

### Key helpers (`index.ts`)

| Function                                          | Purpose                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `getTableType(type)`                              | Returns merged type module                                                   |
| `getActions(type, mode, config?)`                 | Filters actions by type (list/form) minus hidden                             |
| `isReadOnly(type, status, config?)`               | Checks config overrides then type StatusDef                                  |
| `getEffectiveConfig(table)`                       | Merges table config with type default features                               |
| `syncTableTypes()`                                | Fetches from `meta_table_types`, populates dynamic store                     |
| `saveTableTypeToDB()` / `deleteTableTypeFromDB()` | CRUD + re-sync                                                               |
| `saveTableTypeDefinitionDB()`                     | Writes a **raw** type definition (presets editor), preserving action strings |

---

## Field Types System

| Module     | type           | label                        | FormField                                     | Configurator                     |
| ---------- | -------------- | ---------------------------- | --------------------------------------------- | -------------------------------- |
| string     | `'string'`     | Строка                       | `<input type="text">`                         | —                                |
| textarea   | `'textarea'`   | Текст                        | `<textarea>`                                  | —                                |
| number     | `'number'`     | Число                        | `<input type="number">`                       | —                                |
| boolean    | `'boolean'`    | Булево                       | `<input type="checkbox">`                     | —                                |
| date       | `'date'`       | Дата                         | `<input type="date">`                         | —                                |
| datetime   | `'datetime'`   | Дата и время                 | DateTimeField                                 | —                                |
| birth      | `'birth'`      | День рождения                | BirthField (date + timezone)                  | —                                |
| jsonb      | `'jsonb'`      | JSON                         | JsonField (textarea + parse)                  | —                                |
| link       | `'link'`       | Ссылка                       | LookupInput wrapper                           | LinkConfig (select target table) |
| file       | `'file'`       | Файл                         | FileField (single upload)                     | —                                |
| zip        | `'zip'`        | ZIP-архив (несколько файлов) | ZipField (multi + pack)                       | —                                |
| universal  | `'universal'`  | Универсальное                | UniversalField (type select + chosen editor)  | —                                |
| linelink   | `'linelink'`   | Ссылка на строку ТЧ          | LineLinkField (dropdown of a sub-table rows)  | LinelinkConfig                   |
| select     | `'select'`     | Выбор из списка              | SelectField (options from `selectOptionsFor`) | —                                |
| paramslist | `'paramslist'` | Параметры (JSON-объект)      | ParamsListField (key/value with per-key type) | —                                |

**Note**: DynamicForm resolves fields dynamically via `{@const FC = fieldRegistry[col.type]?.FormField}` — adding a new field type module to the registry is sufficient; no DynamicForm edits required.

**Universal field (`universal`)**: per-record value is `{ t: type, v: value }` — each record in a table can use its own type (string, datetime, number, link, …). `UniversalField.svelte` shows a type `<select>` (candidates = all registered types with an editor, minus `universal`) and the chosen type's `FormField` bound to `value.v`; switching type resets `v` to that type's default. `formatFieldValue` formats by `t`; `DynamicList` resolves `t === 'link'` cells via the existing `linkDisplay` map (bulkGet by id — table-agnostic). `LookupInput` with an empty `targetTableId` performs a **universal search across all top-level tables** (each suggestion shows its table title), so links work without configuring `related_table_id`. `saveToDb` parses `t === 'jsonb'` values into real JSON. Requires Postgres enum value (`supabase/migrations/0004_add_universal_column_type.sql`).

**Constants**: a `constant` table with `config.manyRecords` (`getEffectiveConfig` reads it; constructor checkbox «🗂 Несколько констант в одной таблице») becomes a normal multi-row list — `DynamicList` skips the single-record auto-create/auto-open effect for it, and saving auto-enables `create`. Periodic constants: `mainColName`/`mainColType` resolve to the universal or `value` column (not `columns[0]`); the header value is disabled **only while the record has period lines** (`hasPeriodLines`), so plain and periodic constants coexist in one table; `PeriodsTable` renders a `UniversalField` per row when `valueType === 'universal'` (each constant keeps its own value type across periods).

**Constants seed** (`src/lib/state/constants.ts`, called from `metadata.ensureSystemTables()` after `ensureApiQueryTables()`): idempotently creates «Константы» (`name='constants'`, `type='constant'`, `config.manyRecords=true` + `features.create=true` + `periodic=true`) with columns `number`/`name`/`value`(universal)/`description` and its child tabular «Периоды» (`name='constants_periods'`, `period` date + `value` universal) via the same `ensureTable`/`ensureColumns` helpers used by notifications/apiQueries. The seed only ensures existence and missing columns — it never overrides the server config/columns the user edits in the constructor, so it coexists with a manually-created table.

### File / ZIP fields

- Values live in `record.data[col.name]` as a **reference** `{ name, size, type, fileId }`; the base64 payload is stored in `data_files` (Dexie + server table, migration `0010`) and hydrated on demand (`hydrateFileValue` / `hydrateFilesInObject` in `services/files.ts`). Before pushing to the server inline values are externalized back (`externalizeFilesInObject`).
- `FileField.svelte`: pick one file → `fileToStoredFile()` → reference with `fileId`; renders name + size, allows replace/delete/download.
- `ZipField.svelte`: add **multiple** files → stored as `{ name, files: [{name, size}], fileId }` where the payload is a **prebuilt ZIP archive**; download re-builds the archive from the stored blob. Supports removing individual entries.
- **zip.js is vendored** at `src/lib/vendor/zip.min.js` (self-contained ESM bundle, first line `// @ts-nocheck`). Loaded lazily via `await import('$lib/vendor/zip.min.js')` inside the component — keeps it out of the initial bundle. It must NOT live in `static/`: Vite resolves only JS modules, a static URL breaks the build.
- **zip.js pitfalls** (see `ZipField.svelte`):
  - Use `useCompressionStream: false` — the native `CompressionStream` path crashes in Chromium (`Cannot read properties of undefined (reading 'pipeThrough')`).
  - Pass `new BlobReader(blob)` to `writer.add()` — a raw `Blob` input hits the same `pipeThrough` bug.
  - `useWebWorkers: false` keeps zip.js on the main thread (required for the vendored module to work without worker files).

---

## Dynamic Component Rendering

### DynamicForm

1. Loads `tableMeta`, `columns` (sorted by `sort_order`), child tables via `$effect`
2. For new records: auto-generates `number` + today's `date`
3. Renders: Toolbar → field grid (per column type) → TabularSections → totals
4. Save: single Dexie transaction (header + delete-then-insert lines), `is_dirty: 1`

### DynamicList

1. `liveQuery` for reactive column/record loading; keeps `allColumns` (unfiltered) and derives `columns = allColumns.filter(c => c.is_visible !== false)`
2. Hierarchical mode: folder breadcrumbs, filter by `parent_id`
3. Sortable columns, checkbox selection, bulk actions, double-click to open
4. `purgeMarked` removes all records with `status === role 'deleted'` value; `delete` removes selected ones — both close their open form tabs
5. Column visibility is toggled from the Toolbar ⚙️ menu → `metadata.setColumnVisibility(id, bool)` (writes to Supabase AND local Dexie immediately so the next 60s `pullMetadata` doesn't revert it)

### TabularSection

- Renders **dynamically from `meta_columns`**: headers are column titles, cells are the corresponding `fieldRegistry` FormField components (`bind:value={line.data[col.name]}`), so any field type works in a ТЧ (string, number, link, boolean, file, zip…). New lines are initialized with per-type defaults.
- **Legacy auto-compute**: if a ТЧ has columns named `price`, `quantity` and `amount`, then `amount = price × quantity` is auto-recomputed on edit, the `amount` cell is read-only, and selecting a link value autofills `price` from the target record's `price` field.
- ТЧ data is stored under the **column `name`s** (e.g. a document's ТЧ uses `product`, `quantity`, `price`, `amount` — so column names must match the data keys).
- Field order in a ТЧ is not configurable via the Configurator (render follows `sort_order`).

### Toolbar

- Renders buttons from `getActions(tableType, mode, config)`
- Respects `show`/`disabled` status predicates
- Print actions get a dropdown of available print forms
- **⋮ button** (list mode): dropdown duplicating all list actions (same `show`/`disabled` logic)
- **⚙️ button** (list mode): column-visibility menu — one checkbox per column (bound to `is_visible`). Both dropdowns close on outside click but stay open for clicks inside `.toolbar-menu-wrap` (so several checkboxes can be toggled in a row)

### ConfiguratorForm

- Full meta-UI in left column (create table, manage types) + right column (edit columns, ТЧ, settings)
- Constructor tabs in the sidebar: «🖥 Интерфейс» (main-menu order, translate service — `InterfaceConfigurator.svelte`), «💾 Работа с информационной базой» (project export/import — `InfoBaseConfigurator.svelte`), «⚙️ Типы таблиц» (`TypesSectionForm.svelte`), «🗂 Предустановки типа» (`TypeConfiguratorForm.svelte`)
- Uses `liveQuery` for reactive table list
- All mutations go directly to Supabase, then `syncService.runFullSync()`
- When feature `run` is enabled — textarea `runCode` (JS body, async) with hint and example
- **Field order**: ▲/▼ buttons in a dedicated «Порядок» column swap the column's position **in the draft array** (render follows array order). On save the header columns are renumbered `sort_order = (i+1)*10` to keep order stable and avoid duplicates. (Order buttons exist for header columns only, not ТЧ.)
- **List visibility**: each column carries `is_visible`; **new columns default to `is_visible: false`** (they appear in the form but not in the list — the list shows only code+name until enabled via the ⚙️ menu).

---

## Quirks & Conventions

- **Svelte 5 runes enforced** (`vite.config.ts`): `$state`, `$derived`, `$effect`, `$props`, `$bindable`. No `export let`, no `on:click`.
- **Configurator magic string**: `'SYSTEM_CONFIUGRATOR_ID'` (deliberate typo — must match in Sidebar and Workspace).
- **Deep links use hash** (`#/t/`, `#/r/`, `#/l/`) — do NOT introduce real routes: offline-first + SW make server-side fallback impractical. Keep everything in `deeplink.ts` (`parseHash`/`buildUrl`/`resolveLink`/`linkApi`).
- **Prettier only**: tabs, single quotes, no trailing commas, 100 width. No ESLint.
- **Dev server**: `10.66.66.9:5173` (LAN IP, not localhost).
- **Russian UI**: all labels, comments, statuses in Russian.
- **1C terminology**: Справочник, Документ, Реквизиты, Табличные части, Проведение.
- **Print templates**: custom mustache-like parser (`{{doc.title}}`, `{{#each lines}}`). Fallback template always used.
- **No conflict resolution**: last-write-wins sync. Destructive push for lines (deletes all, re-inserts).
- **Push resilience** (`sync.ts pushLocalChanges`): per-record try/catch. Orphan records (FK violation `23503` — record's table was deleted server-side) are dropped locally with a `console.warn`, the rest of the batch continues.
- **Metadata deletion is cascaded** (`metadata.ts`): `deleteTableCascade` removes `data_records` + `data_lines` (server via `.in('table_id')`, local via `.anyOf`) before deleting `meta_tables`.
- **Service Worker is network-first** (`service-worker.ts`): fetch fresh from server, cache successful responses, fall back to cache only when offline. Do NOT switch back to cache-first — Vite dev module URLs are un-hashed, so cache-first serves stale code and breaks hot changes (CDP/browser tests must still clear `caches` + unregister the SW once to drop an old cache).
- **Hard refresh (🔄 in Workspace)**: runs `runFullSync()` → clears all 5 Dexie tables → deletes all Cache Storage entries → `location.replace` with a `?hard=<timestamp>` query (busts SW/navigation cache). Used to reset a stale offline cache.
- **Supabase schema migrations** live in `supabase/migrations/`: `0001_cloud_init.sql` (full dump), `0002` adds `file`/`zip`, `0003` `datetime`/`birth`, `0004` `universal`, `0006` `linelink`, `0007` `select`, `0008` `paramslist` to the `column_type` enum; `0005` adds primary keys; `0009` perf indexes; `0010` adds the `data_files` attachment storage. The folder is gitignored — applied manually with `supabase db push` (or `supabase/init_full.sql` via SQL Editor).
- **Locale-aware dates**: `formatFieldValue` and the `opened_at` special case in `DynamicList` format `date`/`datetime` via `Intl.DateTimeFormat` with the browser's locale (`dateStyle: 'short'`, `timeStyle: 'short'`).
- **Supabase anon key** in `.env` (gitignored), imported via `$env/static/public`.
- **`npm run check`** for type-checking (run `svelte-kit sync` first). No test suite.
- **Adapter-auto**: no production platform detected — build warning is expected.
