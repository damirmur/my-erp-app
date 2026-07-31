import type { TableTypeModule, StatusDef, ActionDef, ActionDefDB, TableTypeFeatures } from './type';
import type { LocalTable, TableConfig } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { derived, get } from 'svelte/store';
import { dynamicTypes } from './store';
import directory from './directory';
import document from './document';
import template from './template';

export type { TableTypeModule, StatusDef, ActionDef };
export type { TableConfig };
export { dynamicTypes };

const builtinRegistry: Record<string, TableTypeModule> = { directory, document, template };
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
		loaded[row.name] = {
			type: row.name,
			label: row.label,
			statuses: def.statuses ?? [],
			features: (def.features ?? {
				hierarchy: false,
				copy: false,
				print: false,
				tabularSections: false
			}) as TableTypeFeatures,
			actions: (def.actions ?? []).map((a: ActionDefDB) => ({
				...a,
				show: a.showWhen
					? (s: string) => s === a.showWhen
					: a.showWhenNot
						? (s: string) => s !== a.showWhenNot
						: undefined,
				disabled: a.disabledWhen ? (s: string) => a.disabledWhen!.split(',').includes(s) : undefined
			}))
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

export function getEffectiveConfig(table: LocalTable): TableConfig {
	const typeDef = getTableType(table.type);
	const c = table.config ?? {};
	return {
		features: {
			hierarchy: c.features?.hierarchy ?? typeDef.features.hierarchy,
			copy: c.features?.copy ?? typeDef.features.copy,
			print: c.features?.print ?? typeDef.features.print,
			tabularSections: c.features?.tabularSections ?? typeDef.features.tabularSections
		},
		hiddenActions: c.hiddenActions ?? [],
		statusReadOnly: c.statusReadOnly ?? {}
	};
}

export function getActions(type: string, mode: string, config?: Record<string, any>): ActionDef[] {
	const hide = config?.hiddenActions ?? [];
	return getTableType(type).actions.filter((a) => a.type === mode && !hide.includes(a.id));
}

export async function saveTableTypeToDB(name: string, label: string, module: TableTypeModule) {
	const definition = {
		statuses: module.statuses,
		features: module.features,
		actions: module.actions.map((a) => ({
			id: a.id,
			label: a.label,
			icon: a.icon,
			type: a.type,
			variant: a.variant
		}))
	};
	const { error } = await supabase
		.from('meta_table_types')
		.upsert({ name, label, definition }, { onConflict: 'name' });
	if (error) throw error;
	await syncTableTypes();
}

export async function deleteTableTypeFromDB(name: string) {
	const { error } = await supabase.from('meta_table_types').delete().eq('name', name);
	if (error) throw error;
	await syncTableTypes();
}
