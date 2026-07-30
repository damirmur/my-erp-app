import type { FieldTypeModule } from './field';
import DateField from './DateField.svelte';

const dateField: FieldTypeModule = {
    type: 'date',
    label: 'Дата',
    defaults: {},
    FormField: DateField
};

export default dateField;
