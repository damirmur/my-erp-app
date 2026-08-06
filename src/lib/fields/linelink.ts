import type { FieldTypeModule } from './field';
import LineLinkField from './LineLinkField.svelte';
import LinelinkConfig from './LinelinkConfig.svelte';

// «Ссылка на строку ТЧ»: выбирает строку табличной части текущей записи из
// выпадающего списка. Значение — id строки data_lines; целевая ТЧ задаётся
// related_table_id. Используется для связей между узлами сценария: from_node/to_node.
const linelinkField: FieldTypeModule = {
	type: 'linelink',
	label: 'Ссылка на строку ТЧ',
	defaults: {},
	Configurator: LinelinkConfig,
	FormField: LineLinkField
};

export default linelinkField;
