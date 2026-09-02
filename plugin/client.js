return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert([
      '.ccw-panel { font-size: 12px; line-height: 1.55; }',
      '.ccw-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 4px 0 8px; }',
      '.ccw-chip { border: 1px solid rgba(128,128,128,.4); border-radius: 10px; padding: 0 8px; font-size: 11px; }',
      '.ccw-chip.hot { border-color: rgba(230,160,60,.7); color: #d79a3c; }',
      '.ccw-btn { font: inherit; font-size: 11.5px; padding: 1px 9px; border-radius: 6px; border: 1px solid rgba(128,128,128,.5); background: transparent; color: inherit; cursor: pointer; }',
      '.ccw-btn:hover:not(:disabled) { background: rgba(128,128,128,.14); }',
      '.ccw-btn:disabled { opacity: .45; cursor: default; }',
      '.ccw-btn.danger { border-color: rgba(220,80,80,.65); color: #d9534f; }',
      '.ccw-input { font: inherit; font-size: 11.5px; padding: 1px 6px; border-radius: 6px; border: 1px solid rgba(128,128,128,.5); background: transparent; color: inherit; width: 150px; }',
      '.ccw-sec { margin: 10px 0 2px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.ccw-item { border: 1px solid rgba(128,128,128,.28); border-radius: 6px; padding: 4px 8px; margin: 4px 0; }',
      '.ccw-row { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }',
      '.ccw-size { font-weight: 600; white-space: nowrap; }',
      '.ccw-path { opacity: .6; font-family: ui-monospace, Consolas, monospace; font-size: 11px; word-break: break-all; }',
      '.ccw-note { opacity: .7; font-size: 11px; }',
      '.ccw-sub { opacity: .75; font-size: 11px; }',
      '.ccw-badge { border: 1px solid rgba(128,128,128,.45); border-radius: 8px; padding: 0 5px; font-size: 10.5px; white-space: nowrap; }',
      '.ccw-badge.warn { border-color: rgba(230,160,60,.7); color: #d79a3c; }',
      '.ccw-badge.ok { border-color: rgba(80,180,110,.7); color: #4caf7d; }',
      '.ccw-badge.bad { border-color: rgba(220,90,90,.7); color: #d9534f; }',
      '.ccw-log { max-height: 150px; overflow: auto; border: 1px dashed rgba(128,128,128,.45); border-radius: 6px; padding: 4px 8px; margin-top: 10px; white-space: pre-wrap; font-size: 11px; }',
      '.ccw-rank { border-bottom: 1px dashed rgba(128,128,128,.2); padding: 2px 4px; }'
    ].join('\n'))

    slots.inject('tool.view.cordis', function () {
      return slots.register({ name: 'tool.view.cordis', key: 'self' }, function () {
        return React.createElement(CleanPanel, null)
      })
    })

    const el = React.createElement

    function fmtBytes(n) {
      if (n === null || n === undefined || isNaN(Number(n))) return '—'
      let v = Number(n)
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let i = 0
      while (v >= 1024 && i < units.length - 1) { v = v / 1024; i = i + 1 }
      return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[i]
    }
    function fmtCount(n) {
      if (n === null || n === undefined) return ''
      if (n >= 10000) return (n / 10000).toFixed(1) + '万'
      return String(n)
    }

    function CleanPanel() {
      const [targets, setTargets] = React.useState([])
      const [drives, setDrives] = React.useState([])
      const [loaded, setLoaded] = React.useState(false)
      const [info, setInfo] = React.useState({})
      const infoRef = React.useRef({})
      const [checked, setChecked] = React.useState({})
      const [dstRoot, setDstRoot] = React.useState('D:\\CRelocated')
      const [wantLnk, setWantLnk] = React.useState(true)
      const [log, setLog] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [confirmPath, setConfirmPath] = React.useState(null)
      const [loadErr, setLoadErr] = React.useState('')
      const [sizeSort, setSizeSort] = React.useState(true)
      const [adItems, setAdItems] = React.useState([])
      const [adBusy, setAdBusy] = React.useState(false)

      const addLog = function (text) {
        setLog(function (prev) {
          const next = prev.concat([{ ts: new Date().toLocaleTimeString(), text: text }])
          return next.length > 200 ? next.slice(next.length - 200) : next
        })
      }
      const patchInfo = function (path, patch) {
        const merged = Object.assign({}, infoRef.current)
        merged[path] = Object.assign({}, merged[path] || {}, patch)
        infoRef.current = merged
        setInfo(merged)
      }
      const callHost = function (method, args) { return host.call(method, args || {}) }

      const load = function () {
        return callHost('catalog').then(function (r) {
          if (!r || r.ok === false) { setLoadErr((r && r.error) || '加载失败'); return [] }
          setTargets(r.targets || [])
          setDrives(r.drives || [])
          setLoaded(true)
          setLoadErr('')
          return r.targets || []
        }).catch(function (e) { setLoadErr(String((e && e.message) || e)); return [] })
      }

      const judgeOne = function (t) {
        const cur = infoRef.current[t.path] || {}
        patchInfo(t.path, { judging: true })
        return callHost('judge', { path: t.path, sizeBytes: cur.sizeBytes || 0 }).then(function (r) {
          if (r && r.reclassified) {
            addLog('「' + t.name + '」重命名探测被拒（Access denied），已归入③区；若占用方已退出，可在④区点「重测回②区」')
            return load()
          }
          if (r && r.ok !== false) patchInfo(t.path, { judging: false, movable: r.movable === true, reason: r.reason || '' })
          else patchInfo(t.path, { judging: false, movable: false, reason: (r && r.error) || '判定失败' })
        }).catch(function (e) { patchInfo(t.path, { judging: false, movable: false, reason: String((e && e.message) || e) }) })
      }

      const scannable = function (t) { return t.cleanMode !== 'recycle' }

      const scanList = async function (list, withJudge) {
        if (busy) return
        setBusy(true)
        for (let i = 0; i < list.length; i++) {
          const t = list[i]
          patchInfo(t.path, { status: 'scan' })
          try {
            const r = await callHost('scan', { path: t.path })
            if (r && r.ok !== false && r.error === undefined) {
              patchInfo(t.path, {
                status: 'done',
                exists: r.exists !== false,
                sizeBytes: r.exists === false ? 0 : r.sizeBytes,
                files: r.files,
                linkType: r.linkType || null
              })
            } else {
              patchInfo(t.path, { status: 'error', msg: (r && (r.error || '统计失败')) || '统计失败' })
            }
          } catch (e) {
            patchInfo(t.path, { status: 'error', msg: String((e && e.message) || e) })
          }
          if (withJudge && t.relocatable && infoRef.current[t.path] && infoRef.current[t.path].exists !== false) {
            await judgeOne(t)
          }
        }
        setBusy(false)
      }

      const cleanChecked = async function () {
        const picked = targets.filter(function (t) { return t.cleanable && checked[t.path] })
        if (!picked.length) { addLog('请先勾选要清理的项目'); return }
        const normal = picked.filter(function (t) { return t.cleanMode !== 'recycle' && t.exists !== false })
        const recycleItems = picked.filter(function (t) { return t.cleanMode === 'recycle' })
        picked.forEach(function (t) { if (t.cleanMode !== 'recycle' && t.exists === false) addLog('跳过 ' + t.name + '（路径不存在，无需清理）') })
        if (!normal.length && !recycleItems.length) { setChecked({}); return }
        setBusy(true)
        let totalFreed = 0
        for (let i = 0; i < normal.length; i++) {
          const t = normal[i]
          patchInfo(t.path, { status: 'clean' })
          try {
            const r = await callHost('clean', { path: t.path })
            const freed = Math.max(0, (r && r.freedBytes) || 0)
            totalFreed += freed
            if (r && r.ok) {
              addLog('✓ ' + t.name + '：清理 ' + r.removed + ' 项，释放约 ' + fmtBytes(freed) + ((r && r.note) ? '（' + r.note + '）' : ''))
              patchInfo(t.path, { status: 'done', sizeBytes: 0, files: 0, cleaned: true })
            } else {
              addLog('△ ' + t.name + '：' + ((r && r.error) || '部分失败（' + ((r && r.firstError) || ('失败 ' + ((r && r.failed) || 0) + ' 项')) + '）') + ((r && r.note) ? '（' + r.note + '）' : '') + '，释放约 ' + fmtBytes(freed))
              patchInfo(t.path, { status: 'done', cleaned: true })
            }
          } catch (e) {
            addLog('× ' + t.name + '：' + String((e && e.message) || e))
            patchInfo(t.path, { status: 'error', msg: String((e && e.message) || e) })
          }
        }
        for (let j = 0; j < recycleItems.length; j++) {
          try {
            const r2 = await callHost('clean', { path: recycleItems[j].path })
            addLog((r2 && r2.ok) ? '✓ 已清空回收站' + ((r2 && r2.note) ? '（' + r2.note + '）' : '') : '× 回收站清空失败：' + ((r2 && (r2.error || r2.firstError)) || ''))
          } catch (e2) { addLog('× 回收站：' + String((e2 && e2.message) || e2)) }
        }
        if (normal.length) addLog('本轮共释放约 ' + fmtBytes(totalFreed) + '（按C盘剩余空间差值估算）')
        setChecked({})
        load()
        setBusy(false)
      }

      const doRelocate = async function (t) {
        if (confirmPath !== t.path) { setConfirmPath(t.path); return }
        const st = infoRef.current[t.path] || {}
        if (st.movable !== true) { setConfirmPath(null); judgeOne(t); addLog('该项目当前不可迁移，已重新检测：' + (st.reason || '')); return }
        setBusy(true)
        setConfirmPath(null)
        patchInfo(t.path, { status: 'move' })
        const dstName = (!t.id || t.id.indexOf('|') !== -1)
          ? String(t.path.split('\\').pop() || 'dir')
          : String(t.id)
        try {
          const r = await callHost('relocate', { path: t.path, dstRoot: dstRoot, shortcut: wantLnk, dstName: dstName.replace(/[\\/:*?"<>|]/g, '') })
          if (r && r.ok) {
            addLog('✓ 已迁移 ' + t.name + ' → ' + r.dst + '；C盘原路径已建立目录联接' + (r.shortcut ? '；已创建桌面快捷方式' : ''))
            patchInfo(t.path, { status: 'moved', movable: false, sizeBytes: 0, reason: '已迁移至 ' + r.dst + '（原路径为联接）' })
            load()
          } else {
            addLog('× 迁移失败 ' + t.name + '：' + ((r && r.error) || '未知错误'))
            patchInfo(t.path, { status: 'error', msg: (r && r.error) || '迁移失败' })
            judgeOne(t)
          }
        } catch (e) {
          addLog('× 迁移异常：' + String((e && e.message) || e))
          patchInfo(t.path, { status: 'error', msg: String((e && e.message) || e) })
        }
        setBusy(false)
      }

      const scanAppdata = function () {
        if (adBusy) return
        setAdBusy(true)
        addLog('AppData 占用扫描开始（Local/Roaming/LocalLow 全部顶层目录，最长需几分钟）…')
        callHost('appdataScan').then(function (r) {
          setAdBusy(false)
          if (r && r.ok) {
            const items = r.items || []
            setAdItems(items)
            addLog('✓ AppData 扫描完成：' + items.length + ' 个顶层目录，前3：' + items.slice(0, 3).map(function (x) { return x.name + ' ' + fmtBytes(x.sizeBytes) }).join('、'))
          } else {
            addLog('× AppData 扫描失败：' + ((r && r.error) || ''))
          }
        }).catch(function (e) {
          setAdBusy(false)
          addLog('× AppData 扫描异常：' + String((e && e.message) || e))
        })
      }

      const addTargetOne = function (item) {
        callHost('addTarget', { path: item.path }).then(function (r) {
          if (r && r.ok) {
            addLog('✓ 已加入迁移：' + item.name + '，自动检测占用中…')
            return load().then(function (ts) {
              const t = (ts || []).find(function (x) { return x.path === item.path })
              if (t) judgeOne(t)
            })
          }
          addLog('× 加入失败：' + ((r && r.error) || ''))
        }).catch(function (e) { addLog('× 加入异常：' + String((e && e.message) || e)) })
      }

      const reAddOne = function (item) {
        callHost('reAddTarget', { path: item.path }).then(function (r) {
          if (r && r.ok) {
            addLog('✓ 「' + item.name + '」已移回②区，重新检测占用中…（若占用方仍在运行会再次归入③区）')
            return load().then(function (ts) {
              const t = (ts || []).find(function (x) { return x.path === item.path })
              if (t) judgeOne(t)
            })
          }
          addLog('× 移回失败：' + ((r && r.error) || ''))
        }).catch(function (e) { addLog('× 移回异常：' + String((e && e.message) || e)) })
      }

      React.useEffect(function () {
        let alive = true
        load().then(function (ts) {
          if (!alive) return
          const autoList = ts.filter(function (t) { return (t.cleanable || t.relocatable) && scannable(t) && t.exists })
          const run = async function () {
            if (!alive) return
            await scanList(autoList, true)
            if (!alive) return
            scanAppdata()
          }
          run()
        })
        return function () { alive = false }
      }, [])

      const cleanables = targets.filter(function (t) { return t.cleanable })
      const relocatables = targets.filter(function (t) { return t.relocatable })
      const infos = targets.filter(function (t) { return t.kind === 'info' })
      const selectable = cleanables.filter(scannable)
      const allChecked = selectable.length > 0 && selectable.every(function (t) { return checked[t.path] })

      const autoList = targets.filter(function (t) { return (t.cleanable || t.relocatable) && scannable(t) && t.exists })
      const scanningCount = autoList.filter(function (t) { const st = info[t.path]; return st && st.status === 'scan' }).length
      const doneCount = autoList.length - scanningCount

      const orderRows = function (list) {
        if (!sizeSort) return list
        return list.slice().sort(function (a, b) {
          const ea = a.exists === false
          const eb = b.exists === false
          if (ea !== eb) return ea ? 1 : -1
          const ia = info[a.path] || {}
          const ib = info[b.path] || {}
          const va = ia.sizeBytes === undefined ? -1 : ia.sizeBytes
          const vb = ib.sizeBytes === undefined ? -1 : ib.sizeBytes
          return vb - va
        })
      }
      const secTotal = function (list) {
        let t = 0
        let any = false
        list.forEach(function (x) {
          const st = info[x.path]
          if (st && st.sizeBytes !== undefined) { t = t + st.sizeBytes; any = true }
        })
        return any ? fmtBytes(t) : null
      }
      const dstNameOf = function (t) {
        const raw = (!t.id || t.id.indexOf('|') !== -1) ? String(t.path.split('\\').pop() || 'dir') : String(t.id)
        return raw.replace(/[\\/:*?"<>|]/g, '')
      }

      const driveChip = function (d) {
        const total = (d.free || 0) + (d.used || 0)
        return el('span', { className: 'ccw-chip', key: d.drive }, d.drive + ': 剩余 ' + fmtBytes(d.free) + ' / 共 ' + fmtBytes(total))
      }

      const subText = function (st) {
        if (st.status === 'scan') return '统计中…'
        if (st.cleaned) return '已清理'
        let text = fmtBytes(st.sizeBytes)
        if (st.files !== undefined && st.files !== null) text = text + ' · ' + fmtCount(st.files) + '文件'
        return text
      }

      const renderCleanRow = function (t) {
        const st = info[t.path] || {}
        const isRecycle = t.cleanMode === 'recycle'
        return el('div', { className: 'ccw-item', key: t.path },
          el('div', { className: 'ccw-row' },
            el('input', {
              type: 'checkbox',
              checked: !!checked[t.path],
              onChange: function (e) {
                const v = e.target.checked
                setChecked(function (p) { const n = Object.assign({}, p); n[t.path] = v; return n })
              }
            }),
            el('strong', null, t.name),
            isRecycle ? null : el('span', { className: 'ccw-size' }, subText(st)),
            t.admin ? el('span', { className: 'ccw-badge warn' }, '需管理员') : null,
            st.linkType ? el('span', { className: 'ccw-badge ok' }, '已是链接') : null,
            st.status === 'error' ? el('span', { className: 'ccw-badge bad' }, st.msg || '失败') : null,
            isRecycle ? null : el('button', { className: 'ccw-btn', disabled: busy, onClick: function () { scanList([t], false) } }, '重新统计')
          ),
          el('div', { className: 'ccw-path' }, t.path),
          t.note ? el('div', { className: 'ccw-note' }, '· ' + t.note) : null
        )
      }

      const renderRelocateRow = function (t) {
        const st = info[t.path] || {}
        const badges = []
        if (t.admin) badges.push(el('span', { className: 'ccw-badge warn', key: 'a' }, '需管理员'))
        if (st.linkType) badges.push(el('span', { className: 'ccw-badge ok', key: 'l' }, '已是链接'))
        if (st.judging) badges.push(el('span', { className: 'ccw-badge', key: 'j' }, '检测中…'))
        else if (st.movable === true) badges.push(el('span', { className: 'ccw-badge ok', key: 'm' }, '可迁移'))
        else if (st.movable === false && st.reason) badges.push(el('span', { className: 'ccw-badge bad', key: 'mb' }, '不可迁移'))
        if (st.status === 'move') badges.push(el('span', { className: 'ccw-badge', key: 'mv' }, '迁移中…'))
        if (st.status === 'error') badges.push(el('span', { className: 'ccw-badge bad', key: 'e' }, st.msg || '失败'))
        return el('div', { className: 'ccw-item', key: t.path, style: t.exists ? undefined : { opacity: 0.45 } },
          el('div', { className: 'ccw-row' },
            el('strong', null, t.name),
            el('span', { className: 'ccw-size' }, subText(st)),
            badges
          ),
          el('div', { className: 'ccw-path' }, t.path),
          t.exists ? el('div', { className: 'ccw-note' }, '→ 将迁移到 ' + dstRoot + '\\' + dstNameOf(t) + '（原路径变联接）') : null,
          st.reason ? el('div', { className: 'ccw-note' }, '· ' + st.reason) : null,
          t.note ? el('div', { className: 'ccw-note' }, '· ' + t.note) : null,
          t.exists ? el('div', { className: 'ccw-row', style: { marginTop: 3 } },
            el('button', { className: 'ccw-btn', disabled: busy, onClick: function () { scanList([t], true) } }, '重新统计'),
            el('button', { className: 'ccw-btn', disabled: busy || st.judging, onClick: function () { judgeOne(t) } }, '重新检测'),
            el('button', {
              className: 'ccw-btn danger',
              disabled: busy || (st.movable !== true && confirmPath !== t.path),
              onClick: function () { doRelocate(t) }
            }, st.status === 'move' ? '迁移中…' : (confirmPath === t.path ? '确认迁移！' : '迁移')),
            confirmPath === t.path ? el('button', { className: 'ccw-btn', onClick: function () { setConfirmPath(null) } }, '取消') : null
          ) : el('div', { className: 'ccw-note' }, '（路径不存在：未安装或已迁移）')
        )
      }

      const renderInfoRow = function (t) {
        const st = info[t.path] || {}
        const sysRe = String(t.id || '').indexOf('sysinfo|') === 0
        return el('div', { className: 'ccw-item', key: t.path },
          el('div', { className: 'ccw-row' },
            el('strong', null, t.name),
            el('span', { className: 'ccw-size' }, subText(st)),
            t.admin ? el('span', { className: 'ccw-badge warn' }, '需管理员') : null,
            el('span', { className: 'ccw-badge bad' }, '不可移动'),
            sysRe ? el('button', { className: 'ccw-btn', disabled: busy, onClick: function () { reAddOne(t) } }, '重测回②区') : null,
            t.exists && !st.sizeBytes ? el('button', { className: 'ccw-btn', disabled: busy, onClick: function () { scanList([t], false) } }, '统计') : null
          ),
          el('div', { className: 'ccw-path' }, t.path),
          t.note ? el('div', { className: 'ccw-note' }, '· ' + t.note) : null
        )
      }

      const rootLabel = function (r) {
        const s = String(r || '').toLowerCase()
        if (s.indexOf('roaming') !== -1) return 'Roaming'
        if (s.indexOf('locallow') !== -1) return 'LocalLow'
        return 'Local'
      }
      const adByRoot = {}
      adItems.forEach(function (it) {
        const k = rootLabel(it.root)
        if (!adByRoot[k]) adByRoot[k] = []
        adByRoot[k].push(it)
      })
      const renderAdRow = function (it) {
        const match = targets.find(function (t) { return t.path === it.path })
        let badge = null
        let action = null
        if (match) {
          if (match.relocatable) {
            badge = el('span', { className: 'ccw-badge', key: 'k' }, '已在②区')
          } else if (String(match.id || '').indexOf('sysinfo|') === 0) {
            badge = el('span', { className: 'ccw-badge bad', key: 'k' }, '已归③区')
            action = el('button', { className: 'ccw-btn', key: 'ra', onClick: function () { reAddOne(it) } }, '重测回②区')
          } else {
            badge = el('span', { className: 'ccw-badge bad', key: 'k' }, '系统强制·不可迁移')
          }
        }
        return el('div', { className: 'ccw-row ccw-rank', key: it.path },
          el('span', { className: 'ccw-size', style: { minWidth: 70 } }, fmtBytes(it.sizeBytes)),
          el('span', { style: { fontWeight: 500 } }, it.name),
          it.files ? el('span', { className: 'ccw-note' }, fmtCount(it.files) + '文件') : null,
          it.isLink ? el('span', { className: 'ccw-badge ok', key: 'l' }, '已是链接') : null,
          badge,
          action,
          (!it.isLink && !match) ? el('button', { className: 'ccw-btn', onClick: function () { addTargetOne(it) } }, '加入迁移') : null
        )
      }
      const renderAdRoot = function (k) {
        const list = (adByRoot[k] || []).slice(0, 15)
        const total = (adByRoot[k] || []).reduce(function (a, x) { return a + (Number(x.sizeBytes) || 0) }, 0)
        return el('div', { key: k, style: { marginBottom: 6 } },
          el('div', { className: 'ccw-row', style: { marginTop: 4 } },
            el('span', { className: 'ccw-chip hot' }, 'AppData\\' + k + ' 合计 ' + fmtBytes(total)),
            el('span', { className: 'ccw-note' }, '显示前 ' + list.length + ' 名（按大小）')
          ),
          list.map(renderAdRow)
        )
      }

      const secHead = function (title, total, buttons) {
        const kids = [title]
        if (total) kids.push(el('span', { className: 'ccw-chip hot', key: 'total' }, '合计 ' + total))
        if (buttons) buttons.forEach(function (b, i) { kids.push(el('span', { key: 'b' + i, style: { fontWeight: 400 } }, b)) })
        return el('div', { className: 'ccw-sec' }, kids)
      }

      return el('div', { className: 'ccw-panel' },
        el('div', { className: 'ccw-toolbar' },
          el('button', {
            className: 'ccw-btn', disabled: busy,
            onClick: function () { load().then(function (ts) { addLog('目录已刷新，共 ' + ts.length + ' 个关注项') }) }
          }, '刷新目录'),
          el('button', {
            className: 'ccw-btn', disabled: busy,
            onClick: function () { scanList(autoList, true) }
          }, '重新扫描全部'),
          el('button', {
            className: 'ccw-btn', disabled: busy,
            onClick: function () { setSizeSort(function (v) { return !v }) }
          }, sizeSort ? '排序：按大小' : '排序：按目录'),
          scanningCount > 0 ? el('span', { className: 'ccw-chip' }, '自动扫描中 ' + doneCount + '/' + autoList.length + '…') : null,
          drives.map(driveChip)
        ),
        loadErr ? el('div', { className: 'ccw-badge bad' }, '加载失败：' + loadErr) : null,
        secHead('① 可直接清理的缓存', secTotal(cleanables.filter(scannable)), [
          el('button', { className: 'ccw-btn', disabled: busy, onClick: function () { scanList(cleanables.filter(scannable), false) } }, '扫描本区'),
          el('button', {
            className: 'ccw-btn', disabled: busy || !selectable.length,
            onClick: function () {
              setChecked(function (p) {
                const n = Object.assign({}, p)
                selectable.forEach(function (t) { n[t.path] = !allChecked })
                return n
              })
            }
          }, allChecked ? '取消全选' : '全选'),
          el('button', { className: 'ccw-btn danger', disabled: busy, onClick: function () { cleanChecked() } }, '清理选中')
        ]),
        el('div', { className: 'ccw-sub' }, '打开面板已自动扫描大小。勾选后点「清理选中」，缓存删除后由系统/应用自动重建，不触碰任何文档数据。'),
        cleanables.length ? orderRows(cleanables).map(renderCleanRow) : el('div', { className: 'ccw-note' }, '未发现可清理项'),
        secHead('② 迁移到D盘（每个文件夹一对一迁移）', secTotal(relocatables), [
          el('button', { className: 'ccw-btn', disabled: busy, onClick: function () { scanList(relocatables, true) } }, '扫描本区')
        ]),
        el('div', { className: 'ccw-row' },
          el('span', null, 'D盘存放根目录：'),
          el('input', { className: 'ccw-input', value: dstRoot, onChange: function (e) { setDstRoot(e.target.value) } }),
          el('label', null,
            el('input', { type: 'checkbox', checked: wantLnk, onChange: function (e) { setWantLnk(e.target.checked) } }),
            ' 迁移后在桌面创建快捷方式'
          )
        ),
        el('div', { className: 'ccw-sub' }, '一一对应：C盘每个文件夹 → 存放根目录下各自的子文件夹（如 C:\\…\\npm-cache → D:\\CRelocated\\npm-cache），并逐条确认；C盘原路径建立目录联接，程序仍按原路径访问，强制C盘的安装路径也继续可用。'),
        relocatables.length ? orderRows(relocatables).map(renderRelocateRow) : el('div', { className: 'ccw-note' }, '未发现可迁移项'),
        secHead('③ 系统强制C盘（仅供参考，本工具不会改动）', secTotal(infos), [
          el('button', { className: 'ccw-btn', disabled: busy, onClick: function () { scanList(infos, false) } }, '统计本区（较慢）')
        ]),
        orderRows(infos).map(renderInfoRow),
        secHead('④ AppData 占用排行（Local / Roaming / LocalLow）', null, [
          el('button', { className: 'ccw-btn', disabled: adBusy || busy, onClick: function () { scanAppdata() } }, adBusy ? '自动扫描中…（最长几分钟）' : '重新扫描 AppData')
        ]),
        el('div', { className: 'ccw-sub' }, '打开面板后自动扫描（排在①②区之后）。AppData 下多为程序数据：点「加入迁移」进②区（探测占用与D盘空间、失败回滚）；被拒绝重命名的自动归入③区，退出占用程序后可点「重测回②区」再试。'),
        adItems.length
          ? ['Local', 'Roaming', 'LocalLow'].filter(function (k) { return adByRoot[k] && adByRoot[k].length }).map(renderAdRoot)
          : (adBusy ? el('div', { className: 'ccw-note' }, '正在自动扫描 AppData（排队在①②区大小扫描之后，完成后按大小排名）…') : el('div', { className: 'ccw-note' }, '等待自动扫描，或点上方按钮手动开始。')),
        el('div', { className: 'ccw-log' },
          log.length === 0
            ? (loaded ? '操作日志（扫描/清理/迁移结果都会显示在这里）' : '正在加载目录…')
            : log.map(function (l, i) { return el('div', { key: i }, '[' + l.ts + '] ' + l.text) })
        )
      )
    }
  }
}
