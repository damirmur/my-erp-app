import type { FieldTypeModule } from './field';
import SelectField from './SelectField.svelte';

// «Выбор из списка»: выпадающий список. Варианты передаются компоненту извне
// (например, для node_type ТЧ «Узлы» — каталог элементов сценария из
// flowElements.selectOptionsFor). Хранимое значение — выбранный код (строка).
const selectField: FieldTypeModule = {
	type: 'select',
	label: 'Выбор из списка',
	defaults: {},
	FormField: SelectField
};

export default selectField;
