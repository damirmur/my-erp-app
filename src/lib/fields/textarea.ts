import type { FieldTypeModule } from './field';
import TextareaField from './TextareaField.svelte';

const textareaField: FieldTypeModule = {
	type: 'textarea',
	label: 'Текст (многострочный)',
	defaults: {},
	FormField: TextareaField
};

export default textareaField;
