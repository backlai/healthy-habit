/**
 * 用户服务：注册 / 登录 / 资料 / 目标推荐
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { JWT_SECRET, ACCESS_TTL } = require('../config');

// 活动系数（用于 Mifflin-St Jeor 计算 TDEE）
const ACTIVITY_FACTOR = {
  sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9
};
// 目标类型 → 热量调整系数
const GOAL_ADJUST = { fat_loss: 0.8, maintain: 1.0, muscle_gain: 1.12 };

/** 生成 JWT access token */
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, scope: 'user' },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

/** 注册：校验唯一性 → 哈希密码 → 入库 → 返回 token */
async function register({ username, password, nickname }) {
  if (!username || !/^[A-Za-z0-9_@.]{3,50}$/.test(username)) {
    throw Object.assign(new Error('用户名格式错误（3-50 位字母/数字/_）'), { code: 1001, http: 400 });
  }
  if (!password || password.length < 8) {
    throw Object.assign(new Error('密码至少 8 位'), { code: 1001, http: 400 });
  }
  const exists = db.prepare('SELECT id FROM app_user WHERE username = ?').get(username);
  if (exists) {
    throw Object.assign(new Error('账号已存在'), { code: 1003, http: 409 });
  }
  // bcrypt 加盐哈希（cost=10，生产建议 12）
  const passwordHash = await bcrypt.hash(password, 10);
  const info = db.prepare(
    'INSERT INTO app_user (username, password_hash, nickname) VALUES (?, ?, ?)'
  ).run(username, passwordHash, nickname || username);

  const user = db.prepare('SELECT id, username, nickname FROM app_user WHERE id = ?')
    .get(info.lastInsertRowid);
  return { user, access_token: signToken(user), expires_in: ACCESS_TTL };
}

/** 登录：比对哈希 → 返回 token（统一错误信息，避免枚举用户名） */
async function login({ username, password }) {
  const row = db.prepare('SELECT * FROM app_user WHERE username = ?').get(username);
  const ok = row && await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    throw Object.assign(new Error('账号或密码错误'), { code: 1004, http: 401 });
  }
  const user = { id: row.id, username: row.username, nickname: row.nickname };
  return { user, access_token: signToken(user), expires_in: ACCESS_TTL };
}

/** 获取用户资料（不返回密码哈希） */
function getProfile(userId) {
  const row = db.prepare(`SELECT id, username, nickname, gender, birth_year,
      height_cm, weight_kg, activity_level, created_at FROM app_user WHERE id = ?`).get(userId);
  if (!row) throw Object.assign(new Error('用户不存在'), { code: 1005, http: 404 });
  return row;
}

/** 更新用户资料（部分更新） */
function updateProfile(userId, patch) {
  const allowed = ['nickname', 'gender', 'birth_year', 'height_cm', 'weight_kg', 'activity_level'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (keys.length === 0) throw Object.assign(new Error('无可更新字段'), { code: 1001, http: 400 });

  // 范围校验
  if (patch.height_cm != null && (patch.height_cm < 50 || patch.height_cm > 250))
    throw Object.assign(new Error('身高超出合理范围(50-250cm)'), { code: 4001, http: 400 });
  if (patch.weight_kg != null && (patch.weight_kg < 20 || patch.weight_kg > 300))
    throw Object.assign(new Error('体重超出合理范围(20-300kg)'), { code: 4001, http: 400 });
  if (patch.activity_level && !ACTIVITY_FACTOR[patch.activity_level])
    throw Object.assign(new Error('活动量取值非法'), { code: 4001, http: 400 });

  const setSql = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE app_user SET ${setSql}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...patch, id: userId });
  return getProfile(userId);
}

/**
 * 系统推荐营养目标
 * 能量：Mifflin-St Jeor → BMR，乘活动系数得 TDEE，再按目标调整
 *   男：BMR = 10*体重(kg) + 6.25*身高(cm) - 5*年龄 + 5
 *   女：BMR = 10*体重(kg) + 6.25*身高(cm) - 5*年龄 - 161
 * 三大营养素分配：脂肪占总热量 25%，蛋白按体重 1.6g/kg（增肌 2.0），余下给碳水
 */
function recommendGoal(userId, goalType = 'maintain') {
  const u = getProfile(userId);
  if (!u.height_cm || !u.weight_kg || !u.birth_year) {
    throw Object.assign(new Error('请先完善身高、体重、出生年份'), { code: 4001, http: 422 });
  }
  const age = new Date().getFullYear() - u.birth_year;
  const isMale = u.gender === 1;
  const bmr = 10 * u.weight_kg + 6.25 * u.height_cm - 5 * age + (isMale ? 5 : -161);
  const tdee = bmr * (ACTIVITY_FACTOR[u.activity_level] || 1.375);
  const calories = Math.round(tdee * (GOAL_ADJUST[goalType] || 1.0));

  // 蛋白：减脂 1.8g/kg，增肌 2.0g/kg，维持 1.6g/kg
  const proteinPerKg = { fat_loss: 1.8, muscle_gain: 2.0, maintain: 1.6 }[goalType] || 1.6;
  const protein = Math.round(u.weight_kg * proteinPerKg);
  const fat = Math.round(calories * 0.25 / 9);          // 脂肪 9 kcal/g
  const carbs = Math.round((calories - protein * 4 - fat * 9) / 4); // 碳水 4 kcal/g

  return {
    goal_type: goalType,
    calories_kcal: calories,
    protein_g: protein,
    fat_g: fat,
    carbs_g: Math.max(carbs, 0),
    fiber_g: 25,
    water_ml: Math.round(u.weight_kg * 30),   // 每 kg 体重约 30ml
    source: 'system_recommended',
    disclaimer: '以上目标为根据身体信息估算的参考值，不构成医疗或专业营养诊疗建议。'
  };
}

/** 保存/更新当前生效目标（同用户旧目标置为非激活） */
function saveGoal(userId, g) {
  // 参数范围校验
  if (!(g.calories_kcal >= 1000 && g.calories_kcal <= 6000))
    throw Object.assign(new Error('热量目标需在 1000-6000 kcal'), { code: 4001, http: 400 });
  if (g.protein_g < 0 || g.fat_g < 0 || g.carbs_g < 0)
    throw Object.assign(new Error('营养素目标不能为负'), { code: 4001, http: 400 });
  if (!['fat_loss', 'muscle_gain', 'maintain'].includes(g.goal_type))
    throw Object.assign(new Error('目标类型非法'), { code: 4001, http: 400 });

  const tx = db.transaction(() => {
    db.prepare('UPDATE goal SET is_active = 0 WHERE user_id = ?').run(userId);
    db.prepare(`INSERT INTO goal
      (user_id, goal_type, calories_kcal, protein_g, fat_g, carbs_g, fiber_g, water_ml, is_active)
      VALUES (@user_id, @goal_type, @calories_kcal, @protein_g, @fat_g, @carbs_g, @fiber_g, @water_ml, 1)`)
      .run({
        user_id: userId,
        goal_type: g.goal_type,
        calories_kcal: g.calories_kcal,
        protein_g: g.protein_g,
        fat_g: g.fat_g,
        carbs_g: g.carbs_g,
        fiber_g: g.fiber_g ?? 25,
        water_ml: g.water_ml ?? 2000
      });
  });
  tx();
  return getGoal(userId);
}

/** 获取当前生效目标；若无则自动用系统推荐值初始化 */
function getGoal(userId) {
  let row = db.prepare('SELECT * FROM goal WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1')
    .get(userId);
  if (!row) {
    const rec = recommendGoal(userId, 'maintain');
    return saveGoal(userId, rec);
  }
  return row;
}

module.exports = { register, login, getProfile, updateProfile, recommendGoal, saveGoal, getGoal, ACTIVITY_FACTOR };