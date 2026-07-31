import type { FieldTypeModule } from './field';
import JsonField from './JsonField.svelte';

const jsonbField: FieldTypeModule = {
	type: 'jsonb',
	label: 'JSON (с валидацией)',
	defaults: {},
	FormField: JsonField
};

export default jsonbField;
