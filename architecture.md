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
│       │   ├── printer.ts          # HTML template batch printing
│       │   └── numbers.ts          # Auto-numbering (prefix + padded digits)
│       ├── state/
│       │   ├── metadata.ts         # CRUD meta_tables/meta_columns via Supabase
│       │   └── workspace.svelte.ts # Tab manager (Svelte 5 runes)
│       ├── table-types/
│       │   ├── type.ts             # StatusDef, ActionDef, TableTypeModule interfaces
│       │   ├── store.ts            # writable store for DB-loaded types
│       │   ├── index.ts            # Registry, helpers, sync/CRUD from Supabase
│       │   ├── directory.ts        # Built-in "Справочник"
│       │   ├── document.ts         # Built-in "Документ"
│       │   └── template.ts         # Built-in "Шаблон" (for tabular sections)
│       ├── fields/
│       │   ├── field.ts            # FieldTypeModule interface
│       │   ├── index.ts            # Registry (string, number, boolean, date, link)
│       │   ├── string.ts / number.ts / boolean.ts / date.ts / link.ts
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

| Table | Key | Fields |
|-------|-----|--------|
| `meta_tables` | `id`, `&name` (unique) | `title`, `type`, `parent_table_id`, `config?` (JSON) |
| `meta_columns` | `id` | `table_id`, `name`, `title`, `type`, `related_table_id?`, `sort_order`, `is_visible` |
| `data_records` | `id` | `table_id`, `status`, `data` (JSON), `number`, `date`, `parent_id`, `is_folder`, `is_dirty`, `updated_at` |
| `data_lines` | `id` | `record_id`, `table_id`, `data` (JSON), `sort_order` |
| `print_forms` | `id` | `table_id`, `name`, `template`, `is_default` |

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
- **Statuses**: lifecycle states (`StatusDef[]` — value, label, icon, badgeClass, isReadOnly)
- **Features**: hierarchy, copy, print, tabularSections (booleans)
- **Actions**: button definitions (`ActionDef[]` — id, label, icon, type `list|form`, variant, show/disabled predicates)

### Resolution order
1. `dynamicTypes` writable store (loaded from Supabase `meta_table_types` table)
2. Built-in registry: `directory`, `document`, `template` (hardcoded `.ts` modules in `table-types/`)
3. Unknown types fall back to `document`

### Adding a new type
- **Option A** (code): create `src/lib/table-types/<name>.ts` with a `TableTypeModule` export, add to `builtinRegistry` in `index.ts`
- **Option B** (UI): use Configurator → "Типы таблиц" → "Новый тип" — copies from a base type, saves to `meta_table_types` in Supabase

### `ActionDef` → `ActionDefDB` conversion
Runtime `ActionDef` uses function predicates: `show?: (status) => boolean`. DB serialization uses strings: `showWhen`, `showWhenNot`, `disabledWhen`. Conversion happens in `syncTableTypes()`.

### Key helpers (`index.ts`)
| Function | Purpose |
|----------|---------|
| `getTableType(type)` | Returns merged type module |
| `getActions(type, mode, config?)` | Filters actions by type (list/form) minus hidden |
| `isReadOnly(type, status, config?)` | Checks config overrides then type StatusDef |
| `getEffectiveConfig(table)` | Merges table config with type default features |
| `syncTableTypes()` | Fetches from `meta_table_types`, populates dynamic store |
| `saveTableTypeToDB()` / `deleteTableTypeFromDB()` | CRUD + re-sync |

---

## Field Types System

| Module | type | label | FormField | Configurator |
|--------|------|-------|-----------|--------------|
| string | `'string'` | Строка | `<input type="text">` | — |
| number | `'number'` | Число | `<input type="number">` | — |
| boolean | `'boolean'` | Булево | `<input type="checkbox">` | — |
| date | `'date'` | Дата | `<input type="date">` | — |
| link | `'link'` | Ссылка | LookupInput wrapper | LinkConfig (select target table) |

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

### TabularSection
- Editable inline grid: product (LookupInput), quantity, price, amount
- `quantity * price` auto-compute, price auto-fill from LookupInput selection

### Toolbar
- Renders buttons from `getActions(tableType, mode, config)`
- Respects `show`/`disabled` status predicates
- Print actions get a dropdown of available print forms

### ConfiguratorForm
- Full meta-UI in left column (create table, manage types) + right column (edit columns, TЧ, settings)
- Uses `liveQuery` for reactive table list
- All mutations go directly to Supabase, then `syncService.runFullSync()`

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
- **Supabase anon key** in `.env` (gitignored), imported via `$env/static/public`.
- **`npm run check`** for type-checking (run `svelte-kit sync` first). No test suite.
- **Adapter-auto**: no production platform detected — build warning is expected.
