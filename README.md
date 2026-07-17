# NOMI Everywhere · 出行代理 Demo

一个本机横屏类车机网页：把自然语言转换为结构化出行任务，结合高德地点、路线、天气和模拟车况生成主动服务建议，并用 15 秒动画演示完整行程。

## 本地运行

1. 安装依赖：`npm install`
2. 复制 `.env.example` 为 `.env.local`
3. 在高德开放平台创建一个应用并配置：
   - `AMAP_WEB_SERVICE_KEY`：Web 服务 Key，用于 POI、路线和天气
   - `NEXT_PUBLIC_AMAP_JS_KEY`：Web 端 JS API Key
   - `NEXT_PUBLIC_AMAP_SECURITY_CODE`：JS API 安全密钥
4. 启动：`npm run dev`
5. 打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)

推荐使用 Chrome 横屏展示，首选分辨率为 1920×1080 或 1440×900。

## 接入 MiniMax 大模型

MiniMax 在本项目中只负责两件事：把自然语言转换为结构化行程，以及把已经由规则引擎算好的规划结果整理成自然语言。地点、坐标、路线、天气、ETA、电量和主动服务动作仍分别由高德与本地 Planner 决定。

### 1. 开通额度与获取 Key

第一次验证推荐使用按量付费，不必先购买长期订阅：

1. 登录 [MiniMax 国内开放平台](https://platform.minimaxi.com/)。
2. 进入“账户管理 → 余额”按需充值。
3. 进入“账户管理 → 接口密钥”，创建普通按量付费 API Key。
4. 只把 Key 写入本机 `.env.local`，不要发到群聊、截图、浏览器代码或提交记录。

如果后续调用频繁，也可以改用 [Token Plan](https://platform.minimaxi.com/docs/token-plan/intro) 的订阅 Key；订阅 Key 与普通按量付费 Key 是两套独立凭证。模型与实时价格以 [官方按量计费页](https://platform.minimaxi.com/docs/guides/pricing-paygo) 为准。

### 2. 启用模型

在 `.env.local` 追加：

```text
INTENT_PARSER_PROVIDER=minimax
TRIP_NARRATOR_PROVIDER=minimax
MINIMAX_API_KEY=你的服务端Key
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M2.7
MINIMAX_TIMEOUT_MS=30000
MINIMAX_ALLOW_MOCK_FALLBACK=false
```

修改后重启 `npm run dev`。右上角不再显示“等待 MiniMax 配置”，规划完成卡片会显示“MiniMax 理解 / 规则规划 / 高德数据 / MiniMax 表达”。

本地联调时如需在模型解析失败后继续演示，可以显式设置 `MINIMAX_ALLOW_MOCK_FALLBACK=true`；界面会标记“规则理解 · 回退”，不会冒充模型成功。生产演示建议保持 `false`，以便第一时间发现 Key、额度或模型输出问题。

### 3. 服务端接口

| 接口 | 职责 |
| --- | --- |
| `POST /api/intents/parse` | 按环境变量选择规则或 MiniMax 解析器；模型 JSON 会经过 Zod 校验，非法结构最多修复一次 |
| `POST /api/trips/plan` | 高德路线与天气 + 本地确定性规划，不调用大模型 |
| `POST /api/trips/narrate` | 异步生成规划总结；超时、限流、余额不足或事实校验失败时返回模板话术 |
| `GET /api/providers/health` | 只检查所需凭证是否配置，不返回任何 Key |

MiniMax 使用服务端 Bearer 鉴权，请求不会从浏览器直接发往 MiniMax。当前官方 OpenAI 兼容端点与模型列表见 [MiniMax 模型调用文档](https://platform.minimaxi.com/docs/guides/text-generation)。

### 4. 可编辑的模型规范

每轮规划的两次模型调用分别读取以下文件：

- `prompts/INTENT_PARSING_SPEC.md`：站点、日期、多个时间锚点、默认值与结构化 JSON 规则。
- `prompts/TRIP_NARRATION_SPEC.md`：面向微信聊天框的长度、必说信息、自动车控语气、雨具提醒与温度口径。

服务端在每次请求时重新读取规范文件，因此本地修改后下一次调用即生效。Markdown 负责可编辑的产品策略；Zod Schema、站点与下标修复、事实一致性检查及确定性模板兜底仍由代码负责，避免模型偶发不遵守规范时直接影响用户。

## 推荐演示流程

1. 输入“明早 8 点送孩子到学校，然后去公司，提前准备一下。”
2. 检查系统是否识别为“8 点前到校”并生成分段路线。
3. 打开右上角 Demo Lab，设置常用地点、主动备车偏好，并启用 `低温座舱 / 小雪 / 42% 电量` 场景后重新规划。
4. 查看预热、座椅加热、除雾、雨具与出发缓冲建议。
5. 点击“确认计划并开始 15 秒演示”，观察模拟时间与车辆沿路线同步推进。

任意地点会通过高德 POI 搜索返回前三个候选；“家、学校、公司”是本地收藏地点，会直接解析。

## 开发检查

- `npm test`：自然语言解析与规划规则单元测试
- `npm run lint`：代码规范检查
- `npm run build`：生产构建和类型检查

## 当前边界

- 不接微信、OpenClaw、真实车辆或真实车控。
- 当前仍是单轮完整行程；通过环境变量可在 Mock 与 MiniMax 解析器之间切换。
- 路线耗时来自高德当前推荐路线，不代表未来实时路况。
- 高德天气只覆盖近期预报；超出范围时不会生成虚构天气。
- 缺少高德凭证时会显示明确配置提示，不伪造在线地图结果。
- 缺少 MiniMax 凭证时默认保持 Mock + 模板模式；启用 MiniMax 后不会静默吞掉解析失败。
