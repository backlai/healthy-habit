/**
 * 数据库访问层（DAO）—— SQLite 版
 * 使用 better-sqlite3：同步 API，示例代码更直观；生产可换 PG/MySQL 连接池。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// 数据库文件路径（可用环境变量覆盖，便于测试使用 :memory:）
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/health_diet.db');

// 确保目录存在
if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // 提升并发读性能
db.pragma('foreign_keys = ON');    // 打开外键约束

/** 初始化表结构（幂等，可重复执行） */
function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(sql);
}

module.exports = { db, initSchema, DB_PATH };
