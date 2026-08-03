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
	jsonb: jsonbField
};

export const fieldTypeList: FieldTypeModule[] = Object.values(fieldRegistry);

export function fieldTypeLabel(type: string): string {
	return fieldRegistry[type]?.label ?? type;
}

// Форматирование значения ячейки списка по типу поля
export function formatFieldValue(type: string, raw: any): string {
	if (raw == null || raw === '') return '';
	if (type === 'datetime') {
		const d = new Date(raw);
		if (isNaN(d.getTime())) return String(raw);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
	if (type === 'birth' && typeof raw === 'object') {
		const parts: string[] = [];
		if (raw.local) parts.push(raw.local.replace('T', ' '));
		if (raw.tz) parts.push(`UTC${raw.tz}`);
		if (raw.place) parts.push(raw.place);
		return parts.join(' · ');
	}
	if (typeof raw === 'object') return JSON.stringify(raw);
	if (type === 'textarea') return String(raw).replace(/\s+/g, ' ').trim();
	return String(raw);
}
