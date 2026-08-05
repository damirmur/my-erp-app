import type { TableTypeModule } from './type';

// Системный тип: внутренние таблицы приложения (например, «История»).
// Никаких пользовательских действий и статусов — объекты открываются особым
// образом (для истории — по ссылке из записи), а не как обычные документы.
const system: TableTypeModule = {
	type: 'system',
	label: 'Системная',
	statuses: [],
	features: {
		create: false,
		save: false,
		post: false,
		copy: false,
		print: false,
		massOperations: false,
		hierarchy: false,
		tabularSections: false,
		delete: false,
		run: false
	},
	actions: [],
	fields: []
};

export default system;
