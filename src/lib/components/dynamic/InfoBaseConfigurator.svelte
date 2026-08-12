<script lang="ts">
	import { db } from '$lib/db/indexeddb';
	import { clearAppStorage } from '$lib/services/sync';
	import { exportProject, importProject, parseBackupFile, downloadBackup } from '$lib/services/backup';

	// Вкладка «Работа с информационной базой»: выгрузка/загрузка проекта JSON.
	// Выгрузка читает все 6 таблиц Supabase (метаданные + данные + вложения),
	// загрузка заменяет данные проекта файлом выгрузки и перезапускает приложение.
	let backupIncludeSystem = $state(true);
	let backupBusy = $state(false);
	let backupFileInput = $state<HTMLInputElement | null>(null);

	async function handleExportProject() {
		if (backupBusy) return;
		backupBusy = true;
		try {
			const backup = await exportProject(backupIncludeSystem);
			downloadBackup(backup);
			const total =
				backup.metaTables.length +
				backup.metaColumns.length +
				backup.dataRecords.length +
				backup.dataLines.length +
				backup.dataFiles.length;
			alert(
				`Выгрузка готова: ${backup.metaTables.length} таблиц, ${backup.metaColumns.length} реквизитов, ` +
					`${backup.dataRecords.length} записей, ${backup.dataLines.length} строк ТЧ, ${backup.dataFiles.length} вложений.`
			);
		} catch (e: any) {
			alert(`Ошибка выгрузки: ${e?.message ?? e}`);
		} finally {
			backupBusy = false;
		}
	}

	function handlePickBackupFile() {
		backupFileInput?.click();
	}

	async function handleBackupFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (backupBusy) return;
		backupBusy = true;
		try {
			const backup = await parseBackupFile(file);
			if (
				!confirm(
					'Загрузить файл выгрузки в этот проект?\n' +
						'Все текущие данные (метаданные, записи, вложения) будут заменены содержимым файла.\n' +
						'После загрузки приложение перезапустится.'
				)
			)
				return;
			const report = await importProject(backup);

			// Сбрасываем локальный кэш, чтобы после перезапуска всё скачалось из импортированных данных
			await db.transaction(
				'rw',
				[db.meta_tables, db.meta_columns, db.data_records, db.data_lines, db.data_files],
				async () => {
					await db.meta_tables.clear();
					await db.meta_columns.clear();
					await db.data_records.clear();
					await db.data_lines.clear();
					await db.data_files.clear();
				}
			);
			clearAppStorage();

			alert(
				`Импорт завершён: ${report.metaTables} таблиц, ${report.metaColumns} реквизитов, ` +
					`${report.dataRecords} записей, ${report.dataLines} строк ТЧ, ${report.dataFiles} вложений.\n` +
					'Перезапускаем приложение…'
			);

			// Жёсткая перезагрузка: новый URL, чтобы страница не взялась из кэша.
			const url = new URL(location.href);
			url.searchParams.set('imported', String(Date.now()));
			location.replace(url.toString());
		} catch (e: any) {
			alert(`Ошибка импорта: ${e?.message ?? e}`);
		} finally {
			backupBusy = false;
		}
	}
</script>

<div class="configurator-layout">
	<div class="meta-editor-box">
		<div class="config-toolbar">
			<span class="cfg-table-name">💾 Работа с информационной базой</span>
			<div class="toolbar-spacer"></div>
		</div>
		<hr class="divider" />

		<div class="navorder-section">
			<div class="group-header-row">
				<span class="group-title">💾 Резервная копия</span>
			</div>
			<div class="translate-config">
				<label class="translate-label">
					<span class="backup-check">
						<input type="checkbox" bind:checked={backupIncludeSystem} />
						Включить системные таблицы (сценарии, печатные формы, сервисы, настройки)
					</span>
				</label>
				<button
					onclick={handleExportProject}
					disabled={backupBusy}
					class="type-btn"
					title="Выгрузить структуру и данные проекта в JSON-файл"
				>
					{backupBusy ? '⏳…' : '📤 Выгрузить проект'}
				</button>
				<button
					onclick={handlePickBackupFile}
					disabled={backupBusy}
					class="type-btn"
					title="Заменить данные проекта содержимым JSON-файла"
				>
					📥 Загрузить проект…
				</button>
				<input
					type="file"
					accept="application/json,.json"
					class="hidden"
					bind:this={backupFileInput}
					onchange={handleBackupFileChange}
				/>
				<div class="navorder-hint">
					Выгрузка читает данные с сервера. Загрузка заменяет все данные текущего проекта
					и перезапускает приложение.
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.configurator-layout {
		padding: 1rem;
		box-sizing: border-box;
		height: 100%;
		overflow-y: auto;
		background-color: #f1f5f9;
	}
	.meta-editor-box {
		border: 1px solid #cbd5e1;
		padding: 1rem;
		border-radius: 6px;
		background: #ffffff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
		max-width: 700px;
	}
	.config-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.cfg-table-name {
		font-size: 1rem;
		font-weight: 700;
		color: #1e293b;
	}
	.toolbar-spacer {
		flex: 1;
	}
	.divider {
		border: 0;
		border-top: 1px solid #e2e8f0;
		margin: 12px 0;
	}
	.navorder-section {
		margin-bottom: 1.25rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid #e5e7eb;
	}
	.group-header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		margin-bottom: 0.5rem;
	}
	.group-title {
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		color: #6b7280;
	}
	.translate-config {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 0 0.25rem;
	}
	.translate-label {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 0.7rem;
		font-weight: 600;
		color: #6b7280;
	}
	.navorder-hint {
		font-size: 0.68rem;
		color: #9ca3af;
		line-height: 1.3;
	}
	.backup-check {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.72rem;
		font-weight: 500;
		color: #475569;
		cursor: pointer;
	}
	.hidden {
		display: none;
	}
	.type-btn {
		background: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		font-size: 0.8rem;
		padding: 4px 8px;
		cursor: pointer;
		color: #475569;
	}
	.type-btn:hover {
		background: #f1f5f9;
	}
	.type-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
