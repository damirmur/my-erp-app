import type { FieldTypeModule } from './field';
import ParamsListField from './ParamsListField.svelte';

// «Параметры (список)»: визуальный редактор jsonb-параметров (например,
// Параметры сценария). Значение — объект { ключ: [...значений] }: каждый ключ —
// строка, значение — список полей-ссылок (targetTableId) с добавлением/удалением.
// Хранимое значение остаётся обычным JSON-объектом (совместимо с jsonb).
const paramslistField: FieldTypeModule = {
	type: 'paramslist',
	label: 'Параметры (список)',
	defaults: {},
	FormField: ParamsListField
};

export default paramslistField;
