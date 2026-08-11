-- ============================================================================
-- Полная схема базы данных my-erp-app (my-erp-app).
-- Самодостаточный идемпотентный эквивалент миграций 0001–0010.
--
-- НАЗНАЧЕНИЕ: развёртывание СХЕМЫ на НОВОМ проекте Supabase с нуля
-- (для фичи «Резервная копия»: выгрузка/загрузка проекта JSON-файлом).
-- Не заменяет миграции для существующих инсталляций — история миграций
-- supabase_migrations.schema_migrations остаётся нетронутой.
--
-- БЕЗОПАСНОСТЬ: все операции идемпотентны (IF NOT EXISTS / OR REPLACE /
-- DO-блоки). Скрипт можно применять повторно без ошибок и без потери данных.
--
-- ПРИМЕНЕНИЕ (любой из способов):
--   1. Supabase Dashboard → SQL Editor → вставить содержимое → Run
--   2. psql:  psql "$DATABASE_URL" -f supabase/init_full.sql
--   3. Supabase CLI на новом проекте (если каталог migrations/ пуст):
--      cp supabase/init_full.sql supabase/migrations/0001_cloud_init.sql
--      supabase db push
--
-- ВАЖНО: скрипт создаёт ТОЛЬКО схему (типы, таблицы, функции, индексы).
-- Данные (в т.ч. записи сидов системных таблиц) приложение создаёт само
-- при первом запуске (metadata.ensureSystemTables → ensureModule/seed).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Типы ENUM
-- ----------------------------------------------------------------------------

-- column_type: базовые значения (без IF NOT EXISTS для самого типа — через DO)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'column_type') THEN
        CREATE TYPE public.column_type AS ENUM (
            'string',
            'number',
            'boolean',
            'date',
            'jsonb',
            'link',
            'parent_link'
        );
    END IF;
END
$$;

-- record_status
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'record_status') THEN
        CREATE TYPE public.record_status AS ENUM (
            'draft',
            'posted',
            'marked_for_deletion'
        );
    END IF;
END
$$;

-- Расширение column_type из миграций 0002–0008 (идемпотентно)
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'file';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'zip';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'datetime';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'birth';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'universal';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'linelink';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'select';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'paramslist';

-- ----------------------------------------------------------------------------
-- Функции
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_first_user_admin() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Если это первый пользователь в системе auth.users, даем ему роль admin
    IF (SELECT COUNT(*) FROM auth.users) = 1 THEN
        INSERT INTO public.user_roles (user_id, role_id)
        VALUES (NEW.id, (SELECT id FROM public.roles WHERE name = 'admin'));
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = auth.uid() AND r.name = 'admin'
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- Таблицы
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.data_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_id uuid,
    table_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.data_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid,
    status public.record_status DEFAULT 'draft'::public.record_status NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_folder boolean DEFAULT false,
    parent_id uuid
);

CREATE TABLE IF NOT EXISTS public.meta_columns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid,
    name text NOT NULL,
    title text NOT NULL,
    type public.column_type DEFAULT 'string'::public.column_type NOT NULL,
    related_table_id uuid,
    sort_order integer DEFAULT 0 NOT NULL,
    is_visible boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.meta_table_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    label text NOT NULL,
    definition jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.meta_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    title text NOT NULL,
    type text DEFAULT 'NULL'::text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    parent_table_id uuid,
    config jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.print_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid,
    name text NOT NULL,
    is_default boolean DEFAULT false,
    template_html text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    role_id uuid
);

CREATE TABLE IF NOT EXISTS public.data_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id uuid REFERENCES public.data_records (id) ON DELETE CASCADE,
    column_id text NOT NULL DEFAULT '',
    name text NOT NULL DEFAULT '',
    size bigint NOT NULL DEFAULT 0,
    type text NOT NULL DEFAULT '',
    content text,
    updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ----------------------------------------------------------------------------
-- Первичные ключи (миграция 0005, идемпотентно)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY[
		'meta_tables',
		'meta_columns',
		'meta_table_types',
		'data_records',
		'data_lines',
		'print_forms',
		'roles',
		'user_roles'
	] LOOP
		IF NOT EXISTS (
			SELECT 1
			FROM pg_constraint c
			JOIN pg_class cl ON cl.oid = c.conrelid
			JOIN pg_namespace n ON n.oid = cl.relnamespace
			WHERE c.contype = 'p' AND cl.relname = t AND n.nspname = 'public'
		) THEN
			EXECUTE format('ALTER TABLE public.%I ADD PRIMARY KEY (id)', t);
		END IF;
	END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Индексы производительности (миграции 0009, 0010, идемпотентно)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS data_records_updated_at_idx
    ON public.data_records (updated_at);

CREATE INDEX IF NOT EXISTS data_records_table_id_idx
    ON public.data_records (table_id);

CREATE INDEX IF NOT EXISTS data_records_tablestatus_idx
    ON public.data_records (table_id, status);

CREATE INDEX IF NOT EXISTS data_lines_record_id_idx
    ON public.data_lines (record_id);

CREATE INDEX IF NOT EXISTS data_lines_table_id_idx
    ON public.data_lines (table_id);

CREATE INDEX IF NOT EXISTS data_files_record_id_idx ON public.data_files (record_id);
