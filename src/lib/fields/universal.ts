import type { FieldTypeModule } from './field';
import UniversalField from './UniversalField.svelte';

// «Универсальное»: в разных записях одной таблицы поле может иметь свой тип
// (строка, датавремя, ссылка, число и т.д.). Хранимое значение — объект
// { t: тип, v: значение }; тип выбирается при редактировании каждой записи.
const universalField: FieldTypeModule = {
	type: 'universal',
	label: 'Универсальное',
	defaults: {},
	FormField: UniversalField
};

export default universalField;
