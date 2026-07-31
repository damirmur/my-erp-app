import type { TableTypeModule } from './type';

// Базовый шаблон для создания новых типов таблиц: полный набор возможностей,
// стандартные кнопки генерируются из фич и ролей статусов автоматически.
const template: TableTypeModule = {
	type: 'template',
	label: 'Шаблон',
	statuses: [
		{
			value: 'draft',
			label: 'Черновик',
			icon: '⚪',
			badgeClass: 'status-draft',
			isReadOnly: false
		},
		{
			value: 'posted',
			label: 'Проведен',
			icon: '🟢',
			badgeClass: 'status-posted',
			isReadOnly: true,
			role: 'posted'
		},
		{
			value: 'marked_for_deletion',
			label: 'Помечен на удаление',
			icon: '❌',
			badgeClass: 'status-marked_for_deletion',
			isReadOnly: true,
			role: 'deleted'
		}
	],
	features: {
		create: true,
		save: true,
		post: true,
		copy: true,
		print: true,
		massOperations: true,
		hierarchy: false,
		delete: false,
		run: false,
		tabularSections: true
	},
	actions: [],
	fields: [
		{ name: 'number', title: 'Номер', type: 'string' },
		{ name: 'name', title: 'Содержание', type: 'string' }
	]
};

export default template;
