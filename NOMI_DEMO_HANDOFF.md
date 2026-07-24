# NOMI 出行代理 Demo：当前进度与 MiniMax 接入需求

> 更新时间：2026-07-17
> 项目目录：`/Users/ziyu.lang/Documents/clawbot`  
> 当前状态：前端体验、确定性 Planner、多轮会话解释与 MiniMax 接入已合并到同一 Demo。

## 1. 当前产品闭环

目前已经跑通以下完整流程：

> 为当前对话锁定 Demo Lab 场景 → 多轮输入与修改 → 确认歧义地点 → 调用高德路线与天气 → 计算时间、能耗和主动服务 → 在地图与对话中呈现结果

标准演示语句：

> 明早 8 点送孩子到学校，然后去公司，提前准备一下。

系统会将其理解为“明天 8 点前到达儿子学校”，默认从家出发；到校后停留 5 分钟，再前往我的公司。

## 2. 已完成功能

### 2.1 自然语言与结构化行程

- 已实现 `IntentParser` 可替换接口，当前实现为 `MockIntentParser`。
- 支持今天、明天、后天和星期表达。
- 能区分 `ARRIVE_BY`（几点前到达）与 `DEPART_AT`（几点出发）。
- 支持“从 X 出发、先去 A、再去 B、然后去 C”，最多 3 个目的地。
- 支持收藏别名：家、我的公司、儿子学校、老婆公司。
- 自定义地点不会静默猜测，会请求高德 POI 并展示前三个候选。
- 用户可以在后续对话中修改日期、时间类型、目标时间、起点和途经点，再重新规划。
- 对不确定时间语义返回 `issues`，由用户确认，不静默覆盖。
- 首轮继续使用行程解析器；后续轮次可以修改日期、起点、时间约束、站点顺序和主动备车偏好，也可以只询问当前计划事实。
- 每个会话独立保留消息、待确认意图、当前成功计划和最新路线，切换会话不会串写请求结果。

### 2.2 高德地图、路线和天气

- 高德 POI 2.0：上海市内关键词搜索，返回前三个候选。
- 高德驾车路径规划 2.0：每一段路线单独算路，返回距离、耗时、导航步骤与 Polyline。
- 高德 JS API：绘制地图、起终点和分段路线。
- 高德天气：当天使用实时天气，未来 1–3 天使用预报；超出可靠范围显示“暂无可靠天气”。
- 缺少 Key、无地点结果、算路失败和天气失败均返回明确错误，不伪造在线结果。

### 2.3 时间、能耗与主动服务规则

- `ARRIVE_BY`：按目标站点前的路线耗时、途经点停留时间和缓冲倒推出发时间。
- 缓冲时间：路线耗时的 10%，且最少 5 分钟，向上取整到分钟。
- 没有后续时间约束的途经点默认停留 5 分钟；若后续站点有到达时间，则反推当前途经点的最晚出发时间，并把中间空档作为停留时间。
- `DEPART_AT`：从用户指定时间顺推各站 ETA。
- 模拟车辆：100 kWh 电池，基础能耗 20 kWh/100 km。
- 室外温度 `≤10°C` 或 `≥30°C` 时，行驶能耗增加 15%。
- 需要温控备车时额外计入 1.5 kWh。
- 默认使用高德天气与气温判断预热或制冷；开启自定义天气后，使用该对话锁定的天气与气温场景。
- 座舱温度 `≤10°C`：提前 15 分钟预热，并建议座椅加热。
- 座舱温度 `≥30°C`：提前 12 分钟制冷。
- 雨、雪、雷天气：增加除雾和雨具提醒。
- 预计到达电量 `<20%`：补能提醒；`<10%`：高风险提醒。
- 新对话默认开启 NOMI 主动备车；用户仍可在后续对话中明确要求关闭。
- 所有路线、ETA、天气、能耗和动作均由程序计算，不由模型生成。

### 2.4 Demo Lab

Demo Lab 已并入每个新对话的开始流程：

- 主动备车默认开启，不再占用初始化开关。
- 默认使用高德实际天气；打开“自定义天气”后才显示天气状况和气温下拉选项。
- 默认电量为 80%；打开“自定义电量”后才显示电量滑块。
- 常用地点默认不设置；打开后可添加家、学校、公司、家人公司等预设标签，也可自定义标签，具体地址通过高德候选确认。
- 用户必须先确认并锁定场景，之后才能在该对话中规划；锁定后该对话内不再允许修改。
- 新建对话可设置另一套场景；切回历史对话时，同时恢复该对话的场景与最新成功路线。
- 会话场景随会话数据保存在 IndexedDB，不再使用全局 Demo Lab `localStorage` 设置。

### 2.5 页面与适配

- Next.js + React + TypeScript 单体全栈项目。
- 横屏类车机布局：左侧地图与导航状态、右侧微信式多轮聊天；输入框固定在聊天区底部。
- 右侧头部提供历史抽屉和新对话，历史切换会恢复对应路线、规划时间与已锁定场景。
- NOMI 灵感视觉，未使用或复刻官方品牌资产。
- 主要适配 Chrome 1184×655、1440×900 与 1920×1080 横屏。
- 会话、消息、最新路线和独立场景保存在原生 IndexedDB；当前会话 ID 保存在元数据表。存储损坏或配额失败时降级为本页内存，不使用服务端数据库或 WebSocket。

## 3. 当前接口与关键文件

### HTTP 接口

| 接口 | 作用 |
| --- | --- |
| `POST /api/intents/parse` | 将自然语言转换为 `TripIntentDraft` |
| `POST /api/conversations/turn` | 解释多轮修改与计划问答，返回计划变更、回答、澄清或刷新请求 |
| `GET /api/places/search` | 使用高德搜索 POI 候选 |
| `POST /api/trips/plan` | 分段算路、查询天气并生成 `TripPlan` |
| `POST /api/trips/narrate` | 根据已验证的规划事实生成 NOMI 总结 |
| `GET /api/providers/health` | 检查三项高德凭证是否已配置 |

### 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/lib/types.ts` | 领域类型与状态机类型 |
| `src/lib/conversations.ts` | 会话、消息、逐轮状态与独立 Demo Lab 场景领域模型 |
| `src/lib/conversation-store.ts` | IndexedDB 会话持久化、当前会话元数据与旧数据迁移 |
| `src/lib/conversation-turn.ts` | 多轮请求与判别联合响应契约 |
| `src/lib/intent-parser.ts` | `IntentParser` 接口和 Mock 规则解析器 |
| `src/lib/planner.ts` | 时间、能耗和主动服务规则引擎 |
| `src/lib/amap.ts` | 高德 POI、路线、天气适配器 |
| `src/lib/default-places.ts` | 四个收藏地点的默认值 |
| `src/components/Cockpit.tsx` | 多会话聊天编排、历史切换与地图状态 |
| `src/components/ConversationScenario.tsx` | 对话开始前的 Demo Lab 设置与锁定后只读展示 |
| `src/components/AmapMap.tsx` | 高德地图、静态路线和站点标记 |
| `src/app/api/**` | 服务端 API 路由 |
| `src/lib/*.test.ts` | 语义规则与规划规则测试 |

## 4. 当前验证状态

最近一次检查结果（2026-07-20）：

- `npm test`：11 个测试文件、96 项测试全部通过。
- `npm run lint`：通过。
- `npm run build`：通过。

运行方式见根目录 `README.md`。高德 Key 只应保存在 `.env.local`，不要写入源码、交接文档或 Git。

## 5. 当前明确边界

- 不接微信、OpenClaw、真实车辆或真实车控。
- 默认自然语言解析仍为本地规则；配置 `INTENT_PARSER_PROVIDER=minimax` 后使用 MiniMax，失败不会静默伪装成功。
- 规划完成总结可由 MiniMax 异步生成并做事实校验；模型失败时使用模板，行程阶段话术仍为确定性模板。
- 路线耗时来自规划当下的高德推荐路线，不代表明早实际交通预测。
- 车辆状态全部为模拟数据。
- 对话支持常用行程修改与计划事实问答，但不扩展为开放聊天或跨设备长期记忆。
- 历史仅保存在当前浏览器，每个会话只保留最新成功路线快照；旧回复文本保留，但不支持回放旧路线版本。
- Demo Lab 场景按会话锁定；新建对话后才能设置另一套场景。

---

## 6. MiniMax 接入目标

模型接入分为两个独立能力：

1. **行程理解**：一句话先交给 MiniMax，输出结构化出行意图，再进入现有地点确认和确定性规划流程。
2. **结果表达**：现有规划完成后，把已经计算好的出发时间、ETA、天气、车况和主动动作交给 MiniMax，生成一段简洁、自然、有陪伴感的 NOMI 回复。

目标链路：

```text
用户输入
  → MiniMaxIntentParser
  → TripIntentDraft
  → 收藏地点解析 / 高德 POI 确认
  → 高德路线与天气
  → 现有 Trip Planner 确定性计算
  → TripPlan
  → MiniMaxTripNarrator
  → 一段面向用户的 NOMI 总结
```

核心原则：

- MiniMax 负责语义理解和语言表达。
- 高德负责地点、路线和天气事实。
- Planner 负责时间、能耗、阈值和主动服务动作。
- 模型不得生成或修改坐标、里程、ETA、电量、天气或执行状态。

## 7. MiniMax 推荐接入设计

### 7.1 服务端调用

- 只在 Next.js 服务端调用 MiniMax，API Key 不得暴露给浏览器。
- 将 MiniMax 的 Base URL、模型名和超时时间全部配置为环境变量，不在代码里写死具体模型版本。
- 优先使用 MiniMax 官方当前支持的结构化输出或兼容调用方式；实现前根据届时官方文档确认实际 Endpoint 和模型名称。
- 建议新增环境变量：

```text
MINIMAX_API_KEY=
MINIMAX_BASE_URL=
MINIMAX_MODEL=
MINIMAX_TIMEOUT_MS=10000
```

不得把任何真实 Key 写入 Markdown、源码或提交记录。

### 7.2 Parser 保持可替换

保留现有接口：

```ts
export interface IntentParser {
  parse(text: string, now?: Date): Promise<TripIntentDraft>;
}
```

新增 `MiniMaxIntentParser`，由环境变量决定使用 Mock 或 MiniMax：

```text
INTENT_PARSER_PROVIDER=mock|minimax
```

模型只输出语义字段，不输出高德坐标。建议模型原始输出至少包含：

```json
{
  "date": "YYYY-MM-DD",
  "city": "上海市",
  "origin": {
    "kind": "FAVORITE_OR_QUERY",
    "favoriteKey": "home",
    "query": "家"
  },
  "stops": [
    {
      "kind": "FAVORITE_OR_QUERY",
      "favoriteKey": "school",
      "query": "儿子学校"
    }
  ],
  "timeConstraints": [
    {
      "type": "ARRIVE_BY",
      "time": "08:00",
      "targetStopIndex": 0,
      "inferred": false
    }
  ],
  "preferences": ["precondition_vehicle"],
  "confidence": 0.95,
  "issues": []
}
```

适配器再将收藏别名映射为本地 `ResolvedPlace`；任意 POI 必须保持 `resolved: null`，继续走现有高德候选确认。

### 7.3 输入模型的必要上下文

每次解析必须明确传入：

- 当前绝对日期、星期和时区 `Asia/Shanghai`。
- 默认城市上海。
- 收藏别名及 key：`home`、`company`、`school`、`wifeCompany`，但不需要向模型暴露经纬度。
- `ARRIVE_BY` 与 `DEPART_AT` 的定义。
- 最多 3 个目的地。
- `issues` 只记录会阻断规划的矛盾或缺失；可编辑的时间假设使用 `timeConstraints[].inferred=true`，不阻断规划。

特别需要覆盖：

- “明早 8 点送孩子到学校” → `ARRIVE_BY 08:00`，目标站为学校。
- “明早 8 点从家出发” → `DEPART_AT 08:00`。
- 一条行程支持 1–3 个时间锚点；未绑定时间的其他途经点不需要追问。
- “送完孩子，再送老婆 8 点上班” → `ARRIVE_BY 08:00`，目标站为老婆公司。
- “10 点前到东方明珠，然后 12 点接孩子放学” → 保留两个 `ARRIVE_BY`，并倒推出从东方明珠前往学校的最晚出发时间。
- “8 点”但未说明出发或到达 → 暂按 `DEPART_AT 08:00`，标记 `inferred: true`，允许用户在卡片中修改但不阻断规划。
- 完全没有精确时间 → 按时段或默认值生成 `DEPART_AT`，标记 `inferred: true` 并继续规划。
- 任意地点名只保留查询词，不编造 POI ID 或坐标。

### 7.4 强制结构校验

- 用 Zod 定义模型原始输出 Schema。
- 日期、时间、站点数量、目标下标和枚举必须在服务端再次校验。
- JSON 无法解析或字段非法时最多自动修复/重试一次。
- 失败后向前端返回明确的模型错误；开发模式可以显式回退 Mock，但必须标注 `fallback: true`，不能让用户误以为模型成功。
- `/api/intents/parse` 的对外响应继续保持 `TripIntentDraft`，避免前端和后续规划接口大改。

### 7.5 规划结果的自然语言总结

建议新增独立接口，而不是把模型调用耦合进 `/api/trips/plan`：

```text
POST /api/trips/narrate
```

输入是已经生成的 `TripPlan` 的必要字段，输出建议为：

```json
{
  "text": "建议你明早 7:31 出发……",
  "provider": "minimax",
  "model": "配置中的模型名",
  "generatedAt": "ISO-8601",
  "fallback": false
}
```

对总结模型的约束：

- 只能复述输入数据，不得补充未提供的事实。
- 必须提到建议出发时间和首个关键到达时间。
- 根据优先级最多选择 2–3 项主动建议，避免把全部规则机械念一遍。
- 电量警告和高风险动作优先于舒适性建议。
- 文案控制在约 60–120 个中文字符，语气自然、有陪伴感、不过度拟人。
- 模型失败时继续使用当前模板话术，不能阻断地图和行程规划。
- 行程执行中的阶段话术继续使用确定性模板；第一阶段只让模型生成“规划完成总结”。

## 8. 建议新增代码结构

```text
src/lib/ai/
├─ minimax-client.ts          # 鉴权、请求、超时、错误归一化
├─ minimax-intent-parser.ts   # 实现 IntentParser
├─ trip-narrator.ts           # Narrator 接口与模板兜底
├─ minimax-trip-narrator.ts   # MiniMax 总结实现
├─ schemas.ts                 # 模型原始输出 Zod Schema
└─ prompts.ts                 # 版本化系统提示词

src/app/api/trips/narrate/
└─ route.ts
```

`src/lib/intent-parser.ts` 中现有 Mock 解析器应保留，作为开发、回归测试和模型不可用时的显式兜底。

## 9. MiniMax 实施顺序

1. 增加配置读取、MiniMax Client、统一错误类型和健康检查。
2. 定义模型原始输出 Schema 与解析提示词。
3. 实现 `MiniMaxIntentParser`，保持 `/api/intents/parse` 响应结构不变。
4. 增加 Parser 合同测试和典型中文行程用例。
5. 新增 `TripNarrator` 与 `/api/trips/narrate`。
6. 前端规划成功后异步请求总结；失败时保留模板话术。
7. UI 增加轻量数据来源标识，例如“MiniMax 理解 / 规则规划 / 高德数据”。
8. 完成超时、限流、无效 JSON、模型不可用和内容安全异常测试。

## 10. MiniMax 接入验收标准

- 标准送娃场景正确识别为 `ARRIVE_BY 08:00`，目标站为学校。
- “8 点从家出发”正确识别为 `DEPART_AT 08:00`。
- 自定义地点不会被模型虚构成坐标，仍会弹出高德前三个候选。
- 用户修改结构化行程后仍能直接复用现有规划流程。
- 模型不能覆盖 Planner 计算出的路线、ETA、能耗和动作。
- 规划总结中的所有数字都能在 `TripPlan` 中找到来源。
- MiniMax 超时、限流或返回非法结构时，页面有明确状态且路线规划不被阻断。
- API Key 不出现在浏览器请求、客户端构建产物、日志和 Git 中。
- Mock 与 MiniMax 两种 Parser 均通过同一组合同测试。
- 接入完成后 `npm test`、`npm run lint`、`npm run build` 全部通过。

## 11. 后续协作注意事项

- 模型接入对话尽量只新增 Provider、Schema、Prompt 和 Narrator，不修改 `planner.ts` 的确定性业务规则。
- 如果模型侧发现新语义字段确有必要，先扩展 `TripIntentDraft` 类型和接口契约，再同步前端编辑器。
- 前端与规则逻辑的后续修改继续在当前对话推进，避免两个对话同时编辑 `Cockpit.tsx`、`types.ts` 或 `planner.ts` 造成覆盖。
- 每次跨对话交接前先检查工作区差异；不要覆盖其他对话尚未提交的更改。

## 12. MiniMax 接入完成状态（2026-07-15）

- 已新增 MiniMax 服务端 Client、统一超时/鉴权/限流/额度/内容安全错误。
- 已新增 `MiniMaxIntentParser`、严格 Zod Schema、非法 JSON/字段自动修复一次，以及显式 Mock 回退开关。
- 已新增 `POST /api/trips/narrate`、规划事实裁剪、关键时间与新增数字校验、模板兜底。
- 前端规划完成后异步请求总结，并显示“MiniMax 理解 / 规则规划 / 高德数据 / MiniMax 表达”等来源标识。
- `/api/providers/health` 已包含 MiniMax 配置状态，但不会返回 Key。
- `.env.example` 与 `README.md` 已补齐开通、配置、切换和故障回退说明。
- 真实 MiniMax Key 仅保存在被忽略的 `.env.local`；标准送娃解析与规划总结均已在线验收通过，返回 `provider=minimax`、`fallback=false`。
- `MiniMax-M2.7` 实测需要 30 秒服务端超时，并可能在 `content` 中混入思考块；适配器已剥离思考块，收藏地点 `query=null` 也会由本地收藏表安全补全。
- 模型产品规范已外置为 `prompts/INTENT_PARSING_SPEC.md` 与 `prompts/TRIP_NARRATION_SPEC.md`，每次调用动态读取；代码侧继续执行结构校验、零/一基下标归一、重复起点清理、明确站点恢复、回答必说项校验与模板兜底。
