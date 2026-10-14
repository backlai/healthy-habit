# 健康饮食 App 系统架构与后端 API 设计文档

版本：v1.0（对应 PRD v1.0 MVP）
范围：整体架构、技术选型理由、RESTful API 设计、鉴权与安全

---

## 1. 整体架构

### 1.1 架构分层

```
┌──────────────────────────────────────────────────────────────┐
│                        客户端层 (Client)                       │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  │
│  │ 移动端 App      │  │ 移动端 App      │  │ Web 端          │  │
│  │ (Flutter iOS)  │  │ (Flutter Andr.) │  │ (React + Vite)  │  │
│  └────────┬───────┘  └────────┬───────┘  └────────┬───────┘  │
│           │ 本地 SQLite 缓存 + 离线同步队列          │           │
└───────────┼───────────────────┼──────────────────┼───────────┘
            │            HTTPS / TLS 1.3            │
            └───────────────────┬──────────────────┘
                                ▼
        ┌──────────────────────────────────────────────┐
        │              API 网关 (Gateway)                │
        │  · 路由转发    · JWT 校验     · 限流/熔断       │
        │  · 请求日志    · TLS 终止     · 版本控制 /v1    │
        └───────────────────┬──────────────────────────┘
                            │ 内部服务间调用 (gRPC / HTTP)
   ┌──────────┬─────────────┼─────────────┬──────────────┬──────────┐
   ▼          ▼             ▼             ▼              ▼          ▼
┌────────┐┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐┌──────────┐
│ 用户    ││ 食物    │  │ 膳食记录  │  │ 营养统计  │  │ 建议引擎  ││ 饮水/体重 │
│ 服务    ││ 营养    │  │ 服务      │  │ 服务      │  │ 服务      ││ 服务      │
│User    ││ Food   │  │ Meal     │  │ Analytics│  │ Advisor  ││ Tracker  │
│Service ││ Service│  │ Service  │  │ Service  │  │ Service  ││ Service  │
└───┬────┘└───┬────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘└────┬─────┘
    │         │            │             │             │           │
    └─────────┴────────────┴─────────────┴─────────────┴───────────┘
                                │
        ┌───────────────────────┼───────────────────────────┐
        ▼                       ▼                           ▼
┌───────────────┐      ┌───────────────┐          ┌──────────────────┐
│ PostgreSQL    │      │ Redis         │          │ 对象存储 (S3/OSS) │
│ 主数据库       │      │ 缓存 / 会话    │          │ 食物图片 / 头像    │
│ (主从 + 只读副本)│      │ + 限流计数     │          │                  │
└───────────────┘      └───────────────┘          └──────────────────┘

        ┌──────────────────────────────────────────────────┐
        │              第三方服务 (External)                  │
        │  · 营养数据服务 (USDA / Open Food Facts / 自建库)    │
        │  · 条码/图片识别 API（视觉 API）                     │
        │  · OAuth 第三方登录（微信 / Apple / Google）         │
        │  · 推送服务 (FCM / APNs) — 饮水与用餐提醒            │
        └──────────────────────────────────────────────────┘
```

### 1.2 数据流示例（一次「添加饮食记录」）

1. App 离线优先：先写本地 SQLite，入同步队列。
2. 有网时 POST `/v1/meal-records` → API 网关校验 JWT。
3. 网关路由至 **Meal Service**；需食物营养快照时同步调用 **Food Service**（命中 Redis 则直返）。
4. Meal Service 将记录写入 PostgreSQL，返回 `201 Created`。
5. **Analytics Service** 异步（消息队列）重算当日营养汇总，失效对应 Redis 缓存键。
6. 客户端本地队列标记已同步；冲突以 `updated_at` 最新为准。

---

## 2. 技术选型与理由

| 层 | 选型 | 理由 |
|---|---|---|
| 移动端 | **Flutter** | 一套代码 iOS/Android；UI 一致性高，适合数据可视化；性能满足图表渲染 |
| Web 端 | **React + Vite** | 生态成熟，构建快，可复用同一套 REST API 与设计系统 |
| 本地存储 | **SQLite (Drift/sqflite)** | 支持结构化离线缓存 + 同步队列，事务可靠 |
| 后端框架 | **NestJS (Node.js)** | 模块化贴合微服务拆分；TypeScript 类型安全；生态与文档完善 |
| 备选后端 | **FastAPI (Python)** | 若营养算法/数据分析用 Python 生态更便捷 |
| 数据库 | **PostgreSQL 15+** | 关系型强一致（用户/记录/目标）；JSONB 存灵活营养字段；全文检索满足 MVP 食物搜索 |
| 缓存 | **Redis 7** | 热点食物查询加速、会话/限流计数；降低主库压力，保障 P95 < 500ms |
| 搜索 | PG 全文检索 → **Elasticsearch** | MVP 用 PG 降复杂度；数据量上行后再引入 ES 支持别名/拼音/模糊 |
| 消息队列 | **RabbitMQ / Redis Streams** | 统计聚合、建议生成异步化，解耦写路径 |
| 对象存储 | **S3 / 阿里云 OSS** | 存食物图片与用户上传，按需 CDN 加速 |
| 认证 | **JWT (Access) + Refresh Token** | 无状态易横向扩展；短期 Access 降泄露风险；OAuth 支持第三方登录 |
| 部署 | **Docker + Kubernetes** | 灰度发布、弹性扩缩；MVP 亦可 Serverless 起步 |
| 监控 | **Sentry + Prometheus/Grafana** | 错误追踪 + 性能指标，支撑崩溃率与 P95 监控 |

---

## 3. 通用约定

- **Base URL**：`https://api.healthdiet.app/v1`
- **协议**：HTTPS / TLS 1.3
- **请求格式**：`Content-Type: application/json; charset=utf-8`
- **鉴权**：`Authorization: Bearer <access_token>`
- **时间格式**：ISO 8601 UTC，如 `2025-10-03T08:30:00Z`
- **分页**：`?page=1&page_size=20`，响应含 `pagination`
- **幂等**：写接口支持 `Idempotency-Key` 请求头（离线重试防重复）
- **字段命名**：`snake_case`

### 3.1 统一响应结构

成功：
```json
{
  "code": 0,
  "message": "ok",
  "data": { },
  "request_id": "req_9f1c2a7b"
}
```

失败：
```json
{
  "code": 2003,
  "message": "食物不存在",
  "data": null,
  "request_id": "req_9f1c2a7b"
}
```

### 3.2 HTTP 状态码

| HTTP | 含义 |
|---|---|
| 200 | 成功（查询/更新） |
| 201 | 创建成功 |
| 204 | 删除成功，无响应体 |
| 400 | 参数校验失败 |
| 401 | 未认证 / Token 失效 |
| 403 | 无权限访问该资源 |
| 404 | 资源不存在 |
| 409 | 冲突（重复/版本冲突） |
| 422 | 业务规则不满足 |
| 429 | 触发限流 |
| 500 | 服务器内部错误 |
| 503 | 服务暂不可用（重试） |

### 3.3 业务错误码

| 业务码 | 说明 |
|---|---|
| 0 | 成功 |
| 1001 | 手机号/邮箱格式错误 |
| 1002 | 验证码错误或过期 |
| 1003 | 账号已存在 |
| 1004 | 账号或密码错误 |
| 1005 | 账号被禁用 |
| 2001 | 搜索关键词为空/过短 |
| 2002 | 搜索无结果 |
| 2003 | 食物不存在 |
| 3001 | 餐次类型非法 |
| 3002 | 份量数值非法 |
| 3003 | 记录不存在或无权限 |
| 3004 | 记录版本冲突 |
| 4001 | 目标参数超出合理范围 |
| 5001 | 数据不足以生成建议 |
| 6001 | 饮水/体重数值超出范围 |
| 9001 | 第三方营养数据服务不可用 |
| 9002 | 请求过于频繁 |

---

## 4. RESTful API 设计

### 4.1 认证与用户

#### 4.1.1 用户注册
- **POST** `/v1/auth/register`
- **请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| phone | string | 是 | 手机号（或 email） |
| password | string | 是 | 8–32 位，需含字母数字 |
| verify_code | string | 是 | 短信/邮箱验证码 |
| nickname | string | 否 | 昵称 |

请求示例：
```json
{
  "phone": "13800138000",
  "password": "Aa12345678",
  "verify_code": "4821",
  "nickname": "小明"
}
```

响应 `201`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "user_id": "u_1024",
    "nickname": "小明",
    "phone": "138****8000",
    "created_at": "2025-10-03T08:30:00Z",
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "rt_7c2f...",
    "expires_in": 7200
  },
  "request_id": "req_9f1c2a7b"
}
```

错误：`409 / 1003`（账号已存在）、`400 / 1001`（格式错误）、`400 / 1002`（验证码错误）

#### 4.1.2 用户登录
- **POST** `/v1/auth/login`
- 请求体：`{ "phone": "13800138000", "password": "Aa12345678" }`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "user_id": "u_1024",
    "access_token": "eyJ...",
    "refresh_token": "rt_7c2f...",
    "expires_in": 7200,
    "token_type": "Bearer"
  },
  "request_id": "req_9f1c2a7b"
}
```
错误：`401 / 1004`

#### 4.1.3 刷新 Token
- **POST** `/v1/auth/refresh`
- 请求体：`{ "refresh_token": "rt_7c2f..." }`
- 响应 `200`：返回新的 `access_token` 与 `refresh_token`（旋转刷新，旧的作废）。错误 `401`。

#### 4.1.4 第三方登录
- **POST** `/v1/auth/oauth/{provider}`（provider: `wechat` | `apple` | `google`）
- 请求体：`{ "code": "oauth_authorization_code" }`
- 响应同登录；首次登录自动建号并返回 `is_new_user: true`。

#### 4.1.5 获取当前用户资料
- **GET** `/v1/users/me`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "user_id": "u_1024",
    "nickname": "小明",
    "gender": "male",
    "birth_year": 1995,
    "height_cm": 175,
    "weight_kg": 70.5,
    "activity_level": "moderate",
    "unit_preference": "metric",
    "created_at": "2025-10-03T08:30:00Z"
  },
  "request_id": "req_9f1c2a7b"
}
```

#### 4.1.6 更新用户资料
- **PATCH** `/v1/users/me`
- 请求体（部分更新）：`{ "height_cm": 175, "weight_kg": 70.5, "activity_level": "moderate" }`
- 响应 `200` 返回更新后的资料。错误 `400`（参数非法）。

---

### 4.2 食物营养查询

#### 4.2.1 搜索食物
- **GET** `/v1/foods/search?keyword=鸡胸肉&page=1&page_size=20`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| keyword | string | 是 | 食物名称/别名，≥1 字符 |
| category | string | 否 | 分类过滤，如 `meat` |
| page | int | 否 | 默认 1 |
| page_size | int | 否 | 默认 20，最大 50 |

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "food_id": "f_2001",
        "name": "鸡胸肉（生）",
        "aliases": ["鸡脯肉", "chicken breast"],
        "image_url": "https://cdn.healthdiet.app/foods/f_2001.jpg",
        "nutrition_per_100g": {
          "calories_kcal": 133,
          "protein_g": 24.6,
          "fat_g": 1.9,
          "carbs_g": 2.5,
          "fiber_g": 0,
          "sodium_mg": 44
        },
        "common_units": [
          { "unit": "克", "grams": 1 },
          { "unit": "块", "grams": 120 }
        ]
      }
    ],
    "pagination": { "page": 1, "page_size": 20, "total": 1 }
  },
  "request_id": "req_9f1c2a7b"
}
```
错误：`400 / 2001`、`404 / 2002`

#### 4.2.2 获取食物详情
- **GET** `/v1/foods/{food_id}`
- 响应 `200` 返回完整营养信息；错误 `404 / 2003`。

#### 4.2.3 按条码查询
- **GET** `/v1/foods/barcode/{barcode}`
- 响应 `200` 同食物详情；第三方不可用时返回 `503 / 9001`。

---

### 4.3 饮食记录

#### 4.3.1 添加饮食记录
- **POST** `/v1/meal-records`
- **Headers**：`Authorization: Bearer <token>`、可选 `Idempotency-Key`
- 请求体

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| record_date | string(date) | 是 | 所属日期 `2025-10-03` |
| meal_type | string | 是 | `breakfast`/`lunch`/`dinner`/`snack` |
| eaten_at | string(datetime) | 否 | 实际就餐时间 |
| food_id | string | 否 | 引用食物库（与 custom_food 二选一） |
| quantity | number | 是 | 份量数值 |
| unit | string | 是 | `g`/`ml`/`serving`/`bowl`/`piece` |
| custom_food | object | 否 | 自定义食物营养 |
| note | string | 否 | 备注，如「外卖」 |
| client_uuid | string | 否 | 客户端本地 ID，用于去重 |

请求示例：
```json
{
  "record_date": "2025-10-03",
  "meal_type": "lunch",
  "eaten_at": "2025-10-03T12:15:00Z",
  "food_id": "f_2001",
  "quantity": 150,
  "unit": "g",
  "note": "自己做的",
  "client_uuid": "local_5f3a-20251003-1215"
}
```

响应 `201`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "record_id": "r_88001",
    "record_date": "2025-10-03",
    "meal_type": "lunch",
    "food": { "food_id": "f_2001", "name": "鸡胸肉（生）" },
    "quantity": 150,
    "unit": "g",
    "nutrition": {
      "calories_kcal": 199.5,
      "protein_g": 36.9,
      "fat_g": 2.85,
      "carbs_g": 3.75,
      "fiber_g": 0,
      "sodium_mg": 66
    },
    "created_at": "2025-10-03T12:16:03Z",
    "updated_at": "2025-10-03T12:16:03Z"
  },
  "request_id": "req_9f1c2a7b"
}
```
错误：`400 / 3001`（餐次非法）、`400 / 3002`（份量非法）、`404 / 2003`（食物不存在）、`409`（`client_uuid` 重复，幂等返回已存在记录）

#### 4.3.2 查询某日饮食记录
- **GET** `/v1/meal-records?date=2025-10-03&meal_type=lunch`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "date": "2025-10-03",
    "meals": [
      {
        "meal_type": "lunch",
        "records": [
          {
            "record_id": "r_88001",
            "food_id": "f_2001",
            "name": "鸡胸肉（生）",
            "quantity": 150,
            "unit": "g",
            "nutrition": { "calories_kcal": 199.5, "protein_g": 36.9, "fat_g": 2.85, "carbs_g": 3.75 }
          }
        ]
      }
    ]
  },
  "request_id": "req_9f1c2a7b"
}
```

#### 4.3.3 修改饮食记录
- **PATCH** `/v1/meal-records/{record_id}`
- 请求体：`{ "quantity": 200, "unit": "g", "note": "加量" }`
- 响应 `200` 返回更新后记录。错误 `404 / 3003`、`409 / 3004`（版本冲突，响应返回服务端最新数据）。

#### 4.3.4 删除饮食记录
- **DELETE** `/v1/meal-records/{record_id}`
- 响应 `204` 无体。错误 `404 / 3003`。

#### 4.3.5 复制某日记录
- **POST** `/v1/meal-records/copy`
- 请求体：`{ "from_date": "2025-10-02", "to_date": "2025-10-03" }`
- 响应 `201`：`{ "data": { "copied_count": 5 } }`

---

### 4.4 每日营养摄入统计

#### 4.4.1 获取某日营养汇总
- **GET** `/v1/nutrition/daily?date=2025-10-03`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "date": "2025-10-03",
    "target": {
      "calories_kcal": 2000,
      "protein_g": 110,
      "fat_g": 60,
      "carbs_g": 275
    },
    "intake": {
      "calories_kcal": 1680.5,
      "protein_g": 95.2,
      "fat_g": 52.4,
      "carbs_g": 210.8,
      "fiber_g": 14.3,
      "sodium_mg": 1850
    },
    "energy_ratio": { "protein_pct": 22.7, "fat_pct": 28.1, "carbs_pct": 49.2 },
    "progress_pct": 84.0,
    "by_meal": [
      { "meal_type": "breakfast", "calories_kcal": 420.0 },
      { "meal_type": "lunch", "calories_kcal": 650.5 },
      { "meal_type": "dinner", "calories_kcal": 480.0 },
      { "meal_type": "snack", "calories_kcal": 130.0 }
    ],
    "tips": ["今天蔬菜摄入偏少，可以再加一份绿叶菜", "钠摄入接近上限，晚餐注意少放盐"]
  },
  "request_id": "req_9f1c2a7b"
}
```

#### 4.4.2 趋势查询
- **GET** `/v1/nutrition/trends?start=2025-09-27&end=2025-10-03&metric=calories_kcal&granularity=day`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "metric": "calories_kcal",
    "granularity": "day",
    "points": [
      { "date": "2025-09-27", "value": 1900.0 },
      { "date": "2025-09-28", "value": 2050.5 },
      { "date": "2025-09-29", "value": 1780.0 }
    ],
    "average": 1910.2
  },
  "request_id": "req_9f1c2a7b"
}
```

---

### 4.5 营养目标设置

#### 4.5.1 获取目标
- **GET** `/v1/goals/current`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "goal_id": "g_301",
    "goal_type": "fat_loss",
    "calories_kcal": 1800,
    "protein_g": 120,
    "fat_g": 50,
    "carbs_g": 200,
    "water_ml": 2000,
    "source": "system_recommended",
    "updated_at": "2025-10-01T09:00:00Z"
  },
  "request_id": "req_9f1c2a7b"
}
```

#### 4.5.2 设置/更新目标
- **PUT** `/v1/goals/current`
- 请求体：
```json
{
  "goal_type": "fat_loss",
  "calories_kcal": 1800,
  "protein_g": 120,
  "fat_g": 50,
  "carbs_g": 200,
  "water_ml": 2000
}
```
- 响应 `200` 返回生效目标。错误 `400 / 4001`（如热量 < 1000 或 > 6000）。

#### 4.5.3 系统推荐目标（基于个人信息）
- **GET** `/v1/goals/recommended?goal_type=fat_loss`
- 响应 `200` 返回按 Mifflin-St Jeor 公式估算的能量与三大营养素建议值（附 `disclaimer` 字段）。

---

### 4.6 饮食建议

#### 4.6.1 获取个性化建议
- **GET** `/v1/advice?range=7d`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "range": "7d",
    "generated_at": "2025-10-03T08:00:00Z",
    "cards": [
      {
        "advice_id": "a_501",
        "category": "vegetable_intake",
        "title": "蔬菜吃得有点少",
        "reason": "近 7 天平均每天蔬菜约 180g，低于建议的 300g",
        "action": "今天午餐加一份清炒西兰花（约 150g）",
        "severity": "medium"
      },
      {
        "advice_id": "a_502",
        "category": "late_dinner",
        "title": "晚餐时间偏晚",
        "reason": "近 7 天有 4 天晚餐在 21:00 之后",
        "action": "试着把晚餐提前到 19:30 前",
        "severity": "low"
      }
    ],
    "disclaimer": "以上建议仅供日常参考，不构成医疗或专业营养诊疗建议。"
  },
  "request_id": "req_9f1c2a7b"
}
```
错误：`422 / 5001`（数据不足，如记录天数 < 2）

---

### 4.7 饮水记录

#### 4.7.1 记录饮水
- **POST** `/v1/water-records`
- 请求体：`{ "date": "2025-10-03", "amount_ml": 250, "recorded_at": "2025-10-03T10:00:00Z", "cup_type": "cup" }`

响应 `201`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "water_record_id": "w_701",
    "date": "2025-10-03",
    "amount_ml": 250,
    "total_ml": 1250,
    "target_ml": 2000,
    "progress_pct": 62.5
  },
  "request_id": "req_9f1c2a7b"
}
```
错误：`400 / 6001`（数值非法，如 amount ≤ 0 或 > 3000）

#### 4.7.2 查询某日饮水
- **GET** `/v1/water-records?date=2025-10-03`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "date": "2025-10-03",
    "total_ml": 1250,
    "target_ml": 2000,
    "progress_pct": 62.5,
    "records": [
      { "water_record_id": "w_701", "amount_ml": 250, "recorded_at": "2025-10-03T10:00:00Z" }
    ]
  },
  "request_id": "req_9f1c2a7b"
}
```

#### 4.7.3 删除饮水记录
- **DELETE** `/v1/water-records/{water_record_id}` → `204`

---

### 4.8 体重记录

#### 4.8.1 新增体重记录
- **POST** `/v1/weight-records`
- 请求体：
```json
{
  "weight_kg": 70.2,
  "body_fat_pct": 18.5,
  "measured_at": "2025-10-03T07:30:00Z"
}
```

响应 `201`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "weight_record_id": "wt_901",
    "weight_kg": 70.2,
    "body_fat_pct": 18.5,
    "measured_at": "2025-10-03T07:30:00Z",
    "bmi": 22.9
  },
  "request_id": "req_9f1c2a7b"
}
```
错误：`400 / 6001`（体重超出 20–300kg 或体脂 0–70%）

#### 4.8.2 查询体重趋势
- **GET** `/v1/weight-records?start=2025-09-01&end=2025-10-03&granularity=day`

响应 `200`：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "points": [
      { "measured_at": "2025-09-01T07:30:00Z", "weight_kg": 72.0, "bmi": 23.5 },
      { "measured_at": "2025-10-03T07:30:00Z", "weight_kg": 70.2, "bmi": 22.9 }
    ],
    "change_kg": -1.8,
    "trend": "down"
  },
  "request_id": "req_9f1c2a7b"
}
```

#### 4.8.3 删除体重记录
- **DELETE** `/v1/weight-records/{weight_record_id}` → `204`

---

### 4.9 数据导出与账号删除（隐私合规）

| 接口 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 导出数据 | POST | `/v1/users/me/export` | 异步生成，返回 `task_id`，完成后提供下载链接（72h 有效） |
| 查询导出状态 | GET | `/v1/users/me/export/{task_id}` | 返回 `pending`/`done`/`failed` 与 `download_url` |
| 删除账号 | DELETE | `/v1/users/me` | 请求体 `{ "password": "***", "confirm": "DELETE" }`，软删后 30 天彻底清除 |

---

## 5. 鉴权方案

### 5.1 JWT 双 Token 机制

- **Access Token**：JWT，有效期 **2 小时**，无状态校验（网关验签）。
  - Payload 示例：
    ```json
    {
      "sub": "u_1024",
      "iat": 1759480200,
      "exp": 1759487400,
      "scope": "user",
      "jti": "at_7c2f"
    }
    ```
- **Refresh Token**：随机不透明串，有效期 **30 天**，服务端存储（Redis），**一次性旋转**：刷新时旧 token 立即失效，防重放。
- **签名算法**：`HS256`（单体/小规模）或 **`RS256`**（微服务，网关持公钥验签，业务服务不接触密钥）。
- **存储**：客户端存于 **Keychain（iOS）/ EncryptedSharedPreferences（Android）**，Web 用 **HttpOnly + Secure + SameSite=Strict Cookie**（勿存 localStorage）。

### 5.2 权限模型
- **RBAC**：`user`（默认）/ `admin`（内容运营，管理食物库）。
- 所有用户数据接口以 `sub`（用户 ID）为数据域边界，服务端**强制按用户过滤**，不信任前端传入的用户标识。

### 5.3 网关鉴权流程
1. 校验 `Authorization` 头存在且为 `Bearer`。
2. 验签（RS256 公钥）+ 校验 `exp`/`nbf`/`iss`/`aud`。
3. 注入 `X-User-Id: u_1024` 到内部请求头（**内部网络隔离，外部禁止传入**）。
4. 失败返回 `401`，并附 `WWW-Authenticate: Bearer error="invalid_token"`。

---

## 6. 安全注意事项

| 类别 | 措施 |
|---|---|
| 传输安全 | 全站 HTTPS/TLS 1.3；HSTS；禁明文 HTTP |
| 密码存储 | **Argon2id**（或 bcrypt cost ≥ 12）加盐哈希，禁止明文/可逆加密 |
| 敏感数据 | 体重/体脂等加密存储（列级 AES-256-GCM，密钥用 KMS 托管） |
| 数据隔离 | 服务端按 `user_id` 强过滤；禁止横向越权（IDOR），每次访问校验归属 |
| 输入校验 | 白名单校验（参数类型/范围/枚举）；防 SQL 注入用参数化查询/ORM |
| 限流防刷 | 网关按 IP + 用户 ID 限流；登录/验证码接口更严格（如 5 次/分钟），超限 `429 / 9002` |
| 防重放 | 写接口支持 `Idempotency-Key`；Refresh Token 一次性旋转；JWT 含 `jti` 可黑名单 |
| 日志脱敏 | 日志中手机号、Token 脱敏；禁止记录密码与完整身份证类信息 |
| CORS | 仅允许白名单来源；不使用通配符 `*` |
| 第三方调用 | 出网调用营养/视觉 API 使用独立凭证与超时熔断；密钥存于 Secret Manager，不入库不入代码 |
| 隐私合规 | 最小化采集；提供导出与删除；上线前完成个人信息保护法/GDPR 评审 |
| 依赖安全 | 定期扫描依赖漏洞（Dependabot/Trivy）；镜像最小化 |
| 审计 | 账号删除、数据导出等敏感操作记录审计日志（可追溯） |

---

## 7. 离线同步与冲突处理

- 客户端对写操作生成 `client_uuid`，服务端以其为幂等键。
- 同步顺序：本地队列按 `created_at` 升序推送。
- 冲突策略：同一条记录以 `updated_at` 较新者为准；服务端返回 `409 / 3004` 时客户端拉取服务端最新快照覆盖本地。
- 缓存失效：写成功后由 Analytics Service 失效对应 `nutrition:daily:{user_id}:{date}` 与趋势缓存键。

---

## 8. 免责声明
本文档接口示例中的营养数值、目标值均为演示数据。产品提供的营养估算与建议仅供日常参考，不构成医疗或专业营养诊疗建议。
