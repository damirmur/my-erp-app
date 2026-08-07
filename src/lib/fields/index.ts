import type { FieldTypeModule } from './field';
import stringField from './string';
import textareaField from './textarea';
import numberField from './number';
import booleanField from './boolean';
import dateField from './date';
import datetimeField from './datetime';
import birthField from './birth';
import linkField from './link';
import jsonbField from './jsonb';
import fileField from './file';
import zipField from './zip';
import universalField from './universal';
import linelinkField from './linelink';
import selectField from './select';
import paramslistField from './paramslist';

export type { FieldTypeModule } from './field';

export const fieldRegistry: Record<string, FieldTypeModule> = {
	string: stringField,
	textarea: textareaField,
	number: numberField,
	boolean: booleanField,
	date: dateField,
	datetime: datetimeField,
	birth: birthField,
	link: linkField,
	jsonb: jsonbField,
	file: fileField,
	zip: zipField,
	universal: universalField,
	linelink: linelinkField,
	select: selectField,
	paramslist: paramslistField
};

export const fieldTypeList: FieldTypeModule[] = Object.values(fieldRegistry);

export function fieldTypeLabel(type: string): string {
	return fieldRegistry[type]?.label ?? type;
}

// Форматирование значения ячейки списка по типу поля
export function formatFieldValue(type: string, raw: any): string {
	if (raw == null || raw === '') return '';
	if (type === 'universal' && raw && typeof raw === 'object' && typeof raw.t === 'string') {
		return formatFieldValue(raw.t, raw.v);
	}
	if (type === 'file' && typeof raw === 'object') {
		return raw.name ? `📄 ${raw.name}` : '';
	}
	if (type === 'zip' && typeof raw === 'object') {
		const count = Array.isArray(raw.files) ? raw.files.length : 0;
		const name = raw.name ? ` ${raw.name}` : '';
		return `🗜${name} (${count} файл.)`;
	}
	if (type === 'datetime') {
		const d = new Date(raw);
		if (isNaN(d.getTime())) return String(raw);
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'short',
			timeStyle: 'short'
		}).format(d);
	}
	if (type === 'date' && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
		const d = new Date(`${raw.slice(0, 10)}T00:00:00`);
		if (!isNaN(d.getTime())) {
			return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(d);
		}
	}
	if (type === 'birth' && typeof raw === 'object') {
		const parts: string[] = [];
		if (raw.local) parts.push(raw.local.replace('T', ' '));
		if (raw.tz) parts.push(`UTC${raw.tz}`);
		if (raw.place) parts.push(raw.place);
		return parts.join(' · ');
	}
	if (type === 'link' && typeof raw === 'string') return String(raw);
	if (type === 'linelink') return String(raw);
	if (type === 'select') return String(raw);
	if (type === 'paramslist' && raw && typeof raw === 'object') {
		const parts = Object.entries(raw)
			.filter(([k]) => k !== '__meta')
			.map(([k, v]) => {
				const n = Array.isArray(v) ? v.length : 1;
				return `${k}: ${n}`;
			});
		return parts.join(' · ') || '∅';
	}
	if (typeof raw === 'object') return JSON.stringify(raw);
	if (type === 'textarea') return String(raw).replace(/\s+/g, ' ').trim();
	return String(raw);
}
