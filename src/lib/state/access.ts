import { supabase } from '$lib/db/supabase';
import { db, type LocalRecord } from '$lib/db/indexeddb';
import {
	ensureTable,
	ensureColumns,
	seedRecord,
	hasServerRows,
	type ColumnSeed
} from '$lib/state/seed';
import { APP_SETTINGS_TABLE } from '$lib/state/settings';

// Модуль доступа (системные таблицы, движок читает их по имени):
//   access_roles   — «Роли» (каталог кодов ролей);
//   team_members   — «Команда» (auth.user_id -> роль, статус, провайдер);
//   access_rules   — «Правила доступа» (principal x object x action).
// Режим защиты хранится в app_settings (ключ access_lockdown, data.mode).
// Роли и правила — это данные (редактируются в конструкторе), а не код:
// движок (RLS-хелперы на сервере + этот модуль на клиенте) читает их по имени.

export const ACCESS_ROLES_TABLE = 'access_roles';
export const TEAM_TABLE = 'team_members';
export const RULES_TABLE = 'access_rules';
export const ACCESS_LOCKDOWN_KEY = 'access_lockdown';

export const ROLE_OWNER = 'owner';
export const ROLE_ADMIN = 'admin';

// Действия правил доступа
export type AccessAction = 'view' | 'edit' | 'execute';

// Правило доступа: кто (principal) x что (object) x действие.
export interface AccessRule {
	id?: string;
	principal_type: 'anon' | 'user' | 'role';
	principal_id: string; // для role — код роли, для user — uuid, для anon — ''
	object_type: 'table' | 'record';
	object_id: string;
	action: AccessAction;
}

export const DEFAULT_ROLES: { code: string; name: string; description: string }[] = [
	{
		code: ROLE_OWNER,
		name: 'Владелец',
		description: 'Полный доступ ко всей базе и управление доступом.'
	},
	{ code: ROLE_ADMIN, name: 'Администратор', description: 'Полный доступ ко всей базе.' },
	{ code: 'editor', name: 'Редактор', description: 'Просмотр и изменение по правилам доступа.' },
	{ code: 'reader', name: 'Читатель', description: 'Только просмотр по правилам доступа.' }
];

const ACCESS_ROLES_COLUMNS: ColumnSeed[] = [
	{ name: 'code', title: 'Код', type: 'string', sort_order: 1, is_visible: true },
	{ name: 'name', title: 'Наименование', type: 'string', sort_order: 2, is_visible: true },
	{ name: 'description', title: 'Описание', type: 'string', sort_order: 3, is_visible: true }
];

const TEAM_COLUMNS: ColumnSeed[] = [
	{
		name: 'user_id',
		title: 'Пользователь (auth)',
		type: 'string',
		sort_order: 1,
		is_visible: false
	},
	{ name: 'display_name', title: 'Имя', type: 'string', sort_order: 2, is_visible: true },
	{ name: 'provider', title: 'Вход', type: 'string', sort_order: 3, is_visible: true },
	{ name: 'external_id', title: 'Внешний id', type: 'string', sort_order: 4, is_visible: false },
	{ name: 'role', title: 'Роль', type: 'string', sort_order: 5, is_visible: true },
	{ name: 'status', title: 'Статус', type: 'string', sort_order: 6, is_visible: true }
];

const RULES_COLUMNS: ColumnSeed[] = [
	{ name: 'principal_type', title: 'Кто', type: 'string', sort_order: 1, is_visible: true },
	{ name: 'principal_id', title: 'Id субъекта', type: 'string', sort_order: 2, is_visible: true },
	{ name: 'object_type', title: 'Объект', type: 'string', sort_order: 3, is_visible: true },
	{ name: 'object_id', title: 'Id объекта', type: 'string', sort_order: 4, is_visible: true },
	{ name: 'action', title: 'Действие', type: 'string', sort_order: 5, is_visible: true }
];

// Идемпотентный сид системных таблиц доступа + каталог ролей по умолчанию.
// Вызывается из metadata.ensureSystemTables (модуль access, ядро).
export async function ensureAccessTables(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const rolesId = await ensureTable(ACCESS_ROLES_TABLE, 'Роли', 'directory', {
		hiddenInMain: true
	});
	await ensureColumns(rolesId, ACCESS_ROLES_COLUMNS, online);

	const teamId = await ensureTable(TEAM_TABLE, 'Команда', 'directory', { hiddenInMain: true });
	await ensureColumns(teamId, TEAM_COLUMNS, online);

	const rulesId = await ensureTable(RULES_TABLE, 'Правила доступа', 'directory', {
		hiddenInMain: true
	});
	await ensureColumns(rulesId, RULES_COLUMNS, online);

	// Каталог ролей по умолчанию — только если таблица пуста (не перезаписываем).
	if (online && !(await hasServerRows(rolesId, online))) {
		for (const r of DEFAULT_ROLES) {
			await seedRole(r.code, r.name, r.description, rolesId, online);
		}
	}
}

async function seedRole(
	code: string,
	name: string,
	description: string,
	tableId: string,
	online: boolean
) {
	const rec: LocalRecord = {
		id: crypto.randomUUID(),
		table_id: tableId,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		data: { code, name, description },
		is_dirty: 1,
		updated_at: new Date().toISOString()
	};
	await seedRecord(rec, online);
}

// id таблицы модуля по имени (локальный кэш).
async function tableIdByName(name: string): Promise<string | null> {
	return (await db.meta_tables.where('name').equals(name).first())?.id ?? null;
}

// Записи таблицы доступа из локального кэша.
async function rowsOf(name: string): Promise<LocalRecord[]> {
	const id = await tableIdByName(name);
	if (!id) return [];
	return db.data_records.where('table_id').equals(id).toArray();
}

// --- Команда ---------------------------------------------------------------

export interface TeamMember {
	id: string;
	user_id: string;
	display_name: string;
	provider: string;
	external_id: string;
	role: string;
	status: string;
}

export async function teamMembers(): Promise<TeamMember[]> {
	const rows = await rowsOf(TEAM_TABLE);
	return rows.map((r) => ({
		id: r.id,
		user_id: String(r.data?.user_id ?? ''),
		display_name: String(r.data?.display_name ?? ''),
		provider: String(r.data?.provider ?? ''),
		external_id: String(r.data?.external_id ?? ''),
		role: String(r.data?.role ?? ''),
		status: String(r.data?.status ?? '')
	}));
}

// Саморегистрация участника: после входа гарантируем строку «Команды».
// Первый участник в пустой таблице становится Владельцем (как на сервере).
export async function ensureTeamMemberRecord(
	uid: string,
	displayName: string,
	provider: string
): Promise<void> {
	const teamId = await tableIdByName(TEAM_TABLE);
	if (!teamId) return;
	const mine = (await rowsOf(TEAM_TABLE)).find((r) => String(r.data?.user_id ?? '') === uid);
	if (mine) return;

	const members = await teamMembers();
	const role = members.length === 0 ? ROLE_OWNER : '';
	const online = typeof navigator === 'undefined' || navigator.onLine;
	await seedRecord(
		{
			id: crypto.randomUUID(),
			table_id: teamId,
			status: 'draft',
			is_folder: false,
			parent_id: null,
			data: {
				user_id: uid,
				display_name: displayName,
				provider,
				external_id: '',
				role,
				status: role === ROLE_OWNER ? 'active' : 'invited'
			},
			is_dirty: 1,
			updated_at: new Date().toISOString()
		},
		online
	);
}

// Сменить роль участника (владелец/админ). Пишем на сервер и в локальный кэш.
export async function setMemberRole(memberId: string, role: string): Promise<void> {
	const teamId = await tableIdByName(TEAM_TABLE);
	if (!teamId) return;
	const rec = await db.data_records.get(memberId);
	if (!rec || rec.table_id !== teamId) return;
	const now = new Date().toISOString();
	const next: LocalRecord = {
		...rec,
		data: { ...rec.data, role, status: role ? 'active' : 'invited' },
		is_dirty: 1,
		updated_at: now
	};
	await db.data_records.put(next);
	try {
		await supabase
			.from('data_records')
			.update({ data: next.data, updated_at: now })
			.eq('id', memberId);
	} catch {
		// уедет при ближайшем синке
	}
}

// Удалить участника из команды.
export async function removeMember(memberId: string): Promise<void> {
	const teamId = await tableIdByName(TEAM_TABLE);
	if (!teamId) return;
	const rec = await db.data_records.get(memberId);
	if (!rec || rec.table_id !== teamId) return;
	await db.data_records.delete(memberId);
	try {
		await supabase.from('data_records').delete().eq('id', memberId);
	} catch {
		// уедет при ближайшем синке
	}
}

// --- Правила доступа -------------------------------------------------------

export async function accessRules(): Promise<AccessRule[]> {
	const rows = await rowsOf(RULES_TABLE);
	return rows
		.filter((r) => r.data?.object_type)
		.map((r) => ({
			id: r.id,
			principal_type: r.data.principal_type as AccessRule['principal_type'],
			principal_id: String(r.data.principal_id ?? ''),
			object_type: r.data.object_type as AccessRule['object_type'],
			object_id: String(r.data.object_id ?? ''),
			action: r.data.action as AccessAction
		}));
}

export function ruleKey(r: {
	principal_type: string;
	principal_id: string;
	object_type: string;
	object_id: string;
	action: string;
}): string {
	return `${r.principal_type}|${r.principal_id}|${r.object_type}|${r.object_id}|${r.action}`;
}

// Добавить/обновить правило (идемпотентно по ключу). Только админы (RLS).
export async function upsertRule(rule: AccessRule): Promise<void> {
	const rulesId = await tableIdByName(RULES_TABLE);
	if (!rulesId) return;
	const existing = (await rowsOf(RULES_TABLE)).find(
		(r) =>
			ruleKey(
				r.data as {
					principal_type: string;
					principal_id: string;
					object_type: string;
					object_id: string;
					action: string;
				}
			) === ruleKey(rule)
	);
	const online = typeof navigator === 'undefined' || navigator.onLine;
	const rec: LocalRecord = {
		id: existing?.id ?? crypto.randomUUID(),
		table_id: rulesId,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		data: { ...rule, id: undefined },
		is_dirty: 1,
		updated_at: new Date().toISOString()
	};
	await seedRecord(rec, online);
}

export async function deleteRule(recordId: string): Promise<void> {
	await db.data_records.delete(recordId);
	try {
		await supabase.from('data_records').delete().eq('id', recordId);
	} catch {
		// уедет при ближайшем синке
	}
}

// --- Режим доступа ---------------------------------------------------------

export async function loadAccessMode(): Promise<'open' | 'locked'> {
	const table = await db.meta_tables.where('name').equals(APP_SETTINGS_TABLE).first();
	if (!table) return 'open';
	const rows = await db.data_records.where('table_id').equals(table.id).toArray();
	const rec = rows.find((r) => r.data?.key === ACCESS_LOCKDOWN_KEY);
	return rec?.data?.mode === 'locked' ? 'locked' : 'open';
}

export async function saveAccessMode(mode: 'open' | 'locked'): Promise<void> {
	const table = await db.meta_tables.where('name').equals(APP_SETTINGS_TABLE).first();
	if (!table) return;
	const rows = await db.data_records.where('table_id').equals(table.id).toArray();
	const existing = rows.find((r) => r.data?.key === ACCESS_LOCKDOWN_KEY);
	const online = typeof navigator === 'undefined' || navigator.onLine;
	const now = new Date().toISOString();
	const rec: LocalRecord = {
		id: existing?.id ?? crypto.randomUUID(),
		table_id: table.id,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		data: { key: ACCESS_LOCKDOWN_KEY, mode },
		is_dirty: 1,
		updated_at: now
	};
	await db.data_records.put(rec);
	if (online) {
		try {
			await supabase.from('data_records').upsert({
				id: rec.id,
				table_id: rec.table_id,
				status: rec.status,
				data: rec.data,
				updated_at: rec.updated_at,
				is_folder: rec.is_folder ?? false,
				parent_id: rec.parent_id ?? null
			});
		} catch {
			// уедет при ближайшем синке
		}
	}
}

// --- Публичность таблиц ----------------------------------------------------

export async function setTablePublic(tableId: string, pub: boolean): Promise<void> {
	const table = await db.meta_tables.get(tableId);
	if (!table) return;
	const config = { ...(table.config ?? {}), public: pub };
	const { error } = await supabase.from('meta_tables').update({ config }).eq('id', tableId);
	if (error) {
		alert(`Ошибка сохранения публичности: ${error.message}`);
		return;
	}
	await db.meta_tables.put({ ...table, config });
}

export function tableIsPublic(table: { config?: Record<string, any> | null }): boolean {
	return table.config?.public === true;
}
