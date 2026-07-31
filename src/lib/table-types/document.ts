import type { TableTypeModule } from './type';

const document: TableTypeModule = {
	type: 'document',
	label: 'Документ',
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
			isReadOnly: true
		},
		{
			value: 'marked_for_deletion',
			label: 'Помечен на удаление',
			icon: '❌',
			badgeClass: 'status-marked_for_deletion',
			isReadOnly: true
		}
	],
	features: {
		hierarchy: false,
		copy: true,
		print: true,
		tabularSections: true
	},
	actions: [
		{ id: 'create', label: 'Создать', icon: '➕', type: 'list', variant: 'primary' },
		{
			id: 'save',
			label: 'Записать',
			icon: '💾',
			type: 'form',
			disabled: (s) => s === 'posted' || s === 'marked_for_deletion'
		},
		{
			id: 'post',
			label: 'Провести',
			icon: '✔️',
			type: 'form',
			variant: 'success',
			show: (s) => s !== 'posted',
			disabled: (s) => s === 'marked_for_deletion'
		},
		{
			id: 'unpost',
			label: 'Отменить проведение',
			icon: '↩️',
			type: 'form',
			variant: 'warning',
			show: (s) => s === 'posted'
		},
		{
			id: 'markDelete',
			label: 'Пометить на удаление',
			icon: '❌',
			type: 'form',
			variant: 'text-danger',
			show: (s) => s !== 'marked_for_deletion'
		},
		{
			id: 'unmarkDelete',
			label: 'Снять пометку удаления',
			icon: '↩️',
			type: 'form',
			variant: 'text-success',
			show: (s) => s === 'marked_for_deletion'
		},
		{ id: 'copy', label: 'Копировать', icon: '📋', type: 'list' },
		{ id: 'copy', label: 'Копировать', icon: '📋', type: 'form' },
		{ id: 'massPost', label: 'Провести выбранные', icon: '✔️', type: 'list', variant: 'success' },
		{
			id: 'massDelete',
			label: 'Пометить на удаление',
			icon: '❌',
			type: 'list',
			variant: 'danger'
		},
		{ id: 'massRestore', label: 'Восстановить', icon: '↩️', type: 'list' },
		{ id: 'print', label: 'Печать', icon: '🖨️', type: 'list' },
		{ id: 'print', label: 'Печать', icon: '🖨️', type: 'form' }
	],
	fields: [
		{ name: 'number', title: 'Номер', type: 'string' },
		{ name: 'name', title: 'Содержание', type: 'string' }
	]
};

export default document;
