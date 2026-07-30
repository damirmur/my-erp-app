import type { FieldTypeModule } from './field';
import StringField from './StringField.svelte';

const stringField: FieldTypeModule = {
    type: 'string',
    label: 'Строка',
    defaults: {},
    FormField: StringField
};

export default stringField;
