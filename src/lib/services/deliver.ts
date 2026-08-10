import { db } from '$lib/db/indexeddb';
import { workspace } from '$lib/state/workspace.svelte';
import { htmlToBase64, printerService } from '$lib/services/printer';
import { autoFillDocumentFields, todayIso } from '$lib/services/numbers';
import { NOTIFY_MESSAGES_TABLE, NOTIFY_MESSAGE_CHANNELS_TABLE } from '$lib/state/notifications';
import { findTableIdByName } from '$lib/state/seed';

// Модуль «Доставка документа»: «✉️ Отправить» не шлёт сразу, а создаёт документ
// «Сообщение» с отрендеренной печатной формой (текст + HTML-вложение) и
// открывает его. Если в записи есть контрагент (поле-ссылка на «Контрагенты») —
// предлагаем добавить его в получатели сообщения; при отказе или отсутствии
// поля получателей заполняют вручную (или программно) и отправляют кнопкой
// «▶️ Выполнить» самого сообщения.

export interface SendResult {
	ok: boolean;
	messageId: string; // id созданного документа «Сообщение»
	title: string;
	fileName: string;
	recipientAdded: boolean; // Добавлен ли контрагент в получатели
	recipientName?: string; // Наименование добавленного контрагента
}

// id таблицы «Контрагенты» (может отсутствовать локально до первого синка)
async function counterpartiesTableId(): Promise<string | null> {
	const t = await db.meta_tables.where('name').equals('counterparties').first();
	return t?.id ?? null;
}

// Авто-выжимка, когда у печатной формы не задана колонка summary: таблица,
// номер, дата, контрагент (из поля-ссылки), количество строк и сумма amount.
async function buildAutoSummary(tableId: string, recordIds: string[]): Promise<string> {
	const metaTable = await db.meta_tables.get(tableId);
	const tableTitle = metaTable?.title ?? 'Документ';
	const contId = await counterpartiesTableId();
	const linkCols = contId
		? (await db.meta_columns.where('table_id').equals(tableId).toArray()).filter(
				(c) => c.type === 'link' && c.related_table_id === contId
			)
		: [];

	const lines: string[] = [];
	for (const id of recordIds) {
		const rec = await db.data_records.get(id);
		if (!rec) continue;
		const bits: string[] = [];
		const num = rec.data?.number || rec.data?.name || '';
		bits.push(num ? `${tableTitle} №${num}` : tableTitle);
		if (rec.data?.date) bits.push(`от ${rec.data.date}`);

		for (const col of linkCols) {
			const v = rec.data?.[col.name];
			if (typeof v === 'string' && v) {
				const c = await db.data_records.get(v);
				const name = c?.data?.name || c?.data?.number || c?.data?.title || '';
				if (name) bits.push(`контрагент: ${name}`);
				break;
			}
		}

		const recLines = await db.data_lines.where('record_id').equals(rec.id).toArray();
		if (recLines.length > 0) {
			bits.push(`строк: ${recLines.length}`);
			const total = recLines.reduce((s, l) => s + (parseFloat(l.data?.amount) || 0), 0);
			if (total) bits.push(`сумма: ${total}`);
		}
		lines.push(bits.filter(Boolean).join(', '));
	}
	return lines.join('\n');
}

export const deliverService = {
	/**
	 * Отрендерить документ по печатной форме, создать документ «Сообщение»
	 * с текстом и HTML-вложением и открыть его. Контрагент из поля-ссылки
	 * записей предлагается добавить в получатели (confirm). Возвращает сводку
	 * о созданном сообщении.
	 */
	async sendDocuments(tableId: string, recordIds: string[], formId = ''): Promise<SendResult> {
		if (recordIds.length === 0) throw new Error('Не выбраны записи для отправки');

		const render = await printerService.renderRecords(tableId, recordIds, formId);

		const messagesTableId = await findTableIdByName(NOTIFY_MESSAGES_TABLE);
		if (!messagesTableId) throw new Error('Системная таблица «Сообщение» не найдена');

		// 1. Создаём документ «Сообщение»: тема, выжимка-текст и вложение.
		// Вложение — исходник документа: HTML (.html) или SVG (.svg). Расширение
		// файла — маркер для шлюза: .html — рендер в картинку/PDF и HTML-тело
		// письма, .svg — рендер в картинку. Сообщение не отправляется сразу.
		const now = new Date().toISOString();
		const messageId = crypto.randomUUID();
		const isSvg = render.format === 'svg' && !!render.svg;
		const fileName = isSvg ? `${render.title}.svg` : `${render.title}.html`;
		const fileContent = isSvg ? (render.svg as string) : render.html;
		const messageText = render.summary.trim() || (await buildAutoSummary(tableId, recordIds));

		const data: Record<string, any> = await autoFillDocumentFields(messagesTableId, {
			number: '',
			date: todayIso(),
			subject: render.title,
			message: `${render.title}\n\n${messageText}`,
			file: {
				name: fileName,
				size: new Blob([fileContent]).size,
				type: isSvg ? 'image/svg+xml' : 'text/html;charset=utf-8',
				data: htmlToBase64(fileContent)
			}
		});

		await db.data_records.put({
			id: messageId,
			table_id: messagesTableId,
			status: 'draft',
			is_folder: false,
			parent_id: null,
			data,
			is_dirty: 1,
			updated_at: now
		});

		// 2. Контрагент из поля-ссылки записей — предлагаем добавить в получатели
		// (не всегда нужно отправлять ему, поэтому подтверждение, а не авто).
		let recipientAdded = false;
		let recipientName = '';
		const contId = await counterpartiesTableId();
		if (contId) {
			const linkCols = (await db.meta_columns.where('table_id').equals(tableId).toArray()).filter(
				(c) => c.type === 'link' && c.related_table_id === contId
			);
			let counterpartyId = '';
			for (const id of recordIds) {
				const rec = await db.data_records.get(id);
				for (const col of linkCols) {
					const v = rec?.data?.[col.name];
					if (typeof v === 'string' && v) {
						counterpartyId = v;
						break;
					}
				}
				if (counterpartyId) break;
			}
			if (counterpartyId) {
				const kontragent = await db.data_records.get(counterpartyId);
				recipientName =
					kontragent?.data?.name || kontragent?.data?.number || kontragent?.data?.title || '';
				const label = recipientName ? `«${recipientName}»` : 'из записи';
				if (confirm(`Добавить контрагента ${label} в получатели сообщения?`)) {
					const recipientsTab = await db.meta_tables
						.where('name')
						.equals(NOTIFY_MESSAGE_CHANNELS_TABLE)
						.first();
					if (recipientsTab) {
						await db.data_lines.put({
							id: crypto.randomUUID(),
							record_id: messageId,
							table_id: recipientsTab.id,
							data: { kontragent: counterpartyId, channel: '' },
							sort_order: 0
						});
						recipientAdded = true;
					}
				}
			}
		}

		// 3. Открываем сообщение для дозаполнения получателей и отправки
		// («▶️ Выполнить» документа «Сообщение»).
		workspace.openForm(messagesTableId, messageId, 'Сообщение', data.number);

		return { ok: true, messageId, title: render.title, fileName, recipientAdded, recipientName };
	}
};
