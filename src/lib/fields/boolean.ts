import type { FieldTypeModule } from './field';
import BooleanField from './BooleanField.svelte';

const booleanField: FieldTypeModule = {
    type: 'boolean',
    label: 'Булево',
    defaults: {},
    FormField: BooleanField
};

export default booleanField;
