# Architecture

## Overview

Offline-first ERP metadata constructor. Inspired by 1С:Предприятие — user defines table types (directories, documents, etc.), columns, tabular sections, statuses, and actions entirely through the UI. All forms and lists render dynamically from metadata.

**Stack**: Svelte 5 (runes) + SvelteKit 2, Dexie/IndexedDB (offline), Supabase (cloud sync).

**Single route** (`/`). Tab-based workspace — no URL routing.

---

## File Tree

```
my-erp-app/
├── src/
│   ├── app.html                    # Root HTML shell
│   ├── service-worker.ts           # Cache-first SW for assets
│   ├── routes/
│   │   ├── +layout.svelte          # SW registration, children render
│   │   └── +page.svelte            # Root: sync on mount + every 60s, Sidebar + Workspace
│   └── lib/
│       ├── db/
│       │   ├── indexeddb.ts        # Dexie schema version 3, TS interfaces (5 tables)
│       │   └── supabase.ts         # Supabase client singleton
│       ├── services/
│       │   ├── sync.ts             # Full sync: pull metadata/push data/pull data
│       │   ├── records.ts          # Physical (irreversible) record deletion, server + Dexie
│       │   ├── actionRunner.ts     # «Выполнить»: executes user JS code (config.runCode) in browser
│       │   ├── printer.ts          # HTML template batch printing
│       │   └── numbers.ts          # Auto-numbering (prefix + padded digits)
│       ├── state/
│       │   ├── metadata.ts         # CRUD meta_tables/meta_columns via Supabase
│       │   └── workspace.svelte.ts # Tab manager (Svelte 5 runes)
│       ├── table-types/
│       │   ├── type.ts             # StatusDef, ActionDef, TableTypeModule, features interfaces
│       │   ├── standardActions.ts  # Standard buttons generated from feature flags
│       │   ├── store.ts            # writable store for DB-loaded types
│       │   ├── index.ts            # Registry, helpers, sync/CRUD from Supabase
│       │   ├── directory.ts        # Built-in "Справочник"
│       │   ├── document.ts         # Built-in "Документ"
│       │   ├── constant.ts         # Built-in "Константа" (single record, periodic option)
│       │   ├── tabular.ts          # Built-in "Табличная часть" (sub-table)
│       │   └── template.ts         # Built-in "Шаблон" (for tabular sections)
│       ├── fields/
│       │   ├── field.ts            # FieldTypeModule interface
│       │   ├── index.ts            # Registry (string, number, boolean, date, datetime, birth, link, jsonb)
│       │   ├── string.ts / number.ts / boolean.ts / date.ts / datetime.ts / birth.ts / link.ts / jsonb.ts
│       │   └── *Field.svelte       # Per-type form inputs + LinkConfig
│       └── components/
│           ├── ui/
│           │   └── LookupInput.svelte     # Searchable autocomplete (liveQuery)
│           ├── layout/
│           │   ├── Sidebar.svelte         # Nav: tables grouped by type + Configurator
│           │   └── Workspace.svelte       # Tab bar + dynamic content area
│           └── dynamic/
│               ├── ConfiguratorForm.svelte # Meta-UI: create tables/columns/types/TЧ
│               ├── DynamicForm.svelte      # Record form (type-driven readOnly/actions)
│               ├── DynamicList.svelte      # Table list (hierarchy, sort, bulk actions)
│               ├── TabularSection.svelte   # Inline editable sub-table
│               └── Toolbar.svelte          # Type-driven action buttons + status badge
```

---

## Dexie (IndexedDB) Schema — `version(3)`

| Table          | Key                    | Fields                                                                                                    |
| -------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `meta_tables`  | `id`, `&name` (unique) | `title`, `type`, `parent_table_id`, `config?` (JSON)                                                      |
| `meta_columns` | `id`                   | `table_id`, `name`, `title`, `type`, `related_table_id?`, `sort_order`, `is_visible`                      |
| `data_records` | `id`                   | `table_id`, `status`, `data` (JSON), `number`, `date`, `parent_id`, `is_folder`, `is_dirty`, `updated_at` |
| `data_lines`   | `id`                   | `record_id`, `table_id`, `data` (JSON), `sort_order`                                                      |
| `print_forms`  | `id`                   | `table_id`, `name`, `template`, `is_default`                                                              |

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

### Read path (pull on interval)

1. `pullMetadata()` — clears and re-fetches `meta_tables`, `meta_columns`, `print_forms` from Supabase
2. `pullDataChanges()` — fetches records with `updated_at > lastSync`, merges into IndexedDB
3. UI components use `liveQuery()` / direct `db.*` queries — React automatically

### Metadata is pushed directly

ConfiguratorForm calls Supabase `.insert/update/delete` directly, then `syncService.runFullSync()` to refresh local cache.

**Offline guard**: `navigator.onLine` check — logs and returns if offline.

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
  `db` (Dexie), `supabase`, `save(record, lines?)` (marks `is_dirty: 1`), `log(...args)` (console)
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

### `ActionDef` → `ActionDefDB` conversion

Runtime `ActionDef` uses function predicates: `show?: (status) => boolean`. DB serialization uses strings: `showWhen`, `showWhenNot`, `disabledWhen`. Conversion happens in `syncTableTypes()`.

### Key helpers (`index.ts`)

| Function                                          | Purpose                                                  |
| ------------------------------------------------- | -------------------------------------------------------- |
| `getTableType(type)`                              | Returns merged type module                               |
| `getActions(type, mode, config?)`                 | Filters actions by type (list/form) minus hidden         |
| `isReadOnly(type, status, config?)`               | Checks config overrides then type StatusDef              |
| `getEffectiveConfig(table)`                       | Merges table config with type default features           |
| `syncTableTypes()`                                | Fetches from `meta_table_types`, populates dynamic store |
| `saveTableTypeToDB()` / `deleteTableTypeFromDB()` | CRUD + re-sync                                           |

---

## Field Types System

| Module   | type         | label         | FormField                    | Configurator                     |
| -------- | ------------ | ------------- | ---------------------------- | -------------------------------- |
| string   | `'string'`   | Строка        | `<input type="text">`        | —                                |
| number   | `'number'`   | Число         | `<input type="number">`      | —                                |
| boolean  | `'boolean'`  | Булево        | `<input type="checkbox">`    | —                                |
| date     | `'date'`     | Дата          | `<input type="date">`        | —                                |
| datetime | `'datetime'` | Дата и время  | DateTimeField                | —                                |
| birth    | `'birth'`    | День рождения | BirthField (date + timezone) | —                                |
| jsonb    | `'jsonb'`    | JSON          | JsonField (textarea + parse) | —                                |
| link     | `'link'`     | Ссылка        | LookupInput wrapper          | LinkConfig (select target table) |

**Note**: DynamicForm resolves fields dynamically via `{@const FC = fieldRegistry[col.type]?.FormField}` — adding a new field type module to the registry is sufficient; no DynamicForm edits required.

---

## Dynamic Component Rendering

### DynamicForm

1. Loads `tableMeta`, `columns` (sorted by `sort_order`), child tables via `$effect`
2. For new records: auto-generates `number` + today's `date`
3. Renders: Toolbar → field grid (per column type) → TabularSections → totals
4. Save: single Dexie transaction (header + delete-then-insert lines), `is_dirty: 1`

### DynamicList

1. `liveQuery` for reactive column/record loading
2. Hierarchical mode: folder breadcrumbs, filter by `parent_id`
3. Sortable columns, checkbox selection, bulk actions, double-click to open
4. `purgeMarked` removes all records with `status === role 'deleted'` value; `delete` removes selected ones — both close their open form tabs

### TabularSection

- Editable inline grid: product (LookupInput), quantity, price, amount
- `quantity * price` auto-compute, price auto-fill from LookupInput selection

### Toolbar

- Renders buttons from `getActions(tableType, mode, config)`
- Respects `show`/`disabled` status predicates
- Print actions get a dropdown of available print forms

### ConfiguratorForm

- Full meta-UI in left column (create table, manage types) + right column (edit columns, ТЧ, settings)
- Uses `liveQuery` for reactive table list
- All mutations go directly to Supabase, then `syncService.runFullSync()`
- When feature `run` is enabled — textarea `runCode` (JS body, async) with hint and example

---

## Quirks & Conventions

- **Svelte 5 runes enforced** (`vite.config.ts`): `$state`, `$derived`, `$effect`, `$props`, `$bindable`. No `export let`, no `on:click`.
- **Configurator magic string**: `'SYSTEM_CONFIUGRATOR_ID'` (deliberate typo — must match in Sidebar and Workspace).
- **Prettier only**: tabs, single quotes, no trailing commas, 100 width. No ESLint.
- **Dev server**: `10.66.66.9:5173` (LAN IP, not localhost).
- **Russian UI**: all labels, comments, statuses in Russian.
- **1C terminology**: Справочник, Документ, Реквизиты, Табличные части, Проведение.
- **Print templates**: custom mustache-like parser (`{{doc.title}}`, `{{#each lines}}`). Fallback template always used.
- **No conflict resolution**: last-write-wins sync. Destructive push for lines (deletes all, re-inserts).
- **Push resilience** (`sync.ts pushLocalChanges`): per-record try/catch. Orphan records (FK violation `23503` — record's table was deleted server-side) are dropped locally with a `console.warn`, the rest of the batch continues.
- **Metadata deletion is cascaded** (`metadata.ts`): `deleteTableCascade` removes `data_records` + `data_lines` (server via `.in('table_id')`, local via `.anyOf`) before deleting `meta_tables`.
- **Service Worker caches dev modules** (`service-worker.ts` cache-first): after code changes in dev use hard reload (Ctrl+Shift+R); CDP tests must clear `caches` and unregister the SW.
- **Supabase anon key** in `.env` (gitignored), imported via `$env/static/public`.
- **`npm run check`** for type-checking (run `svelte-kit sync` first). No test suite.
- **Adapter-auto**: no production platform detected — build warning is expected.
