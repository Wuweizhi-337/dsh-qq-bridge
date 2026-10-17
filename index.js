/**
 * dsh-qq-bridge —— QQ 群机器人桥（主机半侧）
 *
 * 数据流：
 *   QQ 群消息 -> NapCat (OneBot 11 正向 WebSocket 服务端) -> 本插件
 *   本插件 -> ctx.llm.stream(...) 拿回复 -> OneBot send_group_msg 发回群里
 *
 * 权限边界（重要）：
 *   只调用 ctx.llm.stream()，**从不传 tools**。
 *   因此这个机器人物理上拿不到文件读写和命令执行能力，只能聊天。
 *
 * 配置：$DSH_HOME/qq-bridge/config.json   （支持热加载：改完立即生效）
 * 记忆：$DSH_HOME/qq-bridge/memory.json
 * 日志：$DSH_HOME/qq-bridge/bridge.log     （只写 ASCII，非 ASCII 替换为 ?）
 *
 * 给设置界面（客户端半侧）用的路由：
 *   GET  /qq-bridge/config   读配置
 *   POST /qq-bridge/config   写配置（写完立即热加载）
 *   GET  /qq-bridge/status   运行状态
 *
 * 写法参考了两个已装插件的真实约定（dsh-startup-screen / dsh-dafeiyu）：
 *   - 导出具名 name / inject / apply，**不导出 default**
 *   - apply 里全程 try/catch：DSH 把插件激活失败当作整棵启动树的致命错误，
 *     所以任何异常都必须被吞掉，最坏情况只让本插件变成哑巴。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
// ★ 阶段2（2026-10-17）：长期记忆库。旁路模块，坏了最坏是"想不起来"，不影响回话。
import { loadStore, saveStore, addItem, recall, renderRecall, bump, parsePending } from './memory.js'

export const name = 'dsh-qq-bridge'
export const inject = ['llm']

// ---------------------------------------------------------------- 路径与日志

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(DSH_HOME, 'qq-bridge')
const CONFIG_PATH = path.join(DIR, 'config.json')
const MEMORY_PATH = path.join(DIR, 'memory.json')
/** 长期记忆库（阶段2）。和 memory.json 是两回事：那个是会话原文，这个是"记得的事" */
const MEM_STORE_PATH = path.join(DIR, 'memory-store.json')
const LOG_PATH = path.join(DIR, 'bridge.log')

const ROUTE_PREFIX = '/qq-bridge'

// ---------------------------------------------------------------- NapCat 启停用到的路径
// ★ 2026-10-17 改成**配置项**（`napcat.launcher` / `napcat.qrPath`），默认留空 = 不启用启停按钮。
//   以前这两个路径是写死的开发机绝对路径，换台机器必然指向不存在的地方 —— 发布版不能带这种东西。
const DEFAULT_CONFIG = {
  enabled: true,
  napcat: { url: 'ws://127.0.0.1:3001', accessToken: '', launcher: '', qrPath: '' },
  // historyMode: messages = 真正的多轮（推荐，前缀缓存友好）；flatten = 压平退路。
  // 2026-10-14：原先默认 flatten 是为了绕一个**误判的** bug，真因（assistant 缺 source）已修，见坑 A5。
  model: { provider: 'deepseek-account', model: '', reasoningEffort: 'off', maxTokens: 0, temperature: 0, historyMode: 'messages' },
  // anchors：声音锚点（几句她真说过的话，当"节奏样板"注入 system）。空数组 = 不注入。
  persona: { name: '大肥鱼', system: '', aliases: [], anchors: [] },
  // turn：回合制（骰子已删除）。questionWaitSec=问句多少秒没人接就去看一眼；
  // cooldownSec=两次插话最小间隔；window=判断时看最近几条；waitRetrySec=judge 判 wait 后多久再看。
  reply: { groups: true, private: false, requireAt: true, maxChars: 1200, splitAt: 400, atSenderChance: 60, maxAts: 1, allowSilence: true, turn: { enabled: true, window: 12, questionWaitSec: 10, waitRetrySec: 30, cooldownSec: 45, judgeMaxTokens: 80, judgePersonaChars: 500 } },
  // ★ summaryMaxTokens：压缩调用**单独**限长。
  //   实测教训：以前压缩和聊天共用 model.maxTokens(=10000)，而摘要有 600 字硬上限，
  //   于是模型一次「思考」烧掉 3237~6837 个输出 token 去写 600 字 —— 32 次压缩占掉当天 82% 的输出费用。
  //   同行（amadeus-in-shell）把压缩调用硬编码在 1024，这里取同样的量级。
  // recallLimit / recallMinScore：阶段2 记忆召回（纯数学，零模型调用）
  memory: { keepRounds: 20, summarize: true, summaryMaxTokens: 1536, summaryBudgetChars: 2000, summaryInjectChars: 1200, recallLimit: 2, recallMinScore: 0.35, relationEvolveEvery: 30, daySummaryLines: 60 },
  people: { enabled: true, maxInRoster: 30, dir: '', maxBytes: 10240 },
  vision: { enabled: true, maxImages: 2 },
  // 主动插话额度闸门：默认**关闭**，配了才生效（改配置热加载，不用重启）
  proactive: { enabled: false, cooldownSec: 120, maxPerHour: 6, maxPerDay: 30, quietStart: 0, quietEnd: 0 },
  // 只给设置页用：intro = 页面顶部那段「简介」（可自己改），note = 便签。都不影响任何行为。
  ui: { intro: '', note: '' },
  blacklist: { groups: [], users: [] },
}

/** 运行时状态，给设置界面看 */
const state = {
  connected: false,
  startedAt: Date.now(),
  qq: null,
  nickname: '',
  groupCount: 0,
  groups: [],
  lastReplyAt: 0,
  lastIncomingAt: 0,
  lastError: '',
  // 它自己发出去的消息 id：用来识别「有人引用它的话」（引用回复 = 在跟它说话）。
  // 为什么要这个：QQ 里很多人的习惯是**引用你说过的那句**再接着说，不打 @。
  ownMsgIds: new Set(),
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }) } catch {}
}

/** 日志文件只写 ASCII（PS 5.1 / 记事本按 GBK 读 UTF-8 会乱码，历史踩过的坑） */
function ascii(s) {
  return String(s).replace(/[^\x20-\x7E]/g, '?')
}

function safeJson(v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}

let logStream = null
function log(...parts) {
  const line = new Date().toISOString() + ' ' + parts
    .map((p) => (typeof p === 'string' ? p : safeJson(p)))
    .join(' ')
  try {
    if (!logStream) {
      ensureDir(DIR)
      logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' })
    }
    logStream.write(ascii(line) + '\n')
  } catch {}
  try { console.log('[qq-bridge] ' + line) } catch {}
}

// --------------------------------------------------- 主动发言额度闸门（阶段3）

/**
 * 「主动插话」的额度闸门：防刷屏。**纯本地计数，不花一分钱模型调用。**
 *
 * 为什么需要它：没被 @ 时要不要说话，现在由回合制的 judgeRoom 决定（看内容，不看随机数）。
 * 但判断本身**不知道"刚才已经说过几次"** —— 连着几条都被判 speak，就是一分钟插嘴三次，
 * 群里非常像机器人。判断管"该不该说"，这一层管"扎堆"。
 * （★ 2026-10-17：旧的 `reply.chance` 骰子已从代码里彻底删除，配置里残留的 chance 不再被读取。）
 *
 * 设计取舍（学 xiaoke-qqbot 的 ProactivityBudget，但去掉了它依赖的第三方判定服务）：
 *   · **只卡"主动插话"**：被 @、被叫名字的回复**永远不卡** —— 有人跟你说话你不出声才是没礼貌。
 *   · **peek / commit 分离**：判定时只 peek（看还有没有额度），
 *     **发送成功之后才 commit**（扣额度）。否则模型选择 [沉默] 或发送失败时，额度会白扣。
 *   · 状态放内存：重启归零。额度是"防刷屏"用的，不是计费依据，重启归零可以接受。
 *
 * 配置（config.json → proactive，热加载）：
 *   enabled      总开关，默认 false（**不配就不生效**，避免静默改变现有行为）
 *   cooldownSec  两次主动插话之间至少间隔多少秒，默认 120
 *   maxPerHour   每群每小时最多主动几次，默认 6
 *   maxPerDay    每群每天最多主动几次，默认 30
 *   quietStart / quietEnd  静默时段（小时，0~23，支持跨午夜如 23→7），默认都 0 = 不启用
 */
const budgetState = new Map() // groupId -> { seqs: [{at, unsolicited}], day, dayUnsolicited, lastUnsolicitedAt }
/** 被禁言的群：groupId -> 解禁前不再主动判断的时间点（retcode 1200 触发，见 sendSegments） */
const mutedGroups = new Map()
/** 戳一戳冷却：key = 'group:<群>:<人>' → 上次处理时间。同一个人反复戳不会连回。 */
const pokeCooldown = new Map()
const POKE_COOLDOWN_MS = 30000

function budgetOf(groupId) {
  const k = String(groupId)
  let s = budgetState.get(k)
  if (!s) { s = { seqs: [], day: '', dayUnsolicited: 0, lastUnsolicitedAt: 0 }; budgetState.set(k, s) }
  return s
}

/** 本地日期串（用于每日计数归零） */
function localDayKey(now) {
  const d = new Date(now)
  const p = (n) => (n < 10 ? '0' : '') + String(n)
  return String(d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 判断"现在"是否落在静默时段内（支持跨午夜，如 23 → 7） */
function inQuietHours(now, startH, endH) {
  const a = Number(startH), b = Number(endH)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  if (a === b) return false // 起止相同 = 不启用
  const h = new Date(now).getHours()
  return a < b ? (h >= a && h < b) : (h >= a || h < b)
}

/**
 * 看现在还有没有"主动插话"的额度。不改状态。
 * @returns {{ok: boolean, why?: string}} ok=false 时 why 说明被哪一层拦下（写日志用）
 */
/**
 * 读一个"可关掉的上限"配置。
 *
 * ★ 必须区分「没填」和「显式填 0」—— 这里踩过一次：
 *   旧写法 `Number(x) > 0 ? Number(x) : 默认值` 把**显式 0 当成"没填"**，
 *   于是"冷却填 0 = 不要冷却"根本做不到，静默回落到默认 120 秒。
 *   实测症状：A 档（冷却 0）实际按 C 档（冷却 120）在跑，配置看起来完全正常。
 *   ⇒ 规则：**undefined / null / 空串 / 非数字 → 用默认；数字（含 0）→ 用它**。
 */
function budgetLimit(v, def) {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : def
}

function peekBudget(cfg, groupId, now) {
  const b = cfg.proactive || {}
  if (b.enabled !== true) return { ok: true }
  if (inQuietHours(now, b.quietStart, b.quietEnd)) {
    return { ok: false, why: 'quiet-hours ' + String(b.quietStart) + '-' + String(b.quietEnd) }
  }
  const s = budgetOf(groupId)
  // 冷却 = 0 表示**真的不要冷却**（不是"用默认"）
  const cooldown = budgetLimit(b.cooldownSec, 120) * 1000
  if (cooldown > 0 && s.lastUnsolicitedAt && now - s.lastUnsolicitedAt < cooldown) {
    const left = Math.ceil((cooldown - (now - s.lastUnsolicitedAt)) / 1000)
    return { ok: false, why: 'cooldown ' + String(left) + 's left' }
  }
  s.seqs = s.seqs.filter((x) => now - x.at < 3600000)
  const un = s.seqs.filter((x) => x.unsolicited).length
  const maxHour = budgetLimit(b.maxPerHour, 6)
  if (maxHour > 0 && un >= maxHour) return { ok: false, why: 'hourly cap ' + String(un) + '/' + String(maxHour) }
  const day = localDayKey(now)
  const dayUn = s.day === day ? s.dayUnsolicited : 0
  const maxDay = budgetLimit(b.maxPerDay, 30)
  if (maxDay > 0 && dayUn >= maxDay) return { ok: false, why: 'daily cap ' + String(dayUn) + '/' + String(maxDay) }
  return { ok: true }
}

/** 真的发出去了才扣额度。unsolicited=false（被 @）也要记，用来喂冷却/h 上限 */
function commitBudget(groupId, unsolicited, now) {
  const s = budgetOf(groupId)
  const day = localDayKey(now)
  if (s.day !== day) { s.day = day; s.dayUnsolicited = 0 }
  s.seqs.push({ at: now, unsolicited: !!unsolicited })
  s.seqs = s.seqs.filter((x) => now - x.at < 3600000)
  if (unsolicited) { s.lastUnsolicitedAt = now; s.dayUnsolicited += 1 }
}

// ------------------------------------------------------------ 配置与记忆读写

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k])
  return out
}

function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

function loadConfig() {
  ensureDir(DIR)
  let raw = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
    catch (e) { log('config.json parse failed, using defaults:', e?.message) }
  } else {
    try { writeJsonAtomic(CONFIG_PATH, DEFAULT_CONFIG) } catch (e) { log('write default config failed:', e?.message) }
  }
  return deepMerge(DEFAULT_CONFIG, raw)
}

/**
 * 原地更新配置对象：所有闭包持有的是同一个引用，
 * 所以热加载后立刻生效，不需要重连或重启。
 */
function applyConfigInto(target, next) {
  for (const k of Object.keys(target)) delete target[k]
  Object.assign(target, next)
}

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8')) } catch { return { sessions: {} } }
}

/**
 * 我们自己最后一次写盘的内容指纹。
 *
 * ★ 为什么不用"时间窗"（旧写法 `memorySelfWriteUntil = now + 800ms`）：
 *   那是个**会吞掉真实外部改动**的设计 —— 机器人回复很频繁（实测 6 分钟 36 条），
 *   每次回复都设一次窗口，手改文件只要落进窗口就被当成"自己写的"忽略掉，
 *   于是"改了文件没反应"。实测踩到：热加载第一次测试就因为这个没触发。
 *   改成**内容指纹**：只有"磁盘内容 == 我们自己刚写的内容"才忽略，精确且无误伤。
 */
let memoryLastWrittenHash = ''

function hashOf(s) {
  // 不引 crypto（插件只依赖 node 内置且要保持轻），内容比对用简单校验和足够
  let h = 0
  const str = String(s)
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0 }
  return String(h) + ':' + String(str.length)
}

function saveMemory(mem) {
  try {
    const text = JSON.stringify(mem, null, 2)
    memoryLastWrittenHash = hashOf(text)
    const tmp = MEMORY_PATH + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, MEMORY_PATH)
  } catch (e) { log('memory write failed:', e?.message) }
}

/**
 * 把磁盘上的记忆**原地**灌进运行中的对象。
 * 必须原地改（delete 旧键 + Object.assign），因为 startBridge / handleGroup
 * 持有的是同一个引用 —— 换新对象它们看不到（和 applyConfigInto 一个道理）。
 */
function applyMemoryInto(target, next) {
  if (!next || typeof next !== 'object') return
  const sessions = (next.sessions && typeof next.sessions === 'object') ? next.sessions : {}
  for (const k of Object.keys(target)) delete target[k]
  Object.assign(target, { sessions })
}

/**
 * 监听 memory.json：**外面改了文件就自动重载**，不用重启。
 *
 * 为什么需要它（2026-10-14 的真实事故）：
 *   插件启动时只 loadMemory() 一次，之后整场持有内存副本；
 *   每次回复结束又 saveMemory() **整份覆写**文件。
 *   于是"手改 memory.json"必然被内存副本盖掉 —— 那晚我恢复的 48 轮被盖成 18 轮，就是这条。
 *   加了这个 watch，memory.json 的行为就和 people/*.md 一致了：改完即生效。
 *
 * 注意：这个 watcher 只能解决"外部改 → 内存"。反向的"内存 → 外部"仍然是整份覆写，
 *      所以**改文件最好在机器人空闲时做**（它一回复就可能盖回去）。
 */
function watchMemory(mem) {
  try {
    let fired = 0
    const watcher = fs.watch(MEMORY_PATH, { persistent: false }, () => {
      fired++
      setTimeout(() => {
        try {
          // 读原始文本，用**内容指纹**判断这次改动是不是我们自己写的（精确，不受时序影响）
          let text = ''
          try { text = fs.readFileSync(MEMORY_PATH, 'utf8') } catch { return }
          const isSelfWrite = hashOf(text) === memoryLastWrittenHash && memoryLastWrittenHash !== ''
          if (isSelfWrite) {
            log('memory watch fired #' + String(fired) + ' -> our own write, skipped')
            return
          }
          let fresh
          try { fresh = JSON.parse(text) } catch { log('memory watch: disk file is not valid JSON, ignored'); return }
          // 内容和我们内存里一样 → 不是有效的外部改动（可能只是 touch）
          if (JSON.stringify(fresh) === JSON.stringify(mem)) {
            log('memory watch fired #' + String(fired) + ' -> content identical, skipped')
            return
          }
          applyMemoryInto(mem, fresh)
          log('memory.json changed -> hot reloaded (sessions=' + String(Object.keys(mem.sessions || {}).length) + ')')
        } catch (e) { log('memory hot reload failed:', e?.message) }
      }, 200)
    })
    // 建起来没有、在听哪个文件 —— 不写这句，"watcher 没建起来"和"建了但没触发"分不清
    log('memory watcher registered: ' + ascii(MEMORY_PATH))
    return () => { try { watcher.close() } catch {} }
  } catch (e) {
    log('watch memory failed:', e?.message)
    return null
  }
}

// ------------------------------------------------------- 长期记忆库（阶段 2）

let memStore = null

/**
 * 懒加载记忆库。空库时把**积压的待审区**灌进来 ——
 * 那 30 条是已经花过钱抽出来、却从来没有进过模型上下文的东西。
 */
function storeOf() {
  if (memStore) return memStore
  memStore = loadStore(MEM_STORE_PATH)
  if (!Array.isArray(memStore.items) || memStore.items.length === 0) {
    try {
      const seeds = parsePending(fs.readFileSync(PENDING_NOTES_PATH, 'utf8'))
      let n = 0
      for (const s of seeds) if (addItem(memStore, { ...s, kind: 'event', importance: 3 })) n++
      if (n > 0) { log('memory store seeded from pending-notes: ' + String(n) + ' items'); saveStoreNow() }
    } catch (e) { log('memory seed failed:', e?.message) }
  }
  return memStore
}

function saveStoreNow() {
  if (!memStore) return
  const err = saveStore(MEM_STORE_PATH, memStore)
  if (err) log('memory store write failed:', err)
}

/** 写一条记忆；返回是否新增（重复的只加强） */
function memoryAdd(o) {
  const it = addItem(storeOf(), o)
  if (!it) return false
  saveStoreNow()
  return true
}

// ------------------------------------------------------------------ 模型调用

let cachedSelection = null

/** 最近一次"模型空回复"的具体原因（给状态页和日志看） */
let lastAskFailure = ''

/** 最近一次模型调用返回的用量对象（先原样记录，等见过真实结构再据它做统计） */
let lastUsage = null

/**
 * 关系演化入口 —— 由 startBridge 启动时挂上（evolveRelation 是闭包里的函数，
 * 路由注册在另一处，用这个钩子接过来；没启动就是 null）。
 */
let relationEvolver = null

/** provider/model 优先用配置里的；没写就运行时问 DSH 要默认值，避免写死字符串 */
/**
 * 模型选择。
 * 优先级：**该发言者档案里的 `model:` 覆盖** > 全局 cfg.model.model > 目录默认 > 兜底。
 * 单人覆盖写在人物档案的 front matter 里（一人一档，改完立即生效，不用重启）。
 */
async function resolveSelection(ctx, cfg, userKey) {
  const base = await resolveBaseSelection(ctx, cfg)
  if (userKey) {
    try {
      const rec = readPersonFile(cfg, userKey)
      if (rec && rec.model && String(rec.model).trim()) {
        const picked = {
          provider: (rec.modelProvider && String(rec.modelProvider).trim()) || base.provider,
          model: String(rec.model).trim(),
        }
        if (picked.model !== base.model) {
          log('model override from person file: qq=' + String(userKey) + ' -> ' + picked.model)
        }
        return picked
      }
    } catch (e) { log('person model override failed (using default):', e?.message) }
  }
  return base
}

async function resolveBaseSelection(ctx, cfg) {
  if (cfg.model && cfg.model.model) {
    return { provider: cfg.model.provider || 'deepseek-account', model: cfg.model.model }
  }
  if (cachedSelection) return cachedSelection
  try {
    // 必须走 ctx.get(...)：直接写 ctx.sessionController 会在未 inject 时抛
    // "cannot get property ... without inject"（本机日志里实测踩到过）
    const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    const catalog = sc && typeof sc.modelCatalog === 'function' ? await sc.modelCatalog() : null
    const d = catalog?.default
    if (d?.provider && d?.model) {
      cachedSelection = { provider: d.provider, model: d.model }
      log('model from modelCatalog().default:', cachedSelection)
      return cachedSelection
    }
  } catch (e) { log('modelCatalog() unavailable:', e?.message) }
  try {
    const want = (cfg.model && cfg.model.provider) || 'deepseek-account'
    const providers = ctx.llm.listProviders?.() ?? []
    const hit = providers.find((p) => p?.id === want) || providers[0]
    if (hit?.id) {
      const models = await ctx.llm.listModels(hit.id)
      if (models?.[0]?.id) {
        cachedSelection = { provider: hit.id, model: models[0].id }
        log('model from listModels():', cachedSelection)
        return cachedSelection
      }
    }
  } catch (e) { log('listModels() unavailable:', e?.message) }
  cachedSelection = { provider: (cfg.model && cfg.model.provider) || 'deepseek-account', model: 'deepseek-flash' }
  log('model fell back to:', cachedSelection)
  return cachedSelection
}

/** attachments 服务只认这 4 种媒体类型（api-catalog.js ImageMediaType 原文） */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 从 URL 或文件名猜媒体类型（猜不出就按 jpeg） */
function guessMediaType(url, file) {
  const s = (String(file || '') + ' ' + String(url || '')).toLowerCase()
  if (s.includes('.png')) return 'image/png'
  if (s.includes('.webp')) return 'image/webp'
  if (s.includes('.gif')) return 'image/gif'
  return 'image/jpeg'
}

/**
 * 把 QQ 图片转成模型能吃的内容块。
 *
 * 原文依据（app.asar:/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js）：
 *   interface ImageBlock { type:'image'; attachment: ImageAttachmentRef; offloaded?: true }   // :5267
 *   interface SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name?: string } // :6231
 *   ImageMediaType = 'image/png'|'image/jpeg'|'image/webp'|'image/gif'                        // :5271
 * ⇒ **没有 url / base64 字段**，必须：下载成 Uint8Array → attachments.saveImage() → 拿 ref。
 *
 * ⚠️ 另一个坑（调研结论）：模型不支持图片时**不报错**，而是把图静默换成一段纯文本
 *    （dsh-llm-deepseek:252-257 的 textOnlyPrice）。所以必须先探测 inputModalities，
 *    否则就是"模型装作没看见图"。
 */
async function buildImageBlocks(ctx, cfg, images, userKey) {
  const out = []
  if (!cfg || cfg.vision?.enabled === false) return out
  if (!Array.isArray(images) || images.length === 0) return out
  if (typeof fetch !== 'function') { log('vision: no global fetch, skipped'); return out }

  let att
  try { att = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined } catch {}
  if (!att || typeof att.saveImage !== 'function') { log('vision: attachments service unavailable, skipped'); return out }

  // ① 模型支持图像吗？（不支持就别费劲下载了，传了也会被换成占位文本）
  let canSee = true
  try {
    const sel = await resolveSelection(ctx, cfg, userKey)
    if (typeof ctx.llm.resolveModelInfo === 'function') {
      const info = await ctx.llm.resolveModelInfo(sel.provider, sel.model)
      if (info && Array.isArray(info.inputModalities)) canSee = info.inputModalities.indexOf('image') >= 0
      log('vision: model=' + sel.model + ' inputModalities=' + JSON.stringify(info?.inputModalities ?? null) + ' canSee=' + String(canSee))
    }
  } catch (e) { log('vision: resolveModelInfo failed (assume yes):', e?.message) }
  if (!canSee) return out

  const maxN = Math.max(0, Number(cfg.vision?.maxImages) || 2)
  let maxBytes = 20 * 1024 * 1024
  try { if (att.imageLimits && att.imageLimits.maxImageBytes) maxBytes = Number(att.imageLimits.maxImageBytes) } catch {}

  for (const img of images.slice(0, maxN)) {
    try {
      const res = await fetch(img.url, { redirect: 'follow' })
      if (!res.ok) { log('vision: download failed http=' + String(res.status)); continue }
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength === 0) { log('vision: downloaded empty image'); continue }
      if (buf.byteLength > maxBytes) { log('vision: image too large ' + String(buf.byteLength) + ' > ' + String(maxBytes)); continue }
      let mediaType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!IMAGE_MEDIA_TYPES.has(mediaType)) mediaType = guessMediaType(img.url, img.file)
      if (!IMAGE_MEDIA_TYPES.has(mediaType)) { log('vision: unsupported mediaType ' + mediaType); continue }
      const ref = await att.saveImage({ data: buf, mediaType: mediaType, name: img.file || ('qq-image.' + mediaType.split('/')[1]) })
      out.push({ type: 'image', attachment: ref })
      log('vision: attached image ' + mediaType + ' ' + String(buf.byteLength) + ' bytes')
    } catch (e) {
      log('vision: image failed:', e?.message)
    }
  }
  return out
}

/** 只调模型，不传 tools —— 这就是"只能聊天"的技术保证。 */
/**
 * @param askOpts.maxTokens 覆盖 cfg.model.maxTokens（压缩/摘要这类"成品很短"的调用要单独压小，
 *   否则模型会用聊天档位的大预算去思考如何写 600 字摘要，白烧输出 token）
 */
async function ask(ctx, cfg, system, history, userText, signal, images, userKey, askOpts) {
  const sel = await resolveSelection(ctx, cfg, userKey)

  // ★★ 消息构造（2026-10-14 探针实验澄清，**推翻了原先的 A1 结论**）：
  //
  //   原先以为"messages 里出现 assistant 轮就必崩"，所以把历史压平成一条 user。
  //   用 GET /qq-bridge/_probe 做 A/B/C/D 对照（真模型，4 次调用）后的**事实**：
  //     A 手工拼 assistant、**没有 source**  → finish=error
  //        failure=[UNKNOWN] Cannot read properties of undefined (reading 'replayState')  ← 复现
  //     B 同样内容 + source:{kind:'model',provider,model}  → finish=stop，正常回话 ✅
  //     C B 再多带一个 replayState 信封                      → 一样正常（⇒ replayState **不必要**）
  //     D 不带历史（对照）                                   → 正常
  //
  //   真因：适配器读的是 `message.source.replayState`。我们没给 `source`，
  //   于是 `source` 本身是 undefined → 炸在 **source** 上，报错却指向 `replayState`。
  //   适配器里那个"缺失即优雅降级"的守卫（`if (source.replayState === void 0) return foreignAssistant(...)`）
  //   在 `toPiAssistant` 里，**根本轮不到它**。
  //   ⇒ **不是 DSH 的 bug，是我们消息形状不对**。修法就一行：补上 `source`。
  //
  // 两种模式都保留：
  //   · 'messages'（现在默认）—— 真正的多轮，历史前缀逐字节一致，前缀缓存能吃到整个历史
  //   · 'flatten' —— 压平成一条 user，作为**退路**保留（万一将来适配器又变）
  //   切回 flatten 不会让机器人失忆：两种记法它都读得懂（flatten 用「我: 」前缀标自己）。
  const mode = cfg.model?.historyMode === 'messages' ? 'messages' : 'flatten'
  const messages = []
  // 图片块只构建一次，两种模式都要用（messages 模式原先漏了，会静默丢图）
  const imageBlocks = await buildImageBlocks(ctx, cfg, images, userKey)
  if (mode === 'messages') {
    for (const m of history) {
      // ★ 时间戳（A1）：没有 [HH:MM] 它分不清"刚才"和"两小时前"，会把旧事当现在讲（实测出现过）。
      //   只加一次就冻住 —— 老轮次文本逐字节不变，前缀缓存照样命中。
      //
      // ⚠️⚠️ **只给别人的话加，绝不给"我自己说过的话"加**（2026-10-14 实测踩坑）：
      //   起初两边都加，结果模型照着模仿，把自己 16% 的回复也写成 `[23:24] 会，懒得用。`
      //   —— **那些时间戳真的发到群里去了**（83 条里 13 条）。自己说的话不加戳，
      //   它就没有可模仿的样板，同时也更能分清"哪句是我说的"（这正是 assistant role 的语义）。
      const stamp = (m.at && m.role !== 'assistant') ? '[' + fmtClock(m.at) + '] ' : ''
      const t = stamp + String(m.content ?? '')
      if (m.role === 'assistant') {
        // ★ 关键：必须带 source，否则复现 A 变体的崩溃
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: t }],
          source: { kind: 'model', provider: sel.provider, model: sel.model },
        })
      } else {
        messages.push({ role: 'user', content: [{ type: 'text', text: t }] })
      }
    }
    // ★ 图片必须也带上（用外面构建好的 imageBlocks）。
    //   原先这个分支压根没调 buildImageBlocks，一切到 messages 模式就"静默看不见图"——
    //   图被默默丢掉、日志里一个字都不报，最难查。
    messages.push({ role: 'user', content: [{ type: 'text', text: userText }].concat(imageBlocks) })
  } else {
    let text = userText
    if (history.length > 0) {
      // ★ A1：给历史每一轮加时间戳。没有时间戳时它分不清"刚才"和"两小时前"，
      //   会把旧事当现在讲（实测出现过）。旧数据没有 at 字段就不标，不编时间。
      const transcript = history
        .map((m) => {
          const stamp = m.at ? '[' + fmtClock(m.at) + '] ' : ''
          return stamp + (m.role === 'assistant' ? '我: ' + String(m.content ?? '') : String(m.content ?? ''))
        })
        .join('\n')
      text = '【之前的对话】（每行开头是时间，越靠下越新）\n' + transcript + '\n\n【现在】\n' + userText
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: text }].concat(imageBlocks) })
  }

  // ★ 阶段5：把"每轮都会变"的运行上下文（人物档案 / 摘要 / 记忆召回）插到
  //   **消息序列末尾、当前消息之前**。这样 system 逐字节一致、历史段也稳定，
  //   上游的前缀缓存才能从 system 一路吃到上一轮的历史。
  //   位置理由：最后一条仍然是"群友刚说的话"，模型不会对着资料自说自话。
  if (askOpts && askOpts.contextBlock) {
    const at = Math.max(messages.length - 1, 0)
    messages.splice(at, 0, { role: 'user', content: [{ type: 'text', text: String(askOpts.contextBlock) }] })
  }

  const opts = {
    provider: sel.provider,
    model: sel.model,
    system,
    messages,
    signal,
  }
  // 关键修复：reasoningEffort 默认是 'high'（思考默认开着）。
  // 实测出现过"光想不说 → 正文块数为 0 → 适配器抛 EMPTY_RESPONSE → 被折成一个 finish 帧"，
  // 于是机器人一个字都不回。聊天机器人不需要想半天，显式关掉。
  // reasoningEffort：默认跟配置；但**调用方可以覆盖**。判断/摘要这类短输出任务必须关思考，
  // 否则思考把 maxTokens 吃光 → finish=max-tokens → 正文为空（2026-10-17 真实踩到）
  const effortOverride = askOpts && Object.prototype.hasOwnProperty.call(askOpts, 'reasoningEffort')
    ? askOpts.reasoningEffort
    : undefined
  const effort = effortOverride !== undefined ? effortOverride : cfg.model?.reasoningEffort
  if (effort) opts.reasoningEffort = effort
  // 调用方指定了 maxTokens 就优先用它（摘要/压缩走这条，别用聊天档位的大预算）
  const overrideMax = Number(askOpts && askOpts.maxTokens)
  const maxTokens = Number.isFinite(overrideMax) && overrideMax > 0
    ? overrideMax
    : Number(cfg.model?.maxTokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) opts.maxTokens = maxTokens
  // 不填就不传（保持桌面端默认）；发现它爱复读时可以调高，例如 1.0~1.3
  const temperature = Number(cfg.model?.temperature)
  if (Number.isFinite(temperature) && temperature > 0) opts.temperature = temperature

  let out = ''
  let finishKind = ''
  let failureText = ''
  let usage = null
  let reasoningChars = 0
  const sawChunkTypes = []
  for await (const chunk of ctx.llm.stream(opts)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text
    } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoningChars += chunk.text.length
    } else if (chunk?.type === 'finish') {
      // FinishReason = { kind, failure? }，kind ∈ stop | tool-calls | max-tokens | aborted | error。
      // 适配器抛的异常被 DSH 折成一个 finish 帧（不抛给调用方），所以真因只能从 failure 里读。
      const r = chunk.reason || {}
      finishKind = String(r.kind || '')
      if (r.failure) failureText = '[' + String(r.failure.code || '') + '] ' + String(r.failure.message || '')
      log('finish: kind=' + finishKind + (failureText ? ' failure=' + failureText : ''))
    } else if (chunk?.type === 'usage') {
      usage = chunk.usage
    }
    if (chunk?.type && sawChunkTypes.length < 12 && !sawChunkTypes.includes(chunk.type)) {
      sawChunkTypes.push(chunk.type)
    }
  }

  const text = out.trim()
  lastAskFailure = ''
  lastUsage = usage || null
  if (text && usage) log('usage: ' + safeJson(usage))
  if (!text) {
    let why = 'finishKind=' + (finishKind || '(none)')
    if (failureText) why += ' failure=' + failureText
    if (finishKind === 'max-tokens') why += ' (truncated by length limit)'
    if (finishKind === 'stop') why += ' (stop with no content = classic EMPTY_RESPONSE)'
    if (finishKind === 'error' || finishKind === 'aborted') why += ' (adapter threw)'
    why += ' reasoningChars=' + String(reasoningChars) +
      ' chunkTypes=' + sawChunkTypes.join(',') +
      ' usage=' + safeJson(usage)
    lastAskFailure = why
    log('EMPTY model text. ' + why)
  }
  return text
}

/** 把错误码翻成人话（错误对象是鸭子类型：看 .code，不要依赖 instanceof） */
function humanError(err) {
  const code = err && typeof err.code === 'string' ? err.code : ''
  switch (code) {
    case 'ACCOUNT_SIGN_IN_REQUIRED':
    case 'ACCOUNT_TOKEN_INVALID':
    case 'INVALID_CREDENTIAL':
    case 'AUTH':
      return '（我这边 DeepSeek 登录态失效了，需要有人在桌面端重新登录一下账号）'
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
      return '（额度用完了）'
    case 'RATE_LIMIT':
      return '（被限流了，等会儿再试）'
    case 'CONTEXT_WINDOW_EXCEEDED':
      return '（上下文太长了）'
    case 'MISSING_CREDENTIAL':
      return '（没找到可用的凭据）'
    default:
      return '（我这边出错了：' + (code || (err?.message ?? '未知错误')) + '）'
  }
}

// ------------------------------------------------------------------ 记忆管理

function sessionOf(mem, key) {
  if (!isPlainObject(mem.sessions)) mem.sessions = {}
  if (!isPlainObject(mem.sessions[key])) {
    mem.sessions[key] = { summary: '', rounds: [], updatedAt: 0 }
  }
  const s = mem.sessions[key]
  if (!Array.isArray(s.rounds)) s.rounds = []
  if (typeof s.summary !== 'string') s.summary = ''
  return s
}

// ---------------------------------------------------------------- 标记与常量

/** 模型用来把"值得长期记住的事"写进人物档案的标记 */
const FACT_RE = /\[记\s*[:：]\s*([^\[\]]{1,200})\]/g
/** B1：模型觉得"这条不值得回"时只输出这个标记 → 插件不发任何消息（给它一个正当的沉默出口） */
const SILENT_RE = /\[沉默\]/

/** 表情包功能已在 2026-10-17 按用户要求**整块删除**（代码/配置/设置页都不再有）。
 *  只留这一条兜底：模型万一还残留 [表情:x] 标记，出口处静默掐掉，绝不把标记发到群里。 */
const STICKER_MARKER_RE = /\[(?:表情|贴图|sticker|face)\s*[:：]\s*[^\[\]]{1,40}\]/g

/** 按 QQ 号或昵称找出一个人（模型写 [@xxx] 时用） */
function resolvePersonQQ(cfg, token) {
  const t = String(token || '').trim().replace(/^@/, '')
  if (!t) return ''
  if (/^\d{5,15}$/.test(t)) return t
  try {
    const pd = peopleDir(cfg)
    for (const f of fs.readdirSync(pd)) {
      if (!f.endsWith('.md')) continue
      const qq = f.replace(/\.md$/, '')
      const nm = personNameOf(cfg, qq)
      if (nm && (nm === t || nm.indexOf(t) >= 0 || t.indexOf(nm) >= 0)) return qq
    }
  } catch {}
  return ''
}

/** 只读档案头部拿昵称（比整份读进来便宜） */
function personNameOf(cfg, qq) {
  let fd
  try { fd = fs.openSync(personFile(cfg, qq), 'r') } catch { return '' }
  try {
    const buf = Buffer.alloc(512)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return parseFrontMatter(buf.slice(0, n).toString('utf8')).name || ''
  } catch { return '' } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

/**
 * 把回复里的标记换成真正的消息段：
 *   [@QQ号] / [@昵称] -> at 段（这就是"让人收到 @ 提醒"的关键）
 * 认不出的人直接丢掉标记，**绝不把 [@xxx] 原样发到群里**。
 * （2026-10-17：表情包功能删除，这里不再有 [表情:标签] -> image 段 那条路。）
 */
const AT_MARKER_RE = /\[@\s*([^\[\]]{1,40})\]/g

function buildReplySegments(reply, resolveQQ, maxAts) {
  const segments = []
  let text = ''
  let usedAts = 0
  let last = 0
  const flush = () => {
    // 两端都 trim：丢掉 [@xxx] 标记后会留下前导空格，直接进群里很难看
    const t = text.trim()
    if (t) segments.push({ type: 'text', data: { text: t } })
    text = ''
  }
  const atLimit = Number.isFinite(Number(maxAts)) ? Number(maxAts) : 1
  AT_MARKER_RE.lastIndex = 0
  let m
  while ((m = AT_MARKER_RE.exec(reply)) !== null) {
    text += reply.slice(last, m.index)
    last = m.index + m[0].length
    const raw = String(m[1] || '').trim()
    const qq = usedAts < atLimit && typeof resolveQQ === 'function' ? resolveQQ(raw) : ''
    if (qq) {
      flush()
      segments.push({ type: 'at', data: { qq: /^\d+$/.test(qq) ? Number(qq) : qq } })
      text = ' '  // @ 后面留个空格，免得和正文粘在一起
      usedAts++
    } else {
      log('at marker dropped: raw=' + ascii(raw) + ' reason=' + (usedAts >= atLimit ? 'over-limit' : 'unresolved'))
    }
  }
  text += reply.slice(last)
  flush()
  if (segments.length === 0) segments.push({ type: 'text', data: { text: reply } })
  return segments
}

/**
 * 按 maxChars 预算截断文本段（image 段保留）。
 *
 * ★ 2026-10-15 改：**优先收在句子边界**。
 *   原来是无脑 `t.slice(0, budget) + '…'`，把短上限（比如 40 字）用起来之后，
 *   句子会被切在半截：「…今天嫌我…」—— 那不像人打字，像话没说完。
 *   现在按「。！？…；」→「，、」→ 硬切 三级退让，**切不出完整句就不加省略号乱切**。
 */
function truncateSegments(segments, maxChars) {
  if (!maxChars || maxChars <= 0) return segments
  let budget = maxChars
  const out = []
  for (const seg of segments) {
    if (budget <= 0) break
    if (seg.type !== 'text') { out.push(seg); continue }
    const t = String(seg.data?.text ?? '')
    // ★ 换行收口**不看长度**（2026-10-15 二轮改）：规矩是"一条消息就一句话"，
    //   所以哪怕整段没超预算，只要里面有换行，也只发第一句。
    //   之前这条只写在"超预算"分支里 —— 实测漏网：27 字的「第一句。\n第二句。\n第三句…」
    //   总长没超标，于是带着两个换行原样发了出去。
    const nl0 = t.indexOf('\n')
    if (nl0 >= 0) {
      const one = t.slice(0, nl0).trim()
      if (one) { out.push({ type: 'text', data: { text: one } }); budget -= one.length; continue }
    }
    if (t.length <= budget) {
      out.push(seg)
      budget -= t.length
      continue
    }
    // 超出预算：找最后一个句子边界（换行也算），退而求其次找逗号
    const head = t.slice(0, budget)
    // ★ 2026-10-15：**换行 = 第一句就收**。
    //   实测发现 40 字上限拦不住"多"，因为她靠换行塞进**两个想法**：
    //   「你嫌分段。那我不分了。\n刚那句你 @我 问分段，我就当你还在看。」
    //   群里真人是一条消息一个意思，所以第一个换行就是天然的收口位置。
    const nl = head.indexOf('\n')
    if (nl >= 0) {
      const one = head.slice(0, nl).trim()
      if (one) { out.push({ type: 'text', data: { text: one } }); budget = 0; continue }
    }
    const cut = (re) => {
      let last = -1
      for (const m of head.matchAll(re)) last = m.index + m[0].length
      return last
    }
    let end = cut(/[。！？!?…\n]/g)
    if (end < Math.max(8, Math.floor(budget * 0.45))) end = cut(/[，,、；;：:]/g)
    // ★ 兜底：实在找不到任何标点（比如一口气写到底），**硬切但不加省略号**。
    //   这里原来写的是"切不出就整条不发" —— 边界测试实测：41 字无标点的回复会**整条丢掉**，
    //   那比留半句更糟（她直接不吭声了）。宁可硬切。
    if (end <= 0) end = budget
    const piece = head.slice(0, end).trim()
    if (!piece) { budget = 0; break }          // 只有空白 → 不发
    out.push({ type: 'text', data: { text: piece } })
    budget = 0
  }
  return out
}

/**
 * 纯转发（合并转发的聊天记录）的判断。
 *
 * ★ 2026-10-15 加。为什么**不理**而不是"读出来"：
 *   转发记录在 OneBot 里是一个 `forward` 段，只带一个 `id`，**正文要额外调
 *   `get_forward_msg` 才能取**。而 `raw_message` 里的 `[CQ:forward,id=...]` 会被剥掉
 *   （不剥的话 CQ 码会泄进提示词），于是模型只看到一个「（合并转发消息）」占位符
 *   —— 它只能对着空壳瞎说（实测原话：'这合并转发我一打开，里面是空的'，那是**撒谎**）。
 *   要么把内容取出来，要么别理；**不理**是这个场景下最省事也最诚实的做法。
 *
 * 判据：整条消息只有转发段（或转发 + 空白文本）→ 当没看见。
 *   转发**还带着一句话**的不在此列 —— 那种情况那句话本身是有意义的内容。
 */
function isPureForward(segs) {
  if (!Array.isArray(segs) || segs.length === 0) return false
  let hasForward = false
  for (const s of segs) {
    const t = String(s?.type || '')
    if (t === 'forward') { hasForward = true; continue }
    if (t === 'text') { if (String(s?.data?.text ?? '').trim()) return false; continue }
    return false          // 图 / face / json 等任何别的实质段 → 不算"纯转发"
  }
  return hasForward
}

// ------------------------------------------------------------ 待审区（PENDING）

/**
 * 待审区：`~\.dsh\qq-bridge\pending-notes.md`
 *
 * ★ 2026-10-15 新增。为什么必须要有这个东西（修的是"档案可被模型直接改写"这个洞）：
 *   改版前，模型写 `[记:xxx]` 或自动抽取的事实，会**直接落进对应人的档案**，
 *   而档案每轮都注入提示词 ⇒ 模型一句胡话会**永久影响之后每一次对话**，
 *   而且没人有机会拦。群里还有人能诱导它写（持久化提示词注入）。
 *
 *   现在改道：机器想记的东西**只进待审区，绝不进档案**。
 *   待审区**不注入提示词**（模型看不见自己的产物）⇒ 污染不到对话。
 *   人在设置页看到后，觉得该记就自己写进画像 —— 写档案的手，从此只有人这一只。
 */
const PENDING_NOTES_PATH = path.join(DIR, 'pending-notes.md')
const PENDING_MAX = 200               // 待审区最多留多少条（超了砍最老的）
const HTTP_MAX_BODY = 2e6             // 请求体上限（超过就断开，防被打爆）

/**
 * 读一个 JSON 请求体（几条 POST 路由共用）。
 * 回调约定：`cb(errStringOrNull, payload)` —— 出错给**字符串**，方便直接塞进响应。
 * ★ 抽出来的理由：本来 `handlePending` / `handleNote` 各自内联一份一模一样的读体逻辑，
 *   第三次要用时（`/candidate` 的采纳/跳过）才抽 —— 重复三遍就是该抽的信号。
 */
function readJsonBody(req, cb) {
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > HTTP_MAX_BODY) { try { req.destroy() } catch {} }
  })
  req.on('end', () => {
    try { cb(null, JSON.parse(body || '{}')) }
    catch (e) { cb(String(e?.message ?? e), null) }
  })
  req.on('error', (e) => { try { cb(String(e?.message ?? e), null) } catch {} })
}

/** 追加一条待审（纯本地写文件，不调模型）。source: '记' | '抽' */
function appendPending(qq, text, source) {
  const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 200)
  if (!t) return false
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const line = '- [' + stamp + '] (' + String(source || '?') + ') ' + t
    let head = '# 待审记忆（模型想记的东西 —— 采纳与否由人决定）\n' +
      '<!-- 这里的内容**不会**注入提示词，模型也看不见。要把某条写进档案，请到下面「人物档案」里手写。 -->\n'
    let body = ''
    try { body = fs.readFileSync(PENDING_NOTES_PATH, 'utf8') } catch {}
    if (body) {
      const idx = body.indexOf('\n## ')
      head = body.slice(0, idx >= 0 ? idx : body.length)
    }
    let items = loadPending()
    items.push({ at: stamp, source: String(source || '?'), qq: String(qq || ''), text: t })
    if (items.length > PENDING_MAX) items = items.slice(-PENDING_MAX)
    const groups = new Map()
    for (const it of items) {
      if (!groups.has(it.qq)) groups.set(it.qq, [])
      groups.get(it.qq).push(it)
    }
    let out = head.trimEnd() + '\n'
    for (const [g, list] of groups) {
      out += '\n## ' + (g || '(未知)') + '\n'
      for (const it of list) out += '- [' + it.at + '] (' + it.source + ') ' + it.text + '\n'
    }
    fs.writeFileSync(PENDING_NOTES_PATH, out, 'utf8')
    return true
  } catch (e) { log('appendPending failed:', e?.message); return false }
}

/** 读回待审区（结构化）。格式不认识的行直接忽略，不抛。 */function loadPending() {
  let text = ''
  try { text = fs.readFileSync(PENDING_NOTES_PATH, 'utf8') } catch { return [] }
  const out = []
  let cur = ''
  for (const line of String(text).split(/\r?\n/)) {
    const h = /^##\s+(\S+)\s*$/.exec(line)
    if (h) { cur = h[1].trim(); continue }
    const m = /^-\s*\[([^\]]+)\]\s*\(([^)]*)\)\s*(.+)$/.exec(line.trim())
    if (!m) continue
    out.push({ at: m[1].trim(), source: m[2].trim(), qq: cur, text: m[3].trim() })
  }
  return out
}

/**
 * 待审条目的**去重键**（时间 + 内容）。用于"跳过/采纳后不再出现"。
 * 刻意**不含 qq**：同一个人在两条不同时间的同一句话，也该各算一条。
 */
function pendingKey(it) {
  return String(it?.at || '') + '|' + String(it?.text || '')
}

/** 从待审区**精确移除若干条**（按 key），其余原样保留。返回移除条数。 */
function removePending(keys) {
  const want = new Set((keys || []).map(String))
  if (want.size === 0) return 0
  let text = ''
  try { text = fs.readFileSync(PENDING_NOTES_PATH, 'utf8') } catch { return 0 }
  const head = text.slice(0, (() => { const i = text.indexOf('\n## '); return i >= 0 ? i : text.length })())
  const kept = loadPending().filter((it) => !want.has(pendingKey(it)))
  const groups = new Map()
  for (const it of kept) {
    if (!groups.has(it.qq)) groups.set(it.qq, [])
    groups.get(it.qq).push(it)
  }
  let out = head.trimEnd() + '\n'
  for (const [g, list] of groups) {
    out += '\n## ' + (g || '(未知)') + '\n'
    for (const it of list) out += '- [' + it.at + '] (' + it.source + ') ' + it.text + '\n'
  }
  try { fs.writeFileSync(PENDING_NOTES_PATH, out, 'utf8') } catch (e) { log('removePending failed:', e?.message); return 0 }
  return want.size
}

// ------------------------------------------------------- 待审提纯（挑 1 条待采纳）

/** 「已跳过」与候选缓存：`~\.dsh\qq-bridge\pending-seen.json` */
const PENDING_SEEN_PATH = path.join(DIR, 'pending-seen.json')
const PENDING_SEEN_MAX = 500          // 跳过记录最多留多少条（超了砍最老的）

function loadSeen() {
  try {
    const j = JSON.parse(fs.readFileSync(PENDING_SEEN_PATH, 'utf8'))
    return { skipped: Array.isArray(j.skipped) ? j.skipped.map(String) : [], cached: j.cached || null }
  } catch { return { skipped: [], cached: null } }
}
function saveSeen(o) {
  const skipped = (o.skipped || []).slice(-PENDING_SEEN_MAX)
  try { fs.writeFileSync(PENDING_SEEN_PATH, JSON.stringify({ skipped, cached: o.cached || null }, null, 2), 'utf8') } catch (e) { log('saveSeen failed:', e?.message) }
}

/** 待审区内容的指纹 —— 变了才重新问模型（防止每次开设置页都花一次调用） */
function pendingHash(items) {
  return hashOf(items.map(pendingKey).join('\n'))
}

/**
 * 【提纯】从待审区里挑出**全局最值得记的 1 条**，改写成人话，并归到画像标签。
 *
 * ★ 2026-10-15 加。为什么要它：待审区是"模型想记的原始流水"，实测 12 条里
 *   一半是噪音 —— 一次性事件（"问我是不是大肥鱼"）、归错层的观察、带句号的
 *   观察笔记、甚至混进了"人给我的指令"。让人自己一条条读、自己归类、自己改写，
 *   等于把整理工作全推给人，于是这块就没用了。
 *
 * 设计要点（都是刻意的）：
 *   · **只出 1 条**：减少打扰，让人只做"同意/不同意"这一次决定
 *   · **只提"长期有用"的**：一次性事件直接丢，宁可不提（宁可漏，不要烦）
 *   · **改写成人话并归标签**：产出直接能进档案对应字段，不用人再想措辞
 *   · **机器仍然不写档案**：这里只产出**提案**，落盘必须由人在设置页点采纳
 *   · 结果按待审区指纹缓存：内容没变就不重复调模型
 *
 * @returns { provided, reason?, cached?, item?, qq?, name?, label?, text? }
 */
async function getAdoptionCandidate(ctx, cfg) {
  const all = loadPending()
  const seen = loadSeen()
  const skipSet = new Set(seen.skipped)
  const fresh = all.filter((it) => !skipSet.has(pendingKey(it)))
  if (fresh.length === 0) {
    return { provided: false, reason: all.length === 0 ? '待审区是空的' : '剩下的都被你跳过过了' }
  }

  const h = pendingHash(fresh)
  if (seen.cached && seen.cached.hash === h && seen.cached.item) {
    return { provided: true, cached: true, ...seen.cached.item, remaining: fresh.length }
  }

  // 给模型看：条目 + 这个人已有的画像（好让它判断"是不是已经有了"）
  const byQQ = new Map()
  for (const it of fresh) {
    if (!byQQ.has(it.qq)) byQQ.set(it.qq, [])
    byQQ.get(it.qq).push(it)
  }
  const lines = []
  for (const [qq, list] of byQQ) {
    let name = ''
    let prof = {}
    try { const rec = readPersonFile(cfg, qq); name = rec.name || ''; prof = rec.profile || {} } catch {}
    lines.push('■ ' + (name || '(无名)') + '(' + qq + ')')
    const have = PROFILE_RENDER_LABELS.filter((k) => prof[k]).map((k) => k + '：' + prof[k])
    if (have.length) lines.push('  已有画像：' + have.join(' ｜ '))
    for (const it of list) lines.push('  - [' + it.source + '] ' + it.text)
  }

  let raw = ''
  try {
    raw = await ask(
      ctx, cfg,
      '你在给 QQ 群机器人的**人物档案**做提纯。下面是一堆"机器人自己记下来的原始流水"，' +
      '里面混着三类东西：**有长期价值的特征**、**只发生过一次的事件**、**与已有画像重复的**。\n' +
      '你的任务：**只挑出 1 条最值得写进档案的**，改写成人话，并归到最合适的标签。\n' +
      '【什么算值得记】会反复出现的：性格、说话习惯/沟通方式、身份、稳定偏好、跟机器人固定的关系或称呼要求。\n' +
      '【什么不要挑】只发生过一次的事（"问我是不是谁""让我退下"）、情绪波动、' +
      '与"已有画像"重复的、以及**不是人物信息的条目**（比如"某人让机器人别提某件事"这种指令）。\n' +
      '【改写要求】写成**一行短语**，像档案里该有的样子：\n' +
      '  · 去掉"说话爱用…这种观察口吻"，直接写「爱用『杂鱼』这类词怼人」\n' +
      '  · 不要句尾句号，不要日期，不要"今晚/那天"这类时间词\n' +
      '  · 20 字以内\n' +
      '【标签只能从这五个里选】身份 / 性格 / 沟通方式 / 关系 / 注意\n' +
      '【输出】只输出一个 JSON 对象，不要别的字。没有一条值得记就输出 {"none":true}。格式：\n' +
      '{"qq":"QQ号","label":"标签","text":"改写后的一行"}',
      [],
      lines.join('\n'),
      undefined, undefined, undefined,
      // ★ ⚠️ 这个预算**必须够大**：开着思考时，思考 token 和正文**共用同一个预算**。
      //   原先这里写死 300 —— 实测思考一吃就空（`EMPTY model text ... reasoningChars=899`），
      //   提纯永远返回"没有输出"。低档思考也救不了，因为问题在预算不在档位。
      //   现在读配置、默认 3000（正文只要几十 token，多出来的全是留给思考的）。
      { maxTokens: Number(cfg.memory?.factsMaxTokens) || 3000 },
    )
  } catch (e) {
    log('candidate distill failed:', e?.message)
    return { provided: false, reason: '提纯调用失败：' + String(e?.message || e) }
  }
  if (!raw) return { provided: false, reason: '提纯没有输出' }

  const s = String(raw).replace(/```(?:json)?/gi, '').trim()
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) { log('candidate distill: 没有 JSON 对象，跳过'); return { provided: false, reason: '提纯输出不是 JSON' } }
  let obj = null
  try { obj = JSON.parse(s.slice(a, b + 1)) } catch { log('candidate distill: JSON 解析失败'); return { provided: false, reason: '提纯输出解析失败' } }
  if (!obj || obj.none === true) {
    seen.cached = { hash: h, item: null }
    saveSeen(seen)
    return { provided: false, reason: '模型判断这批里没有值得记的' }
  }

  const qq = String(obj.qq || '').trim()
  const label = String(obj.label || '').trim()
  const text = String(obj.text || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  if (!qq || !text || !PROFILE_RENDER_LABELS.includes(label)) {
    log('candidate distill: 字段不合法 qq=' + ascii(qq) + ' label=' + ascii(label))
    return { provided: false, reason: '提纯结果字段不合法' }
  }
  // 必须能在待审区里找到对应条目 —— 找不到说明模型编了个 QQ，直接丢（不许凭空造人）
  const src = fresh.filter((it) => it.qq === qq)
  if (src.length === 0) {
    log('candidate distill: qq 不在待审区里，丢弃 (' + ascii(qq) + ')')
    return { provided: false, reason: '提纯结果里的 QQ 不在待审区' }
  }
  let name = ''
  try { name = readPersonFile(cfg, qq).name || '' } catch {}

  const item = { qq, name, label, text, from: src.map((it) => pendingKey(it)) }
  seen.cached = { hash: h, item }
  saveSeen(seen)
  log('candidate distilled: qq=' + ascii(qq) + ' label=' + ascii(label) + ' text=' + ascii(text))
  return { provided: true, cached: false, ...item, remaining: fresh.length }
}

/**
 * 把候选**采纳**进档案画像的对应字段。
 * ★ 只在设置页点了"采纳"时才调用 —— 这是本插件里**唯一**由"机器建议"触发的写画像路径，
 *   而且触发者是人的一次点击（不是模型自己）。措辞仍以人看到的提案为准。
 */
function adoptCandidate(cfg, cand) {
  if (!cand || !cand.qq || !cand.text) return { ok: false, error: '候选不完整' }
  const rec = readPersonFile(cfg, cand.qq)
  if (!rec._raw) return { ok: false, error: '这个人的档案不存在' }
  const label = PROFILE_RENDER_LABELS.includes(cand.label) ? cand.label : '注意'
  const prev = String(rec.profile?.[label] || '').trim()
  if (prev.includes(cand.text)) {
    removePending(cand.from)
    return { ok: true, qq: cand.qq, label, text: prev, unchanged: true }
  }
  rec.profile = Object.assign({}, rec.profile, { [label]: [prev, cand.text].filter(Boolean).join('；') })
  rec.note = String(rec.profile?.['注意'] || '')
  const bytes = writePersonFile(cfg, rec)
  const seen = loadSeen()
  seen.skipped = seen.skipped.concat(cand.from || [])
  seen.cached = null                       // 下次重新挑
  saveSeen(seen)
  removePending(cand.from)
  log('candidate adopted: qq=' + ascii(cand.qq) + ' label=' + ascii(label) + ' bytes=' + String(bytes))
  return { ok: true, qq: cand.qq, label, text: rec.profile[label], bytes }
}

// ------------------------------------------------------------ 人物档案（一人一档）

/**
 * 一人一档：people\<QQ号>.md
 *   --- 头部 ---   机器字段（qq/name/prevNames/firstSeen/lastSeen/msgCount/model…）
 *   ## 人物画像    人写的（插件只追加，不覆盖措辞）。五个标签：
 *                  身份 / 性格 / 沟通方式 / 关系 / 注意
 *   ## 干过的事    事件记录（AI 追加；整份超过 maxBytes 就自动压缩）
 *
 * ★ 2026-10-15 改版：原先是 `## 备注` + `## 已知事实` 两段。问题在于「已知事实」
 *   里混着**性格/沟通方式和事件**两种东西 —— 实测 28 条里，"说话爱省主语"（特征）
 *   和"说要给我写记忆模块，尚未兑现"（事件）躺在同一个标题下，用同一个语气注入。
 *   模型分不清哪句是行为依据、哪句是背景 → 于是把背景也拿出来讲（引用率高）。
 *   判据：**会反复出现的 = 画像；某天发生过的 = 干过的事。**
 *
 * 注入策略（决定性，别改）：
 *   · 「人物画像」—— **每轮都给**（它是"认人"的依据，和名字同级，去掉就不认识人）
 *   · 「干过的事」—— **只在被直接叫到时给**（@ / 叫名字 / 引用它 / 私聊）。
 *     闲聊时灌一堆背景，等于递给模型一份材料让它讲。
 *   · 其他人只给一行身份 —— 否则 10KB × N 人会把每次调用的成本炸掉。
 */
const PEOPLE_DIR = path.join(DIR, 'people')
const PEOPLE_MAX_BYTES = 10240        // 单档上限 10 KB
const PERSON_HEAD_BYTES = 2048        // 生成"其他人一行"时的部分读取量（要含「人物画像」段）
// （PERSON_KEEP_TAIL 已随 maybeCompactPerson 一起删除：同步上限改用 PERSON_HISTORY_MAX 条数）
const PERSON_PROFILE_MAX = 600        // 「注意」段自动追加的字符上限（人写的部分不受限）
const PERSON_HISTORY_MAX = 400        // 「干过的事」最多留多少条（同步硬上限，不靠模型压缩）
// 摘要的两个上限是**两个不同的数**（方案 C：摘要瘦身）：
//   · summaryBudgetChars —— 压缩**产出**的容量。存得长一点，是为了让下次压缩有更完整的底子，
//     不让信息在每一轮"摘要压摘要"里二次坍缩。
//   · summaryInjectChars —— 真正**注入提示词**的长度。这个数才是每轮花钱的那个。
// 拆开的收益：注入量只小幅上调，但记忆的失真速度明显变慢。
const MEMORY_SUMMARY_BUDGET_CHARS = 2000
const MEMORY_SUMMARY_INJECT_CHARS = 1200

/**
 * 把长摘要压成注入用的短摘要。
 * ★ 取**头 + 尾**，不是简单截断开头：旧摘要的开头是长期沉淀下来的骨架
 *   （人物关系、既定事实），结尾才是最近发生的事 —— 只留开头会把"最近"全丢掉。
 */
function injectableSummary(s, cfg) {
  const t = String(s || '').trim()
  const limit = Math.max(200, Number(cfg?.memory?.summaryInjectChars) || MEMORY_SUMMARY_INJECT_CHARS)
  if (t.length <= limit) return t
  const tailLen = Math.floor(limit * 0.55)
  const headLen = limit - tailLen - 3
  return t.slice(0, headLen) + '\n…\n' + t.slice(t.length - tailLen)
}

function peopleDir(cfg) {
  const custom = cfg.people && cfg.people.dir
  return custom && String(custom).trim() ? String(custom) : PEOPLE_DIR
}

function personFile(cfg, qq) {
  return path.join(peopleDir(cfg), String(qq) + '.md')
}

function fmtTs(ms) {
  if (!ms) return ''
  try {
    const d = new Date(Number(ms))
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  } catch { return '' }
}

/** 只要 时:分（给历史时间戳用，A1） */
function fmtClock(ms) {
  try {
    const d = new Date(Number(ms))
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getHours()) + ':' + p(d.getMinutes())
  } catch { return '' }
}

function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))
  if (!m) return {}
  const out = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    let v = line.slice(i + 1).trim()
    // ★ 剥掉 YAML 引号：写文件时 qq 是带引号的，不剥会导致
    //   `"2182313094"` !== `2182313094`（实测踩到过）
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
      v = v.slice(1, -1)
    }
    out[line.slice(0, i).trim()] = v
  }
  return out
}

/** 取 `## 标题` 到下一个 `## ` 之间的正文；HTML 注释不算内容 */
function extractSection(text, title) {
  const re = new RegExp('^##\\s*' + title + '\\s*$', 'm')
  const m = re.exec(String(text))
  if (!m) return ''
  const rest = String(text).slice(m.index + m[0].length)
  const next = rest.search(/^##\s/m)
  const body = next >= 0 ? rest.slice(0, next) : rest
  return body.replace(/<!--[\s\S]*?-->/g, '').trim()
}

/**
 * 【人物画像】的分段标签。
 *
 * ★ 2026-10-15 新增（人物档案改版）。为什么把"事实"拆成两层：
 *   老的 `## 已知事实` 里混着**三种完全不同的东西**（实测 28 条）：
 *     · "说话爱省主语，一句半截就完事"  ← 会反复出现的【沟通方式】
 *     · "爱用零碎字母逗人"              ← 【性格】
 *     · "说要给我写记忆模块，尚未兑现"  ← 某天发生过的【干过的事】
 *   混在一起的后果：**"怎么待人"和"发生过什么"用同一个语气注入**，
 *   模型分不清该拿哪句当行为依据、哪句当背景 → 于是把背景也拿出来讲（引用率高）。
 *
 *   判据（迁移时用同一条）：**会反复出现的 = 画像；某天发生过的 = 干的事。**
 */
const PROFILE_LABELS = ['身份', '性格', '沟通方式', '关系', '注意', '性别']
/** 渲染给模型看的标签 —— 「性别」不进这里：它是元数据（已经体现在代词上），写出来只是噪音 */
const PROFILE_RENDER_LABELS = ['身份', '性格', '沟通方式', '关系', '注意']

/**
 * 解析 `## 人物画像` 块里的 `- 标签：内容` 行 → { 身份: '…', 沟通方式: '…' }
 * 认不出的行一律忽略（不抛），保证手写档案里的多余内容不会炸掉解析。
 */
function parseProfileBlock(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*([^：:]{2,6})[：:]\s*(.+)$/.exec(line)
    if (!m) continue
    const k = m[1].trim()
    if (!PROFILE_LABELS.includes(k)) continue
    const v = m[2].trim()
    if (v) out[k] = v
  }
  return out
}

/** 把画像对象渲染成 `## 人物画像` 块；全空则返回 '' */
function renderProfileSection(profile) {
  const p = profile || {}
  const lines = PROFILE_LABELS
    .filter((k) => p[k] && String(p[k]).trim())
    .map((k) => '- ' + k + '：' + String(p[k]).trim().replace(/\s*\n\s*/g, ' '))
  if (lines.length === 0) return ''
  return '## 人物画像\n<!-- 她怎么认这个人、怎么跟他说话。人会手改这里；插件只做追加/压缩，不覆盖你的措辞。 -->\n' +
    lines.join('\n') + '\n'
}

function renderPersonFile(rec) {
  const prev = Array.isArray(rec.prevNames) ? rec.prevNames.filter(Boolean).join('、') : ''
  return '---\n' +
    'qq: "' + rec.qq + '"\n' +
    'name: ' + (rec.name || '') + '\n' +
    'prevNames: ' + prev + '\n' +
    'firstSeen: ' + fmtTs(rec.firstSeen) + '\n' +
    'lastSeen: ' + fmtTs(rec.lastSeen) + '\n' +
    'msgCount: ' + (Number(rec.msgCount) || 0) + '\n' +
    // 单人级模型覆盖（不写就跟随全局配置）
    (rec.model && String(rec.model).trim() ? 'model: ' + String(rec.model).trim() + '\n' : '') +
    (rec.modelProvider && String(rec.modelProvider).trim() ? 'modelProvider: ' + String(rec.modelProvider).trim() + '\n' : '') +
    '---\n\n' +
    renderProfileSection(rec.profile) + '\n' +
    // ★ 标题自带引用纪律 —— 这是治"引用率太高"最直接的一处：
    //   老标题叫「已知事实」，还配一句"比你的记忆更可信"，等于告诉模型"这些是可信事实，尽管用"。
    '## 干过的事\n' +
    '<!-- 背景资料：他做过/说过什么。读了就知道，但**不要主动引用**、不要复述、不要拿它当话题。 -->\n' +
    (rec.history && rec.history.trim() ? rec.history.trim() : '<!-- 还没有记录。 -->') + '\n'
}

/**
 * 「干过的事」条数硬上限（同步，本地，不调模型）。
 * 超了就砍最老的，并**在日志里报一声** —— 静默丢数据是这个项目反复踩的坑。
 */
function capPersonHistory(rec) {
  const h = String(rec && rec.history || '')
  if (!h) return rec
  const lines = h.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (lines.length <= PERSON_HISTORY_MAX) return rec
  const kept = lines.slice(-PERSON_HISTORY_MAX)
  log('person history capped: qq=' + String(rec.qq) + ' ' + String(lines.length) + ' -> ' + String(kept.length) + ' 条')
  return Object.assign({}, rec, { history: kept.join('\n') })
}

/**
 * 写档案 —— **整份覆写**，所以必须防"外部手改被盖掉"。
 *
 * ★ 2026-10-15 加固（V3）。原来的 `fs.writeFileSync(整个文件)` 有三个洞：
 *   ① 人和插件同时改同一个人的档案 → 谁后写谁赢，**人的修改可能被静默吃掉**
 *   ② 写失败（磁盘/权限）没有任何痕迹，档案可能停在半截状态
 *   ③ 没有任何历史件，改错了无法回退
 *
 * 现在的策略：
 *   · 写前先留一份 `.bak`（只留最近一次，不堆垃圾）
 *   · 写后**读回校验**：内容对不上就报错，不让调用方以为成功了
 *   · 用 `wx` 之外的普通写即可 —— 但**任何"读-改-写"都必须紧挨着做**（调用方按这个约定）
 *
 * ⚠️ 已知边界：这不是文件锁。真要人在"读"和"写"之间那几毫秒内改文件，仍然会盖掉。
 *    但有了 .bak，损失可恢复；这也是当前实现能给的合理强度（不值得为此上锁）。
 */
function writePersonFile(cfg, rec) {
  ensureDir(peopleDir(cfg))
  const p = personFile(cfg, rec.qq)
  // ★ V5：**不依赖模型**的硬上限。原来的唯一防线是 maybeCompactPerson（要调模型压缩），
  //   模型调用失败 / extractFacts 没开 → 文件只涨不缩。这里做个同步的条数上限，
  //   不管谁调用、调不调得通模型，档案都不会无限长。
  const capped = capPersonHistory(rec)
  const text = renderPersonFile(capped)
  try { fs.copyFileSync(p, p + '.bak') } catch {}
  fs.writeFileSync(p, text, 'utf8')
  // 读回校验：写没写对。失败就抛，别让调用方以为记上了（静默失败是最难查的）
  const back = fs.readFileSync(p, 'utf8')
  if (back !== text) throw new Error('person file write verify failed: ' + p)
  return Buffer.byteLength(text, 'utf8')
}

function readPersonFile(cfg, qq) {
  // ★ model / modelProvider 必须在这里就有默认值：别的路径（设置页写备注、[记:] 追加）
  //   拿到空壳后写回文件，如果这里缺字段，renderPersonFile 读 rec.model 得到 undefined
  //   → **单人级模型覆盖被静默抹掉**（而且是写一次少一次，很难发现）
  const empty = {
    qq: String(qq), name: '', prevNames: [], firstSeen: 0, lastSeen: 0, msgCount: 0,
    note: '', facts: '', profile: {}, history: '', model: '', modelProvider: '',
  }
  let text
  try { text = fs.readFileSync(personFile(cfg, qq), 'utf8') } catch { return empty }
  const fm = parseFrontMatter(text)
  // ★ 新格式优先，老格式兼容 —— 迁移期两种混着也存在，**不要假设只有一种**
  const profileRaw = extractSection(text, '人物画像')
  const historyRaw = extractSection(text, '干过的事')
  const note = extractSection(text, '备注')
  const facts = extractSection(text, '已知事实')
  const profile = parseProfileBlock(profileRaw)
  // 老档案的「备注」就是画像的正文 → 塞进「注意」位，保证一处不漏
  if (!profile['注意'] && note) profile['注意'] = note
  // 老档案的「已知事实」就是干过的事
  const history = historyRaw || facts || ''
  return {
    qq: String(qq),
    name: fm.name || '',
    prevNames: fm.prevNames ? String(fm.prevNames).split(/[、,]/).map((s) => s.trim()).filter(Boolean) : [],
    firstSeen: Date.parse(fm.firstSeen) || 0,
    lastSeen: Date.parse(fm.lastSeen) || 0,
    msgCount: Number(fm.msgCount) || 0,
    note,
    facts,
    profile,
    history,
    _raw: text,
  }
}

/** 只读文件头，拼出"其他人"的一行身份（避免为了名单把所有档案整份读进来） */
function personLine(cfg, qq) {
  const p = personFile(cfg, qq)
  let fd
  try { fd = fs.openSync(p, 'r') } catch { return '' }
  try {
    const buf = Buffer.alloc(PERSON_HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const head = buf.slice(0, n).toString('utf8')
    const fm = parseFrontMatter(head)
    if (!fm.name) return ''
    // 新版：画像里的「关系」「性格」当一行摘要（注：前 PERSON_HEAD_BYTES 字节里就含画像段）
    // 老版回落到「备注」—— 迁移期两种档案混着在，两个都要认
    const prof = parseProfileBlock(extractSection(head, '人物画像'))
    const desc = String(prof['关系'] || prof['性格'] || '').trim() || extractSection(head, '备注')
    return String(fm.qq || qq) + ' ' + fm.name + (desc ? ' —— ' + desc : '')
  } catch { return '' } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

/** 每条群消息都更新一次：昵称跟着群名片走，备注和事实原样保留 */
function touchPerson(cfg, qq, name) {
  const cur = readPersonFile(cfg, qq)
  if (name && cur.name && String(name) !== cur.name && cur.prevNames.indexOf(cur.name) < 0) {
    cur.prevNames.push(cur.name)
  }
  if (name) cur.name = String(name)
  cur.lastSeen = Date.now()
  if (!cur.firstSeen) cur.firstSeen = cur.lastSeen
  cur.msgCount = (Number(cur.msgCount) || 0) + 1
  const bytes = writePersonFile(cfg, cur)
  return bytes
}

/** 超过 maxBytes 就压缩档案 —— **已废弃，见下** */
/* 2026-10-15 删除：这个函数（"调模型把自己的记录压短"）**已经没有任何调用点**。
   它被两件事取代：
     · `capPersonHistory()` —— 写盘前的**同步**条数上限（400 条）。不依赖模型、
       不依赖网络、不会因为模型调用失败而失效。原来唯一的防线就是这个函数，
       而它要调模型 ⇒ 调不通时档案只涨不缩（V5）。
     · 记忆改道待审区之后，**机器已经完全不写档案** ⇒ 没有"越写越长"的来源了。
   留着它反而危险：下一个人会以为档案还有自动压缩在兜底。 */


/** 每个群最近说过话的人（只在内存里，不持久化）—— 用来给"其他人"生成一行身份 */
const recentSpeakers = new Map()
const RECENT_WINDOW_MS = 30 * 60 * 1000

function noteSpeaker(groupId, qq) {
  const key = String(groupId)
  const now = Date.now()
  const list = (recentSpeakers.get(key) || []).filter((x) => String(x.qq) !== String(qq) && now - x.at < RECENT_WINDOW_MS)
  list.push({ qq: String(qq), at: now })
  recentSpeakers.set(key, list.slice(-12))
}

/**
 * 组装人物档案块。
 * ★ 注入策略（别改）：**当前说话者给完整档案**，其他人只给一行身份。
 *   如果所有人的完整档案都塞进去，10KB × N 人会把每次调用成本炸掉。
 */
/**
 * 用档案里**已经存在**的字段，算一行"你和这个人的关系"。
 *
 * ★ 2026-10-15 加（人格真实化 · 方案B）。为什么需要：
 *   人设里只有两层 ——「柑橘」和「别人」。62 份档案、5 个群，除了柑橘**所有人同一个层级**：
 *   跟聊了 89 条的人，和跟第一次冒头的人，待遇在结构上完全一样。
 *   于是"冷淡"只能靠**规则**硬撑，对谁都得演一遍。
 *
 *   而 `msgCount / firstSeen / prevNames / 备注` 本来就写在档案里，只是**没喂给模型**。
 *   喂进去之后，"冷淡"就变成**关系的自然结果**：对陌生人冷是理所当然，
 *   对熟人还是那副腔调才叫没写好。⇒ 不需要新增任何规则，反而能少几条。
 *
 * 刻意**不编**关系类型（"朋友/熟人"这类词要人来判断）：只陈述可数的事实 + 备注原文。
 */
function describeRelation(rec, cfg, now) {
  const qq = String(rec?.qq || '')
  const name = String(rec?.name || '').trim() || qq || '这个人'
  const n = Number(rec?.msgCount) || 0
  // ★ 代词跟着画像的「性别」走。为什么需要：柑橘的备注明写「**她**是你妈妈」，
  //   而这里原本对所有人生成「他」—— 同一个提示词块里他/她打架，模型会在性别上摇摆。
  //   没写性别就默认「他」（不确定时不做额外声明，别猜）。
  const g = String(rec?.profile?.['性别'] || '').trim()
  const TA = g === '女' ? '她' : '他'
  if (!n || n <= 1) {
    return '【你和这个人的关系】你对 ' + name + ' 没有任何记录 —— 这是你第一次见' + TA + '说话。'
  }
  const bits = [TA + '跟你说过 ' + String(n) + ' 条']
  const started = Number(rec?.firstSeen) || 0
  if (started > 0 && now > started) {
    const mins = Math.round((now - started) / 60000)
    const span = mins < 60 ? String(Math.max(1, mins)) + ' 分钟'
      : mins < 1440 ? String(Math.round(mins / 60)) + ' 小时'
        : String(Math.round(mins / 1440)) + ' 天'
    bits.push('你认识' + TA + ' ' + span + ' 了')
  }
  const prev = Array.isArray(rec?.prevNames) ? rec.prevNames.filter(Boolean) : []
  const line = '【你和这个人的关系】' + name + ' —— ' + bits.join('、') +
    (prev.length > 0 ? '，以前叫过 ' + prev.join('、') : '') + '。'
  return line
}

/**
 * 把画像对象渲染成注入用的文本（和档案文件里的分段一一对应）。
 * 单独抽出来，是为了注入样式将来要调时只动这一处。
 */
function renderProfileFields(profile) {
  const p = profile || {}
  const lines = PROFILE_RENDER_LABELS
    .filter((k) => p[k] && String(p[k]).trim())
    .map((k) => '· ' + k + '：' + String(p[k]).trim())
  if (lines.length === 0) return ''
  return '【这个人是谁】\n' + lines.join('\n')
}

function buildPersonBlock(cfg, groupId, speakerQQ, opts) {
  if (cfg.people?.enabled === false) return ''
  // ★ 两层（2026-10-15 改版）：
  //   · 身份层（关系行 + 人物画像）—— **每轮都给**。它是"认人"的依据，和名字同级，
  //     去掉就等于不认识人。所以这层宁可啰嗦也要在。
  //   · 信息层（## 干过的事）—— **只在被直接叫到时给**（@ / 叫名字 / 引用它 / 私聊）。
  //     理由：闲聊时灌一堆"他以前干过什么"，等于递给模型一份材料让它讲 —— 那是引用率高的来源。
  const addressed = !opts || opts.addressed !== false
  const parts = []

  let full = ''
  let hasProfile = false
  let relRec = null
  let rec = null
  try {
    rec = readPersonFile(cfg, speakerQQ)
    if (rec._raw) full = String(rec._raw).trim()
    relRec = rec
    hasProfile = !!(rec.profile && Object.keys(rec.profile).length > 0)
  } catch {}
  if (!full) {
    const line = personLine(cfg, speakerQQ)
    if (line) full = '（这个人的档案还没建起来，只知道：' + line + '）'
  }
  if (full) {
    // ★ 关系行放在最前：先给"我跟他什么关系"的定位，再给细节。
    //   注意：关系行和【人物画像】里的「关系」是互补的 —— 前者是可数事实（说过多少条、
    //   认识多久、改过什么名），后者是人写的定性。两份都留，不要合并。
    if (relRec) parts.push(describeRelation(relRec, cfg, Date.now()))
    // ★ ② 关系演化（arc summary）：一句"你们现在的关系"，永不衰减。
    //   为什么放在可数事实之后：事实给"多久、多少条"，这句给"现在是什么温度"。
    try {
      const st = storeOf()
      const evo = st && st.relations && st.relations[String(speakerQQ)]
      if (evo && evo.text) parts.push('【你们现在的关系】' + String(evo.text))
    } catch {}
    // 老档案没有画像段 → 退回整份原文（保证不丢信息）；有新画像 → 用结构化的那几行
    if (hasProfile) {
      const pb = renderProfileFields(rec.profile)
      if (pb) parts.push(pb)
    } else {
      parts.push('【正在跟你说话的人 · 档案】\n' + full)
    }
    // 信息层：只在被直接叫到时给。标题自带引用纪律，别删。
    if (addressed && rec && rec.history && rec.history.trim()) {
      parts.push('【他干过的事】（背景资料 —— **读了就知道，但不要主动引用**：' +
        '不要复述、不要拿它当话题、不要为了显得记得就提。除非它和眼前这句话直接相关）\n' +
        rec.history.trim())
    }
  }

  const others = (recentSpeakers.get(String(groupId)) || [])
    .filter((x) => String(x.qq) !== String(speakerQQ))
    .map((x) => personLine(cfg, x.qq))
    .filter(Boolean)
  if (others.length > 0) {
    parts.push('【本群最近说过话的其他人】（只有身份；要区分同名的就靠 QQ 号）\n' + others.join('\n'))
  }
  return parts.join('\n\n')
}

/**
 * 【稳定段】系统提示 —— 只放"这个角色 + 这个群**每轮都不变**的东西"。
 *
 * ★★ 阶段5（缓存前缀拆分）。为什么必须拆：
 *   上游按**请求前缀**做上下文缓存 —— 前缀里改一个字，它**后面所有内容**都要重新计费。
 *   实测证据：`cacheReadTokens` 长期卡在 896~1408（≈ persona 的长度），
 *   而 `inputTokens` 已经涨到 2000+ ⇒ **缓存只吃到 persona 就断了**，
 *   后面整段（含整个群聊历史）每轮全价重算。
 *
 *   旧写法把 `personBlock`（说话者完整档案）和 `summary` 拼在 persona **后面**，
 *   这两个每轮都变 → 前缀在 persona 结束处就变了 → 缓存全废。
 *
 *   拆法（学 dsh-plugin-qq-groupmate 的 README「前缀稳定」一章、
 *   amadeus-in-shell 的 append-only turns）：**变的东西一律挪到消息序列末尾**。
 *   ⇒ 同一角色同一配置下，这个函数的输出**逐字节一致**，永远排在请求最前面。
 *
 * ⚠️ 改这个函数前先想清楚：**任何每轮会变的内容都不许加进来**，
 *    否则缓存立刻失效，而且是**静默失效**（只体现在 cacheReadTokens 变小）。
 */
function buildSystem(cfg, invoke) {
  const parts = []
  const persona = (cfg.persona && cfg.persona.system) || ''
  if (persona) parts.push(persona)
  const aliases = (invoke && invoke.aliases) || []
  const botQQ = invoke && invoke.botQQ ? String(invoke.botQQ) : ''
  if (cfg.persona && cfg.persona.name) parts.push('你的名字是「' + cfg.persona.name + '」。')
  // ★ 把"你可以被怎么称呼"讲清楚（2026-10-14 用户要求）。
  //   以前只写 persona.name，但有人在群里叫的是它的**群名片 / 登录昵称**（可能不一样），
  //   名字对不上 → 它以为不是在叫它，或者反过来把别人当成自己 → 错认。
  if (aliases.length > 0) {
    parts.push('【别人怎么称呼你】' + aliases.map((a) => '「' + a + '」').join('、') + ' 都是**在叫你**（可能是 @你，也可能是直接打你的名字、' +
      '或你的群名片）。有人这样叫你时，那就是在跟你说话——但注意：**这跟"有人在聊关于你的事"不同**，' +
      '如果那句话是别人之间在说你、不是冲你说的，仍然不要接。' +
      (botQQ ? '（你在这个群的 QQ 号是 ' + botQQ + '，@我 指的就是你。）' : ''))
  }
  parts.push('你正在一个 QQ 群里聊天。消息格式为「[昵称(QQ号)]: 内容」，请只回复最后那条。' +
    // ★ 2026-10-15：长度锚点。硬闸门（reply.maxChars）会在出口截断，
    //   但不告诉模型的话它会一直写长、一直被砍。这里给明确上限。
    // ★ 2026-10-17：25 → 40。实测 47 条回复**平均只有 15.5 字**、最长 43 字，
    //   没有一条是撞在 maxChars 上被砍的 ⇒ 真正压住她的是这句"25 字以内"，不是截断器。
    //   放宽它，语气才有起伏；上限仍然在（maxChars 兜底）。
    '**回复就是群里的一条消息：一句话，一般不超过 40 字，不要换行。** ' +
    '说不完就别说，剩下的不用说。' +
    '不要议论自己说了多少、也不要跟人争"我话多不多"——别人说你话密，你回一句短的就行，别解释、别顶回去。' +
    '★ 你自己回复时**绝对不要带时间戳**（不要写「[23:24]」这种），也不要带「昵称(QQ号):」这种说话人前缀——' +
    '那些只是聊天记录的标记，你只要说你嘴里那句话。')
  // ★ 教它分清"@我"和"@别人"（2026-10-14 修）：以前 at 段被整个丢弃，
  //   模型看不到"这句话是冲着谁说的"，只能猜 → 别人 @ 别人时它错认成在跟自己说话。
  //   现在 @ 会渲染成 `@我` 或 `@昵称(QQ号)`，这里把这个约定讲明白。
  // ★ 2026-10-15：治"太冲"。她的冲主要来自'否定对方的话 + 猜对方动机 + 下判断'这套组合，
  //   而不是用词。这条只拦行为，不改性格。
  parts.push('【别人之间的事不归你管】别人互相说话时，不要评判、不要猜他们为什么这么说、不要替谁下结论。' +
    '就算你看出来了，也不用说出来。只回冲你来的那部分。')
  parts.push('【怎么分辨别人在跟谁说话】消息里的「@我」= 有人在叫你；「@别人的昵称(QQ号)」= 有人在叫**别人**，' +
    '那句不是对你说的，**别接**。没有 @ 你、也没叫你的名字时，先看这句话在回应谁；' +
    '拿不准是不是在跟你说，就**倾向不回**，或者让它自己去说，不要抢话。')
  // ★ 看图能力：不写这句，它会照着历史里那堆"看不见图"的旧回复继续演（实测踩到过）
  if (cfg.vision?.enabled !== false) {
    parts.push('别人发来的图片你**看得见**（图片会直接附在这条消息里）。所以**绝对不要**再说"我看不见图""图我读不了""雪花屏"这类话——' +
      '那是你以前没有看图能力时的旧说法，历史记录里那些话不算数。' +
      '这条消息带图时，就按图里的实际内容回应；如果图里只是表情包或没什么可说的，就直接聊别的，不用特意提图。')
  }
  parts.push('不要重复自己说过的话。同一个问题再被问到，换个说法或换个角度回答，不要原样复读上一句。')
  // ★ 2026-10-15 改：这段以前写的是"这是你唯一能写进档案的方式"—— 现在**不准了**。
  //   模型已经写不进档案（档案只由人改），`[记:]` 的内容进的是**待审队列**。
  //   提示词必须跟实现一致：说错了模型会以为自己在改档案，措辞就不谨慎了。
  parts.push('如果对方说了值得长期记住的事（偏好、约定、重要事实、关系），就在回复最后另起一行写 [记:要记住的内容]。\n' +
    '· 一次最多 2 条，只记真正重要的，别记闲聊。这一行不会显示给对方。\n' +
    '· **只写对方明确说过的**，不要写你的猜测、你的感受、你的推断。\n' +
    '· 写短、写事实：这句会进一个待审清单，由人来决定要不要采纳。')
  // 主动 @ 人：让它能点名叫人（QQ号见上面的成员档案）
  if (Number(cfg.reply?.maxAts) > 0) {
    parts.push('你想点名某个人说话（@他，让他收到提醒）时，就在回复里写 [@QQ号]（QQ 号见上面的成员档案）。' +
      '一次最多 @ 一个人，别乱 @；平时不用 @，直接说话就行。这个标记不会显示给对方，会变成真正的 @。')
  }
  // ★ B1：沉默出口。不给它这个出口，它面对垃圾消息只能"回一句嫌弃的话"——那还是回了。
  if (cfg.reply?.allowSilence !== false) {
    parts.push('如果你判断这条消息**不值得回应**（纯表情、纯图片、单字、无意义刷屏、跟你无关的别人对话、' +
      '或者你确实没什么想说的），就**只输出 [沉默]**，不要输出任何别的内容。' +
      '插件收到后会**什么都不发**——这是你正当的沉默方式，比回一句嫌弃的话更省事，也更像真人。' +
      '被 @ 了也不一定要回；但有人正经跟你说话、问你问题时，要回。')
  }
  // ★ 声音锚点（2026-10-17，文案由用户逐句批准：B/C/E 三句）。
  //
  //   为什么需要：她语气被自己带跑的机制是 —— 历史里一半是她自己的原文，
  //   最近、最多、最一致，比任何"示例"都强。这里给一份**固定不变**的样句当稳定器。
  //
  //   为什么放在 system（稳定段）而不是消息末尾：
  //     · system 进前缀缓存 → **零成本**；
  //     · 放末尾离生成更近、效果更猛，但也最容易被**逐字照抄**（她现在把上一条当样板就是这个机制）。
  //   如果一周后腔调还在原地打转，再考虑往尾部复制一句做对照。
  //
  //   ⚠️ 文案在 config.json → persona.anchors（数组）。改句子不用改代码，热加载即生效。
  //      这几句是用户挑的，**别自己往里加**。
  const anchors = Array.isArray(cfg.persona?.anchors)
    ? cfg.persona.anchors.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5)
    : []
  if (anchors.length > 0) {
    parts.push('【你的声音 · 节奏样板】\n' +
      anchors.map((a) => '· 「' + a + '」').join('\n') +
      '\n这几句只是**节奏**：短、直接、不解释、结尾不追问。\n' +
      '**不要复读它们**，也不要在回复里引用或改写它们——你只是照这个语感说话。')
  }
  return parts.join('\n\n')
}

/**
 * 【每轮都会变的那块】运行上下文 —— 拼成**单独一条消息**，插在**当前消息之前**。
 *
 * 放这里而不是 system 里，是为了让 system 保持逐字节一致（前缀缓存），
 * 同时让"历史"这一段也尽量稳定：历史是 append-only 的，
 * 只有末尾这一小块每轮在动 ⇒ 缓存能从 system 一路吃到上一轮的历史。
 */
function buildContextBlock(cfg, summary, personBlock, memBlock, windowBlock) {
  const parts = []
  if (personBlock) parts.push(personBlock)
  // ★ 阶段2：召回块放这里 —— 档案之后、摘要之前。
  //   摘要装"最近被压掉的对话"，召回装"很久以前但和眼下的句子有关的事"，两者互补。
  //   块里自带"不一定全对"的纪律（memory.js → renderRecall），不标它就会当铁证引用。
  if (memBlock) parts.push(memBlock)
  // ★ A3：明确告诉它摘要是**模糊的二手记忆**，不是事实 —— 不标注它就会当铁证引用
  if (summary) {
    parts.push('【更早对话的摘要】（这是你自己压缩过的旧记忆，**可能不准确**。它只能当模糊印象用；' +
      '如果摘要和眼前的对话冲突，以眼前的对话为准。不要拿摘要里的细节当事实去断言。）\n' + summary)
  }
  // ★ 回合制：这一批的完整上下文 + "接哪一条"。放最后 —— 离生成最近，指认最清楚。
  if (windowBlock) parts.push(windowBlock)
  return parts.join('\n\n')
}

/**
 * 智能压缩 · 把"值得长期记住的事"顺手存进对应人的档案（阶段③）。
 *
 * 补的是这个缺口：群摘要 600~2000 字，装不下具体的人和事，被压掉的原文还会永久消失。
 * 人档案（`people/<QQ号>.md`）是**按人**永久保存的，正好当摘要之外的第二落点。
 *
 * ★ 纪律（学 amadeus-in-shell 的「客观记录，不轻信」）：
 *   群友会说谎、开玩笑、故意误导。**只记"谁说了什么"，不把话当事实**。
 *   所以提示词明令写成 `自称/说` 这种形式，而不是直接断言。
 *   这条不遵守，档案会被玩笑污染 —— 那比丢记忆更糟（错的信息会一直喂给模型）。
 *
 * 成本控制：一次调用（输出上限 factsMaxTokens），只对**真实出现过且已有档案**的人记。
 * ★ 2026-10-15 起默认**开启**（config 里 `memory.extractFacts = true`）；
 *   但抽取结果**只进待审区**，不写档案（见 appendPending）。
 */
async function maybeExtractFacts(ctx, cfg, old, speakerQQs) {
  if (cfg.memory?.extractFacts !== true) return 0
  if (!Array.isArray(speakerQQs) || speakerQQs.length === 0) return 0
  const transcript = old
    .map((m) => {
      const stamp = m.at ? '[' + fmtClock(m.at) + '] ' : ''
      return stamp + (m.role === 'assistant' ? '我: ' : '对方: ') + m.content
    })
    .join('\n')
  if (!transcript.trim()) return 0

  let raw = ''
  try {
    raw = await ask(
      ctx,
      cfg,
      '你在给 QQ 群里的人整理**长期档案**。从对话里挑出值得长期记住的东西，按人归类。\n' +
      '★ 每条必须判断它是哪一类（这是本次改版的重点，判错就白记）：\n' +
      '  · kind="profile"：**会反复出现的** —— 身份/职业、性格、说话习惯与沟通方式、稳定偏好、\n' +
      '    对你的固定态度、明确说好的约定。例：「说话爱省主语，一句半截」「爱用零碎字母逗人」\n' +
      '  · kind="event"：**某天发生过的** —— 做过什么事、说过什么话、当下的事件。\n' +
      '    例：「说要给我写记忆模块，尚未兑现」「问我想不想柑橘」\n' +
      '【绝对不要】不要记闲聊、不要记一次性的情绪、不要记你自己说了什么、不要推断。\n' +
      '【★ 客观记录，不许把话当事实】群友会开玩笑、会说谎、会故意误导你。所以：\n' +
      '  · 他自称什么 → 写「自称是…」，不要直接写「是…」\n' +
      '  · 别人评价他 → 写「某人说他…」，不要写成结论\n' +
      '  · 拿不准是不是认真的 → 宁可不记\n' +
      '【输出】只输出 JSON 数组，不要任何别的字。没有值得记的就输出 []。格式：\n' +
      '[{"qq":"QQ号","kind":"profile|event","fact":"一句话，15~40字"}]',
      [],
      '【对话】\n' + transcript + '\n\n【这场对话里说话的人】\n' + speakerQQs.join('\n'),
      undefined,
      undefined,
      undefined,
      { maxTokens: Number(cfg.memory?.factsMaxTokens) || 400 },
    )
  } catch (e) { log('fact extraction failed (kept summary only):', e?.message); return 0 }
  if (!raw) return 0

  // 模型爱包 markdown 代码块，先剥掉
  const s = String(raw).replace(/```(?:json)?/gi, '').trim()
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) { log('fact extraction: no JSON array found, skipped'); return 0 }
  let list = []
  try { list = JSON.parse(s.slice(a, b + 1)) } catch (e) { log('fact extraction: JSON parse failed, skipped'); return 0 }
  if (!Array.isArray(list)) return 0

  const allowed = new Set(speakerQQs.map((x) => String(x.qq)))
  const stamp = new Date().toISOString().slice(0, 10)
  let written = 0
  for (const it of list.slice(0, 12)) {
    const qq = String(it?.qq ?? '').trim()
    const fact = String(it?.fact ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
    if (!qq || !fact) continue
    // 只记"真的在这场对话里说过话、而且已经有档案"的人，绝不凭空建档案
    if (!allowed.has(qq)) { log('fact skipped (qq not in transcript): ' + qq); continue }
    try {
      const rec = readPersonFile(cfg, qq)
      if (!rec || !rec._raw) { log('fact skipped (no person file): ' + qq); continue }
      // ★ 2026-10-15 改道：自动抽取的东西**只进待审区**，不写档案（和 [记:] 同一条规矩）。
      //   理由见 appendPending 的注释：档案越自动更新，越没人看得出它记错了什么。
      if (String(rec.history || '').includes(fact) || String(rec.profile?.['注意'] || '').includes(fact)) continue
      if (appendPending(qq, fact, '抽')) written++
      // ★ 阶段2：同时入记忆库。profile 类（稳定属性）→ core，其余 → event。
      //   importance 统一 3：模型给的是事实不是评价，值不值得想起来交给 relevance 判。
      memoryAdd({ qq, group: '', kind: String(it?.kind) === 'profile' ? 'core' : 'event', importance: 3, text: fact, source: '抽' })
    } catch (e) { log('fact write failed qq=' + qq + ':', e?.message) }
  }
  if (written > 0) log('pending written (extractFacts): ' + String(written) + ' -> ' + ascii(PENDING_NOTES_PATH))
  return written
}

/** 超过 keepRounds 轮就把最早的对话压成摘要（角色扮演长期记忆的关键） */
async function maybeSummarize(ctx, cfg, sess) {
  const keep = Math.max(2, Number(cfg.memory?.keepRounds) || 20) * 2
  if (sess.rounds.length <= keep + 4) return
  if (!cfg.memory?.summarize) {
    sess.rounds = sess.rounds.slice(-keep)
    return
  }
  const old = sess.rounds.slice(0, sess.rounds.length - keep)
  sess.rounds = sess.rounds.slice(-keep)
  // ★ A1（方案 A）：压缩**基于原文**，不再"在旧摘要上再摘要"。
  //   旧做法把上一版摘要当作输入主体，信息每压一次就坍缩一次，越滚越糊且无法恢复。
  //   现在以原始对话为主；旧摘要只在原文过长被截断时才作为旁证补进来。
  //   带 [HH:MM] 时间戳，和注入历史用的是同一套标法（A1 时间戳）。
  const transcript = old
    .map((m) => {
      const stamp = m.at ? '[' + fmtClock(m.at) + '] ' : ''
      return stamp + (m.role === 'assistant' ? '我: ' : '对方: ') + m.content
    })
    .join('\n')
  const TRANSCRIPT_BUDGET = 3000
  const useRawOnly = transcript.length <= TRANSCRIPT_BUDGET
  const body = useRawOnly
    ? '【要压缩的对话】\n' + transcript
    : '【已有摘要（较早的记忆，可能不准确）】\n' + (sess.summary || '(无)') +
      '\n\n【要压缩的对话】\n' + transcript.slice(-TRANSCRIPT_BUDGET)
  try {
    const budgetChars = Math.max(200, Number(cfg.memory?.summaryBudgetChars) || MEMORY_SUMMARY_BUDGET_CHARS)
    const summary = await ask(
      ctx,
      cfg,
      '你在做对话记忆压缩。把给到的对话压成简短要点，保留：人物设定、关系变化、约定、重要事实、称呼。不要评价，不要客套，直接给要点。' +
      // ★ 2026-10-17：**明确禁止"情绪基调"**。
      //   旧提示词要求保留它，于是"当时有点不耐烦"被压成无日期的长期特质，
      //   每轮注进去 → 她自己把自己越推越不耐烦（跨窗口的自我强化，比历史回声更狠）。
      //   情绪真要留，必须带日期、写成"那天"。
      '**不要写情绪基调/心情/态度**：一次的情绪不是长期性格，写进长期记忆会把人设带偏；' +
      '非要记情绪，必须带日期，写成「那天她有点X」。' +
      '**只写对话里明确出现过的信息**：不确定的、靠猜的、自己脑补的，一概不要写。不要推断原因、不要补充细节、不要润色。' +
      '**总长必须控制在 ' + budgetChars + ' 字以内**，宁可丢细节也不要超；用短句并列，不要展开。',
      [],
      body + '\n\n请输出压缩后的记忆要点（不超过 ' + budgetChars + ' 字）。',
      undefined,
      undefined,
      undefined,
      { maxTokens: Number(cfg.memory?.summaryMaxTokens) || 1536 },
    )
    if (summary) {
      // ★ 摘要没有上限就等于每条消息都在烧钱（实测出现过 1614 字的摘要）。
      //   提示词只能"劝"，这里再硬截一刀，保证一定不超。
      const clean = String(summary).replace(/\s+/g, ' ').trim()
      sess.summary = clean.length > budgetChars ? clean.slice(0, budgetChars) + '…' : clean
      if (clean.length > budgetChars) {
        log('summary hard-truncated: ' + String(clean.length) + ' -> ' + String(budgetChars))
      }
    }
    log('memory compacted: ' + String(old.length) + ' turns -> summary ' + String(sess.summary ? sess.summary.length : 0) +
      ' chars' + (useRawOnly ? ' (from raw transcript)' : ' (raw truncated, old summary merged)'))
    // ★ 阶段③：摘要之外，把值得长期记住的事按人存进档案（默认关闭，见 maybeExtractFacts）
    //   收集这段对话里真实说过话的人 —— 只认「[昵称(QQ号)]」这种格式
    try {
      const seen = new Map()
      const re = /\[([^\[\]()]{1,24})\((\d{5,12})\)\]/g
      for (const m of old) {
        if (m.role !== 'user') continue
        const txt = String(m.content ?? '')
        let hit
        re.lastIndex = 0
        while ((hit = re.exec(txt)) !== null) {
          if (!seen.has(hit[2])) seen.set(hit[2], { qq: hit[2], name: hit[1] })
        }
      }
      if (seen.size > 0) await maybeExtractFacts(ctx, cfg, old, Array.from(seen.values()))
    } catch (e) { log('fact extraction wrapper failed:', e?.message) }
    // ★ 限长生效的证据：被 max-tokens 截断的压缩调用会写在 lastAskFailure 里。
    //   若这里频繁出现，说明 summaryMaxTokens 压得太狠，摘要会退化成"空"（下方 else 分支会兜底保留原文）。
    if (lastAskFailure.includes('max-tokens')) {
      log('WARN compaction hit the token limit, summary may be degraded: ' + lastAskFailure)
    }
  } catch (e) {
    log('memory compaction failed (dropped oldest turns):', e?.message)
  }
}

// -------------------------------------------------------------- OneBot 通讯

function withToken(url, token) {
  if (!token) return url
  try {
    const u = new URL(url)
    if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', token)
    return u.toString()
  } catch { return url }
}

/** 把非文本消息段翻译成人话，让模型知道"对方发了什么"，而不是把 CQ 码塞进去 */
const SEGMENT_LABEL = {
  image: '（图片）',
  face: '（QQ表情）',
  mface: '（商城表情）',
  record: '（语音）',
  video: '（视频）',
  file: '（文件）',
  forward: '（合并转发消息）',
  json: '（卡片消息）',
  xml: '（卡片消息）',
  music: '（音乐分享）',
  reply: '',
  poke: '（戳一戳）',
  dice: '（骰子）',
  rps: '（石头剪刀布）',
}

/**
 * 机器人可以被怎么称呼（别名表）。
 *
 * 为什么要这个（2026-10-14 用户要求）：只认 `@我` 不够 ——
 * 群里很多人**直接打名字叫它**（「红月初辉，你怎么看」），不打 @。
 * 更麻烦的是**名字有多个来源**：人设名（`persona.name`）、登录 QQ 昵称（NapCat 的 `nick`）、
 * 群里给它设的名片。三者不一致时，模型分不清"在叫它"还是"在说别人" → 错认。
 * 所以这里把知道的都收进来，并显式告诉模型"这些都是在叫你"。
 *
 * @param cfg 配置
 * @param liveNick 运行时从 NapCat 拿到的登录昵称（可能为空）
 */
function botAliases(cfg, liveNick) {
  const out = []
  const push = (v) => {
    const s = String(v || '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  // 配置里可以手写补充（JSON 数组或顿号/逗号分隔的字符串都认）
  const raw = cfg?.persona?.aliases
  if (Array.isArray(raw)) raw.forEach(push)
  else if (typeof raw === 'string') raw.split(/[、,，\s]+/).forEach(push)
  push(cfg?.persona?.name)   // 人设名
  push(liveNick)             // 登录 QQ 昵称（NapCat 报的）
  // 太短或纯符号的别名会误伤，过滤掉（例如一个字的名字到处都命中）
  return out.filter((s) => s.length >= 2)
}

/**
 * 在**原始文本**里找"有没有人直接叫它的名字"。
 *
 * ★ 必须用 `raw_message` 而不是处理后的 text：处理后的 text 里 @ 已经被我渲染成
 *   `@昵称(QQ号)` 了，再拿它去找别名会**重复命中**（名字在 @ 里出现过一次）。
 *   用原文只做一次纯文本判断，干净。
 *
 * 只在"前 12 个字以内出现名字"时算命中 —— 中文习惯是把称呼放句首叫人或句尾，
 * 名字出现在很后面多半是在聊它、不是在叫它。
 */
function detectNameCall(rawText, aliases) {
  const s = String(rawText || '')
  if (!s) return ''
  for (const a of aliases || []) {
    const i = s.indexOf(a)
    if (i >= 0 && i <= 12) return a
  }
  return ''
}

/**
 * 机器人**自己的 QQ 号** —— 判定"有没有人 @ 我"的唯一基准。
 *
 * ★ 2026-10-15 加固。为什么不能只看 `ev.self_id`：
 *   原来三处判据都写成 `String(q) === String(ev.self_id)`，等于把"我是谁"押在
 *   这一条字段上。它一旦缺失或类型不符，判据就静默失效（@ 判定是**静默**失效的，
 *   日志里看不出来 —— 这是最难查的一类 bug）。
 *   实测（2026-10-15 用只读探针抓 NapCat 真实报文）：群消息里 `self_id` = 3328386325，
 *   是 number，和登录 QQ 一致 —— 也就是说它**没有**在骗我们；但"只有一个来源"这件事
 *   本身仍是隐患，这里改成多来源兜底：登录 QQ（state.qq，最可信）→ 调用方传入 → 事件字段。
 *
 * ★ 取不到时返回空串，调用方据此**一律判定"没被 @"** —— 宁可漏回一句，不可错认抢话。
 */
function selfQQOf(ev, invoke) {
  const cands = [state.qq, invoke && invoke.botQQ, ev && ev.self_id]
  for (const c of cands) {
    const s = String(c ?? '').trim()
    if (/^\d{5,}$/.test(s)) return s
  }
  return ''
}

function parseIncoming(ev, invoke) {
  const segs = ev?.message
  const aliases = (invoke && invoke.aliases) || []
  // ★ 自己的 QQ 只在这里算一次，下面三处判据共用（含函数末尾的 @ 渲染）
  const selfQQ = selfQQOf(ev, invoke)
  let text = ''
  let mentioned = false
  const extras = []
  const images = []
  // ★ @ 不再"删掉"，而是**翻译成文字**。为什么必须这么做（2026-10-14 实测）：
  //   旧写法只记一个布尔 mentioned，把 at 段整个丢弃 —— 于是"有人 @ 别人"时，
  //   模型看到的只是干文字，**完全不知道那句话冲着谁**，只能猜，就会错认成在跟自己说话。
  //   现在把 @ 渲染成 `@昵称(QQ号)`，跟说话人标签一个风格；@ 自己渲染成 `@我`。
  //   同时把 @ 了谁也单独收集起来，给"纯 @ 没文字"的情形兜底。
  const mentionedQQ = []
  const mentionedNames = []
  // ★ 引用回复（quote-reply）：QQ 里很多人习惯**引用你说过的那句**再接着说，不打 @。
  //   旧代码把 `reply` 段整个丢掉（SEGMENT_LABEL.reply = ''）→ 这种消息在插件眼里
  //   就是"没 @ 它的普通消息" → 进 5% 骰子 → 96% 概率被静默丢掉。
  //   人设提示词里明明写了"接你的话算在跟你说话"，能力设计了、入口没接，这是个洞。
  //   判据只用**确定性**的两条，不猜 NapCat 的字段格式（猜错是静默失效）：
  //     (a) 引用的 id 在 state.ownMsgIds 里 —— 这条是它自己发出去的消息（主判据）
  //     (b) 引用段的 sender.user_id === self_id —— 引用的是它本人（兜底，字段可能不存在）
  let replyToBot = false
  if (Array.isArray(segs)) {
    for (const s of segs) {
      if (s?.type === 'text') text += s?.data?.text ?? ''
      else if (s?.type === 'reply') {
        const d = s?.data || {}
        const rid = d.id ?? d.message_id ?? ''
        if (rid) {
          try { if (state.ownMsgIds.has(String(rid))) replyToBot = true } catch {}
        }
        if (!replyToBot) {
          const qqOwn = String(state.qq ?? ev?.self_id ?? '')
          const rSender = String(d.user_id ?? d.sender?.user_id ?? '')
          if (qqOwn && qqOwn !== 'null' && rSender && rSender === qqOwn) replyToBot = true
        }
      }
      else if (s?.type === 'at') {
        // 这里**只收集**信息；@ 的文字渲染统一放到函数末尾（先剥 CQ 再渲染，见那里的注释）
        const q = String(s?.data?.qq ?? '')
        if (!q) continue
        const nm = String(s?.data?.name || s?.data?.card || '').trim()
        // selfQQ 为空 → 不认；判据只在"确定我是谁"时才成立
        if (selfQQ && q === selfQQ) mentioned = true
        mentionedQQ.push(q)
        mentionedNames.push(nm ? nm + '(' + q + ')' : q)
      } else if (s?.type === 'image') {
        const d = s?.data || {}
        // QQ 图片 URL 有时效（约 2 小时），够“当场看图”用；过期就只剩文字描述
        const u = String(d.url || d.file || '').replace(/&amp;/g, '&')
        if (/^https?:\/\//i.test(u)) {
          images.push({ url: u, file: String(d.file || ''), summary: String(d.summary || '') })
        } else {
          const label = SEGMENT_LABEL.image
          if (!extras.includes(label)) extras.push(label)
        }
      } else {
        const label = SEGMENT_LABEL[s?.type]
        if (label && !extras.includes(label)) extras.push(label)
      }
    }
  } else if (typeof segs === 'string') {
    text = segs
    // 字符串形态：从 CQ 码里收集 @（QQ + 可选 name）——**别漏了这里**，
    // 否则 messagePostFormat 一旦改成 string，mentioned 会恒为 false（等于彻底不认 @）
    const atRe = /\[CQ:at,qq=([^,\]]+)(?:,name=([^\]]*))?\]/g
    let am
    while ((am = atRe.exec(String(segs))) !== null) {
      const q = String(am[1])
      const nm = String(am[2] || '').trim()
      if (selfQQ && q === selfQQ) mentioned = true
      mentionedQQ.push(q)
      mentionedNames.push(nm ? nm + '(' + q + ')' : q)
    }
    // 字符串形态的 CQ 码里也捞一下图片
    const re = /\[CQ:image,([^\]]*)\]/g
    let m
    while ((m = re.exec(String(segs))) !== null) {
      const urlM = /(?:^|,)url=([^,]+)/.exec(m[1])
      if (urlM) {
        const u = urlM[1].replace(/&amp;/g, '&')
        if (/^https?:\/\//i.test(u)) images.push({ url: u, file: '', summary: '' })
      }
    }
  }
  // 兜底：raw_message 里**不要把 CQ 码喂给模型**（`[CQ:forward,id=...]` 之类它读不懂，
  // 实测泄进过提示词）。先把 CQ 码剥掉，只留纯文本；剥完为空就靠上面的 extras 描述。
  if (!text && typeof ev?.raw_message === 'string') {
    text = String(ev.raw_message)
  }
  // ★ 顺序很重要：**先剥掉所有 CQ 码，再渲染 @**。
  //   反过来的话，这次 CQ 剥离会把刚渲染出来的 @ 文本一起删掉
  //   （旧代码正是这样把 at 段彻底丢掉的 —— 见函数开头注释）。
  text = String(text).replace(/\[CQ:[^\]]*\]/g, '')
  if (mentionedQQ.length > 0) {
    const rendered = mentionedQQ.map((q, i) => {
      if (selfQQ && String(q) === selfQQ) return '@我'
      return '@' + mentionedNames[i]
    }).join(' ')
    text = (rendered + ' ' + text.trim()).trim()
  }
  text = text.trim()
  // ★ 名字识别：有人直接打名字叫它（没打 @）也算"在跟它说话"。
  //   用 raw_message（原文）判断，避免和上面渲染出来的 `@昵称` 重复命中。
  const rawForName = String(ev?.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '')
  const calledName = detectNameCall(rawForName || text, aliases)
  if (calledName) mentioned = true
  // ★ 引用它的话 = 在跟它说话（和"被叫名字"同级，直接放行，不进 5% 骰子）
  if (replyToBot) mentioned = true
  if (!text && extras.length > 0) text = extras.join('')
  return { text, mentioned, images, mentionedQQ, mentionedNames, calledName, replyToBot }
}

/**
 * 防复读用的归一化：去掉空白 + 标点 + 符号，只留"字"。
 * 为什么："差不多就行，我又没跟你计较。" 和 "差不多就行了，别跟我计较" 在旧判据里算两句新话，
 * 但人听着是同一句 —— 旧判据（一字不差）等于没拦。
 */
function normRepeat(s) {
  const str = String(s || '')
  try { return str.replace(/[\s\p{P}\p{S}]/gu, '') } catch { return str.replace(/\s+/g, '') }
}

/**
 * 两句话的像不像：Dice 系数（字符二元组）。
 * 不用编辑距离、也不引依赖：二元组对中文短句最稳，改一个字、换标点都能算出来。
 * 返回 0~1；任一句去掉标点后短于 3 个字 → 直接判 0（"嗯""哦"这类不值得为它再调一次模型）。
 */
function repeatSimilarity(a, b) {
  const x = normRepeat(a)
  const y = normRepeat(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 3 || y.length < 3) return 0
  const bigrams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2)
      m.set(k, (m.get(k) || 0) + 1)
    }
    return m
  }
  const ma = bigrams(x)
  const mb = bigrams(y)
  let inter = 0
  let total = 0
  for (const [k, v] of ma) {
    total += v
    const w = mb.get(k) || 0
    if (w > 0) inter += Math.min(v, w)
  }
  for (const v of mb.values()) total += v
  return total > 0 ? (2 * inter) / total : 0
}

function splitReply(text, size) {
  if (!size || text.length <= size) return [text]
  const out = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/**
 * 从戳一戳事件的 `raw_info` 里拼出**戳的那句话**。
 *
 * ★ 2026-10-15（真实报文实测，不是猜文档）：
 *   群里别人戳人时 NapCat 给的形状是 `raw_info: [{type:'qq',...},{type:'img',...},
 *   {txt:'拍了拍',type:'nor'},{type:'qq',...},{txt:'的小学，哦齁齁齁齁齁',type:'nor'}]` ——
 *   把两段 `txt` 拼起来就是完整那句：「拍了拍」+「的小学，哦齁齁齁齁齁」。
 *   **后半段是戳的人自己设的**，这是很好的人格素材：被戳的人能看到对方戳的什么花样，
 *   而不是干巴巴一句"你被戳了"。
 *
 * 取不到就退化成「戳了戳」——绝不编内容。
 */
function pokePhraseOf(rawInfo) {
  try {
    if (!Array.isArray(rawInfo)) return '戳了戳'
    const t = rawInfo
      .filter((x) => x && typeof x.txt === 'string')
      .map((x) => x.txt)
      .join('')
      // raw_info 是外部输入。★ 顺序有讲究：换行/制表先**变成空格**再压空白 ——
      //   反过来的话 `[\u0000-\u001f]` 会把 \n 直接**删掉**，两行文字粘成一个词
      //   （实测：'拍了\n拍' → '拍了拍'，那是两个意思）
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return t.slice(0, 40) || '戳了戳'
  } catch { return '戳了戳' }
}

/**
 * 把一次戳一戳渲染成**给模型看的 user 消息**。
 * 用和群聊历史一致的 `[昵称(QQ号)]: 内容` 风格，模型不用学新格式。
 */
function renderPokeText(ev, cfg, meQQ) {
  const target = String(ev?.target_id ?? '')
  const from = String(ev?.user_id ?? '')
  const phrase = pokePhraseOf(ev?.raw_info)
  const targetName = target === String(meQQ)
    ? ('你(' + String(meQQ) + ')')
    : ((personNameOf(cfg, target) || '某人') + '(' + target + ')')
  return '（系统提示：群里的戳一戳）' + from + ' ' + phrase + ' → ' + targetName
}

function startBridge(ctx, cfg, mem) {
  if (typeof WebSocket !== 'function') {
    log('no global WebSocket in this runtime; bridge not started')
    state.lastError = 'no global WebSocket'
    return null
  }

  const url = withToken(cfg.napcat?.url || DEFAULT_CONFIG.napcat.url, cfg.napcat?.accessToken)
  const queues = new Map()
  const seen = new Set()

  let ws = null
  let closed = false
  let backoff = 1000
  let retryTimer = null
  let pingTimer = null

  const OPEN = 1

  // ★ 发送回执（2026-10-17）：sendRaw 以前"发出去就不管"，于是群拒收（QQ 返回 120）
  //   时日志照样写 replied —— 假成功。现在每条发送都等回执，失败/超时都能看见。
  const pendingAcks = new Map()
  let ackSeq = 0

  function sendRaw(obj) {
    try {
      if (ws && ws.readyState === OPEN) { ws.send(JSON.stringify(obj)); return true }
    } catch (e) { log('send failed:', e?.message) }
    return false
  }

  /**
   * 发一条 action 并等回执。
   * @returns {ok: true|false|null, retcode?, status?, data?, reason?, timedOut?}
   *   ok=null 表示**超时没等到**：QQ 既没回成功也没回失败（常见于被静默吞掉）
   */
  function sendAction(obj, timeoutMs) {
    return new Promise((resolve) => {
      const echo = obj.echo || ('qqb-ack-' + String(++ackSeq))
      obj.echo = echo
      const timer = setTimeout(() => {
        pendingAcks.delete(echo)
        resolve({ ok: null, timedOut: true })
      }, Math.max(1500, Number(timeoutMs) || 5000))
      pendingAcks.set(echo, (res) => {
        clearTimeout(timer)
        pendingAcks.delete(echo)
        resolve(res)
      })
      if (!sendRaw(obj)) {
        clearTimeout(timer)
        pendingAcks.delete(echo)
        resolve({ ok: false, reason: 'ws-not-open' })
      }
    })
  }

  /** ★ 记下"这条是它自己发出去的消息"：有人引用它的话时要靠这个 id 认出来 */
  function noteOwnMessage(mid) {
    if (mid === undefined || mid === null) return
    const k = String(mid)
    if (!k) return
    try {
      state.ownMsgIds.add(k)
      // 有界：只留最近 500 条，超了就丢最旧的（Set 保持插入顺序）
      if (state.ownMsgIds.size > 500) {
        const oldest = state.ownMsgIds.values().next().value
        state.ownMsgIds.delete(oldest)
      }
    } catch {}
  }

  /**
   * 发送目标：群 or 私聊（2026-10-17 加私聊后抽出来的）。
   * 两边的 OneBot action / 参数字段不同（send_group_msg+group_id / send_private_msg+user_id），
   * 以前只有群这一条路，现在用一个 target 对象带着走，免得在每个调用点各写一遍分支。
   */
  function targetOf(groupId, userId, isPrivate) {
    if (isPrivate) {
      const uid = /^\d+$/.test(String(userId)) ? Number(userId) : String(userId)
      return { action: 'send_private_msg', field: 'user_id', id: uid, label: 'private=' + String(userId) }
    }
    const gid = /^\d+$/.test(String(groupId)) ? Number(groupId) : groupId
    return { action: 'send_group_msg', field: 'group_id', id: gid, label: 'group=' + String(groupId) }
  }

  /**
   * retcode 1200 = **那个群把它禁言了**。
   *
   * ★ 2026-10-17 用户确认：机器人在群里被禁言之后，每次 `send_group_msg` 都回
   *   `status=failed / retcode=1200`，消息**并没有**进群（NapCat 那边还会同时抛
   *   `EventChecker Failed ... onMsgInfoListUpdate`，容易误以为是"其实发出去了"）。
   *
   * 所以：既不能当成功，也不该每来一条消息就白烧一次模型调用 ——
   * 失败时给这个群挂一段冷却，冷却期内不再**主动**判断（被 @ 仍然照回）。
   */
  const MUTE_BACKOFF_MS = 5 * 60 * 1000

  async function sendSegments(t, segments) {
    const params = {}
    params[t.field] = t.id
    params.message = segments
    const ack = await sendAction({
      action: t.action,
      params: params,
      echo: 'qqb-send-' + Date.now(),
    })
    if (ack.ok === false) {
      const rc = Number(ack.retcode)
      if (rc === 1200 && t.field === 'group_id') {
        mutedGroups.set(String(t.id), Date.now() + MUTE_BACKOFF_MS)
        log('send rejected 1200 ' + t.label + ' -> 可能被禁言，' +
          String(Math.round(MUTE_BACKOFF_MS / 60000)) + ' 分钟内不再主动判断这个群')
      }
      log('send REJECTED ' + t.label + ' retcode=' + String(ack.retcode) +
        ' status=' + String(ack.status) + ' reason=' + String(ack.reason || ''))
      state.lastError = 'send rejected ' + String(ack.retcode !== undefined ? ack.retcode : (ack.reason || ''))
    } else if (ack.ok === null) {
      log('send ack timeout ' + t.label + ' (QQ may have silently dropped it)')
      state.lastError = 'send ack timeout'
    } else if (ack.data) {
      noteOwnMessage(ack.data.message_id !== undefined ? ack.data.message_id : ack.data.messageId)
    }
    return ack
  }

  async function sendGroup(t, text) {
    return sendSegments(t, [{ type: 'text', data: { text: String(text) } }])
  }

  async function sendGroupSplit(t, text) {
    const chunks = splitReply(text, Number(cfg.reply?.splitAt) || 400)
    for (let i = 0; i < chunks.length; i++) {
      const ack = await sendGroup(t, chunks[i])
      if (ack && ack.ok === false) {
        throw new Error('send rejected retcode=' + String(ack.retcode !== undefined ? ack.retcode : (ack.reason || '?')))
      }
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 350))
    }
  }

  function enqueue(key, task) {
    const prev = queues.get(key) || Promise.resolve()
    const next = prev.then(task, task).catch((e) => log('task error:', e?.message))
    queues.set(key, next)
    return next
  }

  // ---------------------------------------- 群聊回合制（2026-10-17 · 方案 A）
  /**
   * 把"批处理"换成"回合制"。三件事：
   *   ① 触发不是计时器，是**话落地**：有人问了个问题，10 秒没人接 → 才去判断。
   *      （另有"话题勾连"：消息和她记得的事强命中时也看一眼）
   *   ② 判断看得到 12 条上下文 + **她自己最近 3 句**，输出三态 speak/wait/skip。
   *      wait 是关键：人类多数时候是"等他说完"，不是立刻判断。
   *   ③ 说的时候**锁定"接哪一条"**，其余当背景 —— 这是治答非所问的关键。
   *
   * 防复读怎么解决（用户问的）：判断阶段就把"我最近说过什么"摆在它面前，
   * 它自己会说 skip 或换个角度；出口那层模糊相似闸门留着当兜底（只有命中才多花一次调用）。
   */
  const rooms = new Map() // groupId -> { msgs, questionTimer, recheckTimer, lastSpokeAt, judging, pendingQQ, waited }

  function roomOf(groupId) {
    const key = String(groupId)
    let r = rooms.get(key)
    if (!r) {
      r = { msgs: [], questionTimer: null, recheckTimer: null, lastSpokeAt: 0, judging: false, pendingQQ: '', waited: 0 }
      rooms.set(key, r)
    }
    return r
  }

  /** 问句判据（本地、免费）：有"?"或者常见疑问词。宁可多认几个，反正后面还要判断 */
  const QUESTION_RE = /[?？]|吗|呢|什么|怎么|为什么|为啥|谁|哪|多少|几个|是不是|有没有|能不能|可不可以|要不要/

  /** 记一条到滚动上下文，并写进记忆库（chatter，6h 半衰期，零模型调用） */
  function pushRoom(cfg, groupId, item) {
    const r = roomOf(groupId)
    const win = Math.max(4, Math.min(30, Number(cfg.reply?.turn?.window) || 12))
    const msg = { ...item, at: Date.now(), isQuestion: QUESTION_RE.test(String(item.text || '')) }
    r.msgs.push(msg)
    if (r.msgs.length > win) r.msgs = r.msgs.slice(-win)
    try {
      const raw = String(item.text || '').trim()
      if (raw.length >= 2) {
        memoryAdd({ qq: String(item.userId), group: 'group:' + String(groupId), kind: 'chatter', importance: 1, text: raw.slice(0, 100), source: 'raw' })
      }
    } catch (e) { log('raw memory write failed:', e?.message) }
    // 日摘要的原始素材（跨天 / 攒够条数时才压缩，平时只是追加一行）
    try { noteDay(cfg, groupId, item.nick, item.userId, item.text) } catch (e) { log('noteDay failed:', e?.message) }
    return msg
  }

  /** 这段等待结束（有人回了 / 有人直接 @ 她） */
  function clearQuestion(groupId) {
    const r = roomOf(groupId)
    if (r.questionTimer) { clearTimeout(r.questionTimer); r.questionTimer = null }
    r.pendingQQ = ''
  }

  /**
   * 判一次：要不要说话、接哪一条。
   * act=speak → 生成；wait → 30 秒后再看一次（只一次）；skip → 撤。
   */
  async function judgeRoom(groupId, reason) {
    const key = String(groupId)
    const r = roomOf(key)
    if (r.judging) return
    const tcfg = cfg.reply?.turn || {}
    if (tcfg.enabled === false) return
    r.judging = true
    try {
      const cool = Math.max(0, Number(tcfg.cooldownSec) || 45) * 1000
      if (r.lastSpokeAt && Date.now() - r.lastSpokeAt < cool) {
        log('judge skipped (cooldown) group=' + key)
        return
      }
      // 刚被 1200（禁言）拒过：冷却期内不再主动判断，省一次模型调用。被 @ 那条路不受影响。
      const mutedUntil = mutedGroups.get(key) || 0
      if (mutedUntil > Date.now()) {
        log('judge skipped (muted?, ' + String(Math.ceil((mutedUntil - Date.now()) / 1000)) + 's left) group=' + key)
        return
      }
      const ab = peekBudget(cfg, key, Date.now())
      if (!ab.ok) { log('judge skipped (' + String(ab.why) + ') group=' + key); return }

      const win = Math.max(4, Math.min(30, Number(tcfg.window) || 12))
      const msgs = r.msgs.slice(-win)
      if (msgs.length === 0) return
      const lines = msgs.map((m, i) =>
        '[' + String(i + 1) + '] [' + m.nick + '(' + m.userId + ')]: ' + (String(m.text || '').trim() || '（发了图，没写字）'))

      const gkey = 'group:' + key
      const sess = sessionOf(mem, gkey)
      const mine = sess.rounds.filter((x) => x.role === 'assistant').slice(-3).map((x) => String(x.content || ''))
      const lastUser = String(msgs[msgs.length - 1].userId)
      let memBlock = ''
      try {
        const hits = recall(storeOf(), {
          qq: lastUser, group: gkey, text: lines.join('\n'),
          limit: 2, minScore: Number(cfg.memory?.recallMinScore),
        })
        memBlock = renderRecall(hits)
      } catch (e) { log('memory recall failed:', e?.message) }

      // 判定用的人设节选（默认前 500 字）。太长会让每次判定都贵一大截，所以只给"她是谁"那一段。
      const judgePersonaChars = Math.max(0, Number(tcfg.judgePersonaChars) || 500)
      const personaBrief = judgePersonaChars > 0
        ? String(cfg.persona?.system || '').trim().slice(0, judgePersonaChars)
        : ''
      const idleMin = r.lastSpokeAt ? (Date.now() - r.lastSpokeAt) / 60000 : 999
      // ★ 2026-10-17 改（用户裁定 B）：原来这里是"旁观者"规则 —— 只有没人接、或跟你有关才说话。
      //   实测 3/3 判定全是 skip（why 一律 unrelated to me），主动开口永远是 0。
      //   现在改成"你也是群成员"：有角度就可以接，只把"插不上嘴/别人私事/复读"留作 skip。
      const sys = '你是这个 QQ 群的一员，名字是「' + String(cfg.persona?.name || '') + '」，不是旁观者。\n' +
        (personaBrief ? '【你是这样的人】\n' + personaBrief + '\n\n' : '') +
        '现在只做一件事：判断**要不要插一句话**，以及**接哪一条**。\n' +
        '规则：\n' +
        '· 不用等话题跟你有关 —— 群聊本来就是各说各的。有角度就可以接：吐槽、附和、接梗、补充、指出问题、好奇地问一句。\n' +
        '· 但这些情况 skip：别人在正经讨论你插不上嘴的事、明显是两个人之间的私事、或者你根本没什么可说的。\n' +
        '· 别人刚说了半句、或明显还要继续说 → wait。\n' +
        '· 你要说的话和你「最近说过的」重复或同款 → skip（宁可不说，也别复读）。\n' +
        (idleMin >= 10 ? '· 你已经 ' + String(Math.round(idleMin)) + ' 分钟没说话了：这一条可以稍微主动一点，真有话就说。\n' : '') +
        // ★ why 用英文：日志只写 ASCII，中文会被打成 ????????，调参时等于没有理由。
        '只输出 JSON，不要别的字：{"act":"speak|wait|skip","target":序号,"why":"english, max 8 words"}'

      const user = '【最近的消息】（序号是给你指认用的）\n' + lines.join('\n') +
        '\n\n【你最近说过的】\n' + (mine.length > 0 ? mine.map((x) => '· ' + x).join('\n') : '(还没说过话)') +
        (memBlock ? '\n\n' + memBlock : '') +
        '\n\n现在给出 JSON。'

      let out = ''
      try {
        out = await ask(ctx, cfg, sys, [], user, undefined, undefined, lastUser,
          { maxTokens: Math.max(80, Number(tcfg.judgeMaxTokens) || 160), reasoningEffort: 'off' })
      } catch (e) {
        log('room judge call failed (treat as skip):', e?.message)
        return
      }

      let act = 'skip'
      let target = msgs.length
      let why = ''
      try {
        const s = String(out || '')
        const a = s.indexOf('{')
        const b = s.lastIndexOf('}')
        if (a >= 0 && b > a) {
          const o = JSON.parse(s.slice(a, b + 1))
          act = String(o.act || 'skip')
          target = Number(o.target) || msgs.length
          why = String(o.why || '')
        }
      } catch { log('room judge: JSON parse failed, skip') }
      if (!/^(speak|wait|skip)$/.test(act)) act = 'skip'
      target = Math.max(1, Math.min(msgs.length, target))
      log('room judge(' + String(reason) + '): ' + act + ' target=' + String(target) + ' why=' + ascii(why).slice(0, 40))

      if (act === 'skip') return
      if (act === 'wait') {
        // 只等一次：等完还判 wait 就当 skip，否则会无限拖
        if (r.waited >= 1) { log('judge: waited once already, giving up'); return }
        r.waited++
        if (r.recheckTimer) clearTimeout(r.recheckTimer)
        const retryMs = Math.max(10, Number(tcfg.waitRetrySec) || 30) * 1000
        r.recheckTimer = setTimeout(() => { r.recheckTimer = null; void judgeRoom(key, 'after-wait') }, retryMs)
        return
      }

      // speak：锁定"接哪一条"
      const t = msgs[target - 1]
      const windowBlock = '【群里刚才在说这些】（序号只给你指认用，别写进回复）\n' + lines.join('\n') +
        '\n\n**你要接的是第 ' + String(target) + ' 条**：' +
        '[' + t.nick + '(' + t.userId + ')]: ' + (String(t.text || '').trim() || '（发了图，没写字）') +
        '\n其余几条只是背景，不用逐条回应，也别按顺序挨个答。'

      await enqueue(gkey, async () => {
        const system = buildSystem(cfg, { aliases: botAliases(cfg, state.nickname), botQQ: state.qq })
        const personBlock = buildPersonBlock(cfg, key, String(t.userId), { addressed: false })
        const contextBlock = buildContextBlock(cfg, injectableSummary(sess.summary, cfg), personBlock, memBlock, windowBlock)
        const userText = '[' + t.nick + '(' + t.userId + ')]: ' + (String(t.text || '').trim() || '（发了图，没写字）')
        const r2 = await runReplyAndSend(key, String(t.userId), userText, system, contextBlock, sess, {
          mentioned: false,
          images: t.images,
          mentionedNames: [],
        })
        if (r2 && r2.outcome === 'sent') {
          commitBudget(key, true, Date.now())
          r.lastSpokeAt = Date.now()
          r.waited = 0
        }
      })
    } catch (e) {
      log('judgeRoom failed:', e?.message)
    } finally {
      r.judging = false
    }
  }

  // --------------------------- 日摘要（2026-10-17 · 搬 MemoryBank 的三层摘要）
  /**
   * 每群攒一份"当天原话"，跨天或攒够 maxLines 条时压成一条 event 记忆。
   * 为什么需要：会话窗口只有 20 轮（≈一天），跨天之后她只剩一条几乎不触发的摘要。
   * 日摘要补的正是"昨天大致发生了什么"这一层。
   * 成本：每群每天 1 次（特别忙时每 60 条 1 次），输出 ≤100 字。
   */
  const dayBuf = new Map() // groupId -> { date, lines: [], flushing }

  function noteDay(cfg2, groupId, nick, userId, text) {
    const key = String(groupId)
    const today = localDayKey(Date.now())
    let b = dayBuf.get(key)
    if (!b) { b = { date: today, lines: [], flushing: false }; dayBuf.set(key, b) }
    if (b.date !== today) {
      // 跨天了：把昨天那份压掉，再开新的一天
      const old = b
      dayBuf.set(key, { date: today, lines: [], flushing: false })
      if (!old.flushing && old.lines.length >= 5) { old.flushing = true; void flushDay(key, old) }
      b = dayBuf.get(key)
    }
    const t = String(text || '').trim()
    b.lines.push('[' + fmtClock(Date.now()) + ' ' + nick + '(' + userId + ')] ' + (t || '（发了图）'))
    const maxLines = Math.max(20, Number(cfg2.memory?.daySummaryLines) || 60)
    if (b.lines.length >= maxLines && !b.flushing) {
      const snapshot = b
      dayBuf.set(key, { date: b.date, lines: [], flushing: false })
      snapshot.flushing = true
      void flushDay(key, snapshot)
    }
  }

  async function flushDay(key, b) {
    try {
      const body = b.lines.join('\n').slice(-4000)
      const out = await ask(ctx, cfg,
        '你在给一个 QQ 群做当天摘要。把下面这段群聊压成两三句，只写：\n' +
        '① 发生了什么值得记的事　② 谁和谁的关系有变化　③ 有没有约定\n' +
        '不写评价、不写情绪基调、不写建议。总长不超过 100 字。只输出摘要本身。',
        [], body, undefined, undefined, '', { maxTokens: 300, reasoningEffort: 'off' })
      const text = String(out || '').replace(/\s+/g, ' ').trim().slice(0, 110)
      if (!text) return
      memoryAdd({ qq: '', group: 'group:' + key, kind: 'event', importance: 4, text: b.date + ' ' + text, source: 'day' })
      log('day summary written group=' + key + ' date=' + b.date + ' chars=' + String(text.length))
    } catch (e) {
      log('day summary failed:', e?.message)
    }
  }

  // ------------------------------------ 关系演化（2026-10-17 · 搬 arc summary）
  /**
   * MemoryBooks 的 arc summary 只记"关系怎么变"，不记事件 —— 那正是防角色漂移的东西。
   * 这里**每人一条、永不衰减**，每 N 轮（默认 30）重写一次；
   * 没有变化就沿用旧文本，所以不会越写越飘。
   * 存在 memory-store.json 的 `relations` 里（和记忆条目同一个文件，但不参与衰减/召回）。
   *
   * ★ 2026-10-17 修：计数器以前只放在进程内存（`const relationCounters = new Map()`），
   *   **重启就归零**。开发期一天重启好几次 ⇒ 30 轮的阈值永远到不了，实测 `relations` 一直是 0 条。
   *   现在计数器落在 store.relationCounters[qq]，和条目一起写在同一个文件里，重启不再丢。
   */
  function relationCountAdd(qq) {
    const st = storeOf()
    if (!st.relationCounters || typeof st.relationCounters !== 'object') st.relationCounters = {}
    const k = String(qq)
    const n = (Number(st.relationCounters[k]) || 0) + 1
    st.relationCounters[k] = n
    saveStoreNow()
    return n
  }

  function scheduleRelation(groupId, userId, sess) {
    const every = Math.max(5, Number(cfg.memory?.relationEvolveEvery) || 30)
    let reached = false
    try {
      const n = relationCountAdd(userId)
      if (n >= every) {
        storeOf().relationCounters[String(userId)] = 0
        saveStoreNow()
        reached = true
      }
    } catch (e) { log('relation counter failed:', e?.message); return }
    if (reached) void evolveRelation(userId, sess)
  }

  async function evolveRelation(userId, sess) {
    try {
      const st = storeOf()
      const cur = (st.relations && st.relations[String(userId)] && st.relations[String(userId)].text) || ''
      const turns = sess.rounds.slice(-12)
        .map((m) => (m.role === 'assistant' ? '我: ' : '对方: ') + String(m.content || ''))
        .join('\n')
      if (!turns.trim()) return
      const out = await ask(ctx, cfg,
        '你在更新你和某个人之间的关系记录。\n' +
        '旧记录：' + (cur || '(还没有)') + '\n' +
        '根据下面这段对话，用一到两句重写"你们现在的关系"。\n' +
        '只写有依据的变化（更熟了、更冷了、他开始正经跟你说话、他在敷衍你）；**没有变化就原样沿用旧记录**。\n' +
        '不写建议、不写评价、不超过 40 字，只输出关系本身。',
        [], turns, undefined, undefined, String(userId), { maxTokens: 120, reasoningEffort: 'off' })
      const text = String(out || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      if (!text) return
      if (!st.relations) st.relations = {}
      const prev = st.relations[String(userId)] || {}
      // 文本没变就沿用旧的 at（"没有变化就原样沿用"，别把没变化的日子也记成一次改写）
      st.relations[String(userId)] = {
        text: text,
        at: text !== cur ? Date.now() : (Number(prev.at) || Date.now()),
      }
      saveStoreNow()
      log('relation evolved qq=' + String(userId) + ' -> ' + ascii(text).slice(0, 40))
    } catch (e) { log('relation evolve failed:', e?.message) }
  }

  // 设置页「现在演化」按钮要用它（路由在 registerRoutes 里，拿不到这个闭包）
  relationEvolver = evolveRelation

  async function handleGroup(ev) {
    const groupId = ev.group_id
    const userId = ev.user_id
    const gkey = 'group:' + groupId

    if (cfg.enabled === false) return
    if (cfg.blacklist?.groups?.some((g) => String(g) === String(groupId))) return
    if (cfg.blacklist?.users?.some((u) => String(u) === String(userId))) return
    // ★ 2026-10-15：合并转发的聊天记录**直接不理**。
    //   正文要额外调 get_forward_msg 才取得到；取不到就只能看到占位符，
    //   模型会对着空壳编话（实测："这合并转发我一打开，里面是空的"）。
    //   宁可当没看见，也不要让她瞎说。
    if (isPureForward(ev?.message)) {
      log('pure forward ignored (group=' + String(groupId) + ' user=' + String(userId) + ')')
      return
    }

    // ★ 别名表要在解析之前算好：解析时要用它做"有没有人直接叫它名字"的判断
    const aliases = botAliases(cfg, state.nickname)
    const { text, mentioned, images, mentionedQQ, mentionedNames, calledName, replyToBot } = parseIncoming(ev, { aliases })
    if (images.length > 0) log('message contains ' + String(images.length) + ' image(s)')
    if (calledName) log('called by name: ' + ascii(calledName) + ' (group=' + String(groupId) + ')')
    // ★ 被 @ 的判定结果要留痕（2026-10-15 加）：@ 判定是"静默失效"型的 ——
    //   判错了日志里什么都看不出来，只能靠事后翻聊天记录倒推。这一行把
    //   "基准 QQ / 被 @ 的 QQ 列表 / 依据"钉在日志里，下次一眼可查。
    //   ⚠️ 这段引用的每个标识符都必须在上面解构出来 —— 2026-10-15 就是这里写了
    //      `mentionedQQ` 但没解构，导致**只有被 @ 时才抛 ReferenceError**，
    //      把宿主整个带崩（crash-2026-10-15T13-28-10-261Z-host.log）。
    if (mentioned) {
      log('at-me: selfQQ=' + String(selfQQOf(ev, { botQQ: state.qq })) +
        ' at=' + JSON.stringify(mentionedQQ || []) +
        ' by=' + (calledName ? 'name:' + ascii(calledName) : (replyToBot ? 'quote' : 'at')))
    }
    // ★ 引用回复它的话：留一行日志，重启后一眼就能确认这条判据到底有没有生效
    if (replyToBot) log('quote reply to me (group=' + String(groupId) + ')')
    // ★★ 两条并行逻辑（2026-10-17，用户定的）：
    //   ① 必回通道：@ / 叫名字 / 引用 —— 立刻走下面的完整流程，**不等批处理**
    //   ② 闲聊通道：其余消息进缓冲，静默 N 秒或攒够 M 条后，由模型判断一次要不要插话，
    //      要回就回**一次**（把这几条当一批）
    //
    //   为什么删掉骰子：旧逻辑 `chance=5` 是**纯随机**，跟内容完全无关 ——
    //   一句 @ 全群的技术问题可能被挡掉，一句"哈哈哈哈"可能被抽中。
    //   现在"回不回"由内容判断，"什么时候回"由缓冲窗口决定，
    //   顺带把"每句都回"变成"几句回一句"，群里更像人。
    if (!mentioned) {
      if (cfg.reply?.requireAt) return
      const bnick = ev?.sender?.card || ev?.sender?.nickname || String(userId)
      try { touchPerson(cfg, userId, bnick) } catch (e) { log('touchPerson failed:', e?.message) }
      noteSpeaker(groupId, userId)
      const msg = pushRoom(cfg, groupId, { userId: String(userId), nick: bnick, text, images })
      const r = roomOf(groupId)
      const waitSec = Math.max(3, Number(cfg.reply?.turn?.questionWaitSec) || 10)
      if (msg.isQuestion) {
        // 有人问了一句 —— 这么多秒内没人接，就去看一眼要不要接
        // ★ 2026-10-17 修：以前**每个新问句都会 clearQuestion() 把上一个计时器顶掉**。
        //   群里问句一密（实测 9 分钟 5 次），计时器永远等不到落地 —— 41 条消息只换来 1 次判定。
        //   现在：已有计时器在等就**不重置**，让它照常到点（判的时候窗口里有最新消息，不吃亏）。
        if (r.questionTimer) {
          log('question pending (timer kept, ' + String(waitSec) + 's from first) group=' + String(groupId) + ' user=' + String(userId))
        } else {
          r.pendingQQ = String(userId)
          r.questionTimer = setTimeout(() => {
            r.questionTimer = null
            void judgeRoom(groupId, 'unanswered-question')
          }, waitSec * 1000)
          log('question pending ' + String(waitSec) + 's group=' + String(groupId) + ' user=' + String(userId))
        }
      } else if (r.questionTimer && String(userId) !== String(r.pendingQQ || '')) {
        // 别人接上了 → 这句话落地了，不需要她插嘴
        clearQuestion(groupId)
        log('question answered by ' + String(userId) + ' group=' + String(groupId))
      }
      // 话题勾连：和她记得的事命中到一定程度才看一眼。
      // ★ 2026-10-17 调：阈值原来硬编码 0.6，实测对当前记忆库等于关闭（重启后 9 分钟 0 命中）。
      //   改成可配置 `memory.topicHookMinScore`，默认 0.4。
      try {
        const raw = String(text || '').trim()
        const hookCfg = Number(cfg.memory?.topicHookMinScore)
        const hookMin = Number.isFinite(hookCfg) && hookCfg > 0 ? hookCfg : 0.4
        if (raw.length >= 6 && !r.questionTimer) {
          const hit = recall(storeOf(), {
            qq: String(userId), group: 'group:' + String(groupId), text: raw, limit: 1, minScore: hookMin,
            kinds: ['core', 'event'], // 排除 chatter：否则每条新消息都会命中自己刚说的话
          })
          if (hit.length > 0) {
            if (r.recheckTimer) clearTimeout(r.recheckTimer)
            r.recheckTimer = setTimeout(() => {
              r.recheckTimer = null
              void judgeRoom(groupId, 'topic-hook')
            }, 5000)
            log('topic hook hit (score=' + hit[0].score.toFixed(2) + ') group=' + String(groupId))
          }
        }
      } catch (e) { log('topic hook failed:', e?.message) }
      return
    }
    // 有人直接 @/叫名字/引用 → 这段等待结束，别再补一句
    clearQuestion(groupId)

    const nick = ev?.sender?.card || ev?.sender?.nickname || String(userId)
    // 人物档案：一人一档。先记一笔（昵称跟着群名片走），再把"当前说话者"的档案注入提示词。
    try { touchPerson(cfg, userId, nick) } catch (e) { log('touchPerson failed:', e?.message) }
    noteSpeaker(groupId, userId)
    // 被 @ 的那些话同样是"当天素材"
    try { noteDay(cfg, groupId, nick, userId, text) } catch (e) { log('noteDay failed:', e?.message) }
    // ★ addressed 决定要不要给"他干过的事"那一层：
    //   被直接叫到（@ / 叫名字 / 引用它）→ 给，它可能正要谈正事；
    //   走 5% 骰子的闲聊 → 不给，避免递材料让模型去引用。
    const personBlock = buildPersonBlock(cfg, groupId, userId, { addressed: !!mentioned })
    const tag = '[' + nick + '(' + String(userId) + ')]'
    // 纯图片无文字时**别说成"没说话"**（实测它因此答非所问，明明图里有内容）。
    // ★ 另外补上"只 @ 了别人、没写字"这一情形 —— 旧代码会把它写成"（只是 @ 了你，没说话）"，
    //   等于**撒谎**：明明 @ 的是别人，却告诉模型在 @ 它，模型当然会错认（2026-10-14 修）。
    //   ★ 再补"被叫名字"这一情形：有人直接打名字叫它、没打 @，也要说清是在叫它。
    const onlyAtOthers = !text && mentionedNames.length > 0 && !mentioned
    const userText = text
      ? tag + ': ' + text
      : tag + ': （' + (images.length > 0
          ? '发了 ' + String(images.length) + ' 张图，没写字'
          : onlyAtOthers
            ? '只 @ 了 ' + mentionedNames.join('、') + '，没写字'
            : mentioned
              ? (calledName ? '叫了你的名字（' + calledName + '），没写字' : '只是 @ 了你，没说话')
              : '发了条空消息') + '）'

    state.lastIncomingAt = Date.now()
    log('group message group=' + String(groupId) + ' user=' + String(userId) + ' len=' + String(text.length))

    return enqueue(gkey, async () => {
      const sess = sessionOf(mem, gkey)
      // ★ 阶段5：system 只放稳定段（逐字节一致 → 前缀缓存），每轮都变的档案/摘要走 contextBlock
      //   invoke 把"别名表 + 自己的 QQ"传进去，让它知道哪些称呼是在叫它（和 @ 识别配套）
      const system = buildSystem(cfg, { aliases, botQQ: selfQQOf(ev, { botQQ: state.qq }) })
      // ★ 阶段2：召回纯数学、零模型调用；命中即 hits+1（复习增强：提过的事记得更久）
      let memBlock = ''
      try {
        const hits = recall(storeOf(), {
          qq: String(userId),
          group: gkey,
          text: userText,
          limit: Number(cfg.memory?.recallLimit) || 2,
          minScore: Number(cfg.memory?.recallMinScore),
        })
        memBlock = renderRecall(hits)
        if (bump(hits, Date.now()) > 0) saveStoreNow()
      } catch (e) { log('memory recall failed:', e?.message) }
      const contextBlock = buildContextBlock(cfg, injectableSummary(sess.summary, cfg), personBlock, memBlock)
      // ★ 出口逻辑全部在 runReplyAndSend 里（群消息和戳一戳共用一份，别再往这里写）
      const r = await runReplyAndSend(groupId, userId, userText, system, contextBlock, sess, {
        images: images,
        mentioned: !!mentioned,
        mentionedNames: mentionedNames,
      })
      // ★ 真的发出去了才扣额度（peek/commit 分离）：模型选[沉默]或发送失败都不该扣。
      if (r && r.outcome === 'sent') commitBudget(groupId, !mentioned, Date.now())
    })
  }

  /**
   * 戳一戳（群）。
   *
   * ★ 2026-10-15 加。为什么以前完全看不见（两个坑叠在一起，缺一个都接不到）：
   *   ① 它在 OneBot 里是 **notice 事件**（`post_type:'notice'`），不是 message ——
   *      而 `onMessage` 第一行就是 `if (ev?.post_type !== 'message') return`，**整个丢掉**。
   *      代码里 `SEGMENT_LABEL.poke = '（戳一戳）'` 那行因此是**死代码**，永远走不到。
   *   ② 就算接了 notice，判据也**不能**写 `notice_type === 'poke'` ——
   *      真实报文里 `notice_type` 是 **'notify'**，真正的判据是 **`sub_type === 'poke'`**。
   *      实测原文：{"post_type":"notice","notice_type":"notify","sub_type":"poke",
   *                "group_id":791778458,"user_id":2393751580,"target_id":2010489178,
   *                "raw_info":[...,{"txt":"拍了拍"},...,{"txt":"的小学，哦齁齁齁齁齁"}]}
   *
   * 只处理**戳它自己**的：群里互相戳很频繁（实测 4 分钟内就有一条），全接就是刷屏。
   * 冷却按 (群:人) 算，被同一个人反复戳不会连回。
   */
  /**
   * 【公共出口】取回复 → 重试阶梯 → 沉默判定 → 防复读 → 清洗 → [记:] → 组装段 → 写记忆 → 发送。
   *
   * ★ 2026-10-15 抽取。为什么必须抽（不是"为了好看"）：
   *   群消息和戳一戳是**同一套出口逻辑**，原先各写一遍 —— 我加戳一戳那次就漏了
   *   防复读和分段发送（poke 路径没有这两样）⇒ **重复的代价已经变成过真实的不一致**。
   *   两条入口现在共用这一份，以后改出口只改这里。
   *
   * @param opts.poke     true = 戳一戳入口（日志前缀不同，且不传图片）
   * @param opts.swallow  true = 发送失败也不抛（戳一戳是附赠行为，不值得让整条任务炸）
   * @returns { outcome, reply, segments } —— outcome ∈ sent | silent | empty | error
   *          （调用方据此决定是否 commit 额度、是否重试）
   */
  async function runReplyAndSend(groupId, userId, userText, system, contextBlock, sess, opts) {
    const o = opts || {}
    const poke = o.poke === true
    const isPrivate = o.private === true
    const t = targetOf(groupId, userId, isPrivate)
    const tag = poke ? 'poke' : (isPrivate ? 'private' : 'group')
    const maxAts = Math.max(0, Number(cfg.reply?.maxAts) || 1)
    const nudgeBase = system + (contextBlock ? '\n\n' + contextBlock : '')

    let reply = ''
    try {
      reply = await ask(ctx, cfg, system, sess.rounds, userText, undefined, o.images, userId, { contextBlock })
      if (!reply && !poke) {
        // 空回复重试只在群消息这条路做（戳一戳走下面的简化重试）
        log('empty reply, retry 1/2 (same context + nudge)')
        reply = await ask(ctx, cfg, nudgeBase + '\n\n（请直接输出你要说的那句话。不要思考过程，不要留空。）',
          sess.rounds, userText, undefined, undefined, userId)
        if (!reply) {
          log('empty reply, retry 2/2 (minimal context, no history)')
          reply = await ask(ctx, cfg, nudgeBase + '\n\n（请直接输出你要说的那句话。不要思考过程，不要留空。）',
            [], userText, undefined, undefined, userId)
          if (reply) {
            log('minimal-context retry WORKED -> history suspected, cleared this session history')
            sess.rounds = []
            sess.summary = ''
          }
        }
      } else if (!reply) {
        reply = await ask(ctx, cfg, nudgeBase + '\n\n（对方戳了你。你可以回一句，也可以什么都不说——不想理就只输出 [沉默]。' +
          '要回的话直接说话，不要解释这是一条系统提示。）', sess.rounds, userText, undefined, undefined, userId)
      }
    } catch (e) {
      log(tag + ' llm call failed code=', e?.code ?? '(none)', 'msg=', e?.message)
      state.lastError = String(e?.code || e?.message || 'llm error')
      if (!poke) { try { await sendGroupSplit(t, humanError(e)) } catch {} }
      return { outcome: 'error' }
    }
    if (!reply) {
      log(poke ? 'poke: empty reply, giving up' : 'still empty after both retries, giving up this message')
      if (!poke) state.lastError = lastAskFailure || 'empty reply'
      return { outcome: 'empty' }
    }

    // 模型主动选择沉默 —— 什么都不发，也不写进记忆（省一次群打扰 + 省记忆）
    if (SILENT_RE.test(String(reply))) {
      log((poke ? 'poke: model chose SILENCE' : 'model chose SILENCE, nothing sent') + ' (group=' + String(groupId) + ')')
      return { outcome: 'silent' }
    }

    // 防复读：历史回放去不掉，只能在出口拦。
    // ★ 2026-10-17 改：从"一字不差"改成"像就算"。
    //   理由：改一个字就算新话 —— 实测 47 条回复里没有一条会被旧判据拦到，
    //   可腔调确实在同一套句式里打转（"少来。""谁要你夸了。"）。旧判据形同虚拟。
    //   现在拿**最近 3 句**自己的话做 Dice 二元组相似度，≥0.7 就要求重写一次。
    //   ⚠️ 只重写一次：这里每一次重试都是完整的一次调用，别让它变成 3 倍费用（见 3.5 教训）。
    const lastAssistants = []
    for (let i = sess.rounds.length - 1; i >= 0 && lastAssistants.length < 3; i--) {
      if (sess.rounds[i].role === 'assistant') {
        const c = String(sess.rounds[i].content || '')
        if (c) lastAssistants.push(c)
      }
    }
    const dupOf = lastAssistants.find((x) => repeatSimilarity(x, reply) >= 0.7)
    if (dupOf) {
      log('reply too similar to a recent turn (sim>=0.7), asking for a different wording')
      try {
        const again = await ask(ctx, cfg, system + '\n\n（你刚才那句和前几句太像了：同样的句式、同样的口气。换个说法重说，别复读。）',
          sess.rounds, userText, undefined, undefined, userId)
        if (again && repeatSimilarity(dupOf, again) < 0.7) reply = again
      } catch (e) { log('anti-repeat retry failed:', e?.message) }
    }

    // 压空行 + 剥时间戳。★ 顺序必须在防复读**之后**（那次重试也会改 reply）。
    {
      const before = String(reply)
      let t = before
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim()
      // 剥模型自己加的时间戳前缀。只剥"行首且是合法时钟"的，宁可漏剥不误删。
      // ⚠️ 别写成 `[0-2]?\d` —— 它会匹配 `25`，把「[25:00] 不是时间」也误剥。
      const TS_LINE = /^(?:\[[0-9]:[0-5]\d\]|\[[01]\d:[0-5]\d\]|\[2[0-3]:[0-5]\d\])\s*/gm
      const noTs = t.replace(TS_LINE, '')
      if (noTs !== t) { log('stripped model-added timestamp prefix: ' + String(t.length - noTs.length) + ' chars'); t = noTs.trim() }
      if (!t) { log('reply became empty after timestamp strip -> treating as silence'); return { outcome: 'silent' } }
      reply = t
      if (before !== reply) log('collapsed blank lines: ' + String(before.length) + ' -> ' + String(reply.length) + ' chars')
    }

    // 模型想长期记住的事：[记:...] → **待审区**（不写档案），标签绝不给群里看到
    const factHits = []
    const stripped = String(reply).replace(FACT_RE, (all, body) => {
      const t = String(body).trim()
      if (t) factHits.push(t)
      return ''
    }).trim()
    if (stripped) reply = stripped
    if (factHits.length > 0) {
      let appended = 0
      let seenRec = null
      try { seenRec = readPersonFile(cfg, userId) } catch {}
      for (const t of factHits) {
        if (seenRec && (String(seenRec.history || '').includes(t) || String(seenRec.profile?.['注意'] || '').includes(t))) continue
        if (appendPending(userId, t, '记')) appended++
        // ★ 阶段2：同时进记忆库。待审区给**人**看，记忆库给**她**读 ——
        //   只写待审区就是现在这个死结：抽了、存了、她从来读不到。
        memoryAdd({ qq: String(userId), group: 'group:' + String(groupId), kind: 'core', importance: 4, text: t, source: '记' })
      }
      if (appended > 0) log('pending +' + String(appended) + ' (from [记:]) qq=' + String(userId) + ' -> ' + ascii(PENDING_NOTES_PATH))
    }

    // ★ 2026-10-17：表情包功能删除。历史里可能还留着它以前写的 [表情:标签]，
    //   万一这次又写，就在出口掐掉；掐完什么都不剩，就当这次沉默（别发空消息）。
    const noSticker = String(reply).replace(STICKER_MARKER_RE, '').trim()
    if (noSticker !== String(reply)) { log('sticker marker stripped (feature removed)'); reply = noSticker }
    if (!reply) { log('reply empty after sticker-marker strip -> treat as silence'); return { outcome: 'silent' } }

    // 组装消息段：A 按概率 @ 说话的人；B 模型自己点名的 [@QQ号]
    // ★ 2026-10-17 修：私聊里不能 @（那是群消息才有的段），所以这里排除私聊。
    const atChance = Math.max(0, Math.min(100, Number(cfg.reply?.atSenderChance) || 0))
    const head = []
    let atUsed = 0
    if (!isPrivate && maxAts > 0 && atChance > 0 && (atChance >= 100 || Math.random() * 100 < atChance)) {
      head.push({ type: 'at', data: { qq: /^\d+$/.test(String(userId)) ? Number(userId) : String(userId) } })
      atUsed = 1
    }
    const body = buildReplySegments(reply,
      (raw) => resolvePersonQQ(cfg, raw), Math.max(0, maxAts - atUsed))
    const segments = head.concat(truncateSegments(body, Number(cfg.reply?.maxChars) || 0))
    const plain = segments.filter((s) => s.type === 'text').map((s) => String(s.data?.text ?? '')).join(' ').trim()

    // 先写记忆再发送：发送失败也不该丢掉"它说过什么"（否则下一轮会重复自己）
    sess.rounds.push({ role: 'user', content: userText, at: Date.now() })
    sess.rounds.push({ role: 'assistant', content: plain || reply, at: Date.now() })
    sess.updatedAt = Date.now()
    // ★ 阶段2补（2026-10-17）：把这一轮**原话**也记一笔（chatter，6 小时半衰期，重要度 1）。
    //   为什么非加不可：写入端原先只有两条路，都可能长期不触发 ——
    //     · extractFacts 只在压缩时跑（44 条触发，实测从未发生过）
    //     · [记:] 要模型自己想到
    //   ⇒ 记忆库会常年是空的，闭环名存实亡。
    //   原话入库**不花任何模型调用**，靠 6 小时衰减自己散掉（人也不记得昨天顺嘴说的话）。
    try {
      const rawText = String(userText).replace(/^\[[^\]]*\]\s*:\s*/, '').trim()
      if (rawText && rawText.charAt(0) !== '（' && rawText.length >= 4) {
        memoryAdd({
          qq: String(userId),
          group: 'group:' + String(groupId),
          kind: 'chatter',
          importance: 1,
          text: rawText.slice(0, 100),
          source: 'raw',
        })
      }
    } catch (e) { log('raw memory write failed:', e?.message) }
    await maybeSummarize(ctx, cfg, sess)
    saveMemory(mem)
    // ★ ② 关系演化：每 N 轮更新一次"你们现在的关系"（默认 30 轮，失败只写日志）
    try { scheduleRelation(groupId, userId, sess) } catch (e) { log('scheduleRelation failed:', e?.message) }

    try {
      // ★ 2026-10-17 修（用户反馈"从没见它 @ 过人"）：原来这里只在**含图片**时才发消息段数组，
      //   否则走 sendGroupSplit 只发纯文本 —— 于是 head 里那个 at 段被整个丢掉了，
      //   `atSenderChance` 和模型写的 [@QQ号] 全都发不出去（表情包删掉后永远没有 image 段）。
      //   现在只要**有非文本段**（at / image）就按消息段数组发，纯文本才走分段发送。
      if (segments.some((s) => s.type !== 'text')) {
        const ack = await sendSegments(t, segments)
        if (ack && ack.ok === false) throw new Error('send rejected retcode=' + String(ack.retcode))
      } else await sendGroupSplit(t, plain || reply)
    } catch (e) {
      log(tag + ' send failed:', e?.message)
      if (!o.swallow) throw e
      return { outcome: 'error' }
    }
    state.lastReplyAt = Date.now()
    state.lastError = ''
    log((poke ? 'poked-replied' : (isPrivate ? 'private-replied' : 'replied')) + ' ' + t.label +
      (poke ? ' user=' + String(userId) : ' segments=' + String(segments.length)) +
      ' chars=' + String((plain || reply).length) +
      (poke || isPrivate ? '' : (!o.mentioned ? ' (unsolicited)' : ' (at-me)') + ' at=' + JSON.stringify(o.mentionedNames || [])))
    return { outcome: 'sent', reply: reply, segments: segments }
  }

  /**
   * 私聊（2026-10-17 用户要求开放）。
   * 和群聊的区别：
   *   · 私聊是**冲着它来的**，所以不走回合制判断、不看主动额度 —— 直接回；
   *   · 会话和记忆按 `private:<QQ>` 单独存，不和群里混（跨群不召回那条纪律照旧）；
   *   · 不写日摘要（那是给群用的那一层）。
   * 仍然受：总开关、黑名单、纯合并转发丢弃、[沉默]、防复读、maxChars、看图。
   */
  function handlePrivate(ev) {
    try {
      if (cfg.enabled === false) return
      if (cfg.reply?.private !== true) { log('private message ignored (reply.private=false)'); return }
      const userId = String(ev?.user_id ?? '')
      if (!userId) return
      if (cfg.blacklist?.users?.some((u) => String(u) === userId)) return
      if (isPureForward(ev?.message)) { log('private: pure forward ignored user=' + userId); return }
      const aliases = botAliases(cfg, state.nickname)
      const parsed = parseIncoming(ev, { aliases })
      const text = String(parsed.text || '')
      const images = parsed.images || []
      const nick = ev?.sender?.card || ev?.sender?.nickname || userId
      try { touchPerson(cfg, userId, nick) } catch (e) { log('touchPerson failed:', e?.message) }
      const gkey = 'private:' + userId
      const userText = text
        ? text
        : ('（' + (images.length > 0 ? '发了 ' + images.length + ' 张图，没写字' : '发了条空消息') + '）')
      state.lastIncomingAt = Date.now()
      log('private message user=' + userId + ' len=' + String(text.length) + ' images=' + String(images.length))

      return enqueue(gkey, async () => {
        const sess = sessionOf(mem, gkey)
        const system = buildSystem(cfg, { aliases, botQQ: state.qq })
        let memBlock = ''
        try {
          const hits = recall(storeOf(), {
            qq: userId,
            group: gkey,
            text: userText,
            limit: Number(cfg.memory?.recallLimit) || 2,
            minScore: Number(cfg.memory?.recallMinScore),
          })
          memBlock = renderRecall(hits)
          if (bump(hits, Date.now()) > 0) saveStoreNow()
        } catch (e) { log('memory recall failed (private):', e?.message) }
        const personBlock = buildPersonBlock(cfg, gkey, userId, { addressed: true })
        const contextBlock = buildContextBlock(cfg, injectableSummary(sess.summary, cfg), personBlock, memBlock)
        // 私聊不算"主动插话"、不扣额度；真发出去了这里也不用 commitBudget
        await runReplyAndSend(gkey, userId, userText, system, contextBlock, sess, {
          private: true,
          images: images,
          mentioned: true,
          mentionedNames: [],
        })
      })
    } catch (e) { log('handlePrivate failed:', e?.message) }
  }

  function handlePoke(ev) {
    try {
      if (cfg.enabled === false) return
      const groupId = String(ev?.group_id ?? '')
      const userId = String(ev?.user_id ?? '')
      const targetId = String(ev?.target_id ?? '')
      const meQQ = selfQQOf(ev, { botQQ: state.qq })
      if (!groupId || !userId) return
      if (cfg.blacklist?.groups?.some((g) => String(g) === groupId)) return
      if (cfg.blacklist?.users?.some((u) => String(u) === userId)) return
      // 判据：sub_type 才是真的；notice_type 只是载体（写成 poke 会永远不中）
      if (String(ev?.sub_type) !== 'poke') return
      // 取不到自己的 QQ 就不判「是不是戳我」——宁可不动，不可乱认（和 @ 判定同一个纪律）
      if (!meQQ) { log('poke ignored: cannot resolve own QQ'); return }
      if (targetId !== meQQ) { log('poke: ' + userId + ' -> ' + targetId + ' (not me, ignored)'); return }

      const ck = 'group:' + groupId + ':' + userId
      const last = pokeCooldown.get(ck) || 0
      if (Date.now() - last < POKE_COOLDOWN_MS) {
        log('poke from ' + userId + ' within cooldown, ignored (group=' + groupId + ')')
        return
      }
      pokeCooldown.set(ck, Date.now())

      const phrase = pokePhraseOf(ev?.raw_info)
      const pokeText = renderPokeText(ev, cfg, meQQ)
      log('poke to me: user=' + userId + ' group=' + groupId + ' phrase=' + ascii(phrase))
      state.lastIncomingAt = Date.now()

      // 和群消息共用同一条队列：避免同群并发把记忆写乱，也保证顺序
      enqueue('group:' + groupId, async () => {
        const sess = sessionOf(mem, 'group:' + groupId)
        const aliases = botAliases(cfg, state.nickname)
        // 戳它的人也要进档案/最近发言人，否则模型不知道是谁在戳
        const nick = (personNameOf(cfg, userId) || String(userId))
        try { touchPerson(cfg, userId, nick) } catch {}
        noteSpeaker(groupId, userId)
        const system = buildSystem(cfg, { aliases, botQQ: selfQQOf(ev, { botQQ: state.qq }) })
        const contextBlock = buildContextBlock(cfg, injectableSummary(sess.summary, cfg),
          buildPersonBlock(cfg, groupId, userId, { addressed: true }))
        // ★ 出口逻辑和群消息共用 runReplyAndSend —— 原先这里少了两样（防复读、分段发送），
        //   抽出来之后两条入口行为一致了。
        await runReplyAndSend(groupId, userId, pokeText, system, contextBlock, sess, {
          poke: true,
          swallow: true,     // 戳一戳是附赠行为：发送失败不值得让整条任务炸
        })
      })
    } catch (e) { log('handlePoke failed:', e?.message) }
  }

  function onMessage(ev) {
    try {
      // 先处理我方主动请求的应答（actions 的 echo）
      if (ev && typeof ev.echo === 'string' && ev.post_type === undefined) {
        // ★ 回执先交给等待者（发送是否被拒就靠这条）
        const waiter = pendingAcks.get(ev.echo)
        if (waiter) {
          const failed = ev.status === 'failed' || (typeof ev.retcode === 'number' && ev.retcode !== 0)
          waiter({ ok: !failed, retcode: ev.retcode, status: ev.status, data: ev.data })
        }
        if (ev.echo === 'qqb-login') {
          state.qq = ev.data?.user_id ?? null
          state.nickname = ev.data?.nickname ?? ''
          log('login info: qq=' + String(state.qq) + ' nick=' + ascii(state.nickname))
        } else if (ev.echo === 'qqb-groups') {
          const list = Array.isArray(ev.data) ? ev.data : []
          state.groupCount = list.length
          state.groups = list.map((g) => ({ id: g.group_id, name: g.group_name }))
        } else if (ev.echo.startsWith('qqb-send-')) {
          // ★ 发送回执：NapCat 返回自己那条消息的 message_id（字段可能是 message_id）
          noteOwnMessage(ev.data?.message_id ?? ev.data?.messageId)
        }
        return
      }

      // ★ 戳一戳是 **notice** 事件，不是 message —— 必须在这行 return 之前接住，
      //   否则永远走不到（这就是"机器人看不见戳一戳"的根因）。
      //   判据看 sub_type：notice_type 是 'notify'（实测），写成 'poke' 会永远不中。
      if (ev?.post_type === 'notice') {
        if (ev?.notice_type === 'notify' && String(ev?.sub_type) === 'poke') handlePoke(ev)
        return
      }

      if (ev?.post_type !== 'message') return
      if (ev?.message_type === 'group') {
        if (cfg.reply?.groups === false) return
        // ★ 同一个基准：取不到自己的 QQ 时**不能**放行 —— 否则自己的消息会被
        //   当成群友的（`String(x) === String(undefined)` 这种比较是静默失效的）
        const meQQ = selfQQOf(ev, { botQQ: state.qq })
        if (meQQ && String(ev.user_id) === meQQ) return
        const mid = ev.message_id
        if (mid !== undefined) {
          const k = String(mid)
          if (seen.has(k)) return
          seen.add(k)
          if (seen.size > 500) seen.clear()
        }
        handleGroup(ev)
        return
      }
      if (ev?.message_type === 'private') {
        state.lastIncomingAt = Date.now()
        if (cfg.reply?.private !== true) { log('private message ignored (reply.private=false)'); return }
        const meQQ = selfQQOf(ev, { botQQ: state.qq })
        if (meQQ && String(ev.user_id) === meQQ) return
        const mid = ev.message_id
        if (mid !== undefined) {
          const k = 'p' + String(mid)
          if (seen.has(k)) return
          seen.add(k)
          if (seen.size > 500) seen.clear()
        }
        handlePrivate(ev)
      }
    } catch (e) { log('onMessage failed:', e?.message) }
  }

  function scheduleReconnect() {
    if (closed) return
    const wait = backoff
    backoff = Math.min(backoff * 2, 30000)
    retryTimer = setTimeout(connect, wait)
  }

  function connect() {
    if (closed) return
    try {
      ws = new WebSocket(url)
    } catch (e) {
      log('WebSocket ctor failed:', e?.message)
      state.lastError = 'WebSocket ctor failed: ' + (e?.message ?? '')
      scheduleReconnect()
      return
    }
    ws.addEventListener('open', () => {
      backoff = 1000
      state.connected = true
      state.lastError = ''
      log('connected to NapCat:', ascii(url))
      sendRaw({ action: 'get_login_info', echo: 'qqb-login' })
      sendRaw({ action: 'get_group_list', echo: 'qqb-groups' })
    })
    ws.addEventListener('message', (event) => {
      let ev
      try { ev = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) }
      catch { return }
      onMessage(ev)
    })
    ws.addEventListener('error', () => {
      state.lastError = 'websocket error'
      log('WebSocket error (see next close code)')
    })
    ws.addEventListener('close', (event) => {
      state.connected = false
      log('WebSocket closed code=', event?.code, 'reason=', event?.reason ?? '')
      scheduleReconnect()
    })
  }

  connect()

  pingTimer = setInterval(() => {
    if (closed) return
    if (!ws || ws.readyState !== OPEN) return
    sendRaw({ action: 'get_status', echo: 'qqb-ping-' + Date.now() })
  }, 45000)

  return function stop() {
    closed = true
    state.connected = false
    try { if (retryTimer) clearTimeout(retryTimer) } catch {}
    try { if (pingTimer) clearInterval(pingTimer) } catch {}
    try { if (ws && ws.readyState === OPEN) ws.close() } catch {}
    log('bridge stopped')
  }
}

// ------------------------------------------------------- 设置界面用的 HTTP 路由

function registerRoutes(ctx, cfg) {
  let web
  try { web = (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) ?? ctx.webServer } catch {}
  if (!web || typeof web.register !== 'function') {
    log('webServer unavailable: settings routes not registered')
    return false
  }
  let connection
  try { connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined } catch {}

  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(obj))
    } catch (e) { log('write response failed:', e?.message) }
  }

  const allowed = (req, res) => {
    try {
      if (connection && typeof connection.requestRejection === 'function') {
        const code = connection.requestRejection(req)
        if (code) {
          try { res.writeHead(code); res.end() } catch {}
          return false
        }
      }
    } catch (e) { log('trust fence error:', e?.message) }
    return true
  }

  // ── 各路由的处理函数（2026-10-15 从下面那个大 handler 里拆出来的）──────
  // 拆的理由：原 registerRoutes 有 324 行、7 条路由挤在一个 if 链里，改一条要在
  // 三百行里找。现在每条的**行为一字未动**，只是各归各位，handler 变成分发表。

  function handleConfig(req, res) {
    if (req.method === 'GET') { sendJson(res, 200, loadConfig()); return true }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 2e6) { try { req.destroy() } catch {} }
      })
      req.on('end', () => {
        try {
          const next = JSON.parse(body || '{}')
          writeJsonAtomic(CONFIG_PATH, deepMerge(DEFAULT_CONFIG, next))
          applyConfigInto(cfg, loadConfig())
          log('config updated via settings UI')
          sendJson(res, 200, { ok: true, config: loadConfig() })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e?.message ?? e) })
        }
      })
      return true
    }
    return false
  }

  function handleStatus(req, res) {
    if (req.method !== 'GET') return false
    let sessions = 0
    try {
      const mem = loadMemory()
      sessions = Object.keys(mem.sessions || {}).length
    } catch {}
    let peopleCount = 0
    let peopleOversize = 0
    try {
      const pd = peopleDir(cfg)
      const maxB = Math.max(1024, Number(cfg.people?.maxBytes) || PEOPLE_MAX_BYTES)
      for (const f of fs.readdirSync(pd)) {
        if (!f.endsWith('.md')) continue
        peopleCount++
        try { if (fs.statSync(path.join(pd, f)).size > maxB) peopleOversize++ } catch {}
      }
    } catch {}
    sendJson(res, 200, {
      ...state,
      sessions,
      uptimeMs: Date.now() - state.startedAt,
      // 被禁言冷却中的群（retcode 1200 触发）—— 给设置页显示，剩多少秒一目了然
      muted: (() => {
        const out = []
        for (const [g, until] of mutedGroups) {
          const left = Number(until) - Date.now()
          if (left > 0) out.push({ group: g, leftSec: Math.ceil(left / 1000) })
        }
        return out
      })(),
      people: { count: peopleCount, oversize: peopleOversize, dir: peopleDir(cfg) },
      config: {
        enabled: cfg.enabled,
        url: cfg.napcat?.url,
        provider: cfg.model?.provider,
        model: cfg.model?.model,
        requireAt: cfg.reply?.requireAt,
        private: cfg.reply?.private,
        keepRounds: cfg.memory?.keepRounds,
        reasoningEffort: cfg.model?.reasoningEffort,
        maxTokens: cfg.model?.maxTokens,
        temperature: cfg.model?.temperature,
        historyMode: cfg.model?.historyMode,
        vision: cfg.vision?.enabled === false ? 'off' : ('on/max' + String(cfg.vision?.maxImages ?? 2)),
      },
      lastAskFailure,
      lastUsage,
    })
    return true
  }

  function handlePeople(req, res) {
    if (req.method !== 'GET') return false
    const list = []
    try {
      const pd = peopleDir(cfg)
      for (const f of fs.readdirSync(pd)) {
        if (!f.endsWith('.md')) continue
        const qq = f.replace(/\.md$/, '')
        const rec = readPersonFile(cfg, qq)
        let bytes = 0
        try { bytes = fs.statSync(path.join(pd, f)).size } catch {}
        list.push({ qq: qq, name: rec.name, prevNames: rec.prevNames, note: rec.note, profile: rec.profile || {}, msgCount: rec.msgCount, bytes: bytes, model: rec.model || '', modelProvider: rec.modelProvider || '' })
      }
    } catch (e) { log('list people failed:', e?.message) }
    list.sort((a, b) => (Number(b.msgCount) || 0) - (Number(a.msgCount) || 0))
    sendJson(res, 200, { ok: true, people: list })
    return true
  }

  /** 待审记忆：模型想记的东西（不注入提示词）。GET 列表 / POST 清空 */
  function handlePending(req, res) {
    if (req.method === 'GET') {
      const items = loadPending()
      let bytes = 0
      try { bytes = fs.statSync(PENDING_NOTES_PATH).size } catch {}
      sendJson(res, 200, { ok: true, path: PENDING_NOTES_PATH, count: items.length, bytes: bytes, items: items })
      return true
    }
    if (req.method === 'POST') {
      readJsonBody(req, (err, payload) => {
        if (err) { sendJson(res, 400, { ok: false, error: err }); return }
        if (payload && payload.clear === true) {
          try { fs.writeFileSync(PENDING_NOTES_PATH, '', 'utf8') } catch {}
          log('pending cleared by settings UI')
          sendJson(res, 200, { ok: true, cleared: true, count: 0, items: [] })
          return
        }
        sendJson(res, 400, { ok: false, error: '只支持 {clear:true}' })
      })
      return true
    }
    return false
  }

  /** 人物画像（**唯一**能改档案的入口 —— 机器一律写不进来） */
  function handleNote(req, res) {
    if (req.method !== 'POST') return false
    readJsonBody(req, (err, payload) => {
      try {
        if (err) throw new Error(err)
        const qq = String(payload.qq || '').trim()
        if (!/^\d{3,15}$/.test(qq)) { sendJson(res, 400, { ok: false, error: 'QQ 号不合法' }); return }
        const rec = readPersonFile(cfg, qq)
        if (!rec._raw) { sendJson(res, 404, { ok: false, error: '这个人的档案还不存在（等他在群里说过话就会自动建）' }); return }
        // 画像：接受结构化的 profile（身份/性格/沟通方式/关系/注意），只写传进来的那几项。
        if (payload.profile && typeof payload.profile === 'object') {
          const next = Object.assign({}, rec.profile)
          for (const k of PROFILE_LABELS) {
            if (payload.profile[k] === undefined) continue
            const v = String(payload.profile[k] == null ? '' : payload.profile[k]).trim()
            if (v) next[k] = v; else delete next[k]
          }
          rec.profile = next
        } else if (payload.note !== undefined) {
          // ★ V1 修复：旧 note 字段**只动「注意」这一项**，不再整体替换 profile。
          //   改版前这里是 `rec.profile = {注意: note}` —— 设置页一保存，
          //   身份/性格/沟通方式/关系**全被抹掉**（而且"保存成功"的提示照样弹）。
          const next = Object.assign({}, rec.profile)
          const v = String(payload.note == null ? '' : payload.note).trim()
          if (v) next['注意'] = v; else delete next['注意']
          rec.profile = next
        }
        rec.note = String(rec.profile?.['注意'] || '')
        // 单人级模型覆盖（payload 里带了才改；传空字符串 = 清除覆盖，回到全局）
        if (payload.model !== undefined) rec.model = String(payload.model == null ? '' : payload.model).trim()
        if (payload.modelProvider !== undefined) rec.modelProvider = String(payload.modelProvider == null ? '' : payload.modelProvider).trim()
        const bytes = writePersonFile(cfg, rec)
        log('person profile updated: qq=' + qq + ' bytes=' + bytes +
          ' keys=' + ascii(Object.keys(rec.profile || {}).join(',')) + ' model=' + ascii(rec.model || '(default)'))
        sendJson(res, 200, { ok: true, qq: qq, note: rec.note, profile: rec.profile || {}, model: rec.model || '', modelProvider: rec.modelProvider || '', bytes: bytes })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e?.message ?? e) })
      }
    })
    return true
  }

  const handler = (req, res) => {
    if (!allowed(req, res)) return
    let pathname = '/'
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname } catch {}

    for (const [p, fn] of ROUTES) {
      if (pathname === ROUTE_PREFIX + p && fn(req, res)) return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
  /**
   * 只读诊断路由 `GET /qq-bridge/_probe`（**留着，别删**）。
   * 用真模型对多种消息形状做 A/B 对照，验证"多轮 messages 到底能不能用"（坑 A5）。
   * 只读：不发消息、不写记忆、不改配置；每次固定若干个请求。目的与结论见 91_心得与坑。
   */
  function handleProbe(req, res) {
    if (req.method !== 'GET') return false
        ;(async () => {
          const out = {}
          const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
          let sel = { provider: 'deepseek-account', model: 'deepseek-flash' }
          try {
            const cat = sc && typeof sc.modelCatalog === 'function' ? await sc.modelCatalog() : null
            if (cat?.default?.provider && cat?.default?.model) sel = cat.default
          } catch (e) { out.catalogError = String(e?.message ?? e) }
          const sys = '你是测试助手，只回答一个词。'
          const hist = ['第一条旧消息', '我以前的回复']
          const nowText = '现在回一个词：好'

          // A：我们**现在**的写法 —— 手工拼，没有 source（怀疑这就是崩的原因）
          // B：手工拼 + source{kind:'model', provider, model}
          // C：B 再多带一个 replayState 信封（伪造版，只为看是否影响）
          // D：对照组 —— 不带历史
          const variants = [
            { name: 'A_manual_no_source', mk: () => ([
              { role: 'user', content: [{ type: 'text', text: hist[0] }] },
              { role: 'assistant', content: [{ type: 'text', text: hist[1] }] },
              { role: 'user', content: [{ type: 'text', text: nowText }] },
            ]) },
            { name: 'B_manual_with_source', mk: () => ([
              { role: 'user', content: [{ type: 'text', text: hist[0] }] },
              { role: 'assistant', content: [{ type: 'text', text: hist[1] }], source: { kind: 'model', provider: sel.provider, model: sel.model } },
              { role: 'user', content: [{ type: 'text', text: nowText }] },
            ]) },
            { name: 'C_with_fake_replayState', mk: () => ([
              { role: 'user', content: [{ type: 'text', text: hist[0] }] },
              { role: 'assistant', content: [{ type: 'text', text: hist[1] }], source: { kind: 'model', provider: sel.provider, model: sel.model, replayState: { response: { kind: 'deepseek-messages', version: 1, model: sel.model }, blocks: [] } } },
              { role: 'user', content: [{ type: 'text', text: nowText }] },
            ]) },
            { name: 'D_no_history_control', mk: () => ([
              { role: 'user', content: [{ type: 'text', text: nowText }] },
            ]) },
            // E/F：**新代码真正会发出去的形状**（E = 真实多轮；F = 多轮 + 图片块）
            //   这两个是"重启后到底能不能用"的预检，不是探讨性实验。
            { name: 'E_real_multiturn_shape', mk: () => ([
              { role: 'user', content: [{ type: 'text', text: '[14:20] [小明(10001)]: 第一条旧消息' }] },
              { role: 'assistant', content: [{ type: 'text', text: '[14:21] 我以前的回复' }], source: { kind: 'model', provider: sel.provider, model: sel.model } },
              { role: 'user', content: [{ type: 'text', text: '[小明(10001)]: 现在回一个词：好' }] },
            ]) },
            // G：**阶段5 的真实形状** —— 稳定 system + 历史 + 尾部上下文块 + 当前消息。
            //    专门验证"每轮都变的上下文挪到消息末尾"之后仍能正常出话。
            { name: 'G_stable_system_trailing_context', mk: () => ([
              { role: 'user', content: [{ type: 'text', text: '[14:20] [小明(10001)]: 第一条旧消息' }] },
              { role: 'assistant', content: [{ type: 'text', text: '[14:21] 我以前的回复' }], source: { kind: 'model', provider: sel.provider, model: sel.model } },
              { role: 'user', content: [{ type: 'text', text: '【本群最近说过话的其他人】\n小明(10001) 上次说话 14:20' }] },
              { role: 'user', content: [{ type: 'text', text: '[小明(10001)]: 现在回一个词：好' }] },
            ]) },
          ]

          // F 需要真图片块。★ 用 **data URL**（1x1 PNG），不依赖任何外部 URL ——
          //   原先硬编码了一个 QQ 图片地址，它的 rkey 会过期，导致探针整体 500。
          //   自包含之后，这条永远可复现，且真实验证 attachments.saveImage + image 内容块。
          try {
            const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
            const blocks = await buildImageBlocks(ctx, cfg, [{ url: PNG_1PX, file: 'probe.png' }], '')
            out.F_imageBlocksBuilt = blocks.length
            if (blocks.length > 0) {
              variants.push({ name: 'F_multiturn_with_image', mk: () => ([
                { role: 'user', content: [{ type: 'text', text: '[14:20] [小明(10001)]: 第一条旧消息' }] },
                { role: 'assistant', content: [{ type: 'text', text: '[14:21] 我以前的回复' }], source: { kind: 'model', provider: sel.provider, model: sel.model } },
                { role: 'user', content: [{ type: 'text', text: '[小明(10001)]: 这是什么' }].concat(blocks) },
              ]) })
            }
          } catch (e) { out.F_imageBlocksBuilt = 'error: ' + String(e?.message ?? e) }

          for (const v of variants) {
            const rec = { text: '', finishKind: '', failure: '', chunkTypes: [], error: '' }
            try {
              const opts = { provider: sel.provider, model: sel.model, system: sys, messages: v.mk() }
              const types = []
              for await (const chunk of ctx.llm.stream(opts)) {
                if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') rec.text += chunk.text
                else if (chunk?.type === 'finish') {
                  const r = chunk.reason || {}
                  rec.finishKind = String(r.kind || '')
                  if (r.failure) rec.failure = '[' + String(r.failure.code || '') + '] ' + String(r.failure.message || '')
                } else if (chunk?.type === 'usage') rec.usage = chunk.usage
                if (chunk?.type && !types.includes(chunk.type)) types.push(chunk.type)
              }
              rec.chunkTypes = types
            } catch (e) {
              rec.error = String(e?.code ? '[' + e.code + '] ' : '') + String(e?.message ?? e)
            }
            out[v.name] = rec
            log('PROBE ' + v.name + ' finish=' + (rec.finishKind || rec.error || '(none)') +
              ' textLen=' + String(rec.text.length) + (rec.failure ? ' failure=' + rec.failure : ''))
          }
          // 一句话结论，方便一眼看。
          // ⚠️ 只统计**变体记录**：out 里还混着 F_imageBlocksBuilt 这类辅助字段（不是记录对象），
          //    直接对它们取 .text 会抛 TypeError 把整个探针打成 500（踩过一次）。
          const verdict = {}
          for (const k of Object.keys(out)) {
            const r = out[k]
            if (!r || typeof r !== 'object' || typeof r.text !== 'string') continue
            verdict[k] = r.error ? 'EXCEPTION' : (r.text.trim() ? 'OK' : 'EMPTY_TEXT')
          }
          sendJson(res, 200, { model: sel, verdict, detail: out })
        })().catch((e) => {
          // 别只回一句 message —— 那样会丢掉唯一能定位的证据（坑 A4 的教训）
          log('PROBE failed: ' + String(e?.message ?? e) + ' | stack=' + String((e && e.stack) || '(no stack)').slice(0, 600))
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e), stack: String((e && e.stack) || '').split('\n').slice(0, 6) })
        })
        return
    return true
  }

  /**
   * 待审提纯：从待审区挑 **1 条待采纳**。
   *   GET  → 取候选（按待审区指纹缓存，内容没变不重复调模型）
   *   POST → {skip:true} 跳过当前候选（写进"已跳过"，不再出现）
   */
  function handleCandidate(req, res) {
    if (req.method === 'GET') {
      ;(async () => {
        try {
          const cand = await getAdoptionCandidate(ctx, cfg)
          sendJson(res, 200, Object.assign({ ok: true }, cand))
        } catch (e) {
          log('candidate route failed:', e?.message)
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
        }
      })()
      return true
    }
    if (req.method === 'POST') {
      readJsonBody(req, (err, payload) => {
        try {
          if (err) throw new Error(err)
          if (payload && payload.adopt === true) {
            // ★ 采纳：把提案写进画像对应字段。**触发者是人的一次点击**，
            //   不是模型自己 —— 这条是"机器不写档案"纪律的唯一例外，且留了日志。
            const cand = {
              qq: String(payload.qq || '').trim(),
              label: String(payload.label || '').trim(),
              text: String(payload.text || '').trim(),
            }
            if (!cand.qq || !cand.text) { sendJson(res, 400, { ok: false, error: '缺少 qq 或 text' }); return }
            const seen = loadSeen()
            if (seen.cached && seen.cached.item && seen.cached.item.qq === cand.qq) cand.from = seen.cached.item.from || []
            const r = adoptCandidate(cfg, cand)
            if (!r.ok) { sendJson(res, 400, r); return }
            seen.cached = null
            saveSeen(seen)
            sendJson(res, 200, Object.assign({ ok: true }, r))
            return
          }
          if (payload && payload.skip === true) {
            const seen = loadSeen()
            const cur = seen.cached && seen.cached.item
            let keys = []
            if (cur && Array.isArray(cur.from) && cur.from.length > 0) keys = cur.from
            else { const all = loadPending(); if (all.length > 0) keys = [pendingKey(all[0])] }
            seen.skipped = seen.skipped.concat(keys)
            seen.cached = null
            saveSeen(seen)
            removePending(keys)
            log('candidate skipped: ' + String(keys.length) + ' 条移入已跳过')
            sendJson(res, 200, { ok: true, skipped: keys.length })
            return
          }
          sendJson(res, 400, { ok: false, error: '只支持 {skip:true} 或 {adopt:true,qq,label,text}' })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e?.message ?? e) })
        }
      })
      return true
    }
    return false
  }

  // 路由表 —— 加新路由只加一行，handler 不用动
  /**
   * 关系演化：设置页「关系演化」卡片用。
   *   GET  → 现有关系列表（含每人计数，用来显示"再攒几轮就触发"）
   *   POST {qq} → 用这个人最近那段对话**立刻演化一次**（会调一次模型）
   *
   * 为什么要手动入口：阈值是"每人 30 轮"，冷门的人可能一个月都到不了，
   * 那张卡片就永远是空的。手动触发让"关系"这层能当场验证、也能按需补一条。
   */
  /**
   * NapCat 启停用到的两个路径，来自配置（`napcat.launcher` / `napcat.qrPath`）。
   * 留空 = 这个功能不可用（按钮隐藏/禁用），不会去猜别的机器上的路径。
   */
  function napcatPaths() {
    const n = cfg.napcat || {}
    return {
      launcher: String(n.launcher || '').trim(),
      qr: String(n.qrPath || '').trim(),
    }
  }

  /**
   * NapCat 进程/端口状态（只读，不启动任何东西）。
   * 「跑没跑起来」不靠进程枚举（Node 里没有便宜的接口），靠 **3001 能不能连上** ——
   * OneBot 正向 WS 端口在监听，就说明 NapCat 起来了并且登录了。
   * 再加上二维码图片是否新鲜，用来区分"没跑"和"跑着但等在扫码"。
   */
  function napcatProbe() {
    return new Promise((resolve) => {
      const paths = napcatPaths()
      const out = {
        portListening: false,
        qrWaiting: false,
        qrPath: paths.qr,
        qrConfigured: Boolean(paths.qr),
        qrExists: false,
        launcher: paths.launcher,
        launcherConfigured: Boolean(paths.launcher),
        launcherExists: false,
        autostart: false,
      }
      try {
        out.launcherExists = Boolean(paths.launcher) && fs.existsSync(paths.launcher)
        out.qrExists = Boolean(paths.qr) && fs.existsSync(paths.qr)
        if (out.qrExists) {
          const ageMin = (Date.now() - fs.statSync(paths.qr).mtimeMs) / 60000
          out.qrWaiting = ageMin >= -1 && ageMin < 10
        }
        const lnk = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'QQ机器人-NapCat.lnk')
        out.autostart = fs.existsSync(lnk)
      } catch (e) { out.error = String(e?.message ?? e) }

      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        out.portListening = ok
        try { sock.destroy() } catch {}
        resolve(out)
      }
      const sock = net.connect({ port: 3001, host: '127.0.0.1' })
      sock.setTimeout(900)
      sock.once('connect', () => finish(true))
      sock.once('timeout', () => finish(false))
      sock.once('error', () => finish(false))
    })
  }

  /** NapCat 启停/开二维码：GET 查状态，POST {action:'start'|'stop'|'openqr'} */
  function handleNapcat(req, res) {
    if (req.method === 'GET') {
      napcatProbe()
        .then((s) => sendJson(res, 200, Object.assign({ ok: true }, s)))
        .catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }))
      return true
    }
    if (req.method === 'POST') {
      readJsonBody(req, (err, payload) => {
        if (err) { sendJson(res, 400, { ok: false, error: err }); return }
        const action = String((payload && payload.action) || '')
        const paths = napcatPaths()
        try {
          if (action === 'start') {
            if (!paths.launcher) {
              sendJson(res, 400, { ok: false, error: '没配置 napcat.launcher（启动脚本路径），这个按钮用不了' })
              return
            }
            if (!fs.existsSync(paths.launcher)) {
              sendJson(res, 400, { ok: false, error: '找不到启动脚本：' + paths.launcher })
              return
            }
            // ★ 用 explorer.exe 拉起，而不是直接 spawn：
            //   DSH 启动的子进程挂在桌面端的进程树下，桌面端一退就被清掉（踩过的坑 C1）。
            //   交给 explorer（已在运行的 shell）去开，进程树就不在 DSH 下面了。
            spawn('explorer.exe', [paths.launcher], { detached: true, stdio: 'ignore' }).unref()
            log('napcat start requested from settings UI')
            sendJson(res, 200, { ok: true, action: 'start' })
            return
          }
          if (action === 'stop') {
            // 只杀 NapCat 的引导进程连同它的子树（NapCat 那个 QQ.exe 是它的子进程），
            // **不能**按镜像名杀 QQ.exe —— 那样会把用户自己的 QQ 一起杀掉。
            execFile('taskkill', ['/IM', 'NapCatWinBootMain.exe', '/T', '/F'], { windowsHide: true }, (e, so, se) => {
              log('napcat stop requested: ' + ascii(String(so || '') + ' ' + String(se || '')))
              sendJson(res, 200, { ok: true, action: 'stop', output: String(so || '').trim().slice(0, 200) })
            })
            return
          }
          if (action === 'openqr') {
            if (!paths.qr) {
              sendJson(res, 400, { ok: false, error: '没配置 napcat.qrPath（二维码图片路径），这个按钮用不了' })
              return
            }
            if (!fs.existsSync(paths.qr)) {
              sendJson(res, 400, { ok: false, error: '现在没有二维码（可能已经登录，或还没开始等扫码）' })
              return
            }
            spawn('explorer.exe', [paths.qr], { detached: true, stdio: 'ignore' }).unref()
            sendJson(res, 200, { ok: true, action: 'openqr' })
            return
          }
          sendJson(res, 400, { ok: false, error: "只支持 {action:'start'|'stop'|'openqr'}" })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
        }
      })
      return true
    }
    return false
  }

  function handleRelations(req, res) {
    if (req.method !== 'GET') return false
    const list = []
    try {
      const st = storeOf()
      const rel = (st && st.relations) || {}
      const cnt = (st && st.relationCounters) || {}
      for (const qq of Object.keys(rel)) {
        const r = rel[qq] || {}
        list.push({
          qq: qq,
          name: personNameOf(cfg, qq),
          text: String(r.text || ''),
          at: Number(r.at) || 0,
          n: Number(cnt[qq]) || 0,
        })
      }
      list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    } catch (e) { log('relations list failed:', e?.message) }
    sendJson(res, 200, {
      ok: true,
      every: Math.max(5, Number(cfg.memory?.relationEvolveEvery) || 30),
      relations: list,
    })
    return true
  }

  function handleEvolve(req, res) {
    if (req.method !== 'POST') return false
    readJsonBody(req, (err, payload) => {
      if (err) { sendJson(res, 400, { ok: false, error: err }); return }
      const qq = String((payload && payload.qq) || '').trim()
      if (!/^\d{3,15}$/.test(qq)) { sendJson(res, 400, { ok: false, error: 'QQ 号不合法' }); return }
      if (typeof relationEvolver !== 'function') {
        sendJson(res, 503, { ok: false, error: '桥还没启动（enabled=false 或连接未就绪）' })
        return
      }
      ;(async () => {
        try {
          // 找"这个人说话最多"的那个群会话当素材
          const mem = loadMemory()
          const sessions = (mem && mem.sessions) || {}
          let best = null
          let bestN = 0
          let bestKey = ''
          for (const k of Object.keys(sessions)) {
            const s = sessions[k] || {}
            const rounds = Array.isArray(s.rounds) ? s.rounds : []
            let n = 0
            for (const rr of rounds) {
              if (String((rr && rr.content) || '').indexOf('(' + qq + ')') >= 0) n++
            }
            if (n > bestN) { bestN = n; best = s; bestKey = k }
          }
          if (!best) { sendJson(res, 400, { ok: false, error: '会话里没有这个人的发言，没素材可演化' }); return }
          const st = storeOf()
          const before = String((st.relations && st.relations[qq] && st.relations[qq].text) || '')
          await relationEvolver(qq, best)
          // 手动演化也算"刚演化过"，计数归零，别让它攒着又立刻触发一次
          if (!st.relationCounters || typeof st.relationCounters !== 'object') st.relationCounters = {}
          st.relationCounters[qq] = 0
          saveStoreNow()
          const after = String((st.relations && st.relations[qq] && st.relations[qq].text) || '')
          log('relation evolved manually qq=' + qq + ' group=' + bestKey +
            ' rounds=' + String((best.rounds || []).length) + ' changed=' + String(before !== after))
          sendJson(res, 200, {
            ok: true,
            qq: qq,
            group: bestKey,
            rounds: (best.rounds || []).length,
            before: before,
            after: after,
          })
        } catch (e) {
          log('manual evolve failed: ' + String(e?.message ?? e))
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
        }
      })()
    })
    return true
  }

  const ROUTES = [
    ['/config', handleConfig],
    ['/_probe', handleProbe],
    ['/status', handleStatus],
    ['/people', handlePeople],
    ['/pending', handlePending],
    ['/candidate', handleCandidate],
    ['/note', handleNote],
    ['/relations', handleRelations],
    ['/evolve', handleEvolve],
    ['/napcat', handleNapcat],
  ]

  try {
    web.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    log('settings routes registered:', ROUTE_PREFIX + '/config, ' + ROUTE_PREFIX + '/status, ' + ROUTE_PREFIX + '/people, ' + ROUTE_PREFIX + '/note')
    return true
  } catch (e) {
    log('register routes failed:', e?.message)
    return false
  }
}

/** 监听配置文件：改完立即生效，不用重载插件 */
function watchConfig(cfg) {
  try {
    const watcher = fs.watch(CONFIG_PATH, { persistent: false }, () => {
      setTimeout(() => {
        try {
          applyConfigInto(cfg, loadConfig())
          log('config.json changed -> hot reloaded')
        } catch (e) { log('hot reload failed:', e?.message) }
      }, 150)
    })
    return () => { try { watcher.close() } catch {} }
  } catch (e) {
    log('watch config failed:', e?.message)
    return null
  }
}

// -------------------------------------------------------------------- 入口

export function apply(ctx, config = {}) {
  let stop = null
  let unwatch = null
  let unwatchMem = null
  try {
    const cfg = loadConfig()
    const mem = loadMemory()

    if (cfg.enabled) {
      log('starting: url=', ascii(cfg.napcat?.url || ''), ' provider=', cfg.model?.provider ?? '')
      stop = startBridge(ctx, cfg, mem)
      unwatch = watchConfig(cfg)
      // ★ memory.json 也热加载：外面改完即生效，不用重启（事故复盘见 watchMemory 注释）
      if (cfg.memory?.hotReload !== false) unwatchMem = watchMemory(mem)
    } else {
      log('config.enabled=false: bridge not started')
    }

    // 设置界面的路由（需要 webServer；拿不到就只没有界面，不影响机器人）
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (scoped) => {
          try { registerRoutes(scoped ?? ctx, cfg) } catch (e) { log('register routes (scoped) failed:', e?.message) }
        })
      } else {
        registerRoutes(ctx, cfg)
      }
    } catch (e) { log('inject webServer failed:', e?.message) }
  } catch (e) {
    // 绝不能把异常抛给 DSH：插件激活失败会拖垮整棵启动树
    log('apply failed:', e?.stack || e?.message)
  }
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try { stop?.() } catch (e) { log('stop failed:', e?.message) }
        try { unwatch?.() } catch (e) { log('unwatch failed:', e?.message) }
        try { unwatchMem?.() } catch (e) { log('unwatch memory failed:', e?.message) }
      })
    }
  } catch (e) { log('register effect failed:', e?.message) }
}
