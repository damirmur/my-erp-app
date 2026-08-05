import type { TableTypeModule, StatusDef, ActionDef, ActionDefDB, TableTypeFeatures } from './type';
import { FEATURE_KEYS } from './type';
import { standardActionsFor } from './standardActions';
import type { LocalTable, TableConfig } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { derived, get } from 'svelte/store';
import { dynamicTypes } from './store';
import directory from './directory';
import document from './document';
import template from './template';
import constant from './constant';
import tabular from './tabular';
import system from './system';

export type { TableTypeModule, StatusDef, ActionDef };
export type { TableConfig };
export { dynamicTypes };
export { FEATURE_KEYS, FEATURE_LABELS } from './type';

const builtinRegistry: Record<string, TableTypeModule> = {
	directory,
	document,
	template,
	constant,
	tabular,
	system
};
const defaultType = document;

export const tableTypeList = derived(dynamicTypes, ($dyn) => {
	const merged = { ...builtinRegistry, ...$dyn };
	return Object.values(merged);
});

export function getTableType(type: string): TableTypeModule {
	const merged = { ...builtinRegistry, ...get(dynamicTypes) };
	return merged[type] ?? defaultType;
}

export async function syncTableTypes() {
	const { data, error } = await supabase.from('meta_table_types').select('*');
	if (error || !data) {
		console.warn('Не удалось загрузить типы таблиц из БД:', error?.message);
		return;
	}
	const loaded: Record<string, TableTypeModule> = {};
	for (const row of data) {
		const def = row.definition as any;
		// Недостающие ключи фич подставляем как false (без вывода из действий)
		const defaults: TableTypeFeatures = {
			create: false,
			save: false,
			post: false,
			copy: false,
			print: false,
			massOperations: false,
			hierarchy: false,
			tabularSections: false,
			delete: false,
			run: false
		};
		loaded[row.name] = {
			type: row.name,
			label: row.label,
			statuses: (def.statuses ?? []) as StatusDef[],
			features: { ...defaults, ...(def.features ?? {}) },
			// Явные действия строки — кастомные кнопки и переопределения стандартных
			actions: (def.actions ?? []).map((a: ActionDefDB) => ({
				...a,
				show: a.showWhen
					? (s: string) => s === a.showWhen
					: a.showWhenNot
						? (s: string) => s !== a.showWhenNot
						: undefined,
				disabled: a.disabledWhen ? (s: string) => a.disabledWhen!.split(',').includes(s) : undefined
			})),
			fields: def.fields ?? []
		};
	}
	dynamicTypes.set(loaded);
}

export function getStatusDef(type: string, status: string): StatusDef | undefined {
	return getTableType(type).statuses.find((s) => s.value === status);
}

export function isReadOnly(type: string, status: string, config?: Record<string, any>): boolean {
	const overrides = config?.statusReadOnly;
	if (overrides?.[status] !== undefined) return overrides[status];
	return getStatusDef(type, status)?.isReadOnly ?? false;
}

export function getEffectiveConfig(
	table: LocalTable | null
): TableConfig & { features: TableTypeFeatures } {
	const typeDef = getTableType(table?.type ?? 'document');
	const c = table?.config ?? {};
	const features = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, c.features?.[k] ?? typeDef.features[k]])
	) as unknown as TableTypeFeatures;
	return {
		features,
		hiddenActions: c.hiddenActions ?? [],
		statusReadOnly: c.statusReadOnly ?? {},
		periodic: c.periodic ?? false
	};
}

// Итоговый список кнопок: стандартные из фич + кастомные/переопределения из модуля типа.
// Переопределение: действие с тем же id и mode в module.actions заменяет стандартное.
export function getActions(type: string, mode: string, config?: Record<string, any>): ActionDef[] {
	const typeDef = getTableType(type);
	const hide = config?.hiddenActions ?? [];
	const c = config ?? {};
	// Эффективные фичи: переопределения конкретной таблицы поверх фич типа
	const features = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, c.features?.[k] ?? typeDef.features[k]])
	) as TableTypeFeatures;
	const byKey = new Map<string, ActionDef>();
	for (const a of standardActionsFor(typeDef, features)) {
		byKey.set(`${a.id}|${a.type}`, a);
	}
	for (const a of typeDef.actions) {
		byKey.set(`${a.id}|${a.type}`, a);
	}
	return [...byKey.values()].filter((a) => a.type === mode && !hide.includes(a.id));
}

// upsert в PostgREST (ON CONFLICT DO UPDATE) при включённом RLS отбивает 42501,
// поэтому сохраняем явно: SELECT -> INSERT или UPDATE
async function saveTypeRow(name: string, label: string, definition: Record<string, any>) {
	const { data: existing } = await supabase
		.from('meta_table_types')
		.select('name')
		.eq('name', name)
		.maybeSingle();

	let error: any = null;
	if (existing) {
		({ error } = await supabase
			.from('meta_table_types')
			.update({ label, definition })
			.eq('name', name));
	} else {
		({ error } = await supabase.from('meta_table_types').insert({ name, label, definition }));
	}
	if (error) throw error;
}

export async function saveTableTypeToDB(name: string, label: string, module: TableTypeModule) {
	const definition = {
		statuses: module.statuses,
		features: module.features,
		fields: module.fields ?? [],
		actions: module.actions.map((a) => ({
			id: a.id,
			label: a.label,
			icon: a.icon,
			type: a.type,
			variant: a.variant,
			showWhen: (a as any).showWhen,
			showWhenNot: (a as any).showWhenNot,
			disabledWhen: (a as any).disabledWhen
		}))
	};
	await saveTypeRow(name, label, definition);
	await syncTableTypes();
}

// Создать новый тип от базового: копирует definition (статусы/действия/фичи/шаблон полей)
// из строки meta_table_types базового типа (если есть) или из встроенного модуля
export async function createTableTypeFromBase(baseName: string, name: string, label: string) {
	const { data, error } = await supabase
		.from('meta_table_types')
		.select('definition')
		.eq('name', baseName)
		.maybeSingle();

	let definition: Record<string, any>;
	if (!error && data?.definition) {
		definition = data.definition;
	} else {
		const mod = getTableType(baseName);
		definition = {
			statuses: mod.statuses,
			features: mod.features,
			fields: mod.fields ?? [],
			actions: mod.actions.map((a) => ({
				id: a.id,
				label: a.label,
				icon: a.icon,
				type: a.type,
				variant: a.variant,
				showWhen: (a as any).showWhen,
				showWhenNot: (a as any).showWhenNot,
				disabledWhen: (a as any).disabledWhen
			}))
		};
	}

	// Глубокая копия, чтобы новый тип не делил объекты с базовым
	const cloned = JSON.parse(JSON.stringify(definition));

	await saveTypeRow(name, label, cloned);
	await syncTableTypes();
}

export async function deleteTableTypeFromDB(name: string) {
	const { error } = await supabase.from('meta_table_types').delete().eq('name', name);
	if (error) throw error;
	await syncTableTypes();
}
