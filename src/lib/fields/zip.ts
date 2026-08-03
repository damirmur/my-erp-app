import type { FieldTypeModule } from './field';
import ZipField from './ZipField.svelte';

const zipField: FieldTypeModule = {
	type: 'zip',
	label: 'ZIP-архив (несколько файлов)',
	defaults: {},
	FormField: ZipField
};

export default zipField;
