# dsh-qq-bridge

把 QQ 群聊接进 DSH 模型的一个 DSH 插件：**NapCat（OneBot 11）收发消息，DSH 的模型说话。**

它只做一件事——**像一个人那样在群里说话**。不是助手，不是问答机器人：它有自己的人设、记得住人、会判断该不该开口、也会选择沉默。

> 调用模型时**从不传 `tools`**。所以它物理上拿不到文件读写和命令执行能力，只能聊天。这是设计，不是限制。

> **用途声明**：这是一个**个人学习与技术研究**项目，按 MIT 发布、不提供任何担保。
> 使用前请自行确认符合 QQ / NapCat 的服务条款与你所在地的规定；
> 请不要用它做群发、营销、骚扰或任何需要"假装是真人"去误导别人的事。模型说的话由使用者负责。

---

## 简介

一个**只会聊天**的 QQ 机器人桥：NapCat 负责收发，DSH 的模型负责说话，插件负责"什么时候说、跟谁说、说什么"。

它像人的地方不是话术，而是三件事：

- **认得人**：一人一档（`people/<QQ号>.md`），画像、关系、干过的事都记着，昵称跟着群名片走；
- **记得事**：三层记忆（关系/事件/闲聊）带时间衰减，被提到的事会记得更久，很久以前的事会自己淡掉；
- **会挑时候**：被叫到一定回；没人叫它时先听着，只有当"话落地了"或"勾到它记得的事"才判断一次，也可以判断成"不说"。

边界也是刻意的：**不能读文件、不能跑命令、不能上网**。它没有工具能力，所以它不会替人干活，只会接话。

## 使用场景

**适合：**

- 熟人小群里的"常驻角色"：有固定人设和说话节奏，不是客服腔；
- 挂机陪聊：群里有话头就接一句，没人理就安静待着；
- 一对一私聊闲聊 / 轻角色扮演（设置页一个开关打开）；
- 想观察 LLM 在群聊里的行为：记忆怎么衰减、什么时候肯开口、怎么避免复读 —— 日志和记忆都是明文的，可以逐个看。

**不适合：**

- 客服、答疑、值班机器人 —— 它不保证有问必答，会因为没有"接得上"的角度而沉默；
- 需要查资料、跑命令、读写文件的任务 —— 物理上拿不到工具；
- 大群刷屏式互动 —— 有主动开口的额度上限，且群越大人越容易触发禁言/风控；
- 需要留完整原文日志的合规场景 —— 日志只写 ASCII（中文变 `?`），而且只记事件不记全文。

## 对话的表面逻辑

从群友的视角看，它大概是这么工作的：

**1. 先判断是不是冲它来的。** @ 它、直接叫它名字（包括群名片和登录昵称）、或者引用它说过的那句 —— 算"在跟我说话"，**立刻回**。

**2. 不是冲它来的，就先听着。** 消息进它最近 12 条的上下文，不会立刻接。

**3. 什么时候它才会想插话？** 只有两种触发：

- **话落地了**：有人问了一句，几秒内没人接（`questionWaitSec`，默认 10 秒）；
- **勾到记忆**：这句话和它记得的事相似度过线（`topicHookMinScore`，默认 0.4）。

**4. 触发之后它自己判一次。** 它看到最近 12 条 + 自己最近说过的 3 句，输出三选一：

| 结果 | 含义 | 你看到什么 |
|---|---|---|
| `speak` | 接第 N 条 | 它回一句，锁定那条，其余当背景 |
| `wait` | 可能还有下文 | 30 秒后再看一次（只等一次，之后当 `skip`） |
| `skip` | 不说 | 什么都不发 |

**5. 说的时候有"形状"。** 一条消息就是一句话，一般 40 字内、不换行、不带时间戳、不带「昵称:」前缀；大约六成概率 @ 一下说话的人。

**6. 它可以明确选择沉默。** 模型输出 `[沉默]` 时插件什么都不发 —— 那不是坏了，是它的正常出口。

**7. 不会复读。** 回复和最近 3 句太像（相似度 ≥ 0.7）会被要求换一种说法重写一次。

**8. 主动开口有上限。** 冷却、每小时、每天三个数（页面可调），防止一分钟插嘴三次；**被 @ 的回复不受这个限制**。

**9. 私聊是另一条路。** 开关打开后，单聊**直接回**（不判断、不占主动额度），会话和记忆单独按 `private:<QQ号>` 存。

**10. 被禁言时它会闭嘴。** 发送被 QQ 拒（`retcode 1200`）说明在那个群被禁言了：它会记一笔错误，并在 5 分钟内不再主动判断那个群；页面状态卡会红字提示「疑似被禁言」。

---

## 特性

| 能力 | 说明 |
|---|---|
| **人设** | 系统提示 + 声音锚点（几句固定的样句，防止被自己最近的话带跑） |
| **认人** | 一人一档 `people/<QQ号>.md`：画像、关系、干过的事；昵称跟着群名片自动更新 |
| **长期记忆** | 三层（核心/事件/闲聊）+ 时间衰减 + 复习增强，按打分召回 1~2 条注入 |
| **日摘要** | 每群每天（或攒够 `daySummaryLines` 条）压一条事件记忆：昨天大致发生了什么 |
| **关系演化** | 每人一条"你们现在的关系"，每 `relationEvolveEvery` 轮重写一次；没变化就沿用旧文 |
| **回合制发言** | 不是随机概率，也不是定时器：**话落地**（有人问完 `questionWaitSec` 秒没人接，默认 10）或**话题勾连**才判断 |
| **三态判断** | `speak / wait / skip`，判断时看得到自己最近 3 句（天然防复读） |
| **沉默** | 模型可以输出 `[沉默]`，插件什么都不发 |
| **发送回执** | 每条消息都等 NapCat 回执；QQ 拒收或超时都写日志，不再是"假成功" |
| **点名叫人** | `[@QQ号]` 会变成真正的 @ |
| **私聊** | 设置页一个开关（默认关）。打开后收到单聊**一律回**，会话/记忆按 `private:<QQ号>` 单独存 |
| **NapCat 启停** | 页面里就能启动/停止机器人、看 3001 状态、等扫码时一键打开二维码 |
| **设置页全覆盖** | 状态 / 人设（含别名、声音锚）/ 触发与回合制 / 主动额度 / 看图 / 关系演化（含「现在演化」按钮）/ 人物档案 / 待审 / 模型 / 连接 / 黑名单，都能在界面改 |
| **配置热加载** | 改 `config.json` 立即生效，不用重启；代码改动才需要重启 |
| **设置界面** | 桌面端「设置 → QQ 桥」 |

---

## 数据流

```
QQ 群消息
   │
   ▼
NapCat（OneBot 11 正向 WebSocket 服务端，默认 127.0.0.1:3001）
   │  插件作为 WS 客户端主动连出（token 走 ?access_token=）
   ▼
lib/index.js
   ① 过滤（开关 / 黑名单 / 纯合并转发丢弃）
   ② 判定：被 @ / 叫名字 / 引用 → 必回，立即处理
            其余 → 进滚动上下文，满足触发条件才让模型判断"要不要接、接哪条"
   ③ 组装：system（稳定段，可被前缀缓存）+ 历史 + contextBlock（档案/记忆/本回合上下文）
   ④ ctx.llm.stream(...) —— 不传 tools
   ⑤ 出口：防空回复重试 → 沉默 → 防复读 → 清洗 → [记:] → 分段 → 截断 → 发送 → 等回执
   ▼
lib/memory.js  长期记忆：写入 / 衰减 / 召回 / 渲染
lib/client.js  设置界面
```

---

## 安装

> 通过 **GitHub** 安装：仓库 `Wuweizhi-337/dsh-qq-bridge`。
> 包名带作用域（`@wuweizhi/dsh-qq-bridge`），和 npm 上那个无 scope 的 `dsh-qq-bridge` 不是同一个东西。

1. 让 DSH 从仓库装：
   ```bash
   dsh plugin --profile desktop add git+https://github.com/Wuweizhi-337/dsh-qq-bridge.git
   ```
   或者先 clone 再按目录装：
   ```bash
   git clone https://github.com/Wuweizhi-337/dsh-qq-bridge.git
   dsh plugin --profile desktop add ./dsh-qq-bridge
   ```
   手上只有打包文件时也能装：`dsh plugin --profile desktop add ./dsh-qq-bridge-0.4.x.tgz`
2. 复制 `config.example.json` 为 `~/.dsh/qq-bridge/config.json`，填 `napcat.accessToken` 和人设
3. 重启桌面端（完全退出，含托盘）
4. 自己启动 NapCat（**别让工具代管**：工具拉起的进程会挂在桌面端进程树下，桌面端一退就被清掉）。
   想让页面里的「启动机器人」按钮可用，就在配置里填 `napcat.launcher`（你的启动脚本路径）和
   `napcat.qrPath`（NapCat 缓存里 `qrcode.png` 的路径）—— 留空就是按钮不出现，不影响正常收发。

---

## 配置

`~/.dsh/qq-bridge/config.json`，改完热加载。

| 段 | 键 | 说明 |
|---|---|---|
| `napcat` | `url` / `accessToken` / `launcher` / `qrPath` | OneBot 正向 WS 地址与 token。**改地址要重启**；`launcher`/`qrPath` 留空 = 页面里的「启动机器人 / 打开二维码」不启用 |
| `model` | `provider` / `model` / `reasoningEffort` / `maxTokens` / `temperature` / `historyMode` | 模型选择；`reasoningEffort: off` 可显著降低"光想不说" |
| `persona` | `name` / `system` / `aliases` / `anchors` | 人设正文；`anchors` 是几句"她的声音"当节奏样板 |
| `reply` | `groups` / `private` / `requireAt` / `maxChars` / `atSenderChance` / `maxAts` / `allowSilence` | 出口参数；`private: true` 才接私聊 |
| `reply.turn` | `questionWaitSec` / `waitRetrySec` / `cooldownSec` / `window` / `judgeMaxTokens` / `judgePersonaChars` | 回合制判定参数（页面里叫「回复频率」） |
| `memory` | `keepRounds` / `summary*` / `recallLimit` / `recallMinScore` / `topicHookMinScore` / `extractFacts` / `relationEvolveEvery` / `daySummaryLines` | 会话压缩 + 长期记忆召回 + 日摘要 + 关系演化；`topicHookMinScore` 是话题勾连阈值（越低越爱接话） |
| `people` | `enabled` / `maxInRoster` / `maxBytes` | 人物档案 |
| `vision` | `enabled` / `maxImages` | 看图：群友发的图直接附在消息里，每轮最多几张 |
| `proactive` | `enabled` / `cooldownSec` / `maxPerHour` / `maxPerDay` / `quietStart` / `quietEnd` | 主动插话的硬上限（防刷屏） |
| `blacklist` | `groups` / `users` | 不处理的群/人 |
| `ui` | `intro` / `note` | 只给设置页用：`intro` 是页面顶部那段「简介」（可自己改），`note` 是便签。**都不影响机器人行为** |

### 回合制是怎么判的

```
有人问了一句 → questionWaitSec（默认 10 秒）内没有别人接 → 让模型判断一次
这句话和她记得的事相似度过线（topicHookMinScore，默认 0.4）→ 5 秒后判断一次
判断输出：{"act":"speak|wait|skip","target":序号,"why":"..."}
  speak → 锁定"接第 N 条"生成，其余当背景
  wait  → waitRetrySec（默认 30 秒）后再看一眼（只等一次）
  skip  → 撤
```

判断调用**不带历史**、输出限长，成本约几百 token；`proactive` 的每小时/每天上限在判断之前先卡一道。
同一个群里已经在等一个问句落地时，后面再来的问句**不会把计时器重置**（否则问题一密就永远等不到判定）。

---

## 长期记忆

条目：`{qq, group, kind, text, importance, source, created, lastHit, hits}`

| 层 | 半衰期 | 典型内容 |
|---|---|---|
| `core` | 不衰减 | 关系、约定、雷区、称呼 |
| `event` | 23 小时 | 某天做过/说过什么 |
| `chatter` | 6 小时 | 顺嘴说的话，过期自己散掉 |

打分（召回时，纯数学、零模型调用）：

```
score = (0.5*recency + 3*relevance + 2*importance) / 5.5
        + 0.35 * keywordHit      ← 查询里的字二元组有多大比例出现在这条记忆里（BM25-lite）
        + 0.08（同一个人） + 0.05（同一个人且 core）
recency   = 0.5 ^ (小时数 / (半衰期 * (1 + hits)))   ← 命中越多记得越久
relevance = 字符二元组 Dice 系数（不依赖分词和 embedding）
```

只在「同一个人 / 同一个群」里召回，**跨群不召回**——真实社交就是这样。

### 另外两块（不参与衰减）

- **日摘要**：每群把当天原话攒着，攒够 `daySummaryLines`（默认 60）条或跨天时压成一条 `kind:event` 记忆（≤100 字，只写事实/关系/约定，明确不要"情绪基调"）。
- **关系演化**：`relations[QQ] = { text, at }`，每 `relationEvolveEvery`（默认 30）轮重写一次；文本没变就沿用旧 `at`。计数器存在 `memory-store.json` 的 `relationCounters` 里，**重启不归零**。冷门的人可能很久攒不够 30 轮 —— 设置页那张卡片里有「现在演化」按钮（`POST /qq-bridge/evolve`），用它最近那段对话立刻写一条（会调一次模型），可以当场验证。

---

## 已知边界

- **私聊默认关闭**（`reply.private: false`）。打开后私聊**一律回**，不走回合制、不占主动额度；会话和记忆按 `private:<QQ号>` 单独存，不和群里混
- **没有工具能力**：不能读文件、不能跑命令、不能上网
- 日志只写 ASCII（中文会变 `?`），这是为了避免 GBK 编码把日志弄成乱码
- 改 NapCat 地址/token 需要重启，其余配置热加载
- `pending-notes.md` 给**人**看，`memory-store.json` 给**模型**读，两者不要混
- 旧的 `reply.chance`（没被 @ 时按概率回一句）已从代码删除：回不回由回合制判断；配置里即使残留 `chance` 也不会被读取
- 页面里的「启动机器人 / 打开二维码」要自己配 `napcat.launcher` / `napcat.qrPath`，留空 = 不启用（不影响收发）

---

## 开发 / 发布

- 改完代码跑一次自检：`node scripts/preflight.mjs`（检查必需文件、个人路径泄漏、语法、真加载）
- 版本号与 CHANGELOG、发布步骤、装完怎么验：见 `RELEASING.md`

---

## 许可

MIT
