import {
	db,
	type LocalColumn,
	type LocalLine,
	type LocalRecord,
	type LocalTable
} from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { formatFieldValue } from '$lib/fields';
import { linkApi } from '$lib/services/deeplink';
import {
	apiCall,
	mergeParams,
	runActionCode,
	runAnotherTable,
	saveRecordWithLines
} from '$lib/services/actionRunner';
import { flowLayout } from '$lib/services/flowLayout';

const PRINT_FORMS_TABLE = 'print_forms';

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Денежные суммы в печатной форме округляем до 2 знаков, чтобы из-за
// арифметики плавающей точки не появлялись хвосты вида 15987.359999999997.
function roundMoney(value: number): number {
	return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
	return formatFieldValue('number', roundMoney(value));
}

// Форматирование значения из данных, возвращённых кодом заполнения (form).
function formValue(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'number') return escapeHtml(formatMoney(value));
	if (typeof value === 'boolean') return value ? 'да' : 'нет';
	if (typeof value === 'string') return escapeHtml(value);
	return escapeHtml(String(value));
}

// Базовый макет-заглушка на случай, если для таблицы нет печатной формы
// (кнопка «Печать» при этом скрыта, но код остаётся отказоустойчивым).
const FALLBACK_TEMPLATE = `
<div style="font-family: sans-serif; padding: 20px;">
	<h2>{{doc.title}} № {{doc.number}}</h2>
	<p>Дата: {{doc.date}}</p>
	{{#each lines}}<p>{{@index + 1}}. {{this.name}}</p>{{/each}}
</div>
`;

// Универсальный движок печатных форм.
// Плейсхолдеры:
//   {{field}} / {{doc.field}}        — колонка записи (форматируется по типу,
//                                      ссылки резолвятся в наименования)
//   {{doc.title}}                    — заголовок таблицы
//   {{doc.total_amount}}             — сумма amount по первой табличной части
//   {{#each <ТЧ>}}...{{/each}}       — обход строк табличной части (по имени ТЧ,
//                                      legacy {{#each lines}} = первая ТЧ)
//     {{this.field}}                 — колонка строки
//     {{@index + 1}}                 — номер строки (с 1)
//   {{sum:<ТЧ>:<field>}}             — сумма числовой колонки по ТЧ
//   {{count:<ТЧ>}}                   — количество строк ТЧ
//   {{form.<key>}}                   — значение из данных, возвращённых кодом
//                                      заполнения (поле code печатной формы)
//   {{#each form.<name>}}...{{/each}} — обход массива из данных кода заполнения,
//                                      {{this.<key>}} — поле элемента массива
async function renderTemplate(
	templateHtml: string,
	ctx: {
		record: LocalRecord;
		tableTitle: string;
		columns: LocalColumn[];
		subTables: LocalTable[];
		lines: LocalLine[];
		resolveLink: (id: string) => Promise<string>;
		form?: Record<string, any>; // Данные, возвращённые кодом заполнения
	}
): Promise<string> {
	const { record, tableTitle, columns, subTables, lines, resolveLink, form } = ctx;
	const data = record.data ?? {};
	const colByName = new Map(columns.map((c) => [c.name, c]));
	const subByName = new Map<string, LocalTable>();
	subTables.forEach((s) => {
		if (s.name) subByName.set(s.name, s);
	});
	const firstSub = subTables[0] ?? null;

	const subColumnsCache = new Map<string, LocalColumn[]>();
	async function subColumns(sub: LocalTable | null): Promise<LocalColumn[]> {
		if (!sub) return [];
		if (!subColumnsCache.has(sub.id)) {
			subColumnsCache.set(sub.id, await db.meta_columns.where('table_id').equals(sub.id).toArray());
		}
		return subColumnsCache.get(sub.id)!;
	}

	async function fieldText(col: LocalColumn | null, raw: unknown): Promise<string> {
		if (raw == null || raw === '') return '';
		if (col?.type === 'link' && typeof raw === 'string') return escapeHtml(await resolveLink(raw));
		if (col?.type === 'universal' && raw && typeof raw === 'object') {
			const t = (raw as { t?: string }).t;
			const v = (raw as { v?: unknown }).v;
			if (t === 'link' && typeof v === 'string') return escapeHtml(await resolveLink(v));
			return escapeHtml(formatFieldValue(t ?? 'string', v));
		}
		return escapeHtml(formatFieldValue(col?.type ?? 'string', raw));
	}

	async function sumOf(subName: string, field: string): Promise<string> {
		const sub = subByName.get(subName) ?? firstSub;
		if (!sub) return '0';
		const subLines = lines.filter((l) => l.table_id === sub.id);
		const total = subLines.reduce((sum, l) => sum + (parseFloat(l.data?.[field]) || 0), 0);
		return escapeHtml(formatMoney(total));
	}

	// 1. Блоки {{#each ...}}...{{/each}}: заменяем на HTML строк.
	// Обрабатываем от вложенных к внешним (сначала самые внутренние блоки).
	let out = templateHtml;
	const eachRe = /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
	let hadBlock = true;
	while (hadBlock) {
		hadBlock = false;
		let firstMatch: RegExpExecArray | null = null;
		let firstStart = -1;
		eachRe.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = eachRe.exec(out)) !== null) {
			// Ищем блок без вложенных {{#each}} (самый внутренний)
			const inner = m[2];
			if (!/\{\{#each\s/.test(inner)) {
				firstMatch = m;
				firstStart = m.index;
				break;
			}
		}
		if (!firstMatch) break;
		hadBlock = true;

		const subName = firstMatch[1].trim();
		const body = firstMatch[2];

		const rowsHtml: string[] = [];

		// {{#each form.<name>}} — обход массива из данных кода заполнения
		if (subName.startsWith('form.')) {
			const arr = form ? (form[subName.slice(5)] as unknown[] | undefined) : undefined;
			if (Array.isArray(arr)) {
				for (let i = 0; i < arr.length; i++) {
					const row = (arr[i] ?? {}) as Record<string, any>;
					let rowHtml = body;
					rowHtml = rowHtml.replace(/\{\{@index\s*\+\s*1\}\}/g, String(i + 1));
					const thisRe = /\{\{this\.([^}]+)\}\}/g;
					rowHtml = await replaceAsync(rowHtml, thisRe, async (_full, key: string) =>
						formValue(row[key])
					);
					const bareRe = /\{\{(?!doc\.|form\.|#each|sum:|count:)([^}]+)\}\}/g;
					rowHtml = await replaceAsync(rowHtml, bareRe, async (_full, key: string) =>
						formValue(row[key])
					);
					rowsHtml.push(rowHtml);
				}
			}
			out =
				out.slice(0, firstStart) + rowsHtml.join('') + out.slice(firstStart + firstMatch[0].length);
			continue;
		}

		const sub = subByName.get(subName) ?? (subName === 'lines' ? firstSub : null) ?? null;
		const cols = await subColumns(sub);
		const subLines = sub ? lines.filter((l) => l.table_id === sub.id) : [];

		for (let i = 0; i < subLines.length; i++) {
			const line = subLines[i];
			const lineData = line.data ?? {};
			let rowHtml = body;
			rowHtml = rowHtml.replace(/\{\{@index\s*\+\s*1\}\}/g, String(i + 1));
			// this.field
			const thisRe = /\{\{this\.([^}]+)\}\}/g;
			rowHtml = await replaceAsync(rowHtml, thisRe, async (_full, field: string) => {
				const col = cols.find((c) => c.name === field) ?? null;
				return fieldText(col, lineData[field]);
			});
			// {{field}} внутри блока тоже относится к строке
			const bareRe = /\{\{(?!doc\.|form\.|#each|sum:|count:)([^}]+)\}\}/g;
			rowHtml = await replaceAsync(rowHtml, bareRe, async (_full, field: string) => {
				const col = cols.find((c) => c.name === field) ?? null;
				return fieldText(col, lineData[field]);
			});
			rowsHtml.push(rowHtml);
		}
		out =
			out.slice(0, firstStart) + rowsHtml.join('') + out.slice(firstStart + firstMatch[0].length);
	}

	// 2. Остальные плейсхолдеры (шапка).
	const scalarRe = /\{\{([^}]+)\}\}/g;
	out = await replaceAsync(out, scalarRe, async (_full, expr: string) => {
		const e = expr.trim();
		if (e === 'doc.title') return escapeHtml(tableTitle);
		if (e.startsWith('doc.')) {
			const field = e.slice(4);
			if (field === 'total_amount') {
				const total = lines.reduce((sum, l) => sum + (parseFloat(l.data?.amount) || 0), 0);
				return escapeHtml(formatMoney(total));
			}
			const col = colByName.get(field) ?? null;
			return fieldText(col, data[field]);
		}
		if (e.startsWith('form.')) {
			const key = e.slice(5);
			return formValue(form?.[key]);
		}
		if (e.startsWith('sum:')) {
			const parts = e.split(':');
			if (parts.length >= 3) return sumOf(parts[1], parts.slice(2).join(':'));
			return '';
		}
		if (e.startsWith('count:')) {
			const subName = e.slice(6);
			const sub = subByName.get(subName) ?? firstSub;
			if (!sub) return '0';
			return String(lines.filter((l) => l.table_id === sub.id).length);
		}
		const col = colByName.get(e) ?? null;
		return fieldText(col, data[e]);
	});

	return out;
}

async function replaceAsync(
	source: string,
	re: RegExp,
	replacer: (full: string, ...args: any[]) => Promise<string>
): Promise<string> {
	const parts: string[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	re.lastIndex = 0;
	while ((m = re.exec(source)) !== null) {
		parts.push(source.slice(last, m.index));
		parts.push(await replacer(m[0], ...m.slice(1)));
		last = m.index + m[0].length;
	}
	parts.push(source.slice(last));
	return parts.join('');
}

export const printerService = {
	/**
	 * Универсальная печать одного или нескольких документов по их ID.
	 * formId — конкретная печатная форма; если пусто — дефолтная (is_default)
	 * или первая в порядке sort_order.
	 */
	async printRecords(tableId: string, recordIds: string[], formId = '') {
		if (recordIds.length === 0) {
			alert('Не выбраны записи для печати.');
			return;
		}

		const metaTable = await db.meta_tables.get(tableId);
		const tableTitle = metaTable ? metaTable.title : 'Документ';

		// 1. Печатные формы для таблицы (data_records системной таблицы print_forms)
		const printFormsTable = await db.meta_tables.where('name').equals(PRINT_FORMS_TABLE).first();
		const allForms = printFormsTable
			? await db.data_records.where('table_id').equals(printFormsTable.id).toArray()
			: [];
		const formsForTable = allForms
			.filter((f) => f.data?.target_table === tableId && !f.is_folder)
			.sort((a, b) => (a.data?.sort_order ?? 0) - (b.data?.sort_order ?? 0));

		let templateHtml = '';
		let fillCode = '';
		if (formsForTable.length > 0) {
			const chosen = formId
				? formsForTable.find((f) => f.id === formId)
				: formsForTable.find((f) => f.data?.is_default === true || f.data?.is_default === 1);
			const form = chosen ?? formsForTable[0];
			templateHtml = form?.data?.template_html ?? '';
			fillCode = form?.data?.code ?? '';
		}
		if (!templateHtml) templateHtml = FALLBACK_TEMPLATE;

		const columns = await db.meta_columns.where('table_id').equals(tableId).toArray();
		const allTables = await db.meta_tables.toArray();
		const subTables = allTables.filter((t) => t.parent_table_id === tableId);

		// Резолвер ссылок: id → наименование связанной записи
		const linkCache = new Map<string, string>();
		async function resolveLink(id: string): Promise<string> {
			if (linkCache.has(id)) return linkCache.get(id)!;
			const rec = await db.data_records.get(id);
			const name = rec?.data?.name || rec?.data?.number || rec?.data?.title || String(id || '');
			linkCache.set(id, name);
			return name;
		}

		// 2. Циклом собираем HTML для всех переданных записей
		let finalFullHtml = '';
		for (let i = 0; i < recordIds.length; i++) {
			const record = await db.data_records.get(recordIds[i]);
			if (!record) continue;

			const lines = await db.data_lines.where('record_id').equals(record.id).toArray();

			let rendered: string;
			if (fillCode.trim()) {
				// Код заполнения: выполняется в песочнице с данными записи. Возвращает
				// строку HTML (используется как есть) или объект данных — тогда его
				// поля рендерятся макетом через {{form.…}} / {{#each form.…}}.
				const subLines: Record<string, LocalLine[]> = {};
				for (const t of subTables) {
					if (t.name) subLines[t.name] = lines.filter((l) => l.table_id === t.id);
				}
				try {
					const result = await runActionCode(fillCode, {
						record,
						records: [record],
						lines,
						subLines,
						params: mergeParams(record),
						db,
						supabase,
						save: saveRecordWithLines,
						log: (...args) => console.log('[Печать]', ...args),
						link: linkApi,
						apiCall,
						run: runAnotherTable,
						flowLayout
					});
					if (typeof result === 'string' && result.trim()) {
						rendered = result;
					} else if (result && typeof result === 'object') {
						rendered = await renderTemplate(templateHtml, {
							record,
							tableTitle,
							columns,
							subTables,
							lines,
							resolveLink,
							form: result as Record<string, any>
						});
					} else {
						rendered = await renderTemplate(templateHtml, {
							record,
							tableTitle,
							columns,
							subTables,
							lines,
							resolveLink
						});
					}
				} catch (e: any) {
					rendered = `<div style="color:#c00;font-family:sans-serif;padding:12px;border:1px solid #c00;border-radius:4px;margin:8px 0;"><b>Ошибка кода заполнения:</b> ${escapeHtml(
						e?.message ?? String(e)
					)}</div>`;
				}
			} else {
				rendered = await renderTemplate(templateHtml, {
					record,
					tableTitle,
					columns,
					subTables,
					lines,
					resolveLink
				});
			}

			const pageBreak = i < recordIds.length - 1 ? '<div class="page-break"></div>' : '';
			finalFullHtml += `<div class="print-item">${rendered}</div>${pageBreak}`;
		}

		// 3. Открываем универсальное окно печати
		const printWindow = window.open('', '_blank');
		if (!printWindow) {
			alert('Браузер заблокировал всплывающее окно. Разрешите всплывающие окна в настройках.');
			return;
		}

		printWindow.document.documentElement.innerHTML = `
            <html>
            <head>
                <title>Печать документов пакетно</title>
                <style>
                    body { margin: 0; padding: 0; background: #fff; }
                    .print-item { box-sizing: border-box; }
                    .page-break { page-break-after: always; break-after: page; clear: both; }
                    @media print {
                        body { padding: 0; }
                        .page-break { page-break-after: always; break-after: page; }
                    }
                </style>
            </head>
            <body>
                ${finalFullHtml}
            </body>
            </html>
        `;

		setTimeout(() => {
			printWindow.print();
			printWindow.close();
		}, 400);
	}
};
