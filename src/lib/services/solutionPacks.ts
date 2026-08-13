// «Пакеты решений» (Solution Packs): универсальный механизм переноса целого
// модуля между базами целиком в данных. Пакет — JSON-описание схемы (таблицы,
// колонки, ТЧ, предустановки типов), каталогов (записи-сиды), сценариев-графов
// и печатных форм; применяется идемпотентно без кода (движок не знает ни про
// одну предметную область).
//
// Формат: { format, version, id, title, tables, tableTypes?, seedRecords?,
// scenarios?, printForms? }. Ссылки:
//   @key           — запись-сид из seedRecords (по key);
//   @sys:table/имя — Существующая запись базы (напр. @sys:api_services/proxy);
//   @table:имя     — id таблицы (для КОЛОНКИ trigger_table/target_table и т.п.);
//   @ln:ключ       — строка ТЧ текущей записи (ключ = __id строки, для linelink).
// Применение строится на идемпотентных ensureTable/ensureColumns/seedRecord
// (те же приёмы, что в seedDefaults уведомлений), поэтому повторный прогон не
// плодит дубликаты: таблицы — по name, колонки — только недостающие, записи —
// только если нет совпадения по match-полям (по умолчанию data.name).
import { supabase } from '$lib/db/supabase';
import { db, type LocalLine, type LocalRecord, type TableConfig } from '$lib/db/indexeddb';
import { ensureColumns, ensureTable, findTableIdByName, seedRecord } from '$lib/state/seed';
import { fieldRegistry } from '$lib/fields';
import { bumpMetaVersion } from '$lib/state/metadata';
import { SOLUTION_PACKS_TABLE } from '$lib/state/solutions';

export const SOLUTION_FORMAT = 'my-erp-solution';
export const SOLUTION_VERSION = 1 as const;

// Версия движка для проверки requires.engine (ср. package.json).
export const ENGINE_VERSION = '0.0.1';

export interface TableTypeSeed {
	type: string;
	label: string;
	definition?: Record<string, any>;
}

// Колонка схемы пакета: type — тип поля из fieldRegistry; relatedTable — имя
// таблицы (для link/linelink), разрешается в related_table_id при применении.
export interface ColumnSeed {
	name: string;
	title: string;
	type: string;
	relatedTable?: string;
	is_visible?: boolean;
	sort_order?: number;
}

export interface TableSeed {
	name: string;
	title: string;
	type: string;
	config?: TableConfig;
	parent?: string;
	columns: ColumnSeed[];
}

export interface RecordSeed {
	// Пакет-локальный ключ записи; на него ссылаются '@key'.
	key: string;
	// Поля для поиска уже существующей записи (по умолчанию ['name']).
	match?: string[];
	data: Record<string, any>;
	// Строки ТЧ по имени под-таблицы; для ссылок между строками используйте
	// __id у строки (и @ln:__id в значениях) — см. exportSolution.
	lines?: Record<string, Record<string, any>[]>;
	// Служебное: как запись пришла в пакет (счётчики отчёта).
	kind?: 'record' | 'scenario' | 'printForm';
}

export interface NodeSeed {
	key: string;
	name?: string;
	element?: string;
	nodeType?: string;
	service?: string;
	params?: any;
	code?: string;
}

export interface LinkSeed {
	from: string;
	to: string;
	role?: string;
	label?: string;
}

export interface ScenarioSeed {
	name: string;
	description?: string;
	triggerTable?: string;
	triggerEvent?: 'save' | 'post' | 'unpost' | 'delete';
	params?: Record<string, any>;
	nodes: NodeSeed[];
	links?: LinkSeed[];
}

export interface PrintFormSeed {
	name: string;
	targetTable: string;
	templateHtml?: string;
	code?: string;
	isDefault?: boolean;
	delivery?: string;
	outputFormat?: 'html' | 'svg';
	summary?: string;
	sortOrder?: number;
}

export interface SolutionPack {
	format: 'my-erp-solution';
	version: number;
	id: string;
	title: string;
	description?: string;
	requires?: { engine?: string; packages?: string[] };
	tableTypes?: TableTypeSeed[];
	tables: TableSeed[];
	seedRecords?: Record<string, RecordSeed[]>;
	scenarios?: ScenarioSeed[];
	printForms?: PrintFormSeed[];
}

export interface ApplyReport {
	ok: boolean;
	errors: string[];
	warnings: string[];
	tablesCreated: string[];
	columnsAdded: number;
	recordsSeeded: number;
	recordsSkipped: number;
	scenariosApplied: number;
	printForms: number;
}

export interface ApplyOptions {
	// Только проверки: схема, требования, рефы — без записи в базу.
	dryRun?: boolean;
	// Сидить записи даже если совпадают match-поля (не идемпотентно).
	force?: boolean;
	online?: boolean;
}

interface RefContext {
	recordKeys: Map<string, string>;
	tableIdMap: Map<string, string>;
	sysCache: Map<string, string>;
	lineRefs: Map<string, string>;
	online: boolean;
	report: ApplyReport;
}

const SERVER_PAGE_SIZE = 1000;
const NAME_RE = /^[a-z0-9_]+$/i;
const PACK_ID_RE = /^[a-z0-9_-]+$/i;
const KNOWN_TYPES = new Set([
	'directory',
	'document',
	'template',
	'constant',
	'tabular',
	'system',
	'flow'
]);

// ---------------------------------------------------------------------------
// Валидация

export function validatePack(pack: SolutionPack): string[] {
	const errors: string[] = [];
	if (!pack || typeof pack !== 'object') return ['Пакет пуст'];
	if (pack.format !== SOLUTION_FORMAT)
		errors.push(`Неверный формат пакета: ${String(pack.format)}`);
	if (pack.version !== SOLUTION_VERSION) {
		errors.push(`Несовместимая версия пакета: ${pack.version}. Ожидается ${SOLUTION_VERSION}.`);
	}
	if (typeof pack.id !== 'string' || !PACK_ID_RE.test(pack.id)) {
		errors.push('id пакета — латиница/цифры/_/- (без пробелов)');
	}
	if (typeof pack.title !== 'string' || !pack.title) errors.push('Нет названия пакета (title)');
	if (!Array.isArray(pack.tables) || pack.tables.length === 0) errors.push('В пакете нет таблиц');

	const packTypes = new Set((pack.tableTypes ?? []).map((t) => t.type));
	const names = new Set<string>();
	for (const t of pack.tables ?? []) {
		if (!t || typeof t !== 'object') {
			errors.push('Повреждённая запись таблицы');
			continue;
		}
		if (!t.name || !NAME_RE.test(t.name)) {
			errors.push(`Таблица «${t.name}»: имя — латиница/цифры/подчёркивание`);
		} else if (names.has(t.name)) {
			errors.push(`Дубликат таблицы «${t.name}»`);
		}
		names.add(t.name);
		if (t.parent && !pack.tables.some((x) => x.name === t.parent)) {
			errors.push(`Таблица «${t.name}»: родитель «${t.parent}» не в пакете`);
		}
		if (t.type && !KNOWN_TYPES.has(t.type) && !packTypes.has(t.type)) {
			errors.push(`Таблица «${t.name}»: неизвестный тип «${t.type}»`);
		}
		const colNames = new Set<string>();
		for (const c of t.columns ?? []) {
			if (!c || typeof c !== 'object') {
				errors.push(`Таблица «${t.name}»: повреждённая колонка`);
				continue;
			}
			if (!c.name || !NAME_RE.test(c.name)) {
				errors.push(`Колонка «${c.name}» (${t.name}): имя — латиница/цифры/подчёркивание`);
			} else if (colNames.has(c.name)) {
				errors.push(`Дубликат колонки «${c.name}» (${t.name})`);
			}
			colNames.add(c.name);
			if (!fieldRegistry[c.type]) {
				errors.push(`Колонка «${c.name}» (${t.name}): неизвестный тип поля «${c.type}»`);
			}
			if ((c.type === 'link' || c.type === 'linelink') && !c.relatedTable) {
				errors.push(`Колонка «${c.name}» (${t.name}): для типа ${c.type} укажите relatedTable`);
			}
		}
	}

	const keys = new Set<string>();
	for (const [tableName, recs] of Object.entries(pack.seedRecords ?? {})) {
		for (const r of recs ?? []) {
			if (!r || typeof r !== 'object') {
				errors.push(`Таблица «${tableName}»: повреждённая запись-сид`);
				continue;
			}
			if (!r.key || typeof r.key !== 'string') {
				errors.push(`Таблица «${tableName}»: у записи нет ключа (key)`);
			} else if (keys.has(r.key)) {
				errors.push(`Дубликат ключа записи @${r.key}`);
			}
			keys.add(r.key);
		}
	}

	for (const s of pack.scenarios ?? []) {
		if (!s || !s.name) {
			errors.push('Сценарий без имени');
			continue;
		}
		const nKeys = new Set<string>();
		for (const n of s.nodes ?? []) {
			if (!n || !n.key) {
				errors.push(`Сценарий «${s.name}»: узел без ключа`);
				continue;
			}
			if (nKeys.has(n.key)) errors.push(`Сценарий «${s.name}»: дубликат узла «${n.key}»`);
			nKeys.add(n.key);
			if (!refIsKnown(keys, n.element))
				errors.push(`Сценарий «${s.name}»: элемент ${n.element} не найден в seedRecords`);
			if (!refIsKnown(keys, n.service))
				errors.push(`Сценарий «${s.name}»: сервис ${n.service} не найден в seedRecords`);
		}
		for (const l of s.links ?? []) {
			if (!nKeys.has(l.from))
				errors.push(`Сценарий «${s.name}»: связь из узла «${l.from}» — узел не найден`);
			if (!nKeys.has(l.to))
				errors.push(`Сценарий «${s.name}»: связь в узел «${l.to}» — узел не найден`);
		}
	}

	for (const pf of pack.printForms ?? []) {
		if (!pf || !pf.name) errors.push('Печатная форма без имени');
		if (pf && !pf.targetTable) errors.push(`Печатная форма «${pf.name}»: укажите targetTable`);
	}

	return errors;
}

function refIsKnown(keys: Set<string>, ref: string | undefined): boolean {
	if (!ref) return true;
	if (ref.startsWith('@sys:') || ref.startsWith('@table:')) return true;
	if (ref.startsWith('@')) return keys.has(ref.slice(1));
	return true;
}

// ---------------------------------------------------------------------------
// Требования пакета

async function checkRequires(pack: SolutionPack, report: ApplyReport): Promise<boolean> {
	const req = pack.requires;
	if (!req) return true;
	if (req.engine && !versionAtLeast(ENGINE_VERSION, req.engine)) {
		report.errors.push(`Пакет требует движок ${req.engine}, установлен ${ENGINE_VERSION}.`);
		return false;
	}
	for (const p of req.packages ?? []) {
		if (!(await isPackageInstalled(p))) {
			report.errors.push(`Требуется установить пакет «${p}» перед этим пакетом.`);
			return false;
		}
	}
	return true;
}

// Установлен ли пакет: есть ли запись с таким именем в реестре solution_packs.
async function isPackageInstalled(name: string): Promise<boolean> {
	try {
		const table = await db.meta_tables.where('name').equals(SOLUTION_PACKS_TABLE).first();
		if (!table) return false;
		const recs = await db.data_records.where('table_id').equals(table.id).toArray();
		return recs.some((r) => r.data?.name === name);
	} catch {
		return false;
	}
}

function versionAtLeast(current: string, required: string): boolean {
	const norm = (v: string) =>
		String(v)
			.replace(/^[^\d]*/, '')
			.split('.')
			.map((n) => parseInt(n, 10) || 0);
	const c = norm(current);
	const r = norm(required);
	for (let i = 0; i < Math.max(c.length, r.length); i++) {
		const a = c[i] ?? 0;
		const b = r[i] ?? 0;
		if (a < b) return false;
		if (a > b) return true;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Разрешение ссылок

async function resolveTableId(ctx: RefContext, name: string): Promise<string | undefined> {
	const fromPack = ctx.tableIdMap.get(name);
	if (fromPack) return fromPack;
	const id = await findTableIdByName(name);
	if (!id) ctx.report.errors.push(`Таблица «${name}» не найдена (не в пакете и не в базе)`);
	return id ?? undefined;
}

async function resolveRecordRef(ctx: RefContext, ref: string): Promise<string | null> {
	const rest = ref.slice(5); // после '@sys:'
	const slash = rest.indexOf('/');
	const table = slash >= 0 ? rest.slice(0, slash) : rest;
	const name = slash >= 0 ? rest.slice(slash + 1) : '';
	const cacheKey = `${table}/${name}`;
	if (ctx.sysCache.has(cacheKey)) return ctx.sysCache.get(cacheKey) ?? null;
	const id = await findRecordByName(table, name, ctx.online);
	if (!id) {
		ctx.report.errors.push(`Ссылка @sys:${cacheKey} не найдена`);
		return null;
	}
	ctx.sysCache.set(cacheKey, id);
	return id;
}

async function findRecordByName(
	tableName: string,
	name: string,
	online: boolean
): Promise<string | null> {
	const tableId = await findTableIdByName(tableName);
	if (!tableId) return null;
	const local = await db.data_records
		.where('table_id')
		.equals(tableId)
		.filter((r) => (name ? r.data?.name === name : true))
		.first();
	if (local) return local.id;
	if (online) {
		try {
			let q = supabase.from('data_records').select('id').eq('table_id', tableId);
			if (name) q = q.filter('data->>name', 'eq', name);
			const { data } = await q.limit(1);
			return data?.[0]?.id ?? null;
		} catch {
			return null;
		}
	}
	return null;
}

async function resolveValue(ctx: RefContext, value: any): Promise<any> {
	if (typeof value === 'string') {
		if (value.startsWith('@ln:')) {
			const id = ctx.lineRefs.get(value.slice(4));
			if (id) return id;
			ctx.report.errors.push(`Строка ТЧ ${value} не найдена`);
			return value;
		}
		if (value.startsWith('@table:')) {
			return (await resolveTableId(ctx, value.slice(7))) ?? value;
		}
		if (value.startsWith('@sys:')) {
			return (await resolveRecordRef(ctx, value)) ?? value;
		}
		if (value.startsWith('@') && ctx.recordKeys.has(value.slice(1))) {
			return ctx.recordKeys.get(value.slice(1)) ?? value;
		}
		return value;
	}
	if (Array.isArray(value)) {
		const out: any[] = [];
		for (const v of value) out.push(await resolveValue(ctx, v));
		return out;
	}
	if (value && typeof value === 'object') {
		const out: Record<string, any> = {};
		for (const k of Object.keys(value)) out[k] = await resolveValue(ctx, value[k]);
		return out;
	}
	return value;
}

// Служебные ключи '__*' и undefined убираются перед записью в базу.
function cleanData(value: any): any {
	if (Array.isArray(value)) return value.map(cleanData);
	if (value && typeof value === 'object') {
		const out: Record<string, any> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k.startsWith('__')) continue;
			const cleaned = cleanData(v);
			if (cleaned === undefined) continue;
			out[k] = cleaned;
		}
		return out;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Применение

function orderTables(tables: TableSeed[]): TableSeed[] {
	const byName = new Map(tables.map((t) => [t.name, t]));
	const result: TableSeed[] = [];
	const visited = new Set<string>();
	const visit = (t: TableSeed) => {
		if (visited.has(t.name)) return;
		visited.add(t.name);
		if (t.parent && byName.has(t.parent)) visit(byName.get(t.parent)!);
		result.push(t);
	};
	for (const t of tables) visit(t);
	return result;
}

async function existingRecordData(
	tableId: string,
	online: boolean
): Promise<{ id: string; data: Record<string, any> }[]> {
	const local = await db.data_records.where('table_id').equals(tableId).toArray();
	const out = local.map((r) => ({ id: r.id, data: r.data ?? {} }));
	if (online) {
		try {
			const { data } = await supabase
				.from('data_records')
				.select('id, data')
				.eq('table_id', tableId)
				.limit(1000);
			out.push(...(data ?? []).map((r: any) => ({ id: r.id, data: r.data ?? {} })));
		} catch {
			// сервер недоступен — сверяемся только с локальным кэшем
		}
	}
	return out;
}

function matchesRecord(
	seedData: Record<string, any>,
	fields: string[],
	existing: Record<string, any>
): boolean {
	return fields.every((f) => {
		const sv = seedData[f];
		return sv !== undefined && sv !== null && sv !== '' && String(existing[f] ?? '') === String(sv);
	});
}

// Сохранение строк ТЧ: выделяем id всем строкам заранее (это позволяет
// @ln:ссылкам указывать на строки, идущие позже), затем разрешаем и пишем.
async function seedLines(
	ctx: RefContext,
	recordId: string,
	linesSpec: Record<string, Record<string, any>[]>,
	online: boolean
): Promise<void> {
	const prepared: { subTableId: string; id: string; data: Record<string, any> }[] = [];
	const lnMap = new Map<string, string>();
	const prevLineRefs = ctx.lineRefs;
	ctx.lineRefs = lnMap;
	try {
		for (const [subName, rows] of Object.entries(linesSpec)) {
			const subTableId = ctx.tableIdMap.get(subName) ?? (await findTableIdByName(subName));
			if (!subTableId) {
				ctx.report.errors.push(`Таблица «${subName}» для строк ТЧ не найдена`);
				continue;
			}
			for (const row of rows) {
				const newId = crypto.randomUUID();
				const oldId = row.__id != null ? String(row.__id) : null;
				if (oldId) lnMap.set(oldId, newId);
				prepared.push({ subTableId, id: newId, data: row });
			}
		}

		const localLines: LocalLine[] = [];
		const serverLines: any[] = [];
		const orderBySub = new Map<string, number>();
		for (const p of prepared) {
			const data = cleanData(await resolveValue(ctx, p.data));
			const order = (orderBySub.get(p.subTableId) ?? 0) + 1;
			orderBySub.set(p.subTableId, order);
			localLines.push({
				id: p.id,
				record_id: recordId,
				table_id: p.subTableId,
				data,
				sort_order: order
			});
			serverLines.push({
				id: p.id,
				record_id: recordId,
				table_id: p.subTableId,
				data,
				sort_order: order
			});
		}
		if (localLines.length > 0) await db.data_lines.bulkPut(localLines);
		if (online && serverLines.length > 0) {
			try {
				await supabase.from('data_lines').upsert(serverLines);
			} catch {
				// уедет ближайшим синком
			}
		}
	} finally {
		ctx.lineRefs = prevLineRefs;
	}
}

// Применить пакет: схема (таблицы/колонки/типы) + записи-сиды + сценарии +
// печатные формы. Идемпотентно; отчёт — как результат «▶️ Выполнить».
export async function applySolution(
	pack: SolutionPack,
	opts: ApplyOptions = {}
): Promise<ApplyReport> {
	const online = opts.online ?? (typeof navigator === 'undefined' || navigator.onLine);
	const report: ApplyReport = {
		ok: true,
		errors: [],
		warnings: [],
		tablesCreated: [],
		columnsAdded: 0,
		recordsSeeded: 0,
		recordsSkipped: 0,
		scenariosApplied: 0,
		printForms: 0
	};

	report.errors.push(...validatePack(pack));
	if (report.errors.length) return { ...report, ok: false };
	if (!(await checkRequires(pack, report))) return { ...report, ok: false };

	if (opts.dryRun) {
		report.warnings.push('Пробный прогон (dryRun): записей в базу не вносилось.');
		return report;
	}

	const tableIdMap = new Map<string, string>();
	const recordKeys = new Map<string, string>();
	const ctx: RefContext = {
		recordKeys,
		tableIdMap,
		sysCache: new Map(),
		lineRefs: new Map(),
		online,
		report
	};

	// Предустановки типов (raw definition как в редакторе типов).
	for (const tt of pack.tableTypes ?? []) {
		try {
			const { data } = await supabase
				.from('meta_table_types')
				.select('name')
				.eq('name', tt.type)
				.maybeSingle();
			if (data) {
				report.warnings.push(`Тип «${tt.type}» уже существует — предустановка не перезаписана.`);
			} else {
				const { saveTableTypeDefinitionDB } = await import('$lib/table-types');
				await saveTableTypeDefinitionDB(tt.type, tt.label, tt.definition ?? {});
				report.warnings.push(`Создана предустановка типа «${tt.label}» (${tt.type}).`);
			}
		} catch (e: any) {
			report.errors.push(`Тип ${tt.type}: ${e?.message ?? e}`);
		}
	}

	// Таблицы (родители до ТЧ) + колонки.
	for (const t of orderTables(pack.tables)) {
		try {
			const existed = !!(await db.meta_tables.where('name').equals(t.name).first());
			const parentId = t.parent ? (tableIdMap.get(t.parent) ?? null) : null;
			const tableId = await ensureTable(t.name, t.title, t.type, t.config ?? {}, parentId);
			tableIdMap.set(t.name, tableId);
			if (!existed) report.tablesCreated.push(t.name);
			else
				report.warnings.push(
					`Таблица «${t.title}» уже существует — добавлены только недостающие колонки.`
				);

			const cols: Record<string, any>[] = [];
			let i = 0;
			for (const c of t.columns ?? []) {
				const col: Record<string, any> = {
					name: c.name,
					title: c.title,
					type: c.type,
					sort_order: c.sort_order ?? (i + 1) * 10,
					is_visible: c.is_visible ?? false
				};
				if (c.relatedTable) {
					const related = await resolveTableId(ctx, c.relatedTable);
					if (related) col.related_table_id = related;
				}
				cols.push(col);
				i++;
			}
			if (cols.length > 0) {
				await ensureColumns(tableId, cols as any, online);
				report.columnsAdded += cols.length;
			}
		} catch (e: any) {
			report.errors.push(`Таблица ${t.name}: ${e?.message ?? e}`);
		}
	}

	// Каталоги записей (seedRecords) + печатные формы + сценарии — единый
	// конвейер «записи»; каждый пункт из раздела пакета превращается в RecordSeed.
	const recordsByTable = new Map<string, RecordSeed[]>();
	for (const [tableName, recs] of Object.entries(pack.seedRecords ?? {})) {
		recordsByTable.set(tableName, [...recs]);
	}
	const pfList = pack.printForms ?? [];
	if (pfList.length > 0) {
		const pfRecs = pfList.map<RecordSeed>((pf) => ({
			key: `pf:${pf.name ?? 'form'}`,
			kind: 'printForm',
			data: {
				name: pf.name ?? 'Без имени',
				...(pf.targetTable ? { target_table: `@table:${pf.targetTable}` } : {}),
				...(pf.templateHtml != null ? { template_html: pf.templateHtml } : {}),
				...(pf.code != null ? { code: pf.code } : {}),
				...(pf.isDefault != null ? { is_default: pf.isDefault } : {}),
				...(pf.delivery != null ? { delivery: pf.delivery } : {}),
				...(pf.outputFormat != null ? { output_format: pf.outputFormat } : {}),
				...(pf.summary != null ? { summary: pf.summary } : {}),
				...(pf.sortOrder != null ? { sort_order: pf.sortOrder } : {})
			}
		}));
		recordsByTable.set('print_forms', [...(recordsByTable.get('print_forms') ?? []), ...pfRecs]);
	}
	const scenarioList = pack.scenarios ?? [];
	if (scenarioList.length > 0) {
		const flowTables = ['flow_scenarios', 'flow_nodes', 'flow_links'];
		const flowIds = await Promise.all(flowTables.map((f) => findTableIdByName(f)));
		const missing = flowTables.filter((_, i) => !flowIds[i]);
		if (missing.length > 0) {
			for (const f of missing) {
				report.errors.push(`Модуль «Сценарии» не установлен — нужна таблица «${f}»`);
			}
		} else {
			const scenRecs = scenarioList.map<RecordSeed>((s) => {
				const nodeLines: Record<string, any>[] = (s.nodes ?? []).map((n) => ({
					__id: `node:${n.key}`,
					name: n.name ?? n.key,
					...(n.element != null ? { element: n.element } : {}),
					...(n.nodeType != null ? { node_type: n.nodeType } : {}),
					...(n.service != null ? { service: n.service } : {}),
					...(n.params != null ? { params: n.params } : {}),
					...(n.code != null ? { code: n.code } : {})
				}));
				const linkLines: Record<string, any>[] = (s.links ?? []).map((l) => ({
					from_node: `@ln:node:${l.from}`,
					to_node: `@ln:node:${l.to}`,
					...(l.role != null ? { role: l.role } : {}),
					...(l.label != null ? { label: l.label } : {})
				}));
				const data: Record<string, any> = { name: s.name };
				if (s.description != null) data.description = s.description;
				if (s.triggerTable) data.trigger_table = `@table:${s.triggerTable}`;
				if (s.triggerEvent) data.trigger_event = s.triggerEvent;
				if (s.params && Object.keys(s.params).length > 0) data.params = s.params;
				return {
					key: `sc:${s.name}`,
					kind: 'scenario',
					data,
					lines: { flow_nodes: nodeLines, flow_links: linkLines }
				};
			});
			recordsByTable.set('flow_scenarios', [
				...(recordsByTable.get('flow_scenarios') ?? []),
				...scenRecs
			]);
		}
	}

	// Пасс 1: решить, что сидить (по match-полям), и сразу выделить id.
	// Пропущенные записи всё равно регистрируются в recordKeys — ссылки '@key'
	// на уже существующие записи базы разрешаются к их реальным id.
	const plans: { tableName: string; tableId: string; seed: RecordSeed; id: string }[] = [];
	for (const [tableName, recs] of recordsByTable) {
		const tableId = tableIdMap.get(tableName) ?? (await findTableIdByName(tableName));
		if (!tableId) {
			report.errors.push(`Таблица «${tableName}» для записей не найдена`);
			continue;
		}
		const existing = await existingRecordData(tableId, online);
		for (const seed of recs) {
			const fields = seed.match && seed.match.length > 0 ? seed.match : ['name'];
			if (!opts.force) {
				const hit = existing.find((e) => matchesRecord(seed.data, fields, e.data));
				if (hit) {
					recordKeys.set(seed.key, hit.id);
					report.recordsSkipped++;
					continue;
				}
			}
			const id = crypto.randomUUID();
			recordKeys.set(seed.key, id);
			plans.push({ tableName, tableId, seed, id });
		}
	}

	// Пасс 2: разрешить ссылки и записать (записи + строки ТЧ).
	for (const plan of plans) {
		try {
			ctx.lineRefs = new Map();
			const data = cleanData(await resolveValue(ctx, plan.seed.data ?? {}));
			const record: LocalRecord = {
				id: plan.id,
				table_id: plan.tableId,
				status: 'draft',
				is_folder: false,
				parent_id: null,
				data,
				is_dirty: 1,
				updated_at: new Date().toISOString()
			};
			await seedRecord(record, online);
			if (plan.seed.lines && Object.keys(plan.seed.lines).length > 0) {
				await seedLines(ctx, plan.id, plan.seed.lines, online);
			}
			report.recordsSeeded++;
			if (plan.seed.kind === 'scenario') report.scenariosApplied++;
			else if (plan.seed.kind === 'printForm') report.printForms++;
		} catch (e: any) {
			report.errors.push(`Запись ${plan.seed.key}: ${e?.message ?? e}`);
		}
	}

	// Схема изменилась — уведомим другие клиенты (подтянут метаданные).
	if (report.tablesCreated.length > 0) {
		try {
			await bumpMetaVersion();
		} catch {
			// некритично
		}
	}

	report.ok = report.errors.length === 0;
	return report;
}

// ---------------------------------------------------------------------------
// Обратная операция: выгрузить существующий модуль в пакет (данные построены
// в конструкторе → JSON-пакет). Область — таблицы верхнего уровня (ТЧ
// добавляются автоматически); ссылки link/linelink на записи области
// превращаются в '@key'/'@ln:', ссылки на таблицы — в '@table:'.

async function fetchAll(table: string): Promise<any[]> {
	const rows: any[] = [];
	let offset = 0;
	for (;;) {
		const { data, error } = await supabase
			.from(table)
			.select('*')
			.order('id', { ascending: true })
			.range(offset, offset + SERVER_PAGE_SIZE - 1);
		if (error) throw new Error(`Ошибка чтения ${table}: ${error.message}`);
		const page = data ?? [];
		rows.push(...page);
		if (page.length < SERVER_PAGE_SIZE) break;
		offset += page.length;
	}
	return rows;
}

function convertExportValue(
	v: any,
	type: string | undefined,
	scopeRecordIds: Set<string>,
	scopeTableToName: Map<string, string>,
	lineIds: Set<string>
): any {
	if (typeof v === 'string') {
		if (type === 'link') {
			if (scopeRecordIds.has(v)) return `@${v}`;
			const tName = scopeTableToName.get(v);
			if (tName) return `@table:${tName}`;
			return v;
		}
		if (type === 'linelink' && lineIds.has(v)) return `@ln:${v}`;
		if (
			(type === 'jsonb' || type === 'paramslist' || type === 'universal') &&
			scopeRecordIds.has(v)
		) {
			return `@${v}`;
		}
		return v;
	}
	if (Array.isArray(v)) {
		return v.map((item) =>
			convertExportValue(item, type, scopeRecordIds, scopeTableToName, lineIds)
		);
	}
	if (v && typeof v === 'object') {
		const out: Record<string, any> = {};
		for (const k of Object.keys(v))
			out[k] = convertExportValue(v[k], type, scopeRecordIds, scopeTableToName, lineIds);
		return out;
	}
	return v;
}

function convertExportData(
	data: Record<string, any>,
	colTypeMap: Map<string, string>,
	scopeRecordIds: Set<string>,
	scopeTableToName: Map<string, string>,
	lineIds: Set<string>
): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(data)) {
		out[k] = convertExportValue(v, colTypeMap.get(k), scopeRecordIds, scopeTableToName, lineIds);
	}
	return out;
}

export async function exportSolution(
	opts: {
		tableNames?: string[];
		id?: string;
		title?: string;
		description?: string;
		includeRecords?: boolean;
	} = {}
): Promise<SolutionPack> {
	const tables = await fetchAll('meta_tables');
	const columns = await fetchAll('meta_columns');
	const records = await fetchAll('data_records');
	const allLines = await fetchAll('data_lines');

	const byId = new Map(tables.map((t) => [t.id, t]));

	// Область: явный список (или все таблицы); ТЧ добавляются с родителями.
	const scope = new Set<string>(
		opts.tableNames && opts.tableNames.length > 0 ? opts.tableNames : tables.map((t) => t.name)
	);
	let changed = true;
	while (changed) {
		changed = false;
		for (const t of tables) {
			if (scope.has(t.name)) continue;
			const parentName = t.parent_table_id ? byId.get(t.parent_table_id)?.name : null;
			if (parentName && scope.has(parentName)) {
				scope.add(t.name);
				changed = true;
			}
		}
	}
	const scopeIds = new Set(tables.filter((t) => scope.has(t.name)).map((t) => t.id));
	const scopeTableToName = new Map(
		tables.filter((t) => scope.has(t.name)).map((t) => [t.id, t.name])
	);
	const scopeRecordIds = new Set(records.filter((r) => scopeIds.has(r.table_id)).map((r) => r.id));

	const packTables: TableSeed[] = tables
		.filter((t) => scope.has(t.name))
		.map((t) => {
			const parentName = t.parent_table_id ? byId.get(t.parent_table_id)?.name : null;
			const seed: TableSeed = {
				name: t.name,
				title: t.title,
				type: t.type,
				...(t.config && Object.keys(t.config).length > 0 ? { config: t.config } : {}),
				...(parentName ? { parent: parentName } : {}),
				columns: columns
					.filter((c) => c.table_id === t.id)
					.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
					.map((c) => {
						const col: ColumnSeed = {
							name: c.name,
							title: c.title,
							type: c.type,
							is_visible: c.is_visible ?? false,
							sort_order: c.sort_order ?? 0
						};
						const related = c.related_table_id ? byId.get(c.related_table_id)?.name : null;
						if (related) col.relatedTable = related;
						return col;
					})
			};
			return seed;
		});

	const seedRecords: Record<string, RecordSeed[]> = {};
	if (opts.includeRecords !== false) {
		for (const t of tables.filter((t) => scope.has(t.name) && !t.parent_table_id)) {
			const colMap = new Map(
				columns.filter((c) => c.table_id === t.id).map((c) => [c.name, c.type])
			);
			const list: RecordSeed[] = [];
			for (const r of records.filter((rec) => rec.table_id === t.id)) {
				const recLines = allLines.filter((l) => l.record_id === r.id && scopeIds.has(l.table_id));
				const lineIds = new Set(recLines.map((l) => l.id));
				const seed: RecordSeed = {
					key: r.id,
					data: convertExportData(r.data ?? {}, colMap, scopeRecordIds, scopeTableToName, lineIds),
					...(r.data?.name ? { match: ['name'] } : {})
				};
				if (recLines.length > 0) {
					seed.lines = {};
					for (const l of recLines) {
						const subName = scopeTableToName.get(l.table_id);
						if (!subName) continue;
						const subColMap = new Map(
							columns.filter((c) => c.table_id === l.table_id).map((c) => [c.name, c.type])
						);
						seed.lines[subName] ??= [];
						seed.lines[subName].push({
							__id: l.id,
							...convertExportData(
								l.data ?? {},
								subColMap,
								scopeRecordIds,
								scopeTableToName,
								lineIds
							)
						});
					}
				}
				list.push(seed);
			}
			if (list.length > 0) seedRecords[t.name] = list;
		}
	}

	const id = opts.id ?? `solution-${Date.now().toString(36)}`;
	return {
		format: SOLUTION_FORMAT,
		version: SOLUTION_VERSION,
		id,
		title: opts.title ?? id,
		...(opts.description ? { description: opts.description } : {}),
		tables: packTables,
		...(Object.keys(seedRecords).length > 0 ? { seedRecords } : {})
	};
}

// Скачивание пакета как файла .json (для переноса между базами).
export function downloadSolution(pack: SolutionPack): void {
	const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `solution-${pack.id}.json`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Разобрать файл пакета в объект (бросает при неверном JSON).
export async function parseSolutionFile(file: File): Promise<SolutionPack> {
	const text = await file.text();
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== 'object') throw new Error('Файл не содержит данных пакета.');
	return parsed as SolutionPack;
}
