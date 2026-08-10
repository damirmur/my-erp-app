import { registerSandboxHelper } from '$lib/services/sandbox';
import type { StoredFile } from '$lib/services/files';

// Точка подключения хелперов модулей к песочнице. Единственное место, где
// движок «знает» о существовании модульных хелперов — и то только лениво:
// код модуля (банк и т.д.) грузится динамическим import в момент первого
// обращения, в основной бандл и boot он не попадает.
//
// Универсальные примитивы (parsePdf) регистрируются всегда. Совместимость с
// существующими данными (importStatement у старых таблиц банковских выписок)
// регистрируется так же лениво — если модуль не установлен, хелпер просто
// недоступен, и код его использующий получит понятную ошибку.
export function registerSandboxPlugins(): void {
	// Извлечение текста/строк из PDF — универсальный примитив (не банковский).
	registerSandboxHelper('parsePdf', () => async (file: StoredFile) => {
		const m = await import('$lib/services/pdfText');
		return m.extractPdfText(file);
	});

	// Импорт банковской выписки (модуль «Банк»): лениво, для уже существующих
	// таблиц и сценариев. Если модуль не установлен — import упадёт с понятной ошибкой.
	registerSandboxHelper(
		'importStatement',
		() => async (recordId: string, params?: Record<string, any>) => {
			const m = await import('$lib/services/bankParser');
			return m.importStatement(recordId, params ?? {});
		}
	);
}
