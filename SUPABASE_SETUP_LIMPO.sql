-- ============================================================================
-- ERP FÁBRICA PRO — SETUP LIMPO SUPABASE
-- Versão: 5.1 (2026-03-05)
--
-- INSTRUÇÕES:
--   1. Supabase → SQL Editor → New Query
--   2. Cole TUDO → Run
--   3. Login: admin / supersuecocollor
--
-- ⚠️ APAGA TUDO E RECRIA DO ZERO — use apenas em setup inicial ou reset.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 0: LIMPAR TUDO QUE EXISTIR
-- ─────────────────────────────────────────────────────────────────────────────
DROP VIEW  IF EXISTS vw_dados_analiticos CASCADE;

DROP TABLE IF EXISTS production_plan_items CASCADE;
DROP TABLE IF EXISTS production_plans      CASCADE;
DROP TABLE IF EXISTS grinding_batches      CASCADE;
DROP TABLE IF EXISTS weighing_batches      CASCADE;
DROP TABLE IF EXISTS stock_movements       CASCADE;
DROP TABLE IF EXISTS scan_logs             CASCADE;
DROP TABLE IF EXISTS shopping_list_items   CASCADE;
DROP TABLE IF EXISTS import_history        CASCADE;
DROP TABLE IF EXISTS etiquetas_historico   CASCADE;
DROP TABLE IF EXISTS returns               CASCADE;
DROP TABLE IF EXISTS admin_notices         CASCADE;
DROP TABLE IF EXISTS stock_pack_groups     CASCADE;
DROP TABLE IF EXISTS sku_links             CASCADE;
DROP TABLE IF EXISTS product_boms          CASCADE;
DROP TABLE IF EXISTS orders                CASCADE;
DROP TABLE IF EXISTS stock_items           CASCADE;
DROP TABLE IF EXISTS app_settings          CASCADE;
DROP TABLE IF EXISTS users                 CASCADE;

DROP FUNCTION IF EXISTS login(TEXT, TEXT)                       CASCADE;
DROP FUNCTION IF EXISTS check_setup_status()                   CASCADE;
DROP FUNCTION IF EXISTS adjust_stock_quantity(TEXT, REAL, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS record_production_run(TEXT, REAL, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS record_weighing_and_deduct_stock(TEXT, REAL, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS record_grinding_run(TEXT, REAL, TEXT, TEXT, REAL, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS cancel_scan_id_and_revert_stock(UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS delete_orders(TEXT[])                   CASCADE;
DROP FUNCTION IF EXISTS clear_scan_history()                    CASCADE;
DROP FUNCTION IF EXISTS bulk_set_initial_stock(JSONB, TEXT)     CASCADE;
DROP FUNCTION IF EXISTS sync_database()                        CASCADE;
DROP FUNCTION IF EXISTS reset_database()                       CASCADE;
DROP FUNCTION IF EXISTS set_updated_at()                       CASCADE;

DROP TYPE IF EXISTS canal_type          CASCADE;
DROP TYPE IF EXISTS order_status_value  CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 1: EXTENSÕES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 2: ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE canal_type         AS ENUM ('ML', 'SHOPEE', 'SITE', 'ALL');
CREATE TYPE order_status_value AS ENUM ('NORMAL', 'ERRO', 'DEVOLVIDO', 'BIPADO', 'SOLUCIONADO');

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 3: TABELAS
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. users
CREATE TABLE users (
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
CREATE INDEX idx_users_name  ON users (name);
CREATE INDEX idx_users_role  ON users (role);
CREATE UNIQUE INDEX idx_users_email ON users (email) WHERE email IS NOT NULL;

-- 2. app_settings
CREATE TABLE app_settings (
    key        TEXT  PRIMARY KEY,
    value      JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. stock_items
CREATE TABLE stock_items (
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
CREATE INDEX idx_stock_items_code ON stock_items (code);
CREATE INDEX idx_stock_items_kind ON stock_items (kind);
CREATE INDEX idx_stock_items_name ON stock_items USING gin(name gin_trgm_ops);

-- 4. stock_movements
CREATE TABLE stock_movements (
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
CREATE INDEX idx_stock_mvt_item_code  ON stock_movements (stock_item_code);
CREATE INDEX idx_stock_mvt_created_at ON stock_movements (created_at DESC);
CREATE INDEX idx_stock_mvt_origin     ON stock_movements (origin);

-- 5. orders
CREATE TABLE orders (
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
CREATE UNIQUE INDEX orders_order_id_sku_idx ON orders (order_id, sku);
CREATE INDEX idx_orders_order_id  ON orders (order_id);
CREATE INDEX idx_orders_tracking  ON orders (tracking);
CREATE INDEX idx_orders_status    ON orders (status);
CREATE INDEX idx_orders_canal     ON orders (canal);
CREATE INDEX idx_orders_data      ON orders (data);

-- 6. scan_logs
CREATE TABLE scan_logs (
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
CREATE INDEX idx_scan_logs_display_key ON scan_logs (display_key);
CREATE INDEX idx_scan_logs_scanned_at  ON scan_logs (scanned_at DESC);
CREATE INDEX idx_scan_logs_status      ON scan_logs (status);
CREATE INDEX idx_scan_logs_synced      ON scan_logs (synced) WHERE synced = FALSE;

-- 7. sku_links
CREATE TABLE sku_links (
    imported_sku       TEXT  PRIMARY KEY,
    master_product_sku TEXT  NOT NULL,
    created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sku_links_master ON sku_links (master_product_sku);

-- 8. product_boms
CREATE TABLE product_boms (
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
CREATE INDEX idx_product_boms_code ON product_boms (code);
CREATE INDEX idx_product_boms_kind ON product_boms (kind);

-- 9. weighing_batches
CREATE TABLE weighing_batches (
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
CREATE INDEX idx_weighing_item_code  ON weighing_batches (stock_item_code);
CREATE INDEX idx_weighing_created_at ON weighing_batches (created_at DESC);

-- 10. grinding_batches
CREATE TABLE grinding_batches (
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
CREATE INDEX idx_grinding_source_code ON grinding_batches (source_insumo_code);
CREATE INDEX idx_grinding_created_at  ON grinding_batches (created_at DESC);

-- 11. production_plans
CREATE TABLE production_plans (
    id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT         NOT NULL,
    status      TEXT         DEFAULT 'Draft',
    parameters  JSONB,
    plan_date   TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX idx_prod_plans_created_at ON production_plans (created_at DESC);

-- 12. production_plan_items
CREATE TABLE production_plan_items (
    id                     UUID  PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan_id                UUID  NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
    product_sku            TEXT,
    product_name           TEXT,
    current_stock          REAL,
    avg_daily_consumption  REAL,
    forecasted_demand      REAL,
    required_production    REAL
);
CREATE INDEX idx_plan_items_plan_id ON production_plan_items (plan_id);

-- 13. shopping_list_items
CREATE TABLE shopping_list_items (
    stock_item_code TEXT         PRIMARY KEY,
    name            TEXT         NOT NULL DEFAULT '',
    quantity        REAL         NOT NULL DEFAULT 0,
    unit            TEXT         NOT NULL DEFAULT 'un',
    is_purchased    BOOLEAN      DEFAULT FALSE,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- 14. import_history
CREATE TABLE import_history (
    id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_name      TEXT,
    processed_at   TIMESTAMPTZ,
    user_name      TEXT,
    item_count     INT,
    unlinked_count INT,
    canal          TEXT,
    processed_data JSONB
);
CREATE INDEX idx_import_history_processed_at ON import_history (processed_at DESC);
CREATE INDEX idx_import_history_canal        ON import_history (canal);

-- 15. etiquetas_historico
CREATE TABLE etiquetas_historico (
    id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at        TIMESTAMPTZ  DEFAULT NOW(),
    created_by_name   TEXT,
    page_count        INT,
    zpl_content       TEXT,
    settings_snapshot JSONB,
    page_hashes       TEXT[]       DEFAULT '{}'
);
CREATE INDEX idx_etiquetas_hist_created_at ON etiquetas_historico (created_at DESC);

-- 16. returns
CREATE TABLE returns (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    tracking        TEXT         NOT NULL,
    customer_name   TEXT,
    logged_by_id    TEXT,
    logged_by_name  TEXT,
    order_id        TEXT,
    logged_at       TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX idx_returns_tracking  ON returns (tracking);
CREATE INDEX idx_returns_logged_at ON returns (logged_at DESC);

-- 17. admin_notices
CREATE TABLE admin_notices (
    id         TEXT         PRIMARY KEY,
    text       TEXT         NOT NULL,
    level      TEXT         NOT NULL DEFAULT 'green',
    type       TEXT         NOT NULL DEFAULT 'banner',
    created_by TEXT,
    created_at TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX idx_notices_created_at ON admin_notices (created_at DESC);

-- 18. stock_pack_groups
CREATE TABLE stock_pack_groups (
    id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name         TEXT         NOT NULL,
    barcode      TEXT,
    item_codes   TEXT[]       NOT NULL DEFAULT '{}',
    min_pack_qty REAL         NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX idx_pack_groups_name ON stock_pack_groups (name);

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 4: ROW LEVEL SECURITY (acesso aberto via anon key)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ DECLARE
    tbl TEXT;
BEGIN
    FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS "allow_all" ON public.%I', tbl);
        EXECUTE format('CREATE POLICY "allow_all" ON public.%I FOR ALL USING (true) WITH CHECK (true)', tbl);
    END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 5: VIEW ANALÍTICA
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW vw_dados_analiticos AS
SELECT
    o.id                                        AS id_pedido,
    o.order_id                                  AS codigo_pedido,
    o.data                                      AS data_pedido,
    o.canal,
    o.status                                    AS status_pedido,
    COALESCE(sl.master_product_sku, o.sku)      AS sku_mestre,
    COALESCE(si.name, pb.name, o.sku)           AS nome_produto,
    o.qty_final                                 AS quantidade_final,
    COALESCE(sc.user_name, '')                  AS bipado_por,
    COALESCE(sc.user_id, '')                    AS bipado_por_id,
    sc.scanned_at                               AS data_bipagem,
    CASE
        WHEN o.status::text = 'BIPADO' AND sc.scanned_at IS NOT NULL
             AND o.data IS NOT NULL AND o.data ~ '^\d{4}-\d{2}-\d{2}'
             AND TO_DATE(o.data, 'YYYY-MM-DD') < DATE(sc.scanned_at)
        THEN 'Bipado com Atraso'
        WHEN o.status::text = 'BIPADO'      THEN 'Bipado no Prazo'
        WHEN o.status::text = 'DEVOLVIDO'   THEN 'Devolvido'
        WHEN o.status::text = 'SOLUCIONADO' THEN 'Solucionado'
        WHEN o.status::text = 'ERRO'        THEN 'Com Erro'
        WHEN o.status::text = 'NORMAL' AND o.data IS NOT NULL
             AND o.data ~ '^\d{4}-\d{2}-\d{2}'
             AND TO_DATE(o.data, 'YYYY-MM-DD') < CURRENT_DATE
        THEN 'Atrasado'
        WHEN o.status::text = 'NORMAL' THEN 'Pendente'
        ELSE o.status::text
    END                                         AS status_derivado,
    CASE
        WHEN sc.scanned_at IS NOT NULL AND o.data IS NOT NULL
             AND o.data ~ '^\d{4}-\d{2}-\d{2}'
        THEN EXTRACT(EPOCH FROM (sc.scanned_at - (TO_DATE(o.data,'YYYY-MM-DD') + INTERVAL '12 hours'))) / 3600.0
        ELSE NULL
    END                                         AS tempo_separacao_horas
FROM orders o
LEFT JOIN sku_links sl ON sl.imported_sku = o.sku
LEFT JOIN stock_items si ON si.code = COALESCE(sl.master_product_sku, o.sku)
LEFT JOIN product_boms pb ON pb.code = COALESCE(sl.master_product_sku, o.sku)
LEFT JOIN LATERAL (
    SELECT user_name, user_id, scanned_at
    FROM scan_logs
    WHERE (display_key = o.order_id OR display_key = o.tracking)
      AND status = 'OK'
    ORDER BY scanned_at DESC LIMIT 1
) sc ON TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 6: TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_stock_items_updated_at  BEFORE UPDATE ON stock_items  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_app_settings_updated_at BEFORE UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_product_boms_updated_at BEFORE UPDATE ON product_boms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 7: RPCs (STORED FUNCTIONS)
-- ─────────────────────────────────────────────────────────────────────────────

-- 7.1 login
CREATE OR REPLACE FUNCTION login(login_input TEXT, password_input TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE found_user RECORD;
BEGIN
    SELECT * INTO found_user FROM public.users
    WHERE (lower(trim(COALESCE(name,''))) = lower(trim(COALESCE(login_input,'')))
        OR lower(trim(COALESCE(email,''))) = lower(trim(COALESCE(login_input,''))))
      AND trim(COALESCE(password,'')) = trim(COALESCE(password_input,''))
    LIMIT 1;
    IF found_user IS NOT NULL THEN RETURN to_jsonb(found_user); ELSE RETURN NULL; END IF;
END; $$;

-- 7.2 check_setup_status
CREATE OR REPLACE FUNCTION check_setup_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ts jsonb; ty jsonb; fn jsonb; co jsonb;
BEGIN
    EXECUTE 'SELECT jsonb_agg(jsonb_build_object(''name'',t,''exists'',EXISTS(SELECT FROM pg_tables WHERE schemaname=''public'' AND tablename=t))) FROM unnest($1::text[]) t'
        USING ARRAY['stock_items','orders','stock_movements','users','scan_logs','product_boms','sku_links','weighing_batches','production_plans','shopping_list_items','stock_pack_groups'] INTO ts;
    EXECUTE 'SELECT jsonb_agg(jsonb_build_object(''name'',t,''exists'',EXISTS(SELECT FROM pg_type WHERE typname=t))) FROM unnest($1::text[]) t'
        USING ARRAY['canal_type','order_status_value'] INTO ty;
    EXECUTE 'SELECT jsonb_agg(jsonb_build_object(''name'',t,''exists'',EXISTS(SELECT FROM pg_proc WHERE proname=t))) FROM unnest($1::text[]) t'
        USING ARRAY['sync_database','adjust_stock_quantity','record_production_run','login'] INTO fn;
    SELECT jsonb_agg(jsonb_build_object('table',t,'column',c,'exists',
        EXISTS(SELECT FROM information_schema.columns WHERE table_name=t AND column_name=c)))
    INTO co FROM (VALUES('stock_items','barcode'),('stock_items','substitute_product_code')) AS v(t,c);
    RETURN jsonb_build_object('tables_status',ts,'types_status',ty,'functions_status',fn,'columns_status',co,'db_version','5.1');
END; $$;

-- 7.3 adjust_stock_quantity (busca em stock_items E product_boms)
CREATE OR REPLACE FUNCTION adjust_stock_quantity(
    item_code TEXT, quantity_delta REAL, origin_text TEXT, ref_text TEXT, user_name TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_name TEXT;
BEGIN
    SELECT name INTO v_name FROM stock_items WHERE code = item_code;
    IF v_name IS NOT NULL THEN
        UPDATE stock_items SET current_qty = current_qty + quantity_delta, updated_at = NOW() WHERE code = item_code;
    ELSE
        SELECT name INTO v_name FROM product_boms WHERE code = item_code;
        IF v_name IS NOT NULL THEN
            UPDATE product_boms SET current_qty = current_qty + quantity_delta, updated_at = NOW() WHERE code = item_code;
        ELSE
            RAISE EXCEPTION 'Item not found: %', item_code;
        END IF;
    END IF;
    INSERT INTO stock_movements (stock_item_code, stock_item_name, origin, qty_delta, ref, created_by_name)
    VALUES (item_code, v_name, origin_text, quantity_delta, ref_text, user_name);
END; $$;

-- 7.4 record_production_run
CREATE OR REPLACE FUNCTION record_production_run(
    item_code TEXT, quantity_to_produce REAL, ref_text TEXT, user_name TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE bom JSONB; bi JSONB; ic TEXT; qn REAL;
BEGIN
    PERFORM adjust_stock_quantity(item_code, quantity_to_produce, 'PRODUCAO_MANUAL', ref_text, user_name);
    SELECT items INTO bom FROM product_boms WHERE code = item_code;
    IF bom IS NOT NULL THEN
        FOR bi IN SELECT * FROM jsonb_array_elements(bom) LOOP
            ic := bi->>'stockItemCode'; qn := (bi->>'qty_per_pack')::real * quantity_to_produce;
            IF EXISTS (SELECT 1 FROM stock_items WHERE code = ic) THEN
                PERFORM adjust_stock_quantity(ic, -qn, 'PRODUCAO_MANUAL', ref_text || ' (Consumo)', user_name);
            END IF;
        END LOOP;
    END IF;
END; $$;

-- 7.5 record_weighing_and_deduct_stock
CREATE OR REPLACE FUNCTION record_weighing_and_deduct_stock(
    item_code TEXT, quantity_to_weigh REAL, weighing_type_text TEXT, user_id TEXT, user_name TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_name TEXT;
BEGIN
    SELECT name INTO v_name FROM stock_items WHERE code = item_code;
    INSERT INTO weighing_batches (stock_item_code, stock_item_name, initial_qty, weighing_type, created_by_id, created_by_name)
    VALUES (item_code, COALESCE(v_name, item_code), quantity_to_weigh, weighing_type_text, user_id, user_name);
    PERFORM adjust_stock_quantity(item_code, quantity_to_weigh, 'PESAGEM', 'Lote Pesado', user_name);
END; $$;

-- 7.6 record_grinding_run
CREATE OR REPLACE FUNCTION record_grinding_run(
    source_code TEXT, source_qty REAL, output_code TEXT, output_name TEXT,
    output_qty REAL, op_mode TEXT, op_user_id TEXT, op_user_name TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sn TEXT;
BEGIN
    SELECT name INTO v_sn FROM stock_items WHERE code = source_code;
    PERFORM adjust_stock_quantity(source_code, -source_qty, 'MOAGEM', 'Consumo Moagem', op_user_name);
    IF NOT EXISTS (SELECT 1 FROM stock_items WHERE code = output_code) THEN
        INSERT INTO stock_items (code, name, kind, unit, current_qty) VALUES (output_code, output_name, 'INSUMO', 'kg', 0);
    END IF;
    PERFORM adjust_stock_quantity(output_code, output_qty, 'MOAGEM', 'Produção Moagem', op_user_name);
    INSERT INTO grinding_batches (source_insumo_code, source_insumo_name, source_qty_used, output_insumo_code, output_insumo_name, output_qty_produced, mode, user_id, user_name)
    VALUES (source_code, COALESCE(v_sn, source_code), source_qty, output_code, output_name, output_qty, op_mode, op_user_id, op_user_name);
END; $$;

-- 7.7 cancel_scan_id_and_revert_stock
CREATE OR REPLACE FUNCTION cancel_scan_id_and_revert_stock(scan_id_to_cancel UUID, user_name TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_scan RECORD; v_order RECORD; v_master TEXT;
BEGIN
    SELECT * INTO v_scan FROM scan_logs WHERE id = scan_id_to_cancel;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT * INTO v_order FROM orders WHERE (order_id = v_scan.display_key OR tracking = v_scan.display_key) AND status::text = 'BIPADO';
    IF v_order IS NOT NULL THEN
        UPDATE orders SET status = 'NORMAL' WHERE id = v_order.id;
        SELECT master_product_sku INTO v_master FROM sku_links WHERE imported_sku = v_order.sku;
        IF v_master IS NULL THEN v_master := v_order.sku; END IF;
        PERFORM adjust_stock_quantity(v_master, 1, 'AJUSTE_MANUAL', 'Cancelamento Bipagem ' || v_scan.display_key, user_name);
    END IF;
    DELETE FROM scan_logs WHERE id = scan_id_to_cancel;
END; $$;

-- 7.8 delete_orders
CREATE OR REPLACE FUNCTION delete_orders(order_ids TEXT[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN DELETE FROM orders WHERE id = ANY(order_ids); END; $$;

-- 7.9 clear_scan_history
CREATE OR REPLACE FUNCTION clear_scan_history()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    DELETE FROM public.scan_logs;
    UPDATE public.orders SET status = 'NORMAL' WHERE status::text = 'BIPADO';
END; $$;

-- 7.10 bulk_set_initial_stock
CREATE OR REPLACE FUNCTION bulk_set_initial_stock(updates JSONB, user_name TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v JSONB; vc TEXT; vq REAL; vo REAL; vd REAL; cnt INT := 0;
BEGIN
    FOR v IN SELECT * FROM jsonb_array_elements(updates) LOOP
        vc := v->>'item_code'; vq := (v->>'new_initial_quantity')::real;
        SELECT current_qty INTO vo FROM public.stock_items WHERE code = vc;
        IF NOT FOUND THEN
            SELECT current_qty INTO vo FROM public.product_boms WHERE code = vc;
            IF NOT FOUND THEN CONTINUE; END IF;
        END IF;
        vd := vq - vo; IF vd = 0 THEN CONTINUE; END IF;
        PERFORM public.adjust_stock_quantity(vc, vd, 'AJUSTE_MANUAL', 'Inventário em Massa', user_name);
        cnt := cnt + 1;
    END LOOP;
    RETURN 'Estoque atualizado: ' || cnt || ' itens';
END; $$;

-- 7.11 sync_database
CREATE OR REPLACE FUNCTION sync_database()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN 'Banco de dados sincronizado com sucesso!'; END; $$;

-- 7.12 reset_database
CREATE OR REPLACE FUNCTION reset_database()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
END; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 8: DADOS INICIAIS
-- ─────────────────────────────────────────────────────────────────────────────

-- Admin (login: admin / supersuecocollor)
INSERT INTO users (name, password, role, setor)
VALUES ('admin', 'supersuecocollor', 'SUPER_ADMIN', ARRAY['ADMINISTRATIVO']);

-- Settings default
INSERT INTO app_settings (key, value) VALUES
    ('general', '{}'), ('bling', '{}'), ('zpl', '{}'), ('ui', '{}');

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 9: VERIFICAÇÃO
-- ─────────────────────────────────────────────────────────────────────────────
SELECT table_name,
    (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS colunas
FROM information_schema.tables t
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

SELECT 'SETUP COMPLETO! Login: admin / supersuecocollor' AS resultado;

-- ============================================================================
-- FIM — ERP v5.1 (2026-03-05)
-- ============================================================================
