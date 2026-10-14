-- ============================================================
-- 健康饮食 App —— 数据库建表脚本（SQLite 版，对齐 task_2 数据模型）
-- 生产环境可平滑迁移到 PostgreSQL（见文件末尾差异说明）
-- ============================================================

-- 用户表
CREATE TABLE IF NOT EXISTS app_user (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE,
    password_hash   TEXT    NOT NULL,
    nickname        TEXT,
    gender          INTEGER NOT NULL DEFAULT 0,   -- 0未知 1男 2女
    birth_year      INTEGER,
    height_cm       REAL,
    weight_kg       REAL,
    activity_level  TEXT    NOT NULL DEFAULT 'light', -- sedentary/light/moderate/active/very_active
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 营养素字典（对齐 USDA FoodData Central nutrient）
CREATE TABLE IF NOT EXISTS nutrient (
    id              INTEGER PRIMARY KEY,
    fdc_nutrient_id INTEGER,
    number          TEXT,            -- 208 / 203 / 204 / 205 ...
    name            TEXT NOT NULL,
    name_zh         TEXT,
    unit            TEXT NOT NULL,
    category        INTEGER NOT NULL DEFAULT 1,      -- 1宏量 2维生素 3矿物质 4其他
    rank            INTEGER DEFAULT 0,
    is_daily_value  INTEGER DEFAULT 0
);

-- 食物表
CREATE TABLE IF NOT EXISTS food (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT    NOT NULL,
    name_zh              TEXT,
    brand                TEXT,
    barcode              TEXT,
    category             TEXT,
    source               TEXT    NOT NULL DEFAULT 'seed',  -- usda/user/seed
    data_type            TEXT    NOT NULL DEFAULT 'Custom',
    default_serving_size REAL    NOT NULL DEFAULT 100,
    default_serving_unit TEXT    NOT NULL DEFAULT 'g',
    household_serving    TEXT,                              -- 如 "1碗≈150g"
    energy_kcal_100g     REAL,                              -- 冗余热字段，用于排序/搜索
    created_by           INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_food_name ON food(name_zh);
CREATE INDEX IF NOT EXISTS idx_food_barcode ON food(barcode);

-- 食物-营养素长表，值语义 = 每 100 基准单位（g/ml）
CREATE TABLE IF NOT EXISTS food_nutrient (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    food_id         INTEGER NOT NULL REFERENCES food(id) ON DELETE CASCADE,
    nutrient_id     INTEGER NOT NULL REFERENCES nutrient(id),
    amount_per_100g REAL    NOT NULL DEFAULT 0,
    unit            TEXT,
    UNIQUE (food_id, nutrient_id)
);
CREATE INDEX IF NOT EXISTS idx_fn_food ON food_nutrient(food_id);

-- 食物份量换算（1碗/1个 = 多少克）
CREATE TABLE IF NOT EXISTS food_portion (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    food_id     INTEGER NOT NULL REFERENCES food(id) ON DELETE CASCADE,
    amount      REAL    NOT NULL,
    unit        TEXT    NOT NULL,     -- 碗/个/杯
    gram_weight REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_food ON food_portion(food_id);

-- 营养目标
CREATE TABLE IF NOT EXISTS goal (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    goal_type          TEXT    NOT NULL DEFAULT 'maintain', -- fat_loss/muscle_gain/maintain
    calories_kcal      REAL    NOT NULL,
    protein_g          REAL    NOT NULL,
    fat_g              REAL    NOT NULL,
    carbs_g            REAL    NOT NULL,
    fiber_g            REAL,
    water_ml           INTEGER,
    is_active          INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goal_active ON goal(user_id, is_active);

-- 饮食记录（含宏量营养素快照）
CREATE TABLE IF NOT EXISTS meal_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    log_date     TEXT    NOT NULL,      -- YYYY-MM-DD
    meal_type    TEXT    NOT NULL,      -- breakfast/lunch/dinner/snack
    food_id      INTEGER REFERENCES food(id) ON DELETE SET NULL,
    food_name    TEXT    NOT NULL,      -- 快照，防源数据删除
    amount       REAL    NOT NULL,
    unit         TEXT    NOT NULL,
    gram_weight  REAL    NOT NULL,      -- 归一化克重
    calories_kcal REAL   NOT NULL DEFAULT 0,
    protein_g    REAL    NOT NULL DEFAULT 0,
    fat_g        REAL    NOT NULL DEFAULT 0,
    carbs_g      REAL    NOT NULL DEFAULT 0,
    fiber_g      REAL    NOT NULL DEFAULT 0,
    sodium_mg    REAL    NOT NULL DEFAULT 0,
    note         TEXT,
    client_uuid  TEXT,                  -- 离线同步幂等键
    logged_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meallog_user_date ON meal_log(user_id, log_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meallog_client_uuid
    ON meal_log(user_id, client_uuid) WHERE client_uuid IS NOT NULL;

-- 饮水记录
CREATE TABLE IF NOT EXISTS water_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    log_date  TEXT    NOT NULL,
    amount_ml INTEGER NOT NULL,
    logged_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_water_user_date ON water_log(user_id, log_date);

-- 体重记录
CREATE TABLE IF NOT EXISTS weight_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    log_date    TEXT    NOT NULL,
    weight_kg   REAL    NOT NULL,
    body_fat_pct REAL,
    UNIQUE (user_id, log_date)
);

-- ============================================================
-- MySQL/PostgreSQL 迁移差异说明：
-- 1) INTEGER PRIMARY KEY AUTOINCREMENT -> BIGSERIAL PRIMARY KEY
-- 2) REAL  -> NUMERIC(10,2) / DOUBLE PRECISION
-- 3) TEXT 时间 -> TIMESTAMPTZ，default now()
-- 4) 部分索引 WHERE 语法 PG 支持，MySQL 不支持（需改为普通索引）
-- 5) 模糊查询：SQLite 用 LIKE；PG 建议 pg_trgm + GIN 索引
-- ============================================================
