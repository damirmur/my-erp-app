import type { FieldTypeModule } from './field';
import stringField from './string';
import numberField from './number';
import booleanField from './boolean';
import dateField from './date';
import linkField from './link';

export type { FieldTypeModule } from './field';

export const fieldRegistry: Record<string, FieldTypeModule> = {
	string: stringField,
	number: numberField,
	boolean: booleanField,
	date: dateField,
	link: linkField
};

export const fieldTypeList: FieldTypeModule[] = Object.values(fieldRegistry);
