-- ============================================================================
-- ERP FÁBRICA PRO — SQL COMPLETO PARA SUPABASE
-- Versão: 2025-06-04 v5.0
--
-- INSTRUÇÕES:
--   1. Abra https://app.supabase.com → seu projeto
--   2. SQL Editor → New Query
--   3. Cole TODO este arquivo → Run
--   4. Login: admin / supersuecocollor
--
-- O script é 100% idempotente (pode rodar várias vezes sem erro).
-- Inclui: tabelas, índices, triggers, RPCs, RLS, dados iniciais.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 0.  EXTENSÕES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─────────────────────────────────────────────────────────────────────────────
-- 0.1 ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'canal_type') THEN
        CREATE TYPE canal_type AS ENUM ('ML', 'SHOPEE', 'SITE', 'ALL');
    ELSE
        BEGIN ALTER TYPE canal_type ADD VALUE IF NOT EXISTS 'SITE'; EXCEPTION WHEN duplicate_object THEN NULL; END;
        BEGIN ALTER TYPE canal_type ADD VALUE IF NOT EXISTS 'ALL';  EXCEPTION WHEN duplicate_object THEN NULL; END;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status_value') THEN
        CREATE TYPE order_status_value AS ENUM ('NORMAL', 'ERRO', 'DEVOLVIDO', 'BIPADO', 'SOLUCIONADO');
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1.  TABELA: users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT         NOT NULL,
    email       TEXT,
    password    TEXT,
    role        TEXT         NOT NULL DEFAULT 'OPERATOR',
    setor       TEXT[]       DEFAULT '{}',
    prefix      TEXT,
    attendance  JSONB        DEFAULT '[]'::jsonb,
    ui_settings JSONB,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email       TEXT,
    ADD COLUMN IF NOT EXISTS prefix      TEXT,
    ADD COLUMN IF NOT EXISTS attendance  JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS ui_settings JSONB;

CREATE INDEX IF NOT EXISTS idx_users_name  ON users (name);
CREATE INDEX IF NOT EXISTS idx_users_role  ON users (role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.  TABELA: app_settings
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT  PRIMARY KEY,
    value      JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES
    ('general', '{}'), ('bling', '{}'), ('zpl', '{}'), ('ui', '{}')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3.  TABELA: stock_items (INSUMOS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_items (
    id                      UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                    TEXT         UNIQUE NOT NULL,
    name                    TEXT         NOT NULL,
    kind                    TEXT         NOT NULL DEFAULT 'INSUMO',
    unit                    TEXT         NOT NULL DEFAULT 'un',
    current_qty             REAL         NOT NULL DEFAULT 0,
    min_qty                 REAL         NOT NULL DEFAULT 0,
    category                TEXT         DEFAULT '',
    color                   TEXT,
    product_type            TEXT,
    expedition_items        JSONB        DEFAULT '[]'::jsonb,
    substitute_product_code TEXT,
    barcode                 TEXT,
    reserved_qty            REAL         DEFAULT 0,
    ready_qty               REAL         DEFAULT 0,
    sell_price              REAL         DEFAULT 0,
    cost_price              REAL         DEFAULT 0,
    description             TEXT,
    status                  TEXT         DEFAULT 'ATIVO',
    created_at              TIMESTAMPTZ  DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  DEFAULT NOW()
);

ALTER TABLE stock_items
    ADD COLUMN IF NOT EXISTS category                TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS color                   TEXT,
    ADD COLUMN IF NOT EXISTS product_type            TEXT,
    ADD COLUMN IF NOT EXISTS substitute_product_code TEXT,
    ADD COLUMN IF NOT EXISTS expedition_items        JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS barcode                 TEXT,
    ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS reserved_qty            REAL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ready_qty               REAL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS sell_price              REAL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_price              REAL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS description             TEXT,
    ADD COLUMN IF NOT EXISTS status                  TEXT DEFAULT 'ATIVO';

CREATE INDEX IF NOT EXISTS idx_stock_items_code ON stock_items (code);
CREATE INDEX IF NOT EXISTS idx_stock_items_kind ON stock_items (kind);
CREATE INDEX IF NOT EXISTS idx_stock_items_name ON stock_items USING gin(name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4.  TABELA: stock_movements
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
    id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    stock_item_code   TEXT         NOT NULL,
    stock_item_name   TEXT         NOT NULL DEFAULT '',
    origin            TEXT         NOT NULL DEFAULT 'AJUSTE_MANUAL',
    qty_delta         REAL         NOT NULL,
    ref               TEXT,
    product_sku       TEXT,
    created_by_name   TEXT,
    from_weighing     BOOLEAN      DEFAULT FALSE,
    created_at        TIMESTAMPTZ  DEFAULT NOW()
);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock_movements' AND column_name='created_by')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock_movements' AND column_name='created_by_name')
    THEN
        ALTER TABLE stock_movements RENAME COLUMN created_by TO created_by_name;
    END IF;
END $$;

ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS stock_item_code TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS stock_item_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS from_weighing   BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS product_sku     TEXT,
    ADD COLUMN IF NOT EXISTS created_by_name TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_mvt_item_code  ON stock_movements (stock_item_code);
CREATE INDEX IF NOT EXISTS idx_stock_mvt_created_at ON stock_movements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mvt_origin     ON stock_movements (origin);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5.  TABELA: orders
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id                        TEXT             PRIMARY KEY,
    order_id                  TEXT             NOT NULL,
    tracking                  TEXT,
    sku                       TEXT             NOT NULL DEFAULT '',
    qty_original              INT              NOT NULL DEFAULT 1,
    multiplicador             INT              DEFAULT 1,
    qty_final                 INT              NOT NULL DEFAULT 1,
    color                     TEXT,
    canal                     canal_type,
    data                      TEXT,
    data_prevista_envio       TEXT,
    status                    order_status_value DEFAULT 'NORMAL',
    customer_name             TEXT,
    customer_cpf_cnpj         TEXT,
    price_gross               REAL             DEFAULT 0,
    price_total               REAL             DEFAULT 0,
    platform_fees             REAL             DEFAULT 0,
    shipping_fee              REAL             DEFAULT 0,
    shipping_paid_by_customer REAL             DEFAULT 0,
    price_net                 REAL             DEFAULT 0,
    error_reason              TEXT,
    resolution_details        JSONB,
    created_at                TIMESTAMPTZ      DEFAULT NOW()
);

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS data_prevista_envio       TEXT,
    ADD COLUMN IF NOT EXISTS resolution_details        JSONB,
    ADD COLUMN IF NOT EXISTS shipping_paid_by_customer REAL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS price_total               REAL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS orders_order_id_sku_idx ON orders (order_id, sku);
CREATE INDEX IF NOT EXISTS idx_orders_order_id  ON orders (order_id);
CREATE INDEX IF NOT EXISTS idx_orders_tracking  ON orders (tracking);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_canal     ON orders (canal);
CREATE INDEX IF NOT EXISTS idx_orders_data      ON orders (data);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6.  TABELA: scan_logs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_logs (
    id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    scanned_at  TIMESTAMPTZ  DEFAULT NOW(),
    user_id     TEXT,
    user_name   TEXT,
    device      TEXT,
    display_key TEXT,
    status      TEXT,
    synced      BOOLEAN      DEFAULT FALSE,
    canal       TEXT,
    order_id    TEXT,
    sku         TEXT,
    notes       TEXT
);

ALTER TABLE scan_logs
    ADD COLUMN IF NOT EXISTS order_id TEXT,
    ADD COLUMN IF NOT EXISTS sku      TEXT,
    ADD COLUMN IF NOT EXISTS notes    TEXT;

CREATE INDEX IF NOT EXISTS idx_scan_logs_display_key ON scan_logs (display_key);
CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at  ON scan_logs (scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_logs_status      ON scan_logs (status);
CREATE INDEX IF NOT EXISTS idx_scan_logs_synced      ON scan_logs (synced) WHERE synced = FALSE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7.  TABELA: sku_links
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sku_links (
    imported_sku       TEXT  PRIMARY KEY,
    master_product_sku TEXT  NOT NULL,
    created_at         TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE sku_links ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_sku_links_master ON sku_links (master_product_sku);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8.  TABELA: product_boms (Produtos Finais)
--     PK = id (gerado pelo app), code = UNIQUE (SKU do produto)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_boms (
    id               TEXT         PRIMARY KEY,
    code             TEXT         UNIQUE NOT NULL,
    name             TEXT         NOT NULL,
    kind             TEXT         DEFAULT 'PRODUTO',
    unit             TEXT         DEFAULT 'un',
    category         TEXT         DEFAULT '',
    current_qty      REAL         DEFAULT 0,
    reserved_qty     REAL         DEFAULT 0,
    ready_qty        REAL         DEFAULT 0,
    min_qty          REAL         DEFAULT 0,
    sell_price       REAL         DEFAULT 0,
    cost_price       REAL         DEFAULT 0,
    bom_composition  JSONB        DEFAULT '{"items":[]}'::jsonb,
    items            JSONB        DEFAULT '[]'::jsonb,
    description      TEXT,
    status           TEXT         DEFAULT 'ATIVO',
    barcode          TEXT,
    color            TEXT,
    product_type     TEXT,
    substitute_product_code TEXT,
    expedition_items JSONB        DEFAULT '[]'::jsonb,
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW()
);

-- Garantir colunas se tabela já existia
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'PRODUTO';
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT 'un';
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS category TEXT DEFAULT '';
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS current_qty REAL DEFAULT 0;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS reserved_qty REAL DEFAULT 0;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS ready_qty REAL DEFAULT 0;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS min_qty REAL DEFAULT 0;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS sell_price REAL DEFAULT 0;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS cost_price REAL DEFAULT 0;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS bom_composition JSONB DEFAULT '{"items":[]}'::jsonb;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ATIVO';
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS barcode TEXT;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS product_type TEXT;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS substitute_product_code TEXT;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS expedition_items JSONB DEFAULT '[]'::jsonb;
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE product_boms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Migração: se tabela antiga usava product_sku como PK
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='product_boms' AND column_name='product_sku') THEN
    UPDATE product_boms SET id = product_sku WHERE id IS NULL AND product_sku IS NOT NULL;
    UPDATE product_boms SET code = product_sku WHERE code IS NULL AND product_sku IS NOT NULL;
    UPDATE product_boms SET name = product_sku WHERE name IS NULL AND product_sku IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_product_boms_code ON product_boms (code);
CREATE INDEX IF NOT EXISTS idx_product_boms_kind ON product_boms (kind);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9.  TABELA: weighing_batches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weighing_batches (
    id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    stock_item_code   TEXT         NOT NULL,
    stock_item_name   TEXT         NOT NULL DEFAULT '',
    initial_qty       REAL         NOT NULL DEFAULT 0,
    used_qty          REAL         DEFAULT 0,
    weighing_type     TEXT         DEFAULT 'daily',
    created_by_id     TEXT,
    created_by_name   TEXT,
    created_at        TIMESTAMPTZ  DEFAULT NOW()
);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='weighing_batches' AND column_name='user_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='weighing_batches' AND column_name='created_by_id')
    THEN ALTER TABLE weighing_batches RENAME COLUMN user_id TO created_by_id; END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='weighing_batches' AND column_name='created_by')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='weighing_batches' AND column_name='created_by_name')
    THEN ALTER TABLE weighing_batches RENAME COLUMN created_by TO created_by_name; END IF;
END $$;

ALTER TABLE weighing_batches
    ADD COLUMN IF NOT EXISTS stock_item_code TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS stock_item_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS created_by_id   TEXT,
    ADD COLUMN IF NOT EXISTS created_by_name TEXT;

CREATE INDEX IF NOT EXISTS idx_weighing_item_code  ON weighing_batches (stock_item_code);
CREATE INDEX IF NOT EXISTS idx_weighing_created_at ON weighing_batches (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. TABELA: grinding_batches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grinding_batches (
    id                    UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_insumo_code    TEXT         NOT NULL,
    source_insumo_name    TEXT,
    source_qty_used       REAL         NOT NULL DEFAULT 0,
    output_insumo_code    TEXT         NOT NULL,
    output_insumo_name    TEXT,
    output_qty_produced   REAL         NOT NULL DEFAULT 0,
    mode                  TEXT,
    user_id               TEXT,
    user_name             TEXT,
    created_at            TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grinding_source_code ON grinding_batches (source_insumo_code);
CREATE INDEX IF NOT EXISTS idx_grinding_created_at  ON grinding_batches (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. TABELA: production_plans
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_plans (
    id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT         NOT NULL,
    status      TEXT         DEFAULT 'Draft',
    parameters  JSONB,
    plan_date   TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prod_plans_created_at ON production_plans (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. TABELA: production_plan_items
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_plan_items (
    id                     UUID  PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan_id                UUID  NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
    product_sku            TEXT,
    product_name           TEXT,
    current_stock          REAL,
    avg_daily_consumption  REAL,
    forecasted_demand      REAL,
    required_production    REAL
);

ALTER TABLE production_plan_items
    ADD COLUMN IF NOT EXISTS current_stock         REAL,
    ADD COLUMN IF NOT EXISTS avg_daily_consumption REAL;

CREATE INDEX IF NOT EXISTS idx_plan_items_plan_id ON production_plan_items (plan_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. TABELA: shopping_list_items
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopping_list_items (
    stock_item_code TEXT         PRIMARY KEY,
    name            TEXT         NOT NULL DEFAULT '',
    quantity        REAL         NOT NULL DEFAULT 0,
    unit            TEXT         NOT NULL DEFAULT 'un',
    is_purchased    BOOLEAN      DEFAULT FALSE,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. TABELA: import_history
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_history (
    id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_name      TEXT,
    processed_at   TIMESTAMPTZ,
    user_name      TEXT,
    item_count     INT,
    unlinked_count INT,
    canal          TEXT,
    processed_data JSONB
);

ALTER TABLE import_history ADD COLUMN IF NOT EXISTS processed_data JSONB;
CREATE INDEX IF NOT EXISTS idx_import_history_processed_at ON import_history (processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_history_canal        ON import_history (canal);

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. TABELA: etiquetas_historico
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS etiquetas_historico (
    id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at        TIMESTAMPTZ  DEFAULT NOW(),
    created_by_name   TEXT,
    page_count        INT,
    zpl_content       TEXT,
    settings_snapshot JSONB,
    page_hashes       TEXT[]       DEFAULT '{}'
);

ALTER TABLE etiquetas_historico
    ADD COLUMN IF NOT EXISTS zpl_content       TEXT,
    ADD COLUMN IF NOT EXISTS settings_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS page_hashes       TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_etiquetas_hist_created_at ON etiquetas_historico (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. TABELA: returns
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS returns (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    tracking        TEXT         NOT NULL,
    customer_name   TEXT,
    logged_by_id    TEXT,
    logged_by_name  TEXT,
    order_id        TEXT,
    logged_at       TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_returns_tracking  ON returns (tracking);
CREATE INDEX IF NOT EXISTS idx_returns_logged_at ON returns (logged_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 17. TABELA: admin_notices
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_notices (
    id         TEXT         PRIMARY KEY,
    text       TEXT         NOT NULL,
    level      TEXT         NOT NULL DEFAULT 'green',
    type       TEXT         NOT NULL DEFAULT 'banner',
    created_by TEXT,
    created_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notices_created_at ON admin_notices (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 18. TABELA: stock_pack_groups
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_pack_groups (
    id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name         TEXT         NOT NULL,
    barcode      TEXT,
    item_codes   TEXT[]       NOT NULL DEFAULT '{}',
    min_pack_qty REAL         NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ  DEFAULT NOW()
);

ALTER TABLE stock_pack_groups ADD COLUMN IF NOT EXISTS barcode TEXT;
CREATE INDEX IF NOT EXISTS idx_pack_groups_name ON stock_pack_groups (name);

-- ─────────────────────────────────────────────────────────────────────────────
-- 19. ROW LEVEL SECURITY (acesso aberto via anon key)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ DECLARE
    tbl TEXT;
BEGIN
    FOR tbl IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS "allow_all" ON public.%I', tbl);
        EXECUTE format('CREATE POLICY "allow_all" ON public.%I FOR ALL USING (true) WITH CHECK (true)', tbl);
    END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20. VIEW: vw_dados_analiticos (BI / relatórios)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW vw_dados_analiticos AS
SELECT
    o.id                                  AS id_pedido,
    o.order_id                            AS codigo_pedido,
    o.data                                AS data_pedido,
    o.canal,
    o.status                              AS status_pedido,
    COALESCE(sl_link.master_product_sku, o.sku) AS sku_mestre,
    COALESCE(si.name, pb.name, o.sku)     AS nome_produto,
    o.qty_final                           AS quantidade_final,
    COALESCE(sc.user_name, '')            AS bipado_por,
    COALESCE(sc.user_id, '')              AS bipado_por_id,
    sc.scanned_at                         AS data_bipagem,
    CASE
        WHEN o.status::text = 'BIPADO' AND sc.scanned_at IS NOT NULL
             AND o.data IS NOT NULL AND o.data ~ '^\d{4}-\d{2}-\d{2}'
             AND TO_DATE(o.data, 'YYYY-MM-DD') < DATE(sc.scanned_at)
        THEN 'Bipado com Atraso'
        WHEN o.status::text = 'BIPADO' THEN 'Bipado no Prazo'
        WHEN o.status::text = 'DEVOLVIDO'   THEN 'Devolvido'
        WHEN o.status::text = 'SOLUCIONADO' THEN 'Solucionado'
        WHEN o.status::text = 'ERRO'        THEN 'Com Erro'
        WHEN o.status::text = 'NORMAL' AND o.data IS NOT NULL
             AND o.data ~ '^\d{4}-\d{2}-\d{2}'
             AND TO_DATE(o.data, 'YYYY-MM-DD') < CURRENT_DATE
        THEN 'Atrasado'
        WHEN o.status::text = 'NORMAL' THEN 'Pendente'
        ELSE o.status::text
    END                                   AS status_derivado,
    CASE
        WHEN sc.scanned_at IS NOT NULL AND o.data IS NOT NULL
             AND o.data ~ '^\d{4}-\d{2}-\d{2}'
        THEN EXTRACT(EPOCH FROM (sc.scanned_at - (TO_DATE(o.data,'YYYY-MM-DD') + INTERVAL '12 hours'))) / 3600.0
        ELSE NULL
    END                                   AS tempo_separacao_horas
FROM orders o
LEFT JOIN sku_links sl_link ON sl_link.imported_sku = o.sku
LEFT JOIN stock_items si ON si.code = COALESCE(sl_link.master_product_sku, o.sku)
LEFT JOIN product_boms pb ON pb.code = COALESCE(sl_link.master_product_sku, o.sku)
LEFT JOIN LATERAL (
    SELECT user_name, user_id, scanned_at
    FROM scan_logs
    WHERE (display_key = o.order_id OR display_key = o.tracking)
      AND status = 'OK'
    ORDER BY scanned_at DESC
    LIMIT 1
) sc ON TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 21. TRIGGER: atualiza updated_at automaticamente
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DO $$ DECLARE
    tbl TEXT;
    trg TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['stock_items', 'app_settings', 'product_boms']
    LOOP
        trg := 'trg_' || tbl || '_updated_at';
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = trg) THEN
            EXECUTE format(
                'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                trg, tbl
            );
        END IF;
    END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 22. STORED PROCEDURES (RPCs)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 22.1  login ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION login(login_input TEXT, password_input TEXT)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    found_user RECORD;
BEGIN
    SELECT * INTO found_user
    FROM public.users
    WHERE (
        lower(trim(COALESCE(name, ''))) = lower(trim(COALESCE(login_input, '')))
        OR lower(trim(COALESCE(email, ''))) = lower(trim(COALESCE(login_input, '')))
    )
    AND trim(COALESCE(password, '')) = trim(COALESCE(password_input, ''))
    LIMIT 1;

    IF found_user IS NOT NULL THEN
        RETURN to_jsonb(found_user);
    ELSE
        RETURN NULL;
    END IF;
END;
$$;

-- ── 22.2  check_setup_status ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_setup_status()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    tables_status  jsonb;
    types_status   jsonb;
    functions_status jsonb;
    columns_status jsonb;
BEGIN
    EXECUTE 'SELECT jsonb_agg(jsonb_build_object(''name'', t, ''exists'', EXISTS (SELECT FROM pg_tables WHERE schemaname = ''public'' AND tablename = t))) FROM unnest($1::text[]) t'
        USING ARRAY['stock_items','orders','stock_movements','users','scan_logs','product_boms','sku_links','weighing_batches','production_plans','shopping_list_items','stock_pack_groups']
        INTO tables_status;

    EXECUTE 'SELECT jsonb_agg(jsonb_build_object(''name'', t, ''exists'', EXISTS (SELECT FROM pg_type WHERE typname = t))) FROM unnest($1::text[]) t'
        USING ARRAY['canal_type','order_status_value']
        INTO types_status;

    EXECUTE 'SELECT jsonb_agg(jsonb_build_object(''name'', t, ''exists'', EXISTS (SELECT FROM pg_proc WHERE proname = t))) FROM unnest($1::text[]) t'
        USING ARRAY['sync_database','adjust_stock_quantity','record_production_run','login']
        INTO functions_status;

    SELECT jsonb_agg(jsonb_build_object('table', t, 'column', c, 'exists',
        EXISTS (SELECT FROM information_schema.columns WHERE table_name=t AND column_name=c)))
    INTO columns_status
    FROM (VALUES ('stock_items','barcode'),('stock_items','substitute_product_code')) AS v(t,c);

    RETURN jsonb_build_object(
        'tables_status',    tables_status,
        'types_status',     types_status,
        'functions_status', functions_status,
        'columns_status',   columns_status,
        'db_version',       '5.0'
    );
END;
$$;

-- ── 22.3  adjust_stock_quantity ───────────────────────────────────────────────
--     Busca em stock_items E product_boms
CREATE OR REPLACE FUNCTION adjust_stock_quantity(
    item_code       TEXT,
    quantity_delta   REAL,
    origin_text     TEXT,
    ref_text        TEXT,
    user_name       TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_item_name TEXT;
BEGIN
    -- Primeiro tenta em stock_items
    SELECT name INTO v_item_name FROM stock_items WHERE code = item_code;
    IF v_item_name IS NOT NULL THEN
        UPDATE stock_items SET current_qty = current_qty + quantity_delta, updated_at = NOW() WHERE code = item_code;
    ELSE
        -- Depois tenta em product_boms
        SELECT name INTO v_item_name FROM product_boms WHERE code = item_code;
        IF v_item_name IS NOT NULL THEN
            UPDATE product_boms SET current_qty = current_qty + quantity_delta, updated_at = NOW() WHERE code = item_code;
        ELSE
            RAISE EXCEPTION 'Item not found in stock_items or product_boms: %', item_code;
        END IF;
    END IF;

    INSERT INTO stock_movements (stock_item_code, stock_item_name, origin, qty_delta, ref, created_by_name)
    VALUES (item_code, v_item_name, origin_text, quantity_delta, ref_text, user_name);
END;
$$;

-- ── 22.4  record_production_run ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION record_production_run(
    item_code           TEXT,
    quantity_to_produce REAL,
    ref_text            TEXT,
    user_name           TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    bom_data   JSONB;
    bom_item   JSONB;
    insumo_code TEXT;
    qty_needed REAL;
BEGIN
    PERFORM adjust_stock_quantity(item_code, quantity_to_produce, 'PRODUCAO_MANUAL', ref_text, user_name);

    SELECT items INTO bom_data FROM product_boms WHERE code = item_code;
    IF bom_data IS NOT NULL THEN
        FOR bom_item IN SELECT * FROM jsonb_array_elements(bom_data)
        LOOP
            insumo_code := bom_item->>'stockItemCode';
            qty_needed  := (bom_item->>'qty_per_pack')::real * quantity_to_produce;
            IF EXISTS (SELECT 1 FROM stock_items WHERE code = insumo_code) THEN
                PERFORM adjust_stock_quantity(insumo_code, -qty_needed, 'PRODUCAO_MANUAL', ref_text || ' (Consumo)', user_name);
            END IF;
        END LOOP;
    END IF;
END;
$$;

-- ── 22.5  record_weighing_and_deduct_stock ────────────────────────────────────
CREATE OR REPLACE FUNCTION record_weighing_and_deduct_stock(
    item_code           TEXT,
    quantity_to_weigh   REAL,
    weighing_type_text  TEXT,
    user_id             TEXT,
    user_name           TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_item_name TEXT;
BEGIN
    SELECT name INTO v_item_name FROM stock_items WHERE code = item_code;

    INSERT INTO weighing_batches (stock_item_code, stock_item_name, initial_qty, weighing_type, created_by_id, created_by_name)
    VALUES (item_code, COALESCE(v_item_name, item_code), quantity_to_weigh, weighing_type_text, user_id, user_name);

    PERFORM adjust_stock_quantity(item_code, quantity_to_weigh, 'PESAGEM', 'Lote Pesado', user_name);
END;
$$;

-- ── 22.6  record_grinding_run ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION record_grinding_run(
    source_code   TEXT,
    source_qty    REAL,
    output_code   TEXT,
    output_name   TEXT,
    output_qty    REAL,
    op_mode       TEXT,
    op_user_id    TEXT,
    op_user_name  TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_source_name TEXT;
BEGIN
    SELECT name INTO v_source_name FROM stock_items WHERE code = source_code;
    PERFORM adjust_stock_quantity(source_code, -source_qty, 'MOAGEM', 'Consumo Moagem', op_user_name);
    IF NOT EXISTS (SELECT 1 FROM stock_items WHERE code = output_code) THEN
        INSERT INTO stock_items (code, name, kind, unit, current_qty) VALUES (output_code, output_name, 'INSUMO', 'kg', 0);
    END IF;
    PERFORM adjust_stock_quantity(output_code, output_qty, 'MOAGEM', 'Produção Moagem', op_user_name);
    INSERT INTO grinding_batches (source_insumo_code, source_insumo_name, source_qty_used, output_insumo_code, output_insumo_name, output_qty_produced, mode, user_id, user_name)
    VALUES (source_code, COALESCE(v_source_name, source_code), source_qty, output_code, output_name, output_qty, op_mode, op_user_id, op_user_name);
END;
$$;

-- ── 22.7  cancel_scan_id_and_revert_stock ─────────────────────────────────────
CREATE OR REPLACE FUNCTION cancel_scan_id_and_revert_stock(
    scan_id_to_cancel UUID,
    user_name         TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_scan    RECORD;
    v_order   RECORD;
    v_master  TEXT;
BEGIN
    SELECT * INTO v_scan FROM scan_logs WHERE id = scan_id_to_cancel;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_order FROM orders
    WHERE (order_id = v_scan.display_key OR tracking = v_scan.display_key)
      AND status::text = 'BIPADO';

    IF v_order IS NOT NULL THEN
        UPDATE orders SET status = 'NORMAL' WHERE id = v_order.id;
        SELECT master_product_sku INTO v_master FROM sku_links WHERE imported_sku = v_order.sku;
        IF v_master IS NULL THEN v_master := v_order.sku; END IF;
        PERFORM adjust_stock_quantity(v_master, 1, 'AJUSTE_MANUAL', 'Cancelamento Bipagem ' || v_scan.display_key, user_name);
    END IF;

    DELETE FROM scan_logs WHERE id = scan_id_to_cancel;
END;
$$;

-- ── 22.8  delete_orders ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_orders(order_ids TEXT[])
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    DELETE FROM orders WHERE id = ANY(order_ids);
END;
$$;

-- ── 22.9  clear_scan_history ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION clear_scan_history()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    DELETE FROM public.scan_logs;
    UPDATE public.orders SET status = 'NORMAL' WHERE status::text = 'BIPADO';
END;
$$;

-- ── 22.10 bulk_set_initial_stock ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bulk_set_initial_stock(
    updates   JSONB,
    user_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_item     JSONB;
    v_code     TEXT;
    v_qty      REAL;
    v_old      REAL;
    v_delta    REAL;
    v_count    INT := 0;
BEGIN
    FOR v_item IN SELECT * FROM jsonb_array_elements(updates)
    LOOP
        v_code := v_item->>'item_code';
        v_qty  := (v_item->>'new_initial_quantity')::real;

        SELECT current_qty INTO v_old FROM public.stock_items WHERE code = v_code;
        IF NOT FOUND THEN
            -- Tentar em product_boms
            SELECT current_qty INTO v_old FROM public.product_boms WHERE code = v_code;
            IF NOT FOUND THEN CONTINUE; END IF;
        END IF;

        v_delta := v_qty - v_old;
        IF v_delta = 0 THEN CONTINUE; END IF;

        PERFORM public.adjust_stock_quantity(v_code, v_delta, 'AJUSTE_MANUAL', 'Inventário em Massa', user_name);
        v_count := v_count + 1;
    END LOOP;

    RETURN 'Estoque atualizado: ' || v_count || ' itens';
END;
$$;

-- ── 22.11 sync_database ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_database()
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN 'Banco de dados sincronizado com sucesso!';
END;
$$;

-- ── 22.12 reset_database ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reset_database()
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    DELETE FROM public.scan_logs;
    DELETE FROM public.orders;
    DELETE FROM public.stock_movements;
    DELETE FROM public.weighing_batches;
    DELETE FROM public.grinding_batches;
    DELETE FROM public.production_plan_items;
    DELETE FROM public.production_plans;
    DELETE FROM public.shopping_list_items;
    DELETE FROM public.returns;
    DELETE FROM public.import_history;
    DELETE FROM public.admin_notices;
    DELETE FROM public.etiquetas_historico;
    UPDATE public.stock_items SET current_qty = 0;
    UPDATE public.product_boms SET current_qty = 0, reserved_qty = 0, ready_qty = 0;
    RETURN 'Banco de dados limpo com sucesso.';
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 23. DADOS INICIAIS
-- ─────────────────────────────────────────────────────────────────────────────

-- Usuário admin (login: admin / supersuecocollor)
INSERT INTO users (name, password, role, setor)
VALUES ('admin', 'supersuecocollor', 'SUPER_ADMIN', ARRAY['ADMINISTRATIVO'])
ON CONFLICT DO NOTHING;

-- Insumos de exemplo
INSERT INTO stock_items (code, name, kind, unit, category, current_qty) VALUES
    ('MAT-PAPEL-001', 'Papel A4 80g (resma)', 'INSUMO', 'resmas', 'Papéis', 100),
    ('MAT-TINTA-001', 'Tinta Preta (litro)',  'INSUMO', 'litros', 'Tintas', 50),
    ('MAT-COLA-001',  'Cola PVA (kg)',         'INSUMO', 'kg',     'Adesivos', 25),
    ('MAT-LAM-001',   'Laminado Brilho (m2)',  'INSUMO', 'm2',     'Laminados', 200)
ON CONFLICT (code) DO NOTHING;

-- Produtos finais de exemplo
INSERT INTO product_boms (id, code, name, kind, unit, category, current_qty, reserved_qty, ready_qty, sell_price, cost_price, bom_composition, items) VALUES
    ('prod_001', 'PROD-CARTAZ-001', 'Cartaz A3 Colorido', 'PRODUTO', 'unidades', 'Impressos', 50, 10, 40, 25.50, 12.00,
     '{"items":[{"insumo_code":"MAT-PAPEL-001","insumo_name":"Papel A4 80g (resma)","quantity":0.5,"unit":"resmas"},{"insumo_code":"MAT-TINTA-001","insumo_name":"Tinta Preta (litro)","quantity":0.1,"unit":"litros"},{"insumo_code":"MAT-LAM-001","insumo_name":"Laminado Brilho (m2)","quantity":0.1,"unit":"m2"}]}'::jsonb,
     '[{"insumo_code":"MAT-PAPEL-001","insumo_name":"Papel A4 80g (resma)","quantity":0.5,"unit":"resmas"},{"insumo_code":"MAT-TINTA-001","insumo_name":"Tinta Preta (litro)","quantity":0.1,"unit":"litros"},{"insumo_code":"MAT-LAM-001","insumo_name":"Laminado Brilho (m2)","quantity":0.1,"unit":"m2"}]'::jsonb),
    ('prod_002', 'PROD-FOLDER-001', 'Folder A4 Dobrado', 'PRODUTO', 'unidades', 'Impressos', 100, 20, 80, 15.75, 8.50,
     '{"items":[{"insumo_code":"MAT-PAPEL-001","insumo_name":"Papel A4 80g (resma)","quantity":0.3,"unit":"resmas"},{"insumo_code":"MAT-COLA-001","insumo_name":"Cola PVA (kg)","quantity":0.05,"unit":"kg"}]}'::jsonb,
     '[{"insumo_code":"MAT-PAPEL-001","insumo_name":"Papel A4 80g (resma)","quantity":0.3,"unit":"resmas"},{"insumo_code":"MAT-COLA-001","insumo_name":"Cola PVA (kg)","quantity":0.05,"unit":"kg"}]'::jsonb),
    ('prod_003', 'PROD-BANNER-001', 'Banner Lona 2x3m', 'PRODUTO', 'unidades', 'Outdoors', 10, 2, 8, 85.00, 40.00,
     '{"items":[{"insumo_code":"MAT-TINTA-001","insumo_name":"Tinta Preta (litro)","quantity":0.5,"unit":"litros"},{"insumo_code":"MAT-LAM-001","insumo_name":"Laminado Brilho (m2)","quantity":6.0,"unit":"m2"}]}'::jsonb,
     '[{"insumo_code":"MAT-TINTA-001","insumo_name":"Tinta Preta (litro)","quantity":0.5,"unit":"litros"},{"insumo_code":"MAT-LAM-001","insumo_name":"Laminado Brilho (m2)","quantity":6.0,"unit":"m2"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- SKU Links de marketplace (exemplo)
INSERT INTO sku_links (imported_sku, master_product_sku) VALUES
    ('ML-12345678901', 'PROD-CARTAZ-001'),
    ('ML-87654321098', 'PROD-FOLDER-001'),
    ('ML-11111111111', 'PROD-BANNER-001'),
    ('ML-99999999999', 'PROD-CARTAZ-001')
ON CONFLICT (imported_sku) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 24. VERIFICAÇÃO FINAL
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns c
     WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_type   = 'BASE TABLE'
  AND table_name IN (
      'users','orders','scan_logs','stock_items','stock_movements',
      'stock_pack_groups','sku_links','returns','weighing_batches',
      'grinding_batches','product_boms','production_plans',
      'production_plan_items','shopping_list_items','import_history',
      'app_settings','admin_notices','etiquetas_historico'
  )
ORDER BY table_name;

SELECT
    (SELECT COUNT(*) FROM users)       AS "Usuarios",
    (SELECT COUNT(*) FROM stock_items)  AS "Insumos",
    (SELECT COUNT(*) FROM product_boms) AS "Produtos",
    (SELECT COUNT(*) FROM sku_links)    AS "SKU_Links";

-- ============================================================================
-- FIM — ERP v5.0 (2025-06-04)
-- ============================================================================
