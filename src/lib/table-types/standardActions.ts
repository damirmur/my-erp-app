import type { ActionDef, TableTypeModule, TableTypeFeatures } from './type';

// Каталог стандартных действий: одна запись на фичу, из которой генерируются кнопки.
// Условия показа/блокировки выводятся из статусов (роль + isReadOnly), а не прописываются вручную.

function roleOf(statuses: TableTypeModule['statuses'], status: string): string | undefined {
	return statuses.find((s) => s.value === status)?.role;
}

function isEditable(statuses: TableTypeModule['statuses'], status: string): boolean {
	return !(statuses.find((s) => s.value === status)?.isReadOnly ?? true);
}

export function standardActionsFor(
	typeDef: TableTypeModule,
	features: TableTypeFeatures
): ActionDef[] {
	const { statuses } = typeDef;
	const hasPosted = statuses.some((s) => s.role === 'posted');
	const hasDeleted = statuses.some((s) => s.role === 'deleted');

	const out: ActionDef[] = [];

	if (features.create) {
		out.push({ id: 'create', label: 'Создать', icon: '➕', type: 'list', variant: 'primary' });
	}

	if (features.hierarchy) {
		out.push({ id: 'createFolder', label: 'Создать группу', icon: '📁', type: 'list' });
		out.push({ id: 'moveUp', label: 'На уровень вверх', icon: '⬆️', type: 'list' });
	}

	if (features.save) {
		out.push({
			id: 'save',
			label: 'Записать',
			icon: '💾',
			type: 'form',
			disabled: (s) => !isEditable(statuses, s)
		});
	}

	if (features.post && hasPosted) {
		out.push({
			id: 'post',
			label: 'Провести',
			icon: '✔️',
			type: 'form',
			variant: 'success',
			show: (s) => roleOf(statuses, s) !== 'posted' && isEditable(statuses, s)
		});
		out.push({
			id: 'unpost',
			label: 'Отменить проведение',
			icon: '↩️',
			type: 'form',
			variant: 'warning',
			show: (s) => roleOf(statuses, s) === 'posted'
		});
		if (features.massOperations) {
			out.push({
				id: 'massPost',
				label: 'Провести выбранные',
				icon: '✔️',
				type: 'list',
				variant: 'success'
			});
		}
	}

	if (hasDeleted) {
		out.push({
			id: 'markDelete',
			label: 'Пометить на удаление',
			icon: '❌',
			type: 'form',
			variant: 'text-danger',
			show: (s) => roleOf(statuses, s) !== 'deleted'
		});
		out.push({
			id: 'unmarkDelete',
			label: 'Снять пометку удаления',
			icon: '↩️',
			type: 'form',
			variant: 'text-success',
			show: (s) => roleOf(statuses, s) === 'deleted'
		});
	}

	if (features.copy) {
		out.push({ id: 'copy', label: 'Копировать', icon: '📋', type: 'list' });
		out.push({ id: 'copy', label: 'Копировать', icon: '📋', type: 'form' });
	}

	if (features.print) {
		out.push({ id: 'print', label: 'Печать', icon: '🖨️', type: 'list' });
		out.push({ id: 'print', label: 'Печать', icon: '🖨️', type: 'form' });
	}

	if (features.massOperations && hasDeleted) {
		out.push({
			id: 'massDelete',
			label: 'Пометить на удаление',
			icon: '❌',
			type: 'list',
			variant: 'danger'
		});
		out.push({ id: 'massRestore', label: 'Восстановить', icon: '↩️', type: 'list' });
		out.push({
			id: 'purgeMarked',
			label: 'Удалить помеченные',
			icon: '🗑️',
			type: 'list',
			variant: 'danger'
		});
	}

	if (features.delete) {
		out.push({
			id: 'delete',
			label: 'Удалить',
			icon: '🗑️',
			type: 'list',
			variant: 'danger'
		});
		out.push({
			id: 'delete',
			label: 'Удалить',
			icon: '🗑️',
			type: 'form',
			variant: 'text-danger',
			disabled: (s) => !isEditable(statuses, s)
		});
	}

	if (features.run) {
		out.push({
			id: 'run',
			label: 'Выполнить',
			icon: '▶️',
			type: 'list',
			variant: 'success'
		});
		out.push({
			id: 'run',
			label: 'Выполнить',
			icon: '▶️',
			type: 'form',
			variant: 'success',
			disabled: (s) => !isEditable(statuses, s)
		});
	}

	return out;
}
