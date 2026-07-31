import type { FieldTypeModule } from './field';
import NumberField from './NumberField.svelte';

const numberField: FieldTypeModule = {
	type: 'number',
	label: 'Число',
	defaults: {},
	FormField: NumberField
};

export default numberField;
