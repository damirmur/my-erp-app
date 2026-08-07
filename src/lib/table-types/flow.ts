import type { TableTypeModule } from './type';

// Тип «Сценарий»: одна запись = схема/граф как в n8n. Узлы и связи хранятся
// в табличных частях (сид `ensureFlowTables`), исполнение — по кнопке «▶️
// Выполнить» через движок `flow` (flowRunner.ts), вызываемый из config.runCode.
const flow: TableTypeModule = {
	type: 'flow',
	label: 'Сценарий',
	statuses: [
		{
			value: 'draft',
			label: 'Записан',
			icon: '⚪',
			badgeClass: 'status-draft',
			isReadOnly: false
		}
	],
	features: {
		create: true,
		save: true,
		post: false,
		copy: true,
		print: false,
		massOperations: false,
		hierarchy: false,
		delete: true,
		run: true,
		tabularSections: true
	},
	actions: [],
	fields: [{ name: 'name', title: 'Наименование', type: 'string' }]
};

export default flow;
