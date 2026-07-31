import type { FieldTypeModule } from './field';
import DateTimeField from './DateTimeField.svelte';

const datetimeField: FieldTypeModule = {
	type: 'datetime',
	label: 'ДатаВремя',
	defaults: {},
	FormField: DateTimeField
};

export default datetimeField;
