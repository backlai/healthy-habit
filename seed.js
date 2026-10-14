/**
 * 种子数据：营养素字典 + 常见食物（每 100g 营养值）
 * 数据来源参考 USDA FoodData Central（实测字段：foodNutrients[].nutrient.id/amount）
 * 及中国食物成分表常见值，仅用于演示。
 */
const { db, initSchema } = require('./index');

// ---- 营养素字典（对齐 USDA nutrient id/number）----
const NUTRIENTS = [
  { id: 1008, fdc: 1008, number: '208', name: 'Energy',                  name_zh: '热量',     unit: 'kcal', category: 1, rank: 300   },
  { id: 1003, fdc: 1003, number: '203', name: 'Protein',                 name_zh: '蛋白质',    unit: 'g',    category: 1, rank: 600   },
  { id: 1004, fdc: 1004, number: '204', name: 'Total lipid (fat)',       name_zh: '脂肪',     unit: 'g',    category: 1, rank: 800   },
  { id: 1005, fdc: 1005, number: '205', name: 'Carbohydrate, by diff.',  name_zh: '碳水化合物', unit: 'g',    category: 1, rank: 1110  },
  { id: 1079, fdc: 1079, number: '291', name: 'Fiber, total dietary',    name_zh: '膳食纤维',   unit: 'g',    category: 1, rank: 1200  },
  { id: 1093, fdc: 1093, number: '307', name: 'Sodium, Na',             name_zh: '钠',       unit: 'mg',   category: 3, rank: 5800  },
  { id: 1087, fdc: 1087, number: '301', name: 'Calcium, Ca',            name_zh: '钙',       unit: 'mg',   category: 3, rank: 5300  },
  { id: 1089, fdc: 1089, number: '303', name: 'Iron, Fe',               name_zh: '铁',       unit: 'mg',   category: 3, rank: 5400  }
];

// ---- 食物（营养值均为每 100g）----
// [名称, 分类, 热量, 蛋白, 脂肪, 碳水, 纤维, 钠mg, 钙mg, 铁mg, 常见份量]
const FOODS = [
  ['鸡胸肉（生）',   'meat',    133, 24.6,  1.9,  2.5, 0.0,  44, 15,  0.7, [['块', 120], ['份', 100]]],
  ['白米饭（熟）',   'staple',  116,  2.6,  0.3, 25.9, 0.3,   2, 10,  0.3, [['碗', 200], ['小碗', 150]]],
  ['全麦面包',       'staple',  247, 13.0,  3.4, 41.0, 7.0, 400, 107, 2.5, [['片', 35]]],
  ['鸡蛋（煮）',     'protein', 155, 13.0, 11.0,  1.1, 0.0, 124, 50,  1.2, [['个', 50]]],
  ['牛奶（全脂）',   'dairy',    61,  3.2,  3.3,  4.8, 0.0,  43, 113, 0.1, [['杯', 250]]],
  ['西兰花',         'veg',      34,  2.8,  0.4,  6.6, 2.6,  33, 47,  0.7, [['份', 150], ['朵', 20]]],
  ['菠菜',           'veg',      23,  2.9,  0.4,  3.6, 2.2,  79, 99,  2.7, [['份', 150]]],
  ['番茄',           'veg',      18,  0.9,  0.2,  3.9, 1.2,   5, 10,  0.3, [['个', 150]]],
  ['苹果',           'fruit',    52,  0.3,  0.2, 13.8, 2.4,   1,  6,  0.1, [['个', 182]]],
  ['香蕉',           'fruit',    89,  1.1,  0.3, 22.8, 2.6,   1,  5,  0.3, [['根', 120]]],
  ['三文鱼',         'seafood', 208, 20.4, 13.4,  0.0, 0.0,  59,  9,  0.3, [['块', 150]]],
  ['豆腐（北）',     'protein',  98, 12.2,  4.8,  1.5, 0.5,   7, 138, 1.5, [['块', 100]]],
  ['燕麦片（干）',   'staple',  389, 16.9,  6.9, 66.3,10.6,   2, 54,  4.7, [['份', 40]]],
  ['花生（炒）',     'snack',   589, 24.1, 48.0, 21.5, 7.6,   6, 47,  1.5, [['把', 30]]],
  ['可乐（含糖）',   'drink',     43,  0.0,  0.0, 10.6, 0.0,   4,  2,  0.1, [['罐', 330]]],
  ['清炒时蔬',       'dish',      72,  2.5,  5.0,  5.0, 2.0, 300, 45,  0.8, [['份', 200]]],
  ['红烧肉',         'dish',     472, 12.0, 45.0,  6.0, 0.0, 550, 12,  1.0, [['份', 150]]],
  ['炸鸡（裹粉）',   'dish',     289, 18.0, 18.0, 14.0, 0.8, 700, 20,  1.1, [['块', 100]]]
];

function seed() {
  initSchema();
  const tx = db.transaction(() => {
    // 营养素质字典 upsert
    const insN = db.prepare(`INSERT OR REPLACE INTO nutrient
      (id, fdc_nutrient_id, number, name, name_zh, unit, category, rank, is_daily_value)
      VALUES (@id, @fdc, @number, @name, @name_zh, @unit, @category, @rank, 1)`);
    NUTRIENTS.forEach(n => insN.run(n));

    // 食物 + 营养值 + 份量
    const insF = db.prepare(`INSERT INTO food
      (name, name_zh, category, source, data_type, energy_kcal_100g)
      VALUES (@name, @name, @category, 'seed', 'Foundation', @energy)`);
    const insFN = db.prepare(`INSERT INTO food_nutrient (food_id, nutrient_id, amount_per_100g, unit)
      VALUES (?, ?, ?, ?)`);
    const insFP = db.prepare(`INSERT INTO food_portion (food_id, amount, unit, gram_weight)
      VALUES (?, 1, ?, ?)`);
    const findF = db.prepare('SELECT id FROM food WHERE name = ?');
    const unitOf = id => NUTRIENTS.find(n => n.id === id).unit;

    for (const f of FOODS) {
      const [name, category, kcal, protein, fat, carbs, fiber, sodium, calcium, iron, portions] = f;
      if (findF.get(name)) continue;   // 已存在则跳过（幂等）
      const { lastInsertRowid: fid } = insF.run({ name, category, energy: kcal });
      const vals = [[1008, kcal], [1003, protein], [1004, fat], [1005, carbs],
                    [1079, fiber], [1093, sodium], [1087, calcium], [1089, iron]];
      for (const [nid, amount] of vals) insFN.run(fid, nid, amount, unitOf(nid));
      for (const [unit, grams] of portions) insFP.run(fid, unit, grams);
    }
  });
  tx();

  const foodCount = db.prepare('SELECT COUNT(*) c FROM food').get().c;
  const nutCount  = db.prepare('SELECT COUNT(*) c FROM nutrient').get().c;
  console.log(`✅ 种子数据完成：${nutCount} 种营养素，${foodCount} 种食物`);
}

if (require.main === module) seed();
module.exports = { seed, NUTRIENTS, FOODS };