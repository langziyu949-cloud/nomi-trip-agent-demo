# NOMI Everywhere · 出行代理 Demo

一个本机横屏类车机网页：在彼此独立的多轮对话中，把自然语言转换为结构化出行任务，结合高德地点、路线、天气和模拟车况生成主动服务建议，并在地图上展示完整行程。

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

## 公网部署

本项目包含 Next.js 服务端接口，不能使用纯静态网页托管。推荐将私人 GitHub 仓库导入 Vercel，并在项目的 Production Environment Variables 中配置 `.env.example` 列出的变量。

公网演示建议同时设置：

```text
DEMO_ACCESS_USERNAME=nomi
DEMO_ACCESS_PASSWORD=一段独立的高强度密码
```

设置密码后，页面和 `/api/*` 接口都会要求浏览器进行 HTTP Basic Authentication；凭证通过 Vercel 的 HTTPS 连接传输。密码只放在 Vercel 环境变量中，不要写入代码、截图或 Git 仓库。不设置 `DEMO_ACCESS_PASSWORD` 时不启用访问保护。

部署完成后，还需要在高德控制台把 Vercel 生产域名或自定义域名加入 Web 端 JS Key 的域名白名单。`NEXT_PUBLIC_*` 变量会在构建时写入浏览器包，修改后必须重新部署。

当前会话历史存放在各设备自己的 IndexedDB 中：分享网址不会共享聊天记录，每台手机或电脑会获得独立的会话与 Demo Lab 场景。

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
| `POST /api/conversations/turn` | 解释对当前行程的追问或修改；返回计划变更、事实问答、澄清或实时刷新请求 |
| `POST /api/trips/plan` | 高德路线与天气 + 本地确定性规划，不调用大模型 |
| `POST /api/trips/narrate` | 异步生成规划总结；超时、限流、余额不足或事实校验失败时返回模板话术 |
| `GET /api/providers/health` | 只检查所需凭证是否配置，不返回任何 Key |

MiniMax 使用服务端 Bearer 鉴权，请求不会从浏览器直接发往 MiniMax。当前官方 OpenAI 兼容端点与模型列表见 [MiniMax 模型调用文档](https://platform.minimaxi.com/docs/guides/text-generation)。

### 4. 可编辑的模型规范

模型调用读取以下产品规范：

- `prompts/INTENT_PARSING_SPEC.md`：站点、日期、多个时间锚点、默认值与结构化 JSON 规则。
- `prompts/CONVERSATION_TURN_SPEC.md`：多轮修改、计划事实问答、必要澄清和实时刷新规则。
- `prompts/TRIP_NARRATION_SPEC.md`：面向微信聊天框的长度、必说信息、自动车控语气、雨具提醒与温度口径。

服务端在每次请求时重新读取规范文件，因此本地修改后下一次调用即生效。Markdown 负责可编辑的产品策略；Zod Schema、站点与下标修复、事实一致性检查及确定性模板兜底仍由代码负责，避免模型偶发不遵守规范时直接影响用户。

## 推荐演示流程

1. 新建对话后，先在对话区的 Demo Lab 设置常用地点、主动备车偏好及 `低温座舱 / 小雪 / 42% 电量` 等场景，并确认锁定。
2. 输入“明早 8 点送孩子到学校，然后去公司，提前准备一下。”
3. 检查系统是否识别为“8 点前到校”并生成分段路线。
4. 继续输入“改成九点出发”或询问当前计划的里程、电量与天气，确认路线修改和事实问答都沿用该对话上下文。
5. 查看预热、座椅加热、除雾、雨具与出发缓冲建议，并按需刷新当前路线与天气。
6. 新建另一条对话设置不同场景，再从历史中切回，确认地图、路线和已锁定场景随所选对话恢复。

每个对话的 Demo Lab 场景只在开始前设置一次；确认后在该对话中不可修改。会话、消息、最新成功路线和独立场景保存在浏览器 IndexedDB，刷新后可继续；存储不可用时会降级到本页内存并提示历史暂未保存。

任意地点会通过高德 POI 搜索返回前三个候选；“家、学校、公司”是本地收藏地点，会直接解析。

## 开发检查

- `npm test`：自然语言解析与规划规则单元测试
- `npm run lint`：代码规范检查
- `npm run build`：生产构建和类型检查

## 当前边界

- 不接微信、OpenClaw、真实车辆或真实车控。
- 对话限定为行程创建、常用修改、计划事实问答与必要澄清，不扩展为开放聊天。
- 历史仅保存在当前浏览器；每个会话只保存最新成功路线快照，不支持回放旧消息对应的旧路线版本。
- 历史快照默认不自动刷新；只有显式刷新或询问实时路况、天气时才重新调用高德。
- 通过环境变量可在 Mock 与 MiniMax 解析器之间切换；模型不可用时只提供有限规则降级。
- 路线耗时来自高德当前推荐路线，不代表未来实时路况。
- 高德天气只覆盖近期预报；超出范围时不会生成虚构天气。
- 缺少高德凭证时会显示明确配置提示，不伪造在线地图结果。
- 缺少 MiniMax 凭证时默认保持 Mock + 模板模式；启用 MiniMax 后不会静默吞掉解析失败。
