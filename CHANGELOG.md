# CHANGELOG

只记**会影响行为**的改动。日期为本地日期。

## 0.4.5 — 2026-10-17

- 分发方式定为 **GitHub**：`package.json` 补上 `repository` / `homepage` / `bugs`（`github.com/Wuweizhi-337/dsh-qq-bridge`）。
- README 安装段改为 `dsh plugin add git+https://...`，并保留「只有 tgz 时怎么装」。
- `RELEASING.md` 重写为 GitHub 流程（网页上传即可，不需要装 Git），npm 只留作备注。

## 0.4.4 — 2026-10-17

- **改为 npm 分发**：包名改成作用域包 `@wuweizhi/dsh-qq-bridge`（`author: 无为治`）；
  `cordis.patch.yml` 的 `id` 用短名 `qq-bridge`、`name` 用完整包名；客户端 `load({ id })` 同步成完整包名。
- 新增 `scripts/sync-from-local.mjs`：从本地开发副本同步 `lib/*.js` 并自动改写 client 的 load id（避免手抄错）。
- `preflight` 增加第五组检查：client load id / patch name 是否等于包名、`private` 是否为 false、作用域包是否设了 public。
- README 改为 npm 安装命令，并加**用途声明**（个人学习、MIT、无担保、遵守平台规则）。
- 本地开发副本仍是 `dsh-qq-bridge`（`private: true`、`link:` 安装），不发布。

## 0.4.3 — 2026-10-17

- 「回合制」卡片改名「**回复频率（多爱说话）**」，并把之前**页面上调不到**的
  `memory.topicHookMinScore`（话题勾连阈值）加进页面：调低更容易触发（更爱说话），调高更安静。
- 「简介」卡片的说明里加了一句：改回复频率去「回复频率」和「主动插话额度」两张卡片，保存即生效。

## 0.4.2 — 2026-10-17

- **页面「简介」可自己改**：设置页顶部新增一块「📖 简介」，内容存 `ui.intro`，原样显示、跟着配置保存；
  下面再带一块「📝 便签」存 `ui.note`。两者**都只影响显示**，不参与任何对话逻辑。

## 0.4.1 — 2026-10-17

- **修**：`reply.atSenderChance`（按概率 @ 说话的人）和模型自己写的 `[@QQ号]` **从来没真正发出去过**。
  原因：只有回复里含图片时才走「消息段数组」发送，纯文本走的是分段发送（只发文字），
  at 段被整个丢掉了；表情包功能删掉之后，就再没有 image 段能把这条路撑起来。
  现在只要**含非文本段**（at / image）就按消息段数组发送，纯文本才分段。
- 私聊不再尝试 @（私聊消息里没有 at 段这种东西）。

## 0.4.0 — 2026-10-17

- **私聊**：新增 `reply.private` 开关（默认关）。打开后收到单聊**一律回**，不走回合制、不占主动额度；
  会话与记忆按 `private:<QQ号>` 单独存，不和群聊混。
- 发送层重构：`targetOf()` 统一群/私聊（`send_group_msg`+`group_id` / `send_private_msg`+`user_id`）。
- **禁言识别**：`send_group_msg` 回 `retcode 1200` = 被该群禁言（消息没进群）。现在除记 `lastError` 外，
  还给这个群挂 5 分钟冷却，冷却期内不再主动判断；`/status` 暴露 `muted: [{group, leftSec}]`，页面红字提示。
  被 @ / 叫名字 的必回通道不受影响。
- **NapCat 启停搬进页面**：`GET/POST /qq-bridge/napcat`（端口探测 / 等扫码判断 / 启动 / 停止 / 开二维码）。
  启动走 `explorer.exe`，进程不挂在桌面端进程树下；停止只 `taskkill /IM NapCatWinBootMain.exe /T /F`。
- **去个人化**：二维码路径与启动脚本路径从写死改成配置项 `napcat.launcher` / `napcat.qrPath`（留空即不启用）。
- 设置页新增「文件备注」+「什么改动什么时候生效」卡片。

## 0.3.5 — 2026-10-17

- 设置页人物备注编辑器从「一人一个按钮」改成下拉框（档案上百份时会铺满整页）。
- 「清空待审记忆」加二次确认（原来一键清空且不可恢复）。

## 0.3.0 — 2026-10-17

- 设置页补齐：回合制（`reply.turn.*`）、主动插话额度（`proactive.*`）、看图（`vision.*`）、
  别名 + 声音锚（`persona.aliases` / `persona.anchors`）、关系演化（含「现在演化」按钮）。
- 新增 `GET /qq-bridge/relations`、`POST /qq-bridge/evolve {qq}`：用某人最近那段对话立刻写一条关系。

## 0.2.0 — 2026-10-17

- 回合制取代随机骰子：删掉 `reply.chance`；问句落地 / 话题勾连才让模型判断 `speak|wait|skip`。
- 长期记忆三层（core / event / chatter）+ 时间衰减 + 复习增强 + 多路打分召回。
- 关系演化与日摘要（每人一条关系、每群每天一条事件记忆），计数器落盘不再随重启归零。
- 发送回执：每条消息等 NapCat ack，拒收/超时都写日志（以前是"发出去就记成功"）。
- 删除表情包功能（整块，含配置与状态行）；出口保留一条把 `[表情:x]` 静默掐掉的兜底。

## 0.1.0 — 2026-10-14

- 首个可用版本：NapCat(OneBot 11) ↔ DSH 模型，群聊收发、人设、人物档案、摘要压缩、设置页。
- 调用模型时**不传 tools** —— 只能聊天，拿不到文件与命令能力。
