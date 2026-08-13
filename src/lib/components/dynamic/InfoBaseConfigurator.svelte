<script lang="ts">
	import { onMount } from 'svelte';
	import { db, type LocalRecord } from '$lib/db/indexeddb';
	import { clearAppStorage } from '$lib/services/sync';
	import {
		exportProject,
		importProject,
		parseBackupFile,
		downloadBackup
	} from '$lib/services/backup';
	import { seedRecord } from '$lib/state/seed';
	import { SOLUTION_PACKS_TABLE } from '$lib/state/solutions';
	import {
		applySolution,
		downloadSolution,
		exportSolution,
		parseSolutionFile,
		validatePack
	} from '$lib/services/solutionPacks';

	// Вкладка «Работа с информационной базой»: выгрузка/загрузка проекта JSON.
	// Выгрузка читает все 6 таблиц Supabase (метаданные + данные + вложения),
	// загрузка заменяет данные проекта файлом выгрузки и перезапускает приложение.
	let backupIncludeSystem = $state(true);
	let backupBusy = $state(false);
	let backupFileInput = $state<HTMLInputElement | null>(null);

	// Пакеты решений: экспорт построенного модуля в JSON / импорт из файла.
	let solutionTables = $state<{ name: string; title: string; selected: boolean }[]>([]);
	let solutionLoaded = $state(false);
	let solutionBusy = $state(false);
	let solutionWithRecords = $state(true);
	let solutionName = $state('');
	let solutionFileInput = $state<HTMLInputElement | null>(null);

	onMount(async () => {
		const tables = await db.meta_tables.filter((t) => !t.parent_table_id).toArray();
		solutionTables = tables
			.map((t) => ({ name: t.name ?? '', title: t.title, selected: false }))
			.filter((t) => t.name)
			.sort((a, b) => a.title.localeCompare(b.title));
		solutionLoaded = true;
	});

	function toggleAllSolution(v: boolean) {
		for (const t of solutionTables) t.selected = v;
	}

	async function handleExportSolution() {
		const selected = solutionTables.filter((t) => t.selected).map((t) => t.name);
		if (selected.length === 0) {
			alert('Отметьте хотя бы одну таблицу для экспорта.');
			return;
		}
		if (solutionBusy) return;
		solutionBusy = true;
		try {
			const pack = await exportSolution({
				tableNames: selected,
				id: (solutionName || 'solution').toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
				title: solutionName || selected.join(', '),
				includeRecords: solutionWithRecords
			});
			downloadSolution(pack);
			alert(
				`Пакет готов: ${pack.tables.length} таблиц (ТЧ включены автоматически), ` +
					(solutionWithRecords ? 'записи-сиды включены.' : 'только схема.') +
					'\nИмпорт в другую базу — «📦 Импорт пакета» (или запись в реестре «Пакеты решений»).'
			);
		} catch (e: any) {
			alert(`Ошибка экспорта: ${e?.message ?? e}`);
		} finally {
			solutionBusy = false;
		}
	}

	function handlePickSolutionFile() {
		solutionFileInput?.click();
	}

	async function handleSolutionFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || solutionBusy) return;
		solutionBusy = true;
		try {
			const pack = await parseSolutionFile(file);
			const errors = validatePack(pack);
			if (errors.length > 0) {
				alert('Пакет не прошёл проверку:\n• ' + errors.join('\n• '));
				return;
			}
			if (
				!confirm(
					`Импортировать пакет «${pack.title}»?\nЗапись будет создана в реестре «Пакеты решений».`
				)
			)
				return;

			const table = await db.meta_tables.where('name').equals(SOLUTION_PACKS_TABLE).first();
			if (!table) throw new Error('Реестр «Пакеты решений» ещё не создан — обновите страницу.');
			const record: LocalRecord = {
				id: crypto.randomUUID(),
				table_id: table.id,
				status: 'draft',
				is_folder: false,
				parent_id: null,
				data: {
					name: pack.title ?? pack.id,
					description: pack.description ?? '',
					definition: pack
				},
				is_dirty: 1,
				updated_at: new Date().toISOString()
			};
			await seedRecord(record, true);

			const apply = confirm('Запись создана. Применить пакет сейчас (▶️ Выполнить)?');
			if (!apply) {
				alert('Пакет сохранён в реестре. Откройте его в конструкторе и нажмите «▶️ Выполнить».');
				return;
			}
			const report = await applySolution(pack);
			const lines = [
				report.ok ? 'Пакет применён.' : 'Пакет применён с ошибками.',
				`Таблиц создано: ${report.tablesCreated.length}`,
				`Колонок добавлено: ${report.columnsAdded}`,
				`Записей создано: ${report.recordsSeeded} (пропущено существующих: ${report.recordsSkipped})`,
				`Сценариев: ${report.scenariosApplied}`,
				`Печатных форм: ${report.printForms}`
			];
			if (report.warnings.length > 0)
				lines.push('Предупреждения:\n• ' + report.warnings.join('\n• '));
			if (report.errors.length > 0) lines.push('Ошибки:\n• ' + report.errors.join('\n• '));
			alert(lines.join('\n'));
		} catch (e: any) {
			alert(`Ошибка импорта: ${e?.message ?? e}`);
		} finally {
			solutionBusy = false;
		}
	}

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
					Выгрузка читает данные с сервера. Загрузка заменяет все данные текущего проекта и
					перезапускает приложение.
				</div>
			</div>
		</div>

		<div class="navorder-section">
			<div class="group-header-row">
				<span class="group-title">📦 Пакеты решений</span>
			</div>
			<div class="translate-config">
				<label class="translate-label">
					<span>Название пакета (для экспорта)</span>
					<input
						type="text"
						bind:value={solutionName}
						placeholder="weather-notify"
						class="text-input"
					/>
				</label>
				<label class="backup-check">
					<input type="checkbox" bind:checked={solutionWithRecords} />
					Включить записи (сиды) в пакет
				</label>
				{#if solutionLoaded}
					<div class="solution-tables">
						<div class="backup-check">
							<button type="button" class="type-btn" onclick={() => toggleAllSolution(true)}>
								Выбрать все
							</button>
							<button type="button" class="type-btn" onclick={() => toggleAllSolution(false)}>
								Сброс
							</button>
						</div>
						{#each solutionTables as t}
							<label class="backup-check">
								<input type="checkbox" bind:checked={t.selected} />
								{t.title}
							</label>
						{/each}
					</div>
				{:else}
					<div class="navorder-hint">Загружаю список таблиц…</div>
				{/if}
				<button
					onclick={handleExportSolution}
					disabled={solutionBusy}
					class="type-btn"
					title="Выгрузить выбранные таблицы (+ТЧ) в пакет-файл JSON"
				>
					{solutionBusy ? '⏳…' : '📦 Экспорт пакета'}
				</button>
				<button
					onclick={handlePickSolutionFile}
					disabled={solutionBusy}
					class="type-btn"
					title="Загрузить пакет-файл и применить (создаст запись в реестре «Пакеты решений»)"
				>
					📦 Импорт пакета…
				</button>
				<input
					type="file"
					accept="application/json,.json"
					class="hidden"
					bind:this={solutionFileInput}
					onchange={handleSolutionFileChange}
				/>
				<div class="navorder-hint">
					Пакет переносит схему (таблицы/колонки/типы), каталоги, сценарии и печатные формы без
					кода. Экспорт читает данные с сервера; импорт создаёт запись в реестре «Пакеты решений» и
					может применить её.
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
	.text-input {
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		font-size: 0.8rem;
		padding: 4px 8px;
		color: #475569;
		background: #fff;
	}
	.solution-tables {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 220px;
		overflow-y: auto;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		padding: 6px 8px;
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
