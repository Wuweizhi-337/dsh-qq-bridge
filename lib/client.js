/**
 * dsh-qq-bridge —— 浏览器半侧（桌面端「设置 → QQ 桥」）
 *
 * 手写 ModuleLoader bundle，无构建步骤。规则（照已装插件的真实写法）：
 *   - id 必须等于 loader entry 名（= 包名），否则报 "loaded without registering"
 *   - 只导出 apply / inject，不要 export default
 *   - 界面用 react.createElement（文件是原样加载，没有 JSX 编译）
 *   - 样式用应用的主题变量（--dsw-alias-*），深浅色自动适配
 *   - 数据走宿主半侧的路由：GET/POST /qq-bridge/config、GET /qq-bridge/status
 *     （宿主侧已做信任栅栏 connection.requestRejection）
 */
window.__ModuleLoader__.load({
  id: '@wuweizhi/dsh-qq-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var API = '/qq-bridge/config'
    var STATUS = '/qq-bridge/status'

    /* ── 样式 ──────────────────────────────────────────────────────────── */
    var CSS = [
      '.qqb-root{max-width:680px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.qqb-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.qqb-title{font-size:12px;font-weight:700;letter-spacing:.02em;opacity:.9}',
      '.qqb-field{display:flex;flex-direction:column;gap:4px}',
      '.qqb-label{font-size:12px;font-weight:600}',
      '.qqb-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.qqb-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;outline:none}',
      '.qqb-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.qqb-area{min-height:150px;resize:vertical;line-height:1.6}',
      '.qqb-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}',
      '.qqb-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}',
      '.qqb-check{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}',
      '.qqb-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}',
      '.qqb-btnPrimary{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff}',
      '.qqb-btn:disabled{opacity:.5;cursor:default}',
      '.qqb-small{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.qqb-ok{font-size:12px;color:var(--dsw-alias-state-business-primary)}',
      '.qqb-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#f85149)}',
      '.qqb-dot{width:8px;height:8px;border-radius:50%;display:inline-block}',
      '.qqb-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}',
      '.qqb-k{color:var(--dsw-alias-label-tertiary)}',
      '.qqb-num{width:110px}'
    ].join('')
    var tagId = 'dsh-qq-bridge/main.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-qq-bridge'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ── 小工具 ────────────────────────────────────────────────────────── */
    function setIn(obj, pathStr, value) {
      var parts = String(pathStr).split('.')
      var next = Object.assign({}, obj)
      var cur = next
      for (var i = 0; i < parts.length - 1; i++) {
        var k = parts[i]
        cur[k] = Object.assign({}, cur[k] || {})
        cur = cur[k]
      }
      cur[parts[parts.length - 1]] = value
      return next
    }

    function getIn(obj, pathStr, fallback) {
      var parts = String(pathStr).split('.')
      var cur = obj
      for (var i = 0; i < parts.length; i++) {
        if (cur === null || cur === undefined) return fallback
        cur = cur[parts[i]]
      }
      return cur === undefined || cur === null ? fallback : cur
    }

    function listToText(arr) {
      return Array.isArray(arr) ? arr.join('\n') : ''
    }

    function textToList(text, numeric) {
      return String(text || '')
        .split(/[\s,，、]+/)
        .map(function (s) { return s.trim() })
        .filter(Boolean)
        .map(function (s) { return numeric && /^\d+$/.test(s) ? Number(s) : s })
    }

    /** 一行一个（别名表 / 声音锚）：**只按换行切**。
     *  ★ 2026-10-17 实测踩到：早先按逗号/顿号也切，结果「差不多就行，我又没跟你计较。」
     *    这种带逗号的整句被切成两截，声音锚直接坏掉。所以这里只认换行。 */
    function linesToList(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map(function (s) { return s.trim() })
        .filter(Boolean)
    }

    function fmtTime(ms) {
      if (!ms) return '—'
      try { return new Date(ms).toLocaleString() } catch (e) { return String(ms) }
    }

    function Field(props) {
      return h('div', { className: 'qqb-field' },
        h('div', { className: 'qqb-label' }, props.label),
        props.children,
        props.hint ? h('div', { className: 'qqb-hint' }, props.hint) : null
      )
    }

    function Check(props) {
      return h('label', { className: 'qqb-check' },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          onChange: function (e) { props.onChange(e.target.checked) }
        }),
        props.label
      )
    }

    function Text(props) {
      return h('input', {
        className: 'qqb-input' + (props.mono ? ' qqb-mono' : '') + (props.num ? ' qqb-num' : ''),
        type: 'text',
        spellCheck: false,
        value: props.value === null || props.value === undefined ? '' : String(props.value),
        placeholder: props.placeholder || '',
        onChange: function (e) { props.onChange(e.target.value) }
      })
    }

    /* ── 面板 ──────────────────────────────────────────────────────────── */
    function Panel() {
      var [draft, setDraft] = react.useState(null)
      var [status, setStatus] = react.useState(null)
      var [blGroups, setBlGroups] = react.useState('')
      var [blUsers, setBlUsers] = react.useState('')
      var [error, setError] = react.useState(null)
      var [notice, setNotice] = react.useState(null)
      var [busy, setBusy] = react.useState(false)
      // 备注编辑器
      var [pList, setPList] = react.useState(null)   // null = 还没读到
      var [pSel, setPSel] = react.useState('')
      var [pNote, setPNote] = react.useState('')
      var [pModel, setPModel] = react.useState('')
      var [pBusy, setPBusy] = react.useState(false)
      var [pMsg, setPMsg] = react.useState(null)
      var [pErr, setPErr] = react.useState(false)
      // 待审记忆（模型想记的东西 —— 不注入提示词，采纳与否由人定）
      var [pend, setPend] = react.useState(null)
      var [pendMsg, setPendMsg] = react.useState(null)
      // 提纯候选（从待审区自动挑 1 条最值得记的 —— 只做提案，落盘要人点采纳）
      var [cand, setCand] = react.useState(null)
      var [candBusy, setCandBusy] = react.useState(false)
      var [candMsg, setCandMsg] = react.useState(null)
      var [candErr, setCandErr] = react.useState(false)
      // 别名 / 声音锚：文本框里一行一个（草稿里是数组，保存时再切）
      var [aliasText, setAliasText] = react.useState('')
      var [anchorsText, setAnchorsText] = react.useState('')
      // 关系演化：当前关系列表 + 手动演化
      var [rel, setRel] = react.useState(null)
      var [relBusy, setRelBusy] = react.useState(false)
      var [relMsg, setRelMsg] = react.useState(null)
      var [relErr, setRelErr] = react.useState(false)
      var [evq, setEvq] = react.useState('')
      // NapCat 启停/状态（从桌面搬进页面）
      var [nap, setNap] = react.useState(null)
      var [napBusy, setNapBusy] = react.useState(false)
      var [napMsg, setNapMsg] = react.useState(null)
      var [napErr, setNapErr] = react.useState(false)

      function loadCandidate() {
        setCandBusy(true); setCandMsg(null); setCandErr(false)
        return fetch('/qq-bridge/candidate', { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) { setCand(j || { ok: false }) })
          .catch(function (e) {
            setCandErr(true)
            setCandMsg('取候选失败：' + String(e && e.message ? e.message : e))
          })
          .then(function () { setCandBusy(false) })
      }

      // action: 'adopt' | 'skip'
      function actCandidate(action) {
        if (!cand || cand.provided !== true) return
        setCandBusy(true); setCandMsg(null); setCandErr(false)
        var body = action === 'adopt'
          ? { adopt: true, qq: cand.qq, label: cand.label, text: cand.text }
          : { skip: true }
        fetch('/qq-bridge/candidate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'failed')
            setCandMsg(action === 'adopt' ? ('已写进 ' + (cand.name || cand.qq) + ' 的「' + cand.label + '」') : '已跳过，不会再提这条。')
            return Promise.all([loadCandidate(), loadPending(), loadPeople()])
          })
          .catch(function (e) {
            setCandErr(true)
            setCandMsg((action === 'adopt' ? '采纳失败：' : '跳过失败：') + String(e && e.message ? e.message : e))
          })
          .then(function () { setCandBusy(false) })
      }

      function loadPending() {
        return fetch('/qq-bridge/pending', { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) { setPend(j || { count: 0, items: [] }) })
          .catch(function () { setPend({ count: 0, items: [], error: true }) })
      }

      function clearPending() {
        // ★ 2026-10-17：这个按钮**不可恢复**（服务端把 pending-notes.md 直接写空），先问一句。
        var ok = true
        try {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            ok = window.confirm('清空待审记忆？这会直接清空 pending-notes.md，不能撤销。')
          }
        } catch (e) { ok = true }
        if (!ok) return
        setPendMsg(null)
        fetch('/qq-bridge/pending', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear: true })
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'clear failed')
            setPendMsg('已清空。')
            return loadPending()
          })
          .catch(function (e) { setPendMsg('清空失败：' + String(e && e.message ? e.message : e)) })
      }

      function loadPeople() {
        setPMsg(null)
        return fetch('/qq-bridge/people', { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) {
            var list = (j && j.people) || []
            setPList(list)
            var q = pSel
            var exists = list.some(function (p) { return p.qq === q })
            if (!q || !exists) { q = list.length ? list[0].qq : ''; setPSel(q) }
            var hit = list.filter(function (p) { return p.qq === q })[0]
            setPNote(hit ? (hit.note || '') : '')
            setPModel(hit ? (hit.model || '') : '')
          })
          .catch(function (e) {
            setPList([]); setPErr(true)
            setPMsg('读取名单失败：' + String(e && e.message ? e.message : e))
          })
      }

      function pickPerson(q) {
        setPSel(q); setPMsg(null); setPErr(false)
        var hit = (pList || []).filter(function (p) { return p.qq === q })[0]
        setPNote(hit ? (hit.note || '') : '')
        setPModel(hit ? (hit.model || '') : '')
      }

      function saveNote() {
        if (!pSel) return
        setPBusy(true); setPMsg(null); setPErr(false)
        fetch('/qq-bridge/note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qq: pSel, note: pNote, model: pModel })
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'save failed')
            setPMsg('已保存，立即生效。')
            return loadPeople()
          })
          .catch(function (e) {
            setPErr(true)
            setPMsg('保存失败：' + String(e && e.message ? e.message : e))
          })
          .then(function () { setPBusy(false) })
      }

      function loadRelations() {
        return fetch('/qq-bridge/relations', { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) { setRel(j || { relations: [] }) })
          .catch(function () { setRel({ relations: [] }) })
      }

      /** 手动演化一次：用他最近那段对话立刻写一条关系（会调一次模型） */
      function evolveNow() {
        var qq = evq || (pList && pList[0] ? pList[0].qq : '')
        if (!qq) return
        setRelBusy(true); setRelMsg(null); setRelErr(false)
        fetch('/qq-bridge/evolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qq: qq })
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'evolve failed')
            if (!j.after) { setRelMsg('模型没写出东西（对话太短或都被裁掉了），下次再试') }
            else if (j.before === j.after) { setRelMsg('没看出变化，沿用旧文本：' + j.after) }
            else { setRelMsg('已更新：' + j.after) }
            return loadRelations()
          })
          .catch(function (e) {
            setRelErr(true)
            setRelMsg('演化失败：' + String(e && e.message ? e.message : e))
          })
          .then(function () { setRelBusy(false) })
      }

      function loadStatus() {
        return fetch(STATUS, { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) { setStatus(j) })
          .catch(function () {})
      }

      function loadNapcat() {
        return fetch('/qq-bridge/napcat', { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) { setNap(j || {}) })
          .catch(function () { setNap({ error: true }) })
      }

      /** action: 'start' | 'stop' | 'openqr' */
      function napAction(action) {
        if (action === 'stop') {
          var ok = true
          try {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              ok = window.confirm('停止 NapCat？下次启动可能要在手机上重新扫码登录。')
            }
          } catch (e) { ok = true }
          if (!ok) return
        }
        setNapBusy(true); setNapMsg(null); setNapErr(false)
        fetch('/qq-bridge/napcat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action })
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'failed')
            setNapMsg(action === 'start'
              ? '已拉起启动脚本：窗口里会出现二维码（如果 QQ 要求重新登录）'
              : (action === 'stop' ? '已发送停止命令' : '已打开二维码图片'))
            return new Promise(function (r) { setTimeout(r, 2500) }).then(loadNapcat)
          })
          .catch(function (e) {
            setNapErr(true)
            setNapMsg('操作失败：' + String(e && e.message ? e.message : e))
          })
          .then(function () { setNapBusy(false) })
      }

      function load() {
        setError(null)
        return fetch(API, { cache: 'no-store', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (j) {
            setDraft(j)
            setBlGroups(listToText(getIn(j, 'blacklist.groups', [])))
            setBlUsers(listToText(getIn(j, 'blacklist.users', [])))
            setAliasText(listToText(getIn(j, 'persona.aliases', [])))
            setAnchorsText(listToText(getIn(j, 'persona.anchors', [])))
          })
          .catch(function (e) {
            setError('读取配置失败：' + String(e && e.message ? e.message : e))
          })
      }

      react.useEffect(function () {
        load()
        loadStatus()
        loadPeople()
        loadPending()
        loadCandidate()
        loadRelations()
        loadNapcat()
        var t = setInterval(function () { loadStatus(); loadNapcat() }, 15000)
        return function () { clearInterval(t) }
      }, [])

      function set(pathStr, value) {
        setNotice(null)
        setDraft(function (d) { return setIn(d || {}, pathStr, value) })
      }

      function save() {
        if (!draft) return
        setBusy(true); setNotice(null); setError(null)
        var payload = JSON.parse(JSON.stringify(draft))
        payload.blacklist = {
          groups: textToList(blGroups, true),
          users: textToList(blUsers, true)
        }
        payload.reply.maxChars = Number(payload.reply.maxChars) || 0
        payload.reply.splitAt = Number(payload.reply.splitAt) || 0
        // ★ 2026-10-17：模型参数归一成数字。以前 maxTokens 从配置里读出来是字符串 "10000"，
        //   保存一次就把它又原样写回去，类型一直不干净（代码里靠 Number() 兜着）。
        if (payload.model) {
          payload.model.maxTokens = Number(payload.model.maxTokens) || 0
          payload.model.temperature = Number(payload.model.temperature) || 0
        }
        payload.memory.keepRounds = Number(payload.memory.keepRounds) || 20
        // ★ 2026-10-17：新暴露的参数统一归一成数字（以前只归一了 maxChars/splitAt/keepRounds，
        //   其余从文本框回来是字符串，靠宿主侧 Number() 兜着，类型不干净）。
        payload.persona = payload.persona || {}
        payload.persona.aliases = linesToList(aliasText)
        payload.persona.anchors = linesToList(anchorsText)
        if (payload.reply && payload.reply.turn) {
          var turnKeys = ['window', 'questionWaitSec', 'waitRetrySec', 'cooldownSec', 'judgeMaxTokens']
          for (var i = 0; i < turnKeys.length; i++) {
            var tk = turnKeys[i]
            payload.reply.turn[tk] = Number(payload.reply.turn[tk]) || 0
          }
        }
        if (payload.proactive) {
          var proKeys = ['cooldownSec', 'maxPerHour', 'maxPerDay', 'quietStart', 'quietEnd']
          for (var pi = 0; pi < proKeys.length; pi++) {
            var pk = proKeys[pi]
            payload.proactive[pk] = Number(payload.proactive[pk]) || 0
          }
        }
        if (payload.vision) payload.vision.maxImages = Number(payload.vision.maxImages) || 0
        if (payload.memory) {
          payload.memory.relationEvolveEvery = Number(payload.memory.relationEvolveEvery) || 30
        // 话题勾连阈值：0~1，0 会被代码当成"没填"回落到 0.4，所以这里用 nullish 判断而不是 ||
        var hook = Number(payload.memory.topicHookMinScore)
        payload.memory.topicHookMinScore = Number.isFinite(hook) && hook > 0 ? Math.min(1, hook) : 0.4
          payload.memory.daySummaryLines = Number(payload.memory.daySummaryLines) || 60
        }
        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || j.ok !== true) throw new Error((j && j.error) || 'save failed')
            setDraft(j.config)
            setBlGroups(listToText(getIn(j.config, 'blacklist.groups', [])))
            setBlUsers(listToText(getIn(j.config, 'blacklist.users', [])))
            setAliasText(listToText(getIn(j.config, 'persona.aliases', [])))
            setAnchorsText(listToText(getIn(j.config, 'persona.anchors', [])))
            setNotice('已保存，立即生效。')
            loadStatus()
          })
          .catch(function (e) {
            setError('保存失败：' + String(e && e.message ? e.message : e))
          })
          .then(function () { setBusy(false) })
      }

      if (!draft) {
        return h('div', { className: 'qqb-root' },
          h('div', { className: 'qqb-small' }, error || '读取配置中…'),
          error ? h('button', { className: 'qqb-btn', type: 'button', onClick: load }, '重试') : null
        )
      }

      var connected = status && status.connected === true
      var dotColor = connected ? 'var(--dsw-alias-state-business-primary,#3fb950)' : 'var(--dsw-alias-state-error-primary,#f85149)'
      // 「机器人跑没跑」看 3001 能不能连上；连不上但有新鲜二维码 = 跑着但等在扫码
      var napState = !nap || nap.error ? '—'
        : (nap.portListening ? '3001 监听中（已登录）'
          : (nap.qrWaiting ? '未登录 · 正在等扫码' : '未监听（机器人没在跑）'))

      var statusCard = h('div', { className: 'qqb-card' },
        h('div', { className: 'qqb-row' },
          h('div', { className: 'qqb-title' }, '运行状态'),
          h('span', { className: 'qqb-dot', style: { background: dotColor } }),
          h('span', { className: 'qqb-small' }, connected ? '已连接 NapCat' : '未连接'),
          h('button', { className: 'qqb-btn', type: 'button', onClick: function () { loadStatus(); loadNapcat() } }, '刷新')
        ),
        h('div', { className: 'qqb-grid' },
          h('span', { className: 'qqb-k' }, '机器人 QQ'), h('span', null, status && status.qq ? String(status.qq) + (status.nickname ? '（' + status.nickname + '）' : '') : '—'),
          h('span', { className: 'qqb-k' }, '所在群'), h('span', null, status ? String(status.groupCount || 0) + ' 个' : '—'),
          h('span', { className: 'qqb-k' }, '会话数'), h('span', null, status ? String(status.sessions || 0) + ' 个' : '—'),
          h('span', { className: 'qqb-k' }, '最后回复'), h('span', null, status ? fmtTime(status.lastReplyAt) : '—'),
          h('span', { className: 'qqb-k' }, '最后错误'), h('span', { className: status && status.lastError ? 'qqb-err' : '' }, status && status.lastError ? status.lastError : '无'),
          h('span', { className: 'qqb-k' }, '人物档案'), h('span', null, status && status.people ? String(status.people.count || 0) + ' 人' + (status.people.oversize ? '（' + status.people.oversize + ' 份超限）' : '') : '—'),
          h('span', { className: 'qqb-k' }, 'NapCat'), h('span', null, napState),
          h('span', { className: 'qqb-k' }, '开机自启'), h('span', null, nap && !nap.error ? (nap.autostart ? '有（登录时自动起）' : '没有') : '—')
        ),
        h('div', { className: 'qqb-row' },
          h('button', {
            className: 'qqb-btn qqb-btnPrimary', type: 'button',
            disabled: napBusy || !(nap && nap.launcherConfigured) || Boolean(nap && nap.portListening),
            onClick: function () { napAction('start') }
          }, napBusy ? '处理中…' : '启动机器人'),
          nap && nap.qrWaiting && nap.qrConfigured
            ? h('button', { className: 'qqb-btn', type: 'button', disabled: napBusy, onClick: function () { napAction('openqr') } }, '打开二维码')
            : null,
          h('button', {
            className: 'qqb-btn', type: 'button',
            disabled: napBusy || !(nap && (nap.portListening || nap.qrWaiting)), onClick: function () { napAction('stop') }
          }, '停止'),
          napMsg ? h('span', { className: napErr ? 'qqb-err' : 'qqb-ok' }, napMsg) : null
        ),
        nap && !nap.launcherConfigured
          ? h('div', { className: 'qqb-small' }, '「启动机器人」未启用：在下面「NapCat 连接」里填 napcat.launcher（你自己启动 NapCat 的脚本路径）。')
          : null,
        nap && !nap.qrConfigured
          ? h('div', { className: 'qqb-small' }, '「打开二维码」未启用：填 napcat.qrPath（NapCat 缓存里 qrcode.png 的路径）。')
          : null,
        status && status.muted && status.muted.length > 0
          ? h('div', { className: 'qqb-err' },
              status.muted.map(function (m) {
                return '群 ' + m.group + ' 发送被拒（疑似被禁言）—— 还剩 ' + m.leftSec + ' 秒不再主动判断'
              }).join('；'))
          : null,
        h('div', { className: 'qqb-small' },
          '启动用 explorer 拉起你配置的启动脚本 —— 进程不挂在桌面端下面，桌面端重启不会把它一起带走。' +
          '停止只杀 NapCatWinBootMain.exe 那一棵进程树，不会碰你自己的 QQ。')
      )

      // 页面顶部这块「简介」是可写的：内容存在 config.json 的 ui.intro，只影响显示，不影响机器人。
      var introText = String(getIn(draft, 'ui.intro', ''))

      return h('div', { className: 'qqb-root' },

        statusCard,

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '📖 简介（可自己改）'),
          h('div', { className: 'qqb-hint' },
            '这段就是这个页面顶部的介绍，随配置保存（`ui.intro`）。**只影响显示，不影响机器人怎么说话**。' +
            '想写什么写什么：它是什么、给谁用、你自己要记住的注意事项。' +
            '⚠️ 想改**回复频率**（它多爱说话）去下面「回复频率」和「主动插话额度」两张卡片 —— 那里能直接改，保存即生效。'),
          introText
            ? h('div', {
                className: 'qqb-hint',
                style: {
                  whiteSpace: 'pre-wrap',
                  borderLeft: '3px solid var(--dsw-alias-border-l2)',
                  paddingLeft: '8px',
                  opacity: 0.85
                }
              }, introText)
            : null,
          h('textarea', {
            className: 'qqb-input',
            spellCheck: false,
            style: { minHeight: '96px', whiteSpace: 'pre-wrap' },
            placeholder: '例：\n一个只会聊天的 QQ 机器人桥：NapCat 收发，DSH 的模型说话。\n它认得人、记得事、会挑时候开口；拿不到文件与命令，只能聊天。\n\n这台机器的注意：791778458 那个群被禁言了，先别管。',
            value: introText,
            onChange: function (e) { set('ui.intro', e.target.value) }
          }),
          h('div', { className: 'qqb-title', style: { marginTop: '8px' } }, '📝 便签（只给你自己看）'),
          h('textarea', {
            className: 'qqb-input',
            spellCheck: false,
            style: { minHeight: '60px', whiteSpace: 'pre-wrap' },
            placeholder: '例：\n· 私聊只回熟人\n· NapCat 重启脚本在 D:\\...',
            value: String(getIn(draft, 'ui.note', '')),
            onChange: function (e) { set('ui.note', e.target.value) }
          })
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '总开关'),
          h('div', { className: 'qqb-row' },
            h(Check, {
              label: '启用（关掉后不再回复任何消息）',
              checked: getIn(draft, 'enabled', true),
              onChange: function (v) { set('enabled', v) }
            })
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '人设'),
          h(Field, { label: '名字' },
            h(Text, { value: getIn(draft, 'persona.name', ''), onChange: function (v) { set('persona.name', v) } })
          ),
          h(Field, {
            label: '人设正文（system）',
            hint: '每次调模型时作为 system 传入。可写身份、性格、说话风格、称呼、口头禅、禁忌等。'
          },
            h('textarea', {
              className: 'qqb-input qqb-area',
              spellCheck: false,
              value: String(getIn(draft, 'persona.system', '')),
              onChange: function (e) { set('persona.system', e.target.value) }
            })
          ),
          h(Field, {
            label: '别名（一行一个）',
            hint: '别人在群里可能这样叫你：直接打名字、叫群名片、或用登录昵称。写全一点，它才认得出是在叫自己。'
          },
            h('textarea', {
              className: 'qqb-input',
              spellCheck: false,
              style: { minHeight: '56px' },
              value: aliasText,
              onChange: function (e) { setAliasText(e.target.value) }
            })
          ),
          h(Field, {
            label: '声音锚（一行一句，0~5 句）',
            hint: '几句"最像她"的原话，每轮都注入 system，当节奏样板用（防止被自己最近的话带跑）。' +
              '这几句是要人挑的 —— 别自己往里加，也别让它们变成口头禅。'
          },
            h('textarea', {
              className: 'qqb-input',
              spellCheck: false,
              style: { minHeight: '56px' },
              value: anchorsText,
              onChange: function (e) { setAnchorsText(e.target.value) }
            })
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '触发规则'),
          h('div', { className: 'qqb-hint' },
            '被 @ / 叫名字 / 引用你的话：总是回复。其余群消息走"回合制"：' +
            '有人问了一句且几秒内没人接、或这句话和你记得的事强相关时，才让模型判断"要不要接、接哪一条"。' +
            '（旧的"回复概率"骰子已经从代码里删掉 —— 回不回由内容判断，不再由随机数决定。）'),
          h('div', { className: 'qqb-row' },
            h(Check, { label: '没被 @ 时一律不回（勾上 = 完全不走回合制判断）', checked: getIn(draft, 'reply.requireAt', true), onChange: function (v) { set('reply.requireAt', v) } }),
            h(Check, { label: '群消息', checked: getIn(draft, 'reply.groups', true), onChange: function (v) { set('reply.groups', v) } }),
            h(Check, { label: '私聊（私聊一律回，不走回合制）', checked: getIn(draft, 'reply.private', false), onChange: function (v) { set('reply.private', v) } })
          ),
          h('div', { className: 'qqb-hint' },
            '私聊打开后：收到谁的单聊就直接回（不判断、不占"主动插话"额度），会话和记忆单独按「私聊:<QQ号>」存，不和群里混。'),
          h('div', { className: 'qqb-row' },
            h(Field, {
              label: '@ 说话的人的概率（0~100）',
              hint: '回复时 @ 一下对方 —— 被 @ 的人手机会收到提醒。0 = 永不 @；60 = 大约六成。'
            },
              h(Text, { num: true, value: getIn(draft, 'reply.atSenderChance', 60), onChange: function (v) { set('reply.atSenderChance', v) } })
            ),
            h(Field, {
              label: '一条最多 @ 几个人',
              hint: '包含"@说话的人"和机器人自己点名的 [@QQ号]。默认 1。设 0 = 完全关闭 @ 功能。'
            },
              h(Text, { num: true, value: getIn(draft, 'reply.maxAts', 1), onChange: function (v) { set('reply.maxAts', v) } })
            )
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '回复频率（多爱说话）'),
          h('div', { className: 'qqb-hint' },
            '没被 @ 的消息不会直接回：要么有人问了一句、等了若干秒没人接，要么这句话和你记得的事命中到阈值，' +
            '才让模型判断一次（输出 speak / wait / skip）。**下面这几个数就是"它多爱说话"的旋钮**，保存立即生效。'),
          h('div', { className: 'qqb-row' },
            h(Check, { label: '启用回合制判断（关掉 = 没被 @ 就完全不说话）', checked: getIn(draft, 'reply.turn.enabled', true), onChange: function (v) { set('reply.turn.enabled', v) } })
          ),
          h('div', { className: 'qqb-row' },
            h(Field, { label: '判断窗口（看最近几条）', hint: '4~30，默认 12。' },
              h(Text, { num: true, value: getIn(draft, 'reply.turn.window', 12), onChange: function (v) { set('reply.turn.window', v) } })
            ),
            h(Field, { label: '问句等多久（秒）', hint: '这么长时间没人接，才去看一眼要不要接。默认 10；调小 = 更容易被触发 = 更爱说话。' },
              h(Text, { num: true, value: getIn(draft, 'reply.turn.questionWaitSec', 10), onChange: function (v) { set('reply.turn.questionWaitSec', v) } })
            ),
            h(Field, { label: '话题勾连阈值（0~1）', hint: '这句话和它记得的事相似度过线才会看一眼。默认 0.4；调低（如 0.25）= 更容易触发，调高（如 0.6）= 更安静。' },
              h(Text, { num: true, value: getIn(draft, 'memory.topicHookMinScore', 0.4), onChange: function (v) { set('memory.topicHookMinScore', v) } })
            )
          ),
          h('div', { className: 'qqb-row' },
            h(Field, { label: '判 wait 后回看（秒）', hint: '"等等看"时过多久再看一次，只等一次。默认 30。' },
              h(Text, { num: true, value: getIn(draft, 'reply.turn.waitRetrySec', 30), onChange: function (v) { set('reply.turn.waitRetrySec', v) } })
            ),
            h(Field, { label: '两次说话最小间隔（秒）', hint: '同一个群里的冷却。默认 30；调大 = 更安静。' },
              h(Text, { num: true, value: getIn(draft, 'reply.turn.cooldownSec', 45), onChange: function (v) { set('reply.turn.cooldownSec', v) } })
            ),
            h(Field, { label: '判断输出上限（maxTokens）', hint: '默认 160。开大了它会把预算花在"想"上，反而没结论。' },
              h(Text, { num: true, value: getIn(draft, 'reply.turn.judgeMaxTokens', 160), onChange: function (v) { set('reply.turn.judgeMaxTokens', v) } })
            )
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '主动插话额度（防刷屏）'),
          h('div', { className: 'qqb-hint' },
            '只卡"主动插话"：被 @ / 叫名字 / 引用的回复**永远不受限**。判断前先看额度，真发出去了才扣。' +
            '冷却填 0 = 不要冷却；每小时/每天填 0 = 不限。'),
          h('div', { className: 'qqb-row' },
            h(Check, { label: '启用额度闸门', checked: getIn(draft, 'proactive.enabled', false), onChange: function (v) { set('proactive.enabled', v) } })
          ),
          h('div', { className: 'qqb-row' },
            h(Field, { label: '冷却（秒）', hint: '两次主动插话之间至少隔多久。' },
              h(Text, { num: true, value: getIn(draft, 'proactive.cooldownSec', 120), onChange: function (v) { set('proactive.cooldownSec', v) } })
            ),
            h(Field, { label: '每群每小时上限' },
              h(Text, { num: true, value: getIn(draft, 'proactive.maxPerHour', 6), onChange: function (v) { set('proactive.maxPerHour', v) } })
            ),
            h(Field, { label: '每群每天上限' },
              h(Text, { num: true, value: getIn(draft, 'proactive.maxPerDay', 30), onChange: function (v) { set('proactive.maxPerDay', v) } })
            )
          ),
          h('div', { className: 'qqb-row' },
            h(Field, { label: '静默时段开始（0~23 点）', hint: '开始=结束（或都填 0）= 不启用。支持跨午夜，如 23 → 7。' },
              h(Text, { num: true, value: getIn(draft, 'proactive.quietStart', 0), onChange: function (v) { set('proactive.quietStart', v) } })
            ),
            h(Field, { label: '静默时段结束（0~23 点）', hint: '这个时段内不主动插话；被 @ 照样回。' },
              h(Text, { num: true, value: getIn(draft, 'proactive.quietEnd', 0), onChange: function (v) { set('proactive.quietEnd', v) } })
            )
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '看图（vision）'),
          h('div', { className: 'qqb-hint' },
            '群友发的图会直接附在消息里给模型看。关掉的话它会说"我看不见图"——那是它以前没有看图能力时的旧说法。'),
          h('div', { className: 'qqb-row' },
            h(Check, { label: '启用看图', checked: getIn(draft, 'vision.enabled', true), onChange: function (v) { set('vision.enabled', v) } }),
            h(Field, { label: '每轮最多几张', hint: '多出来的图会被丢掉。默认 2。' },
              h(Text, { num: true, value: getIn(draft, 'vision.maxImages', 2), onChange: function (v) { set('vision.maxImages', v) } })
            )
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '回复与记忆'),
          h('div', { className: 'qqb-row' },
            h(Field, { label: '单条上限字数' },
              h(Text, { num: true, value: getIn(draft, 'reply.maxChars', 1200), onChange: function (v) { set('reply.maxChars', v) } })
            ),
            h(Field, { label: '超长拆分长度' },
              h(Text, { num: true, value: getIn(draft, 'reply.splitAt', 400), onChange: function (v) { set('reply.splitAt', v) } })
            ),
            h(Field, { label: '保留最近几轮' },
              h(Text, { num: true, value: getIn(draft, 'memory.keepRounds', 20), onChange: function (v) { set('memory.keepRounds', v) } })
            )
          ),
          h('div', { className: 'qqb-row' },
            h(Check, { label: '超出后压成摘要（长期记忆）', checked: getIn(draft, 'memory.summarize', true), onChange: function (v) { set('memory.summarize', v) } })
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '人物档案（一人一档）'),
          h('div', { className: 'qqb-hint' },
            '每个人一个 .md 文件，文件名就是 QQ 号。档案分两层：' +
            '「人物画像」（身份/性格/沟通方式/关系/注意 —— **只有这里能改**，插件永不覆盖你的措辞）' +
            '和「干过的事」（事件的流水账，超过上限自动砍最老的）。' +
            '注入时：画像每轮都给；干过的事只在它被 @ / 叫名字时给，且明确要求"不要主动引用"。' +
            (status && status.people && status.people.dir ? '当前文件夹：' + status.people.dir : '')
          ),
          h('div', { className: 'qqb-row' },
            h(Check, { label: '启用人物档案', checked: getIn(draft, 'people.enabled', true), onChange: function (v) { set('people.enabled', v) } })
          ),
          h('div', { className: 'qqb-row' },
            h(Field, { label: '单档上限（字节）', hint: '默认 10240 = 10KB。满了就用机器人自己的模型压缩「已知事实」。' },
              h(Text, { num: true, value: getIn(draft, 'people.maxBytes', 10240), onChange: function (v) { set('people.maxBytes', v) } })
            ),
            h(Field, { label: '自定义文件夹', hint: '留空 = 默认的 qq-bridge\\people。' },
              h(Text, { mono: true, value: getIn(draft, 'people.dir', ''), onChange: function (v) { set('people.dir', v) } })
            )
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '关系演化（每人一条，永不衰减）'),
          h('div', { className: 'qqb-hint' },
            '每 N 轮重写一次「你们现在的关系」，模型没看出变化就沿用旧文本。' +
            '等不及可以挑一个人点「现在演化」—— 用它最近那段对话立刻写一条（会调一次模型）。'),
          h('div', { className: 'qqb-row' },
            h(Field, { label: '每 N 轮演化一次', hint: '默认 30。' },
              h(Text, { num: true, value: getIn(draft, 'memory.relationEvolveEvery', 30), onChange: function (v) { set('memory.relationEvolveEvery', v) } })
            ),
            h(Field, { label: '日摘要触发条数', hint: '每群攒够这么多条原话就压一条当日事件记忆，默认 60。' },
              h(Text, { num: true, value: getIn(draft, 'memory.daySummaryLines', 60), onChange: function (v) { set('memory.daySummaryLines', v) } })
            )
          ),
          h('div', { className: 'qqb-row' },
            h('select', {
              className: 'qqb-input',
              style: { maxWidth: '260px' },
              value: evq || (pList && pList[0] ? pList[0].qq : ''),
              onChange: function (e) { setEvq(e.target.value); setRelMsg(null) }
            },
              (pList || []).map(function (p) {
                return h('option', { key: 'ev' + p.qq, value: p.qq }, (p.name || p.qq) + '（' + (p.msgCount || 0) + '）')
              })
            ),
            h('button', {
              className: 'qqb-btn qqb-btnPrimary', type: 'button',
              disabled: relBusy || !(pList && pList.length), onClick: evolveNow
            }, relBusy ? '演化中…' : '现在演化'),
            h('button', { className: 'qqb-btn', type: 'button', disabled: relBusy, onClick: loadRelations }, '刷新')
          ),
          relMsg ? h('div', { className: relErr ? 'qqb-err' : 'qqb-ok' }, relMsg) : null,
          rel && rel.relations && rel.relations.length > 0
            ? h('div', { className: 'qqb-small' },
                rel.relations.map(function (r, i) {
                  return h('div', { key: 'rel' + i, className: 'qqb-hint' },
                    '[' + (r.name || r.qq) + '] ' + (r.text || '（空）') +
                    (r.n ? '　计数 ' + r.n : '') + (r.at ? '　' + fmtTime(r.at) : ''))
                })
              )
            : h('div', { className: 'qqb-small' }, '还没有关系记录 —— 攒够轮数，或点上面的「现在演化」。')
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '✍️ 人物备注编辑器'),
          h('div', { className: 'qqb-hint' },
            '选一个人，写下你对他的备注（性格、身份、该怎么对待他）。' +
            '这里写的是画像里的「注意」一项，插件永不覆盖，且每轮都注入模型的上下文——比机器人自己揣摩的准得多。' +
            '要写身份/性格/沟通方式/关系，直接在档案 .md 里手改（编辑框只对应「注意」这一项）。'
          ),
          pList === null
            ? h('div', { className: 'qqb-small' }, '读取名单中…')
            : pList.length === 0
              ? h('div', { className: 'qqb-small' }, '还没有任何人的档案。等群里有人说话，插件会自动建。')
              : h('div', { className: 'qqb-field' },
                  h('div', { className: 'qqb-row' },
                    // ★ 2026-10-17：一人一个按钮在 109 份档案时会把整页铺满（实测），改成下拉框；
                    //   人多也能用，选中态还一眼看得见。
                    h('select', {
                      className: 'qqb-input',
                      style: { maxWidth: '300px' },
                      value: pSel,
                      onChange: function (e) { pickPerson(e.target.value) }
                    },
                      pList.map(function (p) {
                        return h('option', { key: p.qq, value: p.qq },
                          (p.name || p.qq) + '（' + (p.msgCount || 0) + '）')
                      })
                    ),
                    h('span', { className: 'qqb-small' }, '共 ' + String((pList || []).length) + ' 人（按发言数排序）')
                  ),
                  h('div', { className: 'qqb-hint' },
                    pSel
                      ? '正在编辑：' + pSel + '　档案 ' + (function () {
                          var hit = (pList || []).filter(function (x) { return x.qq === pSel })[0]
                          return hit ? (hit.bytes + ' 字节') : '?'
                        })()
                      : '先点上面一个人'
                  ),
                  h('textarea', {
                    className: 'qqb-input', spellCheck: false, style: { minHeight: '80px' },
                    placeholder: '例：群主，脾气急，爱骂人但心软，别跟他硬碰',
                    value: pNote,
                    onChange: function (e) { setPMsg(null); setPErr(false); setPNote(e.target.value) }
                  }),
                  h('div', { className: 'qqb-row' },
                    h(Field, {
                      label: '这个人的模型覆盖',
                      hint: '留空 = 跟随全局模型。填 deepseek-v4-pro 就是给这个人单独用更强的模型（更贵）。填了立即生效。'
                    },
                      h(Text, { mono: true, value: pModel, onChange: function (v) { setPMsg(null); setPModel(v) } })
                    )
                  ),
                  h('div', { className: 'qqb-row' },
                    h('button', {
                      className: 'qqb-btn qqb-btnPrimary', type: 'button',
                      disabled: pBusy || !pSel, onClick: saveNote
                    }, pBusy ? '保存中…' : '保存备注'),
                    h('button', { className: 'qqb-btn', type: 'button', disabled: pBusy, onClick: loadPeople }, '刷新名单'),
                    pMsg ? h('span', { className: pErr ? 'qqb-err' : 'qqb-ok' }, pMsg) : null
                  )
                )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '📌 本条待采纳（自动挑 1 条）'),
          h('div', { className: 'qqb-hint' },
            '机器从待审记忆里**只挑 1 条最值得记的**，改写成人话并归到画像标签，等你点头。' +
            '点「采纳」才会写进档案 —— 它自己永远不写。不合意就点「跳过」，那条不再提。'
          ),
          cand && cand.provided === true
            ? h('div', null,
                h('div', { className: 'qqb-row' },
                  h('span', { className: 'qqb-k' }, '拟写进'),
                  h('span', null, (cand.name || '(无名)') + '（' + cand.qq + '）' + ' 的「' + cand.label + '」')
                ),
                h('div', { className: 'qqb-row' },
                  h('span', { className: 'qqb-k' }, '内容'),
                  h('span', { style: { fontWeight: 600 } }, cand.text)
                ),
                cand.cached ? h('div', { className: 'qqb-small' }, '（这条是缓存的提纯结果，待审区没变就不会重新问模型）') : null,
                h('div', { className: 'qqb-row' },
                  h('button', { className: 'qqb-btn qqb-btnPrimary', type: 'button', disabled: candBusy, onClick: function () { actCandidate('adopt') } }, candBusy ? '处理中…' : '采纳，写进档案'),
                  h('button', { className: 'qqb-btn', type: 'button', disabled: candBusy, onClick: function () { actCandidate('skip') } }, '跳过这条'),
                  candMsg ? h('span', { className: candErr ? 'qqb-err' : 'qqb-ok' }, candMsg) : null
                )
              )
            : h('div', null,
                h('div', { className: 'qqb-small' },
                  candBusy ? '正在提纯…（会调一次模型）'
                    : (cand && cand.reason ? ('暂无待采纳：' + cand.reason) : '暂无待采纳。')),
                h('div', { className: 'qqb-row' },
                  h('button', { className: 'qqb-btn', type: 'button', disabled: candBusy, onClick: loadCandidate }, '重新提纯'),
                  candMsg ? h('span', { className: candErr ? 'qqb-err' : 'qqb-ok' }, candMsg) : null
                )
              )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '📥 待审记忆（模型想记的东西）'),
          h('div', { className: 'qqb-hint' },
            '机器人写 [记:内容] 或自动抽取出来的东西，**只落在这里，不会自动进任何人的档案**。' +
            '这份清单**也不会注入提示词**——所以里面写错了也污染不到对话。' +
            '觉得哪条该记，就到上面「人物备注编辑器」里自己写进去；不想要的直接清空。' +
            (pend && pend.path ? '文件：' + pend.path : '')
          ),
          h('div', { className: 'qqb-row' },
            h('button', { className: 'qqb-btn', type: 'button', onClick: loadPending }, '刷新'),
            h('button', { className: 'qqb-btn', type: 'button', onClick: clearPending }, '清空待审清单'),
            pendMsg ? h('span', { className: 'qqb-ok' }, pendMsg) : null,
            pend ? h('span', { className: 'qqb-small' }, '共 ' + String(pend.count || 0) + ' 条') : null
          ),
          pend && pend.items && pend.items.length > 0
            ? h('div', { className: 'qqb-small' },
                pend.items.slice(-40).reverse().map(function (it, i) {
                  return h('div', { key: 'pend' + i, className: 'qqb-hint' },
                    '[' + it.at + '] (' + it.source + ') ' + it.qq + '：' + it.text)
                })
              )
            : h('div', { className: 'qqb-small' }, pend && pend.count === 0 ? '暂无（模型还没想记什么）' : '（未读取）')
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '模型'),
          h('div', { className: 'qqb-row' },
            h(Field, { label: 'provider' , hint: '桌面端账号登录用 deepseek-account' },
              h(Text, { value: getIn(draft, 'model.provider', 'deepseek-account'), onChange: function (v) { set('model.provider', v) } })
            ),
            h(Field, { label: 'model', hint: '留空 = 自动取桌面端默认' },
              h(Text, { value: getIn(draft, 'model.model', ''), onChange: function (v) { set('model.model', v) } })
            )
          ),
          h('div', { className: 'qqb-row' },
            h(Field, {
              label: 'reasoningEffort（思考量）',
              hint: '默认 off。桌面端默认是 high，实测会导致"光想不说、一个字都不回"。想让它更聪明可填 low / medium / high，但会变慢且更容易空回复。'
            },
              h(Text, { value: getIn(draft, 'model.reasoningEffort', 'off'), onChange: function (v) { set('model.reasoningEffort', v) } })
            ),
            h(Field, { label: 'maxTokens', hint: '0 = 用桌面端默认（256000）。可限制单次输出上限，省额度。' },
              h(Text, { num: true, value: getIn(draft, 'model.maxTokens', 0), onChange: function (v) { set('model.maxTokens', v) } })
            ),
            h(Field, { label: 'temperature', hint: '0 = 不传（用桌面端默认）。发现它爱复读同一个回答时，试着填 1.0~1.3 增加变化。' },
              h(Text, { value: getIn(draft, 'model.temperature', 0), onChange: function (v) { set('model.temperature', v) } })
            ),
            h(Field, {
              label: 'historyMode（历史传法）',
              hint: 'messages = 推荐，真正的多轮上下文，历史前缀逐字节一致、前缀缓存命中更好。flatten = 退路，把历史压平成一条消息。★ 旧说法「messages 会崩、必须用 flatten」已作废（2026-10-14 探针实验证实真因是 assistant 消息缺 source，已修）。有异常就改回 flatten。'
            },
              h(Text, { value: getIn(draft, 'model.historyMode', 'messages'), onChange: function (v) { set('model.historyMode', v) } })
            )
          ),
          status && status.lastAskFailure
            ? h('div', { className: 'qqb-err' }, '最近一次空回复的原因：' + status.lastAskFailure)
            : null
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, 'NapCat 连接'),
          h(Field, { label: 'WebSocket 地址', hint: '改这里需要重启桌面端才会重连。' },
            h(Text, { mono: true, value: getIn(draft, 'napcat.url', ''), onChange: function (v) { set('napcat.url', v) } })
          ),
          h(Field, { label: 'access token' },
            h(Text, { mono: true, value: getIn(draft, 'napcat.accessToken', ''), onChange: function (v) { set('napcat.accessToken', v) } })
          ),
          h(Field, {
            label: '启动脚本（可选）',
            hint: '填了才会出现「启动机器人」按钮（点它用 explorer 拉起这个脚本，不挂在桌面端进程树下）。' +
              '留空 = 不启用这一步，自己去启动 NapCat。例：C:\\你的\\路径\\启动QQ机器人.cmd'
          },
            h(Text, { mono: true, value: getIn(draft, 'napcat.launcher', ''), onChange: function (v) { set('napcat.launcher', v) } })
          ),
          h(Field, {
            label: '二维码图片路径（可选）',
            hint: 'NapCat 等扫码时会把二维码存成图片；填了才能在页面里「打开二维码」。' +
              '留空 = 不启用。例：…\\resources\\app\\napcat\\cache\\qrcode.png'
          },
            h(Text, { mono: true, value: getIn(draft, 'napcat.qrPath', ''), onChange: function (v) { set('napcat.qrPath', v) } })
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '黑名单'),
          h(Field, { label: '群号', hint: '一行一个，或用逗号/空格分隔。留空 = 不拦截。' },
            h('textarea', {
              className: 'qqb-input', spellCheck: false, style: { minHeight: '60px' },
              value: blGroups, onChange: function (e) { setNotice(null); setBlGroups(e.target.value) }
            })
          ),
          h(Field, { label: 'QQ 号' },
            h('textarea', {
              className: 'qqb-input', spellCheck: false, style: { minHeight: '60px' },
              value: blUsers, onChange: function (e) { setNotice(null); setBlUsers(e.target.value) }
            })
          )
        ),

        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title' }, '📄 文件备注（都在 ~/.dsh/qq-bridge/）'),
          h('div', { className: 'qqb-small' },
            [
              ['config.json', '配置本体。页面「保存」写的就是它；直接改这个文件也会热加载。'],
              ['memory.json', '每群最近 20 轮的原文（会话历史）。'],
              ['memory-store.json', '长期记忆条目 + relations（关系）+ relationCounters（演化计数）。'],
              ['pending-notes.md', '待审记忆（模型想记、等人采纳）；这份不注入提示词。'],
              ['people\\<QQ号>.md', '一人一档的人物画像；只有「人物备注编辑器」和手改能写进去。'],
              ['bridge.log', '桥日志。只写 ASCII，中文会变成 ?（故意的，避免 GBK 乱码）。'],
              ['napcat.launcher（配置项）', '你自己启动 NapCat 的脚本路径，填了页面才有「启动机器人」。'],
              ['napcat.qrPath（配置项）', 'NapCat 存二维码图片的位置，填了页面才能「打开二维码」。'],
              ['开机自启', 'Windows Startup 目录里的快捷方式，本插件不创建也不管理它。']
            ].map(function (row, i) {
              return h('div', { key: 'file' + i, className: 'qqb-hint', style: { marginTop: '2px' } },
                h('span', { className: 'qqb-mono' }, row[0]), ' — ' + row[1])
            })
          ),
          h('div', { className: 'qqb-title', style: { marginTop: '6px' } }, '什么改动什么时候生效'),
          h('div', { className: 'qqb-small' },
            [
              ['保存 / 直接改 config.json', '立即生效（热加载），不用重启'],
              ['人物画像、备注、单人模型', '立即生效（下一轮就用）'],
              ['NapCat 地址 / token', '要重启桌面端才会重连'],
              ['总开关 从「关」打到「开」', '要重启（关着的时候桥根本没启动）'],
              ['lib\\*.js 代码改动', '要重启桌面端；客户端还要刷新页面']
            ].map(function (row, i) {
              return h('div', { key: 'eff' + i, className: 'qqb-hint', style: { marginTop: '2px' } },
                h('span', { className: 'qqb-mono' }, row[0]), ' — ' + row[1])
            })
          )
        ),

        h('div', { className: 'qqb-row' },
          h('button', { className: 'qqb-btn qqb-btnPrimary', type: 'button', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { className: 'qqb-btn', type: 'button', disabled: busy, onClick: load }, '放弃修改'),
          notice ? h('span', { className: 'qqb-ok' }, notice) : null,
          error ? h('span', { className: 'qqb-err' }, error) : null
        )
      )
    }

    /* ── 插件 ──────────────────────────────────────────────────────────── */
    var inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        try {
          return ctx.slots.register(
            { name: 'settings.section', id: 'qq-bridge', order: 30, label: 'QQ 桥' },
            function () { return h(Panel, {}) }
          )
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[dsh-qq-bridge] 设置页注册失败：', error)
          }
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
