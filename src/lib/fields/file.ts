import type { FieldTypeModule } from './field';
import FileField from './FileField.svelte';

const fileField: FieldTypeModule = {
	type: 'file',
	label: 'Файл',
	defaults: {},
	FormField: FileField
};

export default fileField;
