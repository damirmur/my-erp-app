import { registerSandboxHelper } from '$lib/services/sandbox';
import type { StoredFile } from '$lib/services/files';
import { parseRuAmount, parseRuDate, parseRuNumber } from '$lib/utils/ruFormat';

// Точка подключения универсальных примитивов к песочнице. Единственное место,
// где движок «знает» о модульных хелперах — и то только лениво: код грузится
// динамическим import в момент первого обращения, в основной бандл и boot он
// не попадает.
//
// Примитивы здесь — универсальные (не привязаны к конкретному модулю):
//   parsePdf            — извлечение текста/строк из PDF (файл может быть ссылкой);
//   runCode             — исполнение кода-строки из данных (например, parser_code
//                          банка) в песочнице;
//   parseNum/Amount/Date — разбор русского формата чисел/сумм/дат.
export function registerSandboxPlugins(): void {
	// Извлечение текста/строк из PDF — универсальный примитив.
	// Файл может прийти ссылкой на хранилище — разворачиваем перед чтением.
	registerSandboxHelper('parsePdf', () => async (file: StoredFile) => {
		const { hydrateFileValue } = await import('$lib/services/files');
		const hydrated = ((await hydrateFileValue(file)) ?? file) as StoredFile;
		const m = await import('$lib/services/pdfText');
		return m.extractPdfText(hydrated);
	});

	// Исполнение произвольного кода-строки из данных в песочнице (код-парсеры
	// банков, код действия и т.п.). ctx — объект с переменными контекста.
	registerSandboxHelper('runCode', () => async (code: string, ctx?: Record<string, any>) => {
		const m = await import('$lib/services/actionRunner');
		return m.runActionCode(code, (ctx ?? {}) as any);
	});

	registerSandboxHelper('parseNum', () => parseRuNumber);
	registerSandboxHelper('parseAmount', () => parseRuAmount);
	registerSandboxHelper('parseDate', () => parseRuDate);

	// Рендер mermaid-диаграммы в статичный <svg>. Универсальный примитив:
	// текст-определение → строка <svg>, которую можно встроить в HTML печатной
	// формы. Библиотека грузится лениво — только при первом обращении.
	registerSandboxHelper('mermaid', () => async (definition: string, opts?: { theme?: string }) => {
		const mod: any = await import('mermaid');
		const mermaid = mod.default ?? mod;
		mermaid.initialize?.({ startOnLoad: false, theme: opts?.theme ?? 'default' });
		const { svg } = await mermaid.render(
			`mmd-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`,
			definition
		);
		return svg;
	});

	// Применение «пакета решений»: JSON-описание схемы (таблицы/колонки/типы),
	// каталогов, сценариев и печатных форм — применяется идемпотентно без кода.
	// Универсальный примитив: движок не знает ни про один конкретный модуль.
	registerSandboxHelper('applySolution', () => async (pack: any, opts?: Record<string, any>) => {
		const m = await import('$lib/services/solutionPacks');
		return m.applySolution(pack, opts ?? {});
	});

	// Проверка пакета без записи в базу (ошибки/предупреждения).
	registerSandboxHelper('validateSolution', () => async (pack: any) => {
		const m = await import('$lib/services/solutionPacks');
		return m.validatePack(pack);
	});
}
