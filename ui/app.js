import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

let mcpApp = null;
let useHttpFallback = false;
let currentData = null;
let currentRegMode = 'phase';
let currentDataVersion = 0;
let sseConnection = null;
let appPollTimer = null;
let selectableUnits = []; // 供自定义 A vs B 比较器选择的全部会话与阶段切片

const PLATFORM_COLORS = {
  antigravity: '#3b82f6',
  dsh: '#a855f7',
  'claude-code': '#f59e0b',
  codex: '#10b981',
  custom: '#ec4899',
};

function platBadge(p) {
  const cls = p === 'antigravity' ? 'tag-agy' : p === 'dsh' ? 'tag-dsh' : p === 'claude-code' ? 'tag-claude' : 'tag-codex';
  return `<span class="tag ${cls}">${escapeHtml(p)}</span>`;
}

function roleBadge(role) {
  if (role === 'advisor') return `<span class="tag" style="background:rgba(56,189,248,0.18);color:#38bdf8">优化顾问</span>`;
  if (role === 'probe') return `<span class="tag" style="background:rgba(148,163,184,0.18);color:#94a3b8">微探针</span>`;
  return `<span class="tag tag-ok">执行任务</span>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showStatus(msg, autoHideMs = 4000) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (autoHideMs > 0) setTimeout(() => el.classList.add('hidden'), autoHideMs);
}

function flashLiveBadge(text) {
  const b = document.getElementById('liveStreamBadge');
  if (!b) return;
  b.textContent = text;
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 1200);
}

async function callBackend(action, payload = {}) {
  if (!useHttpFallback && mcpApp) {
    const toolMap = {
      version: 'qtc_check_version',
      dashboard: 'qtc_get_dashboard',
      sync: 'qtc_sync_sources',
      rate: 'qtc_rate_session',
      simulate: 'qtc_simulate_policy',
      export: 'qtc_export_csv',
    };
    const res = await mcpApp.callServerTool({
      name: toolMap[action],
      arguments: payload,
    });
    return res?.structuredContent || {};
  }
  if (action === 'version') {
    const r = await fetch('/api/version');
    return await r.json();
  }
  if (action === 'dashboard') {
    const q = payload.platform ? `?platform=${encodeURIComponent(payload.platform)}` : '';
    const r = await fetch(`/api/dashboard${q}`);
    return await r.json();
  }
  const r = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await r.json();
}

function renderLivePulseStrip(data) {
  const strip = document.getElementById('livePulseStrip');
  const meta = data.realtime_meta || {};
  const actives = data.live_active_sessions || [];
  const watchedCnt = meta.watched_dirs ?? 5;
  const ver = meta.version || 1;
  const timeStr = meta.updated_at ? new Date(meta.updated_at).toLocaleTimeString() : '刚刚';

  const badge = document.getElementById('liveStreamBadge');
  if (badge && !badge.classList.contains('flash')) {
    badge.textContent = useHttpFallback
      ? `🟢 SSE 实时流已连接 · ${watchedCnt}源监听 · v${ver}`
      : `🟢 MCP 实时流同步中 · ${watchedCnt}源监听 · v${ver}`;
  }

  if (!actives.length) {
    strip.innerHTML = `
      <span class="pulse-dot"></span>
      <strong>内核级 fs.watch 秒级监听就绪 (${watchedCnt} 个 Agent 日志目录)</strong>
      <span style="color:#94a3b8">| 最近模型重算: ${timeStr} | 一旦任意 Agent 运行将自动秒级捕获、重训模型并更新对照表！</span>
    `;
    return;
  }

  strip.innerHTML = `
    <span class="pulse-dot"></span>
    <strong style="color:#34d399">正在实时捕获 ${actives.length} 个活跃会话：</strong>
    ${actives.map((s) => `
      <span class="live-sess-chip" title="${escapeHtml(s.title)}">
        ${platBadge(s.platform)}
        <code>${escapeHtml(s.session_uid.split(':')[1]?.slice(0, 8) || s.session_uid)}</code>
        <span><strong>${s.turns}</strong>轮</span>
        <span>Ctx ${s.ctx_k}k</span>
        <span style="color:#38bdf8">${s.cost_u}U</span>
        <span style="color:#34d399">${s.seconds_ago < 60 ? `${s.seconds_ago}s前` : `${Math.round(s.seconds_ago / 60)}m前`}</span>
      </span>
    `).join('')}
  `;
}

function renderOverview(data) {
  const k = data.kpis;
  document.getElementById('alertCountPill').textContent = String(k.sesame_alert_count || 0);

  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi">
      <div class="lbl">跨Agent总收录样本</div>
      <div class="val">${k.total_sessions}</div>
      <div class="sub">${k.root_projects} 个主会话 + ${k.subagent_sessions} 个子代理</div>
    </div>
    <div class="kpi">
      <div class="lbl">受控因果对照实验对</div>
      <div class="val" style="color:#38bdf8">${k.paired_experiment_count || 0} 组</div>
      <div class="sub">严格同任务前后阶段 / 同工程迭代</div>
    </div>
    <div class="kpi">
      <div class="lbl">累计吞吐总 Tokens</div>
      <div class="val">${k.total_tokens_M} M</div>
      <div class="sub">缓存重读占比 ${k.cost_shares_pct.cache_read}%</div>
    </div>
    <div class="kpi">
      <div class="lbl">累计加权总额度 C</div>
      <div class="val">${k.total_weighted_cost_u} U</div>
      <div class="sub">有效干活输出仅占 ${k.cost_shares_pct.output}%</div>
    </div>
    <div class="kpi">
      <div class="lbl">累计任务执行时长 T</div>
      <div class="val">${k.total_exec_hours} h</div>
      <div class="sub">动态 50% 生死线: <strong style="color:#fbbf24">${k.dynamic_n_crit_50} 轮</strong></div>
    </div>
    <div class="kpi">
      <div class="lbl">抓获耗用率爆炸/降质</div>
      <div class="val" style="color:#fb7185">${k.sesame_alert_count} 组</div>
      <div class="sub">对比基线超额多花 ≈ ${k.total_estimated_waste_u} U</div>
    </div>
  `;

  const cs = k.cost_shares_pct;
  document.getElementById('costStackBar').innerHTML = `
    <div class="stack-track">
      <div class="stack-seg" style="width:${cs.cache_read}%;background:#ef4444">缓存重读 ${cs.cache_read}%</div>
      <div class="stack-seg" style="width:${cs.fresh_input}%;background:#f59e0b">新塞输入 ${cs.fresh_input}%</div>
      <div class="stack-seg" style="width:${cs.output}%;background:#10b981">输出 ${cs.output}%</div>
    </div>
    <div class="stack-legend">
      <span>🔴 历史上下文重复读取税: ${cs.cache_read}%</span>
      <span>🟠 新输入(原图/长日志): ${cs.fresh_input}%</span>
      <span>🟢 真正干活输出: ${cs.output}%</span>
    </div>
  `;

  const ts = k.time_shares_pct;
  document.getElementById('timeStackBar').innerHTML = `
    <div class="stack-track">
      <div class="stack-seg" style="width:${ts.async_wait}%;background:#6366f1">后台等待 ${ts.async_wait}%</div>
      <div class="stack-seg" style="width:${ts.llm_think}%;background:#ec4899">LLM思考 ${ts.llm_think}%</div>
      <div class="stack-seg" style="width:${ts.sync_tool}%;background:#14b8a6">同步工具 ${ts.sync_tool}%</div>
    </div>
    <div class="stack-legend">
      <span>🟣 后台异步/GPU队列等待: ${ts.async_wait}%</span>
      <span>🩷 LLM流式思考与打字输出: ${ts.llm_think}%</span>
      <span>🩵 同步命令与文件读写: ${ts.sync_tool}%</span>
    </div>
  `;

  const tbody = document.querySelector('#platformTable tbody');
  tbody.innerHTML = (data.platform_summary || []).map((p) => `
    <tr>
      <td>${platBadge(p.platform)}</td>
      <td><strong>${p.total_sessions}</strong> (${p.root_sessions} 主 + ${p.sub_sessions} 子)</td>
      <td>${p.total_turns.toLocaleString()}</td>
      <td>${p.in_M} M</td>
      <td>${p.cache_M} M</td>
      <td>${p.out_M} M</td>
      <td><strong style="color:#34d399">${p.avg_q}</strong> 分</td>
      <td><code>${p.avg_burn_uh} U/h</code></td>
      <td>${p.exec_hours} h / <strong>${p.weighted_cost_u} U</strong></td>
    </tr>
  `).join('');
}

function renderEvolutionTable(data) {
  const tbody = document.querySelector('#evolutionTable tbody');
  if (!tbody) return;
  const rows = data.model_evolution || [];
  tbody.innerHTML = rows.map((r, idx) => `
    <tr style="${idx === 0 ? 'background:rgba(16,185,129,0.08)' : ''}">
      <td>${new Date(r.recorded_at).toLocaleString()} ${idx === 0 ? '<span class="tag tag-ok">最新生效</span>' : ''}</td>
      <td><strong>${r.sample_count}</strong></td>
      <td>${(r.total_turns || 0).toLocaleString()}</td>
      <td><code>${Number(r.power_slope).toFixed(4)}</code></td>
      <td><code>${Number(r.linear_slope).toFixed(4)}</code></td>
      <td><code>${Number(r.q_decay_slope).toFixed(4)}</code></td>
      <td><strong style="color:#fbbf24">${r.n_crit_50} 轮</strong></td>
      <td><span class="tag tag-ok">${r.logit_acc}%</span></td>
    </tr>
  `).join('');
}

function renderRegressionChart() {
  if (!currentData) return;
  const svg = document.getElementById('regSvg');
  const tooltip = document.getElementById('chartTooltip');
  const titleEl = document.getElementById('regTitle');
  const formulaEl = document.getElementById('regFormula');

  const W = 880, H = 410;
  const pad = { l: 68, r: 30, t: 28, b: 50 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  let regObj = { band: [] };
  let xLabel = '', yLabel = '', pts = [];

  if (currentRegMode === 'phase') {
    const ph = currentData.regressions.burn_vs_speed_phase || { points: [], theory_curves: [] };
    pts = ph.points || [];
    xLabel = '相对对照基线 B 的真实省时率 s_T (%)  [越往右越省时 →]';
    yLabel = '相对对照基线 B 的额度耗用率增幅 ΔC_dot (%)  [越往上越烧钱 ↑]';
    titleEl.textContent = `① 策略优化因果相图 (n = ${pts.length} 组受控对照)：省时率 s_T vs 小时额度耗用率增幅 ΔC_dot%`;
    formulaEl.textContent = `微分守恒定律: c_A/c_B = (1 + ΔC_dot%)·(1 - s_T%)  |  绿线下方=既快又省钱黄金区，红线上方=“时间没省多少、耗用率剧增”亏损区`;
  } else if (currentRegMode === 'power') {
    regObj = currentData.regressions.power_law_cost_vs_turns;
    pts = regObj.points || [];
    xLabel = '交互轮数自然对数 ln(N)';
    yLabel = '原始额度对数 ln(C_raw)';
    titleEl.textContent = `② 双对数幂律膨胀实时回归 (n = ${regObj.n} 个会话)：轮数每翻倍，成本增至 ${(2 ** regObj.slope).toFixed(2)}×`;
    formulaEl.textContent = `ln(C) = ${regObj.slope} · ln(N) ${regObj.intercept >= 0 ? '+' : ''} ${regObj.intercept}   |   R² = ${regObj.r2}   |   t = ${regObj.tStat}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'linear') {
    regObj = currentData.regressions.linear_throughput;
    pts = regObj.points || [];
    xLabel = '加权上下文总吞吐量 μ · N · L_mean (百万加权 Tokens)';
    yLabel = '实际加权额度消耗 C (Units)';
    titleEl.textContent = `③ 物理计费吞吐纯线性实时回归 (n = ${regObj.n} 个会话)`;
    formulaEl.textContent = `C = ${regObj.slope} · (μ·N·L) ${regObj.intercept >= 0 ? '+' : ''} ${regObj.intercept}   |   R² = ${regObj.r2}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'quality') {
    regObj = currentData.regressions.quality_vs_turns;
    pts = regObj.points || [];
    xLabel = '项目总交互轮数对数 ln(N_tree)';
    yLabel = '任务完成质量 Q_task (0~100)';
    titleEl.textContent = `④ 任务完成质量 Q_task vs 轮数回归 (n = ${regObj.n} 个实质执行项目，已剥离报错/压缩噪声)`;
    formulaEl.textContent = `Q_task = ${regObj.intercept} ${regObj.slope >= 0 ? '+' : ''} ${regObj.slope} · ln(N_tree)   |   r = ${regObj.r}   |   R² = ${regObj.r2}`;
  } else if (currentRegMode === 'latency') {
    regObj = currentData.regressions.turn_latency_vs_out;
    pts = regObj.points || [];
    const mb = regObj.mult_beta || [0, 0, 0];
    xLabel = '单步模型输出量 Out_k (千 Tokens)';
    yLabel = '单步 LLM 推理耗时 t_LLM (秒)';
    titleEl.textContent = `⑤ 微观单步延迟多元最小二乘实时回归 (n = ${regObj.n} 个推理步)`;
    formulaEl.textContent = `多元方程: t_LLM = ${mb[0]}s + ${mb[1]}s·Out_k + ${mb[2]}s·Ctx_100k  (多元R²=${regObj.mult_r2})`;
  } else {
    const sig = currentData.regressions.sigmoid_probability;
    pts = sig.points || [];
    const w = sig.weights || [0, 0, 0, 0];
    xLabel = '项目总交互轮数对数 ln(N_tree)  [刻度附真实轮数]';
    yLabel = '质量达标且耗用率健康概率 P_CE (%)';
    titleEl.textContent = `⑥ 在线 IRLS 逻辑斯蒂概率生死线 (分类准确率 = ${sig.accuracy}%)`;
    formulaEl.textContent = `logit(P_CE) = ${w[0]} ${w[1] >= 0 ? '+' : ''}${w[1]}·ln(N) ${w[2] >= 0 ? '+' : ''}${w[2]}·Ctx_100k ${w[3] >= 0 ? '+' : ''}${w[3]}·Comp  |  实时生死线 N_50% = ${sig.n_crit_50} 轮`;
  }

  if (!pts.length && currentRegMode !== 'phase') {
    svg.innerHTML = `<rect x="0" y="0" width="${W}" height="${H}" fill="#0b1120" rx="6"/><text x="440" y="205" text-anchor="middle" fill="#94a3b8">当前筛选条件下样本不足 3 条</text>`;
    return;
  }

  let minX, maxX, minY, maxY;
  if (currentRegMode === 'phase') {
    minX = -45; maxX = 70;
    minY = -55; maxY = Math.max(180, ...(pts.map((p) => p.y)), 160);
  } else {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    minX = Math.min(...xs); maxX = Math.max(...xs);
    minY = currentRegMode === 'sigmoid' ? -4 : Math.min(...ys);
    maxY = currentRegMode === 'sigmoid' ? 104 : Math.max(...ys);
    if (currentRegMode === 'sigmoid') {
      minX = Math.min(minX, Math.log(4));
      maxX = Math.max(maxX, Math.log(1200));
    }
    if (maxX - minX < 1e-3) { minX -= 1; maxX += 1; }
    if (maxY - minY < 1e-3) { minY -= 1; maxY += 1; }
    const dx = (maxX - minX) * 0.05;
    const dy = currentRegMode === 'sigmoid' ? 2 : (maxY - minY) * 0.08;
    minX -= dx; maxX += dx; minY -= dy; maxY += dy;
  }

  const sx = (v) => pad.l + ((v - minX) / (maxX - minX)) * plotW;
  const sy = (v) => pad.t + plotH - ((v - minY) / (maxY - minY)) * plotH;

  let out = `<defs><clipPath id="plotClip"><rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}"/></clipPath></defs>`;
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="#0b1120" rx="6"/>`;

  for (let i = 0; i <= 5; i++) {
    const xv = minX + (maxX - minX) * (i / 5);
    const px = sx(xv);
    const xTickText = currentRegMode === 'sigmoid'
      ? `${xv.toFixed(1)} (${Math.round(Math.exp(xv))}轮)`
      : currentRegMode === 'phase' ? `${xv >= 0 ? '+' : ''}${Math.round(xv)}%` : xv.toFixed(1);
    out += `<line x1="${px}" y1="${pad.t}" x2="${px}" y2="${pad.t + plotH}" stroke="#334155" stroke-dasharray="3 3" stroke-width="1"/>`;
    out += `<text x="${px}" y="${H - 24}" text-anchor="middle" fill="#94a3b8" font-size="11">${xTickText}</text>`;

    const yv = minY + (maxY - minY) * (i / 5);
    const py = sy(yv);
    const yTickText = currentRegMode === 'phase' ? `${yv >= 0 ? '+' : ''}${Math.round(yv)}%` : yv.toFixed(currentRegMode === 'sigmoid' ? 0 : 1);
    out += `<line x1="${pad.l}" y1="${py}" x2="${pad.l + plotW}" y2="${py}" stroke="#334155" stroke-dasharray="3 3" stroke-width="1"/>`;
    out += `<text x="${pad.l - 8}" y="${py + 4}" text-anchor="end" fill="#94a3b8" font-size="11">${yTickText}</text>`;
  }

  out += `<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="none" stroke="#475569" stroke-width="1.2"/>`;
  out += `<text x="${pad.l + plotW / 2}" y="${H - 5}" text-anchor="middle" fill="#cbd5e1" font-size="12" font-weight="600">${escapeHtml(xLabel)}</text>`;
  out += `<text x="16" y="${pad.t + plotH / 2}" text-anchor="middle" fill="#cbd5e1" font-size="12" font-weight="600" transform="rotate(-90 16 ${pad.t + plotH / 2})">${escapeHtml(yLabel)}</text>`;

  out += `<g clip-path="url(#plotClip)">`;

  if (currentRegMode === 'phase') {
    const tc = currentData.regressions.burn_vs_speed_phase?.theory_curves || [];
    const x0 = sx(0), y0 = sy(0);
    out += `<line x1="${x0}" y1="${pad.t}" x2="${x0}" y2="${pad.t + plotH}" stroke="#64748b" stroke-dasharray="4 4" stroke-width="1.2"/>`;
    out += `<line x1="${pad.l}" y1="${y0}" x2="${pad.l + plotW}" y2="${y0}" stroke="#64748b" stroke-dasharray="4 4" stroke-width="1.2"/>`;
    if (tc.length >= 2) {
      const neutralPoly = tc.map((c) => `${sx(c.s_pct).toFixed(1)},${sy(c.neutral_burn_pct).toFixed(1)}`).join(' ');
      const aerPoly = tc.map((c) => `${sx(c.s_pct).toFixed(1)},${sy(c.aer15_burn_pct).toFixed(1)}`).join(' ');
      out += `<polyline points="${neutralPoly}" fill="none" stroke="#10b981" stroke-width="2.6"/>`;
      out += `<polyline points="${aerPoly}" fill="none" stroke="#f43f5e" stroke-width="2.4" stroke-dasharray="7 4"/>`;
      out += `<text x="${pad.l + 12}" y="${pad.t + 22}" fill="#f43f5e" font-size="11.5" font-weight="700">- - 捡芝麻丢西瓜警戒边界 (AER = 1.5, 上方为耗用率失控亏损区)</text>`;
      out += `<text x="${pad.l + 12}" y="${pad.t + 40}" fill="#10b981" font-size="11.5" font-weight="700">── 等总成本零溢价边界 ΔC_dot = s_T/(1-s_T) (下方为省时且省总钱)</text>`;
    }
  }

  if (currentRegMode === 'sigmoid') {
    const sig = currentData.regressions.sigmoid_probability;
    const y50 = sy(50);
    out += `<line x1="${pad.l}" y1="${y50}" x2="${pad.l + plotW}" y2="${y50}" stroke="#94a3b8" stroke-dasharray="4 4" stroke-width="1.2"/>`;
    const xCrit = sx(Math.log(Math.max(2, sig.n_crit_50 || 45)));
    out += `<line x1="${xCrit}" y1="${pad.t}" x2="${xCrit}" y2="${pad.t + plotH}" stroke="#fbbf24" stroke-width="2.4" stroke-dasharray="7 3"/>`;
    out += `<text x="${xCrit + 6}" y="${pad.t + 20}" fill="#fbbf24" font-size="11.5" font-weight="700">实时生死线 N_50% = ${sig.n_crit_50} 轮</text>`;
    if (sig.curve?.length >= 2) {
      const cleanPoly = sig.curve.map((c) => `${sx(c.lnN).toFixed(1)},${sy(c.p_clean).toFixed(1)}`).join(' ');
      const compPoly = sig.curve.map((c) => `${sx(c.lnN).toFixed(1)},${sy(c.p_comp).toFixed(1)}`).join(' ');
      out += `<polyline points="${cleanPoly}" fill="none" stroke="#10b981" stroke-width="3"/>`;
      out += `<polyline points="${compPoly}" fill="none" stroke="#f43f5e" stroke-width="2.4" stroke-dasharray="6 4"/>`;
    }
  }

  if (regObj.band && regObj.band.length >= 2) {
    const upper = regObj.band.map((b) => `${sx(b.x).toFixed(1)},${sy(b.hi).toFixed(1)}`).join(' ');
    const lower = [...regObj.band].reverse().map((b) => `${sx(b.x).toFixed(1)},${sy(b.lo).toFixed(1)}`).join(' ');
    out += `<polygon points="${upper} ${lower}" fill="rgba(244, 63, 94, 0.18)" />`;
    const b0 = regObj.band[0];
    const bLast = regObj.band[regObj.band.length - 1];
    out += `<line x1="${sx(b0.x)}" y1="${sy(b0.y)}" x2="${sx(bLast.x)}" y2="${sy(bLast.y)}" stroke="#f43f5e" stroke-width="2.6"/>`;
  }

  if (currentRegMode === 'power' && regObj.band?.length) {
    const b0 = regObj.band[0];
    const bLast = regObj.band[regObj.band.length - 1];
    const yEndSlope1 = b0.y + 1.0 * (bLast.x - b0.x);
    out += `<line x1="${sx(b0.x)}" y1="${sy(b0.y)}" x2="${sx(bLast.x)}" y2="${sy(yEndSlope1)}" stroke="#10b981" stroke-dasharray="6 4" stroke-width="1.8"/>`;
  }

  pts.forEach((pt, idx) => {
    const cx = sx(pt.x);
    const cy = sy(pt.y);
    let fill = PLATFORM_COLORS[pt.platform] || '#38bdf8';
    let r = pt.is_sub ? 3.8 : 5.5;
    if (currentRegMode === 'latency') r = 4.2;
    if (currentRegMode === 'phase') {
      fill = pt.bad ? '#ef4444' : '#10b981';
      r = 7.2;
    } else if ((currentRegMode === 'quality' || currentRegMode === 'sigmoid') && pt.comp > 0) {
      fill = '#ef4444';
      r = 6.0;
    }
    out += `<circle class="pt-dot" data-idx="${idx}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}" fill-opacity="0.86" stroke="#0f172a" stroke-width="1.2"/>`;
  });

  out += `</g>`;
  svg.innerHTML = out;

  svg.querySelectorAll('.pt-dot').forEach((circle) => {
    circle.addEventListener('mouseenter', (ev) => {
      const idx = Number(circle.getAttribute('data-idx'));
      const pt = pts[idx];
      if (currentRegMode === 'phase') {
        tooltip.innerHTML = `
          <div><strong>${escapeHtml(pt.verdict)}</strong></div>
          <div style="color:#94a3b8;margin:2px 0">${escapeHtml(pt.title)}</div>
          <div>质量变化 ΔQ: <strong>${pt.dq >= 0 ? '+' : ''}${pt.dq} 分</strong></div>
          <div>省时率: <strong>${pt.x}%</strong> | 耗用率变化: <strong style="color:#fb7185">${pt.y >= 0 ? '+' : ''}${pt.y}%</strong> | 单位成本: <strong>${pt.cost_pct >= 0 ? '+' : ''}${pt.cost_pct}%</strong></div>
        `;
      } else {
        tooltip.innerHTML = `
          <div><strong>${escapeHtml(pt.platform)}</strong> · ${escapeHtml(String(pt.uid).slice(0, 18))}</div>
          <div style="color:#94a3b8;margin:2px 0">${escapeHtml(pt.title || '')}</div>
          <div>坐标: (${pt.x}, ${pt.y})</div>
        `;
      }
      tooltip.classList.remove('hidden');
      const rect = svg.parentElement.getBoundingClientRect();
      tooltip.style.left = `${Math.min(rect.width - 290, Math.max(10, ev.clientX - rect.left + 12))}px`;
      tooltip.style.top = `${Math.max(10, ev.clientY - rect.top - 20)}px`;
    });
    circle.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });
}

function exportCurrentChart(format = 'png') {
  const svgEl = document.getElementById('regSvg');
  if (!svgEl) return;
  const serializer = new XMLSerializer();
  let svgStr = serializer.serializeToString(svgEl);
  if (!svgStr.includes('xmlns=')) svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (format === 'svg') {
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `qtc_v12_${currentRegMode}_${stamp}.svg`;
    a.click();
    return;
  }
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1760; canvas.height = 820;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `qtc_v12_${currentRegMode}_${stamp}.png`;
    a.click();
  };
  img.src = url;
}

/**
 * 构建自由 A vs B 对照选择池（既包含所有同会话阶段切片，也包含所有独立执行会话）
 */
function buildCustomComparatorPool(data) {
  selectableUnits = [];
  for (const cp of (data.counterfactual_pairs || [])) {
    if (cp.pair_id.startsWith('intra:')) {
      selectableUnits.push({
        key: `${cp.pair_id}#B`,
        name: `[阶段基线B] ${cp.base.uid.slice(0, 12)} · ${cp.base.label.replace('【基线 B】', '')} | ${cp.title.slice(0, 22)}`,
        T_min: cp.base.T_min,
        C_u: cp.base.C_u,
        burn_uh: cp.base.burn_uh,
        Q_task: cp.base.Q_task,
      });
      selectableUnits.push({
        key: `${cp.pair_id}#A`,
        name: `[阶段实验A] ${cp.target.uid.slice(0, 12)} · ${cp.target.label.replace('【实验 A】', '')} | ${cp.title.slice(0, 22)}`,
        T_min: cp.target.T_min,
        C_u: cp.target.C_u,
        burn_uh: cp.target.burn_uh,
        Q_task: cp.target.Q_task,
      });
    }
  }
  for (const p of (data.projects || [])) {
    if (p.session_role === 'probe') continue;
    selectableUnits.push({
      key: `sess:${p.session_uid}`,
      name: `[完整会话] ${p.platform}:${p.session_uid.split(':')[1]?.slice(0, 8) || p.session_uid} (${p.tree_turns}轮, ${p.C_units}U, Q=${p.Q_final}) | ${p.title.slice(0, 24)}`,
      T_min: p.T_min,
      C_u: p.C_units,
      burn_uh: p.burn_uh,
      Q_task: p.Q_final,
    });
  }

  const selB = document.getElementById('cmpBaseSelect');
  const selA = document.getElementById('cmpTargetSelect');
  if (!selB || !selA) return;
  const prevB = selB.value;
  const prevA = selA.value;

  const optsHtml = selectableUnits.map((u, i) => `<option value="${i}">${escapeHtml(u.name)}</option>`).join('');
  selB.innerHTML = optsHtml;
  selA.innerHTML = optsHtml;

  if (selectableUnits.length >= 2) {
    selB.value = prevB && selectableUnits[Number(prevB)] ? prevB : '0';
    selA.value = prevA && selectableUnits[Number(prevA)] ? prevA : '1';
  }
  recomputeCustomPair();
}

function recomputeCustomPair() {
  const resEl = document.getElementById('cmpCustomResult');
  if (!resEl || selectableUnits.length < 2) return;
  const b = selectableUnits[Number(document.getElementById('cmpBaseSelect').value) || 0];
  const a = selectableUnits[Number(document.getElementById('cmpTargetSelect').value) || 1];
  const scaleRatio = Math.max(0.05, Number(document.getElementById('cmpScaleInput').value) || 1.0);
  if (!b || !a) return;

  const unitTimeB = b.T_min;
  const unitTimeA = a.T_min / scaleRatio;
  const unitCostB = b.C_u;
  const unitCostA = a.C_u / scaleRatio;

  const sPct = ((unitTimeB - unitTimeA) / Math.max(0.05, unitTimeB)) * 100.0;
  const burnPct = ((a.burn_uh - b.burn_uh) / Math.max(0.05, b.burn_uh)) * 100.0;
  const costPct = ((unitCostA - unitCostB) / Math.max(0.01, unitCostB)) * 100.0;
  const dq = a.Q_task - b.Q_task;
  const sFrac = Math.min(0.88, Math.max(-2.0, sPct / 100.0));
  const neutralBurn = sFrac > 0 ? (sFrac / (1.0 - sFrac)) * 100.0 : 0.0;

  let tag = '🟢 正向合算改进';
  if (dq <= -8 || a.Q_task < 65) tag = '🔴 质量失守翻车 (任务完成质量下降)';
  else if (costPct > 25 && sPct <= 0) tag = '🔴 双输恶化 (未省时且更烧钱)';
  else if (costPct > 25 && sPct > 0 && (costPct / Math.max(1, sPct)) > 1.5) tag = '🟠 捡芝麻丢西瓜 (时间没省多少，耗用率剧增！)';

  resEl.innerHTML = `
    <div>
      <strong>任务完成质量对比:</strong> ${b.Q_task} → <strong>${a.Q_task} 分</strong> (<span style="color:${dq >= -2 ? '#34d399' : '#fb7185'}">ΔQ = ${dq >= 0 ? '+' : ''}${dq.toFixed(1)}</span>) &nbsp;|&nbsp;
      <strong>等量速度对比:</strong> ${unitTimeB.toFixed(1)}m → ${unitTimeA.toFixed(1)}m (省时 <strong>${sPct.toFixed(1)}%</strong>) &nbsp;|&nbsp;
      <strong>额度耗用率对比:</strong> ${b.burn_uh} → <strong style="color:#38bdf8">${a.burn_uh} U/h</strong> (<strong style="color:${burnPct > neutralBurn + 20 ? '#fb7185' : '#34d399'}">${burnPct >= 0 ? '+' : ''}${burnPct.toFixed(1)}%</strong>，零溢价上限 +${neutralBurn.toFixed(1)}%) &nbsp;|&nbsp;
      <strong>单位产出总成本:</strong> <strong style="color:${costPct > 20 ? '#fb7185' : '#34d399'}">${costPct >= 0 ? '+' : ''}${costPct.toFixed(1)}%</strong>
    </div>
    <div style="font-weight:700">${tag}</div>
  `;
}

function renderCounterfactualTable(data) {
  const tbody = document.querySelector('#sesameTable tbody');
  const catFilter = document.getElementById('pairCategoryFilter')?.value || 'all';
  const allPairs = data.counterfactual_pairs || [];
  const list = catFilter === 'all' ? allPairs : allPairs.filter((x) => x.pair_category === catFilter);

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:18px">当前筛选条件下暂无符合条件的受控因果对照对（可在上方自由验算器中任意指定两个会话比对）。</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((cp) => {
    const d = cp.deltas;
    const isBloat = cp.pair_category === 'bloat_drift';
    const qColor = d.delta_Q >= -2 ? '#34d399' : '#fb7185';
    const qTag = d.delta_Q >= 0.5 ? '质量提升' : d.delta_Q >= -2.5 ? '质量保持' : '质量下降!';
    const speedUnitNote = isBloat ? '单轮均速对比' : '阶段耗时对比';

    return `
      <tr>
        <td>
          <div>${platBadge(cp.platform)} <strong style="color:#38bdf8">${escapeHtml(cp.comparison_scope)}</strong></div>
          <div style="margin:3px 0;font-weight:600">${escapeHtml(cp.title.slice(0, 48))}</div>
          <div style="font-size:11px;color:#94a3b8">
            <div>▪ ${escapeHtml(cp.base.label)} (${cp.base.turns}轮${cp.base.sub_count ? `+${cp.base.sub_count}子` : ''})</div>
            <div>▪ ${escapeHtml(cp.target.label)} (${cp.target.turns}轮${cp.target.sub_count ? `+${cp.target.sub_count}子` : ''})</div>
            ${cp.trigger_note ? `<div style="color:#cbd5e1;margin-top:2px">↳ 切换点: ${escapeHtml(cp.trigger_note.slice(0, 56))}</div>` : ''}
          </div>
        </td>
        <td>
          <div><strong>${cp.base.Q_task}</strong> → <strong>${cp.target.Q_task} 分</strong></div>
          <div style="color:${qColor};font-weight:700">ΔQ = ${d.delta_Q >= 0 ? '+' : ''}${d.delta_Q} (${qTag})</div>
        </td>
        <td>
          <div style="font-size:11px;color:#94a3b8">${speedUnitNote}</div>
          <div>${cp.base.T_min}m → ${cp.target.T_min}m</div>
          <div>省时率: <strong style="color:${d.time_saved_pct > 0 ? '#34d399' : '#fb7185'}">${d.time_saved_pct >= 0 ? '+' : ''}${d.time_saved_pct}%</strong></div>
        </td>
        <td>
          <div>耗用率: <code>${cp.base.burn_uh}</code> → <strong style="color:#38bdf8">${cp.target.burn_uh} U/h</strong> (<strong style="color:${d.burn_surge_pct > d.neutral_burn_limit_pct + 20 ? '#fb7185' : '#34d399'}">${d.burn_surge_pct >= 0 ? '+' : ''}${d.burn_surge_pct}%</strong>)</div>
          <div style="font-size:11px;color:#94a3b8">零溢价容忍上限: +${d.neutral_burn_limit_pct}%</div>
          <div>总额: ${cp.base.C_u}U → <strong>${cp.target.C_u}U</strong> (单位成本 <strong>${d.cost_surge_pct >= 0 ? '+' : ''}${d.cost_surge_pct}%</strong>)</div>
        </td>
        <td>
          <div><span class="tag ${cp.is_bad_tradeoff ? 'tag-bad' : 'tag-ok'}">${escapeHtml(cp.verdict_label)}</span></div>
          <div style="margin-top:4px">超额多花: <strong style="color:#f59e0b">${d.excess_cost_u} U</strong></div>
          <div style="font-size:11px;color:#94a3b8">合算概率 P_CE = ${d.prob_ce_pct}%</div>
        </td>
        <td>${(cp.reasons || []).map((r) => `• ${escapeHtml(r)}`).join('<br/>')}</td>
      </tr>
    `;
  }).join('');
}

function renderPrescriptions(data) {
  const pr = data.prescriptions;
  const ec = pr.empirical_constants;
  const bf = ec.burn_formula_beta || [0, 0, 0, 0];
  document.getElementById('constStrip').innerHTML = `
    <span><strong>在线重训物理常数 (n=${pr.sample_basis_count})：</strong></span>
    <span>轮数膨胀 β = <strong>${ec.turn_cost_exponent}</strong> (翻倍成本 ×${ec.double_turns_cost_mult})</span>
    <span>耗用功率方程: <code>C_dot(U/h) = ${bf[0]} + ${bf[1]}·μ + ${bf[2]}·Ctx_100k + ${bf[3]}·Sub/h</code></span>
    <span>动态50%生死线 = <strong style="color:#fbbf24">${ec.dynamic_n_crit_50} 轮</strong></span>
  `;

  const mA = pr.mode_extreme_cost_effectiveness;
  document.getElementById('modeCeBox').innerHTML = `
    <h3>🎯 ${escapeHtml(mA.title)}</h3>
    <div class="rule-highlight">${escapeHtml(mA.core_math_rule)}</div>
    <p><strong>动态推算硬阈值：</strong>单窗口建议上限 <code>≤ ${mA.recommended_max_turns_per_session} 轮</code> | 上下文红线 <code>≤ ${mA.recommended_context_ceiling_k}k</code> | 单轮并发工具 <code>≥ ${mA.min_parallel_tools_per_turn} 个</code></p>
    <ul class="rule-list">
      ${[...mA.model_routing_strategy, ...mA.execution_tactics].map((x) => `<li>${escapeHtml(x)}</li>`).join('')}
    </ul>
  `;

  const mB = pr.mode_extreme_output_quality;
  document.getElementById('modeQualBox').innerHTML = `
    <h3>🏆 ${escapeHtml(mB.title)}</h3>
    <div class="rule-highlight" style="border-left-color:#38bdf8;background:rgba(56,189,248,0.1)">${escapeHtml(mB.core_math_rule)}</div>
    <p><strong>动态推算硬阈值：</strong>分模块清零周期 <code>${mB.recommended_stage_turns} 轮/模块</code> | <code>${escapeHtml(mB.zero_compaction_mandate)}</code></p>
    <ul class="rule-list">
      ${[...mB.model_routing_strategy, ...mB.execution_tactics].map((x) => `<li>${escapeHtml(x)}</li>`).join('')}
    </ul>
  `;
}

function renderSamplesTable(data, keyword = '') {
  const kw = keyword.trim().toLowerCase();
  const rows = (data.projects || []).filter((p) => {
    if (!kw) return true;
    return `${p.session_uid} ${p.platform} ${p.title} ${p.primary_model} ${p.domain} ${p.project_key}`.toLowerCase().includes(kw);
  });

  const tbody = document.querySelector('#projectsTable tbody');
  tbody.innerHTML = rows.slice(0, 120).map((p) => `
    <tr>
      <td>${platBadge(p.platform)} ${roleBadge(p.session_role)}<br/><small>${escapeHtml(p.session_uid.split(':')[1]?.slice(0, 10) || p.session_uid)}</small></td>
      <td title="${escapeHtml(p.title)}">
        <div><strong>[${escapeHtml(p.domain.slice(0, 4))}]</strong> ${escapeHtml(p.title.slice(0, 44))}</div>
        ${p.project_key ? `<small style="color:#38bdf8">📁 ${escapeHtml(p.project_key)}</small>` : ''}
      </td>
      <td><small>${escapeHtml(p.primary_model.slice(0, 22))}</small></td>
      <td>${p.root_turns}${p.sub_turns ? ` + ${p.sub_turns} (${p.sub_count}子)` : ''}</td>
      <td>${p.T_min}m</td>
      <td><strong>${p.C_units}U</strong></td>
      <td><code>${p.burn_uh} U/h</code></td>
      <td>
        <input type="number" class="q-input" min="0" max="100" value="${p.Q_final}" data-uid="${escapeHtml(p.session_uid)}" />
        <button class="btn sm btn-save-q" data-uid="${escapeHtml(p.session_uid)}">保存校准</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-save-q').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-uid');
      const inp = tbody.querySelector(`.q-input[data-uid="${CSS.escape(uid)}"]`);
      const val = Number(inp.value);
      const plat = document.getElementById('platformFilter').value;
      const updated = await callBackend('rate', { session_uid: uid, q_human: val, platform: plat });
      if (updated && updated.kpis) {
        renderAll(updated);
        updateSimulator();
        showStatus(`已校准会话 ${uid} 的真实任务完成质量 (${val} 分)，全库对照差分与回归模型已同步更新！`);
      }
    });
  });
}

async function updateSimulator() {
  const turns = Number(document.getElementById('simTurns').value);
  const modelMult = Number(document.getElementById('simModel').value);
  const tools = Number(document.getElementById('simTools').value);
  const ctx = Number(document.getElementById('simCtx').value);
  const subs = Number(document.getElementById('simSubs').value);
  const [subMultStr, dupStr] = document.getElementById('simSubMode').value.split('|');

  document.getElementById('lblSimTurns').textContent = `${turns} 轮`;
  document.getElementById('lblSimModel').textContent = `${modelMult}x`;
  document.getElementById('lblSimTools').textContent = `${tools}`;
  document.getElementById('lblSimCtx').textContent = `${ctx}k`;
  document.getElementById('lblSimSubs').textContent = `${subs} 个`;

  const res = await callBackend('simulate', {
    turns,
    model_mult: modelMult,
    tools_per_turn: tools,
    avg_ctx_k: ctx,
    sub_count: subs,
    sub_mult: Number(subMultStr),
    sub_dup_read: dupStr === '1',
  });

  document.getElementById('simResultBar').innerHTML = `
    <div>
      <strong>预估完成质量 Q_task:</strong> ${res.pred_Q} 分 (ΔQ=${res.delta_Q >= 0 ? '+' : ''}${res.delta_Q}) &nbsp;|&nbsp;
      <strong>预估耗时:</strong> ${res.pred_T_min}m (省时 <strong>${res.time_saved_pct}%</strong>) &nbsp;|&nbsp;
      <strong>额度耗用率:</strong> ${res.base_burn_uh} → <strong style="color:#38bdf8">${res.pred_burn_uh} U/h</strong> (${res.burn_surge_pct >= 0 ? '+' : ''}${res.burn_surge_pct}%) &nbsp;|&nbsp;
      <strong>总成本:</strong> ${res.pred_C_units} U (${res.cost_surge_pct >= 0 ? '+' : ''}${res.cost_surge_pct}%) &nbsp;|&nbsp;
      <strong>合算概率:</strong> <strong style="color:#38bdf8">${res.prob_ce_pct}%</strong>
    </div>
    <div style="font-weight:700">${escapeHtml(res.verdict)}</div>
  `;
}

function renderAll(data) {
  if (!data || !data.kpis) return;
  currentData = data;
  if (data.realtime_meta?.version) currentDataVersion = data.realtime_meta.version;
  renderLivePulseStrip(data);
  renderOverview(data);
  renderRegressionChart();
  renderEvolutionTable(data);
  buildCustomComparatorPool(data);
  renderCounterfactualTable(data);
  renderPrescriptions(data);
  renderSamplesTable(data, document.getElementById('searchBox').value);
}

function startRealtimeStreams() {
  if (useHttpFallback) {
    if (sseConnection) sseConnection.close();
    sseConnection = new EventSource('/api/events');
    sseConnection.addEventListener('update', async (ev) => {
      try {
        const msg = JSON.parse(ev.data || '{}');
        if (msg.version && msg.version > currentDataVersion) {
          const plat = document.getElementById('platformFilter').value;
          const fresh = await callBackend('dashboard', { platform: plat });
          renderAll(fresh);
          updateSimulator();
          flashLiveBadge(`⚡ 实时捕获新步进 · 模型与图表已自修正 (v${msg.version})`);
        }
      } catch {}
    });
  } else if (mcpApp) {
    if (appPollTimer) clearInterval(appPollTimer);
    appPollTimer = setInterval(async () => {
      try {
        if (document.activeElement && (document.activeElement.classList.contains('q-input') || document.activeElement.tagName === 'SELECT')) return;
        const vInfo = await callBackend('version', {});
        if (vInfo?.version && vInfo.version > currentDataVersion) {
          const plat = document.getElementById('platformFilter').value;
          const fresh = await callBackend('dashboard', { platform: plat });
          renderAll(fresh);
          updateSimulator();
          flashLiveBadge(`⚡ 实时捕获新步进 · 模型与图表已自修正 (v${vInfo.version})`);
        }
      } catch {}
    }, 2500);
  }
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'regression') renderRegressionChart();
    });
  });

  document.querySelectorAll('.reg-selector .btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.reg-selector .btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentRegMode = btn.dataset.reg;
      renderRegressionChart();
    });
  });

  document.getElementById('btnExportChartPng').addEventListener('click', () => exportCurrentChart('png'));
  document.getElementById('btnExportChartSvg').addEventListener('click', () => exportCurrentChart('svg'));

  document.getElementById('platformFilter').addEventListener('change', async (e) => {
    const d = await callBackend('dashboard', { platform: e.target.value });
    renderAll(d);
  });

  document.getElementById('pairCategoryFilter').addEventListener('change', () => {
    if (currentData) renderCounterfactualTable(currentData);
  });

  ['cmpBaseSelect', 'cmpTargetSelect', 'cmpScaleInput'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => recomputeCustomPair());
    document.getElementById(id).addEventListener('input', () => recomputeCustomPair());
  });

  document.getElementById('btnSync').addEventListener('click', async () => {
    showStatus('正在扫描全机 AI Agent 最新会话并在线重算因果对照与数学模型...', 0);
    const plat = document.getElementById('platformFilter').value;
    const d = await callBackend('sync', { force: false, platform: plat });
    renderAll(d);
    updateSimulator();
    const si = d.sync_info || {};
    showStatus(`同步完成！扫描 ${si.scanned_files || 0} 个文件，更新 ${si.updated_sessions || 0} 条样本 (${si.elapsed_ms || 0}ms)`);
  });

  document.getElementById('btnExport').addEventListener('click', async () => {
    const r = await callBackend('export', {});
    showStatus(`已导出全量科研样本集 CSV: ${r.csv_path} (共 ${r.row_count} 行)`);
  });

  document.getElementById('searchBox').addEventListener('input', (e) => {
    if (currentData) renderSamplesTable(currentData, e.target.value);
  });

  ['simTurns', 'simModel', 'simTools', 'simCtx', 'simSubs', 'simSubMode'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => updateSimulator());
    document.getElementById(id).addEventListener('change', () => updateSimulator());
  });
}

async function boot() {
  bindEvents();
  const isStandaloneHttp = window.location.protocol.startsWith('http') && window.parent === window;
  if (isStandaloneHttp) {
    useHttpFallback = true;
    const d = await callBackend('dashboard', { platform: 'all' });
    renderAll(d);
    updateSimulator();
    startRealtimeStreams();
    return;
  }

  try {
    mcpApp = new App({ name: 'QTC Observatory', version: '1.2.0' }, {});
    mcpApp.ontoolresult = (result) => {
      if (result?.structuredContent?.kpis) renderAll(result.structuredContent);
    };
    mcpApp.onhostcontextchanged = (ctx) => {
      if (ctx?.theme) applyDocumentTheme(ctx.theme);
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    };
    await mcpApp.connect();
    const ctx = mcpApp.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

    const initData = await callBackend('dashboard', { platform: 'all' });
    renderAll(initData);
    updateSimulator();
    startRealtimeStreams();
  } catch {
    useHttpFallback = true;
    const d = await callBackend('dashboard', { platform: 'all' });
    renderAll(d);
    updateSimulator();
    startRealtimeStreams();
  }
}

boot();
