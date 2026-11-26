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
let selectableUnits = [];

const PLATFORM_COLORS = {
  antigravity: '#38bdf8',
  dsh: '#c084fc',
  'claude-code': '#fbbf24',
  codex: '#34d399',
  custom: '#f472b6',
};

const PLATFORM_LABELS = {
  antigravity: 'Antigravity',
  dsh: 'DSH',
  'claude-code': 'Claude',
  codex: 'Codex',
  custom: 'Custom',
};

function shortUid(uid = '') {
  const raw = String(uid).includes(':') ? String(uid).split(':')[1] : String(uid);
  return raw.replace(/^session-/, '').slice(0, 8);
}

function fullRawId(uid = '') {
  return String(uid).includes(':') ? String(uid).split(':')[1] : String(uid);
}

function platPill(p) {
  const cls = p === 'antigravity' ? 'pill-agy' : p === 'dsh' ? 'pill-dsh' : p === 'claude-code' ? 'pill-claude' : 'pill-codex';
  return `<span class="pill ${cls}">${escapeHtml(PLATFORM_LABELS[p] || p)}</span>`;
}

function rolePill(role) {
  if (role === 'advisor') return `<span class="pill pill-neutral">优化顾问</span>`;
  if (role === 'probe') return `<span class="pill pill-neutral">微探针</span>`;
  return `<span class="pill pill-good">执行任务</span>`;
}

function idChipHtml(uid = '') {
  const full = fullRawId(uid);
  const sh = shortUid(uid);
  return `<span class="id-chip" data-copy-id="${escapeHtml(full)}" title="点击复制完整对话 ID: ${escapeHtml(full)}">#${escapeHtml(sh)}</span>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showStatus(msg, autoHideMs = 3600) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (autoHideMs > 0) setTimeout(() => el.classList.add('hidden'), autoHideMs);
}

function flashLiveBadge(text) {
  const wrap = document.getElementById('liveStreamBadge');
  const txt = document.getElementById('liveStatusText');
  if (!wrap || !txt) return;
  txt.textContent = text;
  wrap.classList.add('flash');
  setTimeout(() => wrap.classList.remove('flash'), 1300);
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
  const watchedCnt = meta.watched_dirs ?? 6;
  const ver = meta.version || 1;

  const statusTxt = document.getElementById('liveStatusText');
  const statusWrap = document.getElementById('liveStreamBadge');
  if (statusTxt && statusWrap && !statusWrap.classList.contains('flash')) {
    statusTxt.textContent = `实时监听就绪 (${watchedCnt}源 · v${ver} · 改名秒级同步)`;
  }

  if (!actives.length) {
    strip.innerHTML = `
      <span class="rail-label">近期活跃对话</span>
      <span style="color:var(--fg-muted);font-size:12px">过去 15 分钟暂无正在步进的对话 · 任意 Agent 运行或修改对话名称后将在此秒级浮现</span>
    `;
    return;
  }

  strip.innerHTML = `
    <span class="rail-label">正在活跃 (${actives.length})</span>
    ${actives.map((s) => `
      <div class="live-card" title="${escapeHtml(s.display_name)}&#10;首句摘要: ${escapeHtml(s.title)}">
        ${platPill(s.platform)}
        <span class="conv-name">${escapeHtml(s.display_name)}</span>
        ${idChipHtml(s.session_uid)}
        <span class="live-metrics">${s.turns}轮 · ${s.ctx_k}k · <strong class="text-accent">${s.cost_u}U</strong> · <span class="text-good">${s.seconds_ago < 60 ? `${s.seconds_ago}s前` : `${Math.round(s.seconds_ago / 60)}m前`}</span></span>
      </div>
    `).join('')}
  `;
}

function renderOverview(data) {
  const k = data.kpis;
  document.getElementById('alertCountPill').textContent = String(k.sesame_alert_count || 0);

  document.getElementById('kpiGrid').innerHTML = `
    <div class="metric-cell">
      <div class="m-label">收录总对话样本</div>
      <div class="m-value">${k.total_sessions}</div>
      <div class="m-sub">${k.root_projects} 个主对话 · ${k.subagent_sessions} 个子代理</div>
    </div>
    <div class="metric-cell">
      <div class="m-label">受控因果对照实验</div>
      <div class="m-value text-accent">${k.paired_experiment_count || 0} 组</div>
      <div class="m-sub">同任务阶段对照 / 同工程迭代</div>
    </div>
    <div class="metric-cell">
      <div class="m-label">累计吞吐 Tokens</div>
      <div class="m-value">${k.total_tokens_M} M</div>
      <div class="m-sub">历史缓存重读占 ${k.cost_shares_pct.cache_read}%</div>
    </div>
    <div class="metric-cell">
      <div class="m-label">累计加权总额度</div>
      <div class="m-value">${k.total_weighted_cost_u} U</div>
      <div class="m-sub">有效内容输出占 ${k.cost_shares_pct.output}%</div>
    </div>
    <div class="metric-cell">
      <div class="m-label">累计执行总时长</div>
      <div class="m-value">${k.total_exec_hours} h</div>
      <div class="m-sub">50% 性价比生死线: <strong class="text-warn">${k.dynamic_n_crit_50} 轮</strong></div>
    </div>
    <div class="metric-cell">
      <div class="m-label">耗用率失控 / 降质</div>
      <div class="m-value text-bad">${k.sesame_alert_count} 组</div>
      <div class="m-sub">相对基线超额多花 ≈ ${k.total_estimated_waste_u} U</div>
    </div>
  `;

  const cs = k.cost_shares_pct;
  document.getElementById('costStackBar').innerHTML = `
    <div class="prop-track">
      <div class="prop-seg" style="width:${cs.cache_read}%;background:#f43f5e"></div>
      <div class="prop-seg" style="width:${cs.fresh_input}%;background:#f59e0b"></div>
      <div class="prop-seg" style="width:${cs.output}%;background:#10b981"></div>
    </div>
    <div class="prop-legend">
      <div class="prop-item">
        <div class="p-head"><span class="p-dot" style="background:#f43f5e"></span>缓存重读税</div>
        <div class="p-val">${cs.cache_read}%</div>
      </div>
      <div class="prop-item">
        <div class="p-head"><span class="p-dot" style="background:#f59e0b"></span>新增输入</div>
        <div class="p-val">${cs.fresh_input}%</div>
      </div>
      <div class="prop-item">
        <div class="p-head"><span class="p-dot" style="background:#10b981"></span>有效输出</div>
        <div class="p-val">${cs.output}%</div>
      </div>
    </div>
  `;

  const ts = k.time_shares_pct;
  document.getElementById('timeStackBar').innerHTML = `
    <div class="prop-track">
      <div class="prop-seg" style="width:${ts.async_wait}%;background:#8b5cf6"></div>
      <div class="prop-seg" style="width:${ts.llm_think}%;background:#38bdf8"></div>
      <div class="prop-seg" style="width:${ts.sync_tool}%;background:#10b981"></div>
    </div>
    <div class="prop-legend">
      <div class="prop-item">
        <div class="p-head"><span class="p-dot" style="background:#8b5cf6"></span>后台异步等待</div>
        <div class="p-val">${ts.async_wait}%</div>
      </div>
      <div class="prop-item">
        <div class="p-head"><span class="p-dot" style="background:#38bdf8"></span>模型流式思考</div>
        <div class="p-val">${ts.llm_think}%</div>
      </div>
      <div class="prop-item">
        <div class="p-head"><span class="p-dot" style="background:#10b981"></span>同步工具执行</div>
        <div class="p-val">${ts.sync_tool}%</div>
      </div>
    </div>
  `;

  const tbody = document.querySelector('#platformTable tbody');
  tbody.innerHTML = (data.platform_summary || []).map((p) => `
    <tr>
      <td>${platPill(p.platform)}</td>
      <td class="num"><strong>${p.total_sessions}</strong> <span style="color:var(--fg-muted)">(${p.root_sessions}主+${p.sub_sessions}子)</span></td>
      <td class="num">${p.total_turns.toLocaleString()}</td>
      <td class="num">${p.in_M} M</td>
      <td class="num">${p.cache_M} M</td>
      <td class="num">${p.out_M} M</td>
      <td class="num"><strong class="text-good">${p.avg_q}</strong> 分</td>
      <td class="num"><code>${p.avg_burn_uh} U/h</code></td>
      <td class="num">${p.exec_hours} h / <strong>${p.weighted_cost_u} U</strong></td>
    </tr>
  `).join('');
}

function renderEvolutionTable(data) {
  const tbody = document.querySelector('#evolutionTable tbody');
  if (!tbody) return;
  const rows = data.model_evolution || [];
  tbody.innerHTML = rows.map((r, idx) => `
    <tr>
      <td>${new Date(r.recorded_at).toLocaleString()} ${idx === 0 ? '<span class="pill pill-good">当前生效</span>' : ''}</td>
      <td class="num"><strong>${r.sample_count}</strong></td>
      <td class="num">${(r.total_turns || 0).toLocaleString()}</td>
      <td class="num"><code>${Number(r.power_slope).toFixed(4)}</code></td>
      <td class="num"><code>${Number(r.linear_slope).toFixed(4)}</code></td>
      <td class="num"><code>${Number(r.q_decay_slope).toFixed(4)}</code></td>
      <td class="num"><strong class="text-warn">${r.n_crit_50} 轮</strong></td>
      <td class="num"><span class="pill pill-good">${r.logit_acc}%</span></td>
    </tr>
  `).join('');
}

function renderRegressionChart() {
  if (!currentData) return;
  const svg = document.getElementById('regSvg');
  const tooltip = document.getElementById('chartTooltip');
  const titleEl = document.getElementById('regTitle');
  const formulaEl = document.getElementById('regFormula');

  const W = 900, H = 410;
  const pad = { l: 68, r: 32, t: 28, b: 50 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  let regObj = { band: [] };
  let xLabel = '', yLabel = '', pts = [];

  if (currentRegMode === 'phase') {
    const ph = currentData.regressions.burn_vs_speed_phase || { points: [], theory_curves: [] };
    pts = ph.points || [];
    xLabel = '相对对照基线 B 的真实省时率 s_T (%)  [向右为提速省时 →]';
    yLabel = '相对对照基线 B 的额度耗用率增幅 ΔC_dot (%)';
    titleEl.textContent = `策略优化因果相图（n = ${pts.length} 组基线 B → 实验 A 对照）`;
    formulaEl.textContent = `c_A / c_B = (1 + ΔC_dot%) × (1 - s_T%)   |   绿线下方 = 省时且省钱黄金区，红线上方 = 微弱省时但耗用率剧增亏损区`;
  } else if (currentRegMode === 'power') {
    regObj = currentData.regressions.power_law_cost_vs_turns;
    pts = regObj.points || [];
    xLabel = '交互轮数自然对数 ln(N)';
    yLabel = '原始额度对数 ln(C_raw)';
    titleEl.textContent = `双对数轮数幂律膨胀回归（n = ${regObj.n} 个对话）：轮数翻倍成本增至 ${(2 ** regObj.slope).toFixed(2)}×`;
    formulaEl.textContent = `ln(C) = ${regObj.slope} · ln(N) ${regObj.intercept >= 0 ? '+' : ''} ${regObj.intercept}   |   R² = ${regObj.r2}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'linear') {
    regObj = currentData.regressions.linear_throughput;
    pts = regObj.points || [];
    xLabel = '加权上下文总吞吐量 μ · N · L_mean (百万加权 Tokens)';
    yLabel = '实际加权额度消耗 C (Units)';
    titleEl.textContent = `物理计费吞吐纯线性回归（n = ${regObj.n} 个对话）`;
    formulaEl.textContent = `C = ${regObj.slope} · (μ·N·L) ${regObj.intercept >= 0 ? '+' : ''} ${regObj.intercept}   |   R² = ${regObj.r2}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'quality') {
    regObj = currentData.regressions.quality_vs_turns;
    pts = regObj.points || [];
    xLabel = '对话树总交互轮数对数 ln(N_tree)';
    yLabel = '任务完成质量 Q_task (0~100)';
    titleEl.textContent = `任务完成质量 Q_task vs 轮数分布（n = ${regObj.n} 个执行任务）`;
    formulaEl.textContent = `Q_task = ${regObj.intercept} ${regObj.slope >= 0 ? '+' : ''} ${regObj.slope} · ln(N_tree)   |   r = ${regObj.r}   |   R² = ${regObj.r2}`;
  } else if (currentRegMode === 'latency') {
    regObj = currentData.regressions.turn_latency_vs_out;
    pts = regObj.points || [];
    const mb = regObj.mult_beta || [0, 0, 0];
    xLabel = '单步模型输出量 Out_k (千 Tokens)';
    yLabel = '单步模型推理耗时 t_LLM (秒)';
    titleEl.textContent = `微观单步流式推理延迟多元回归（n = ${regObj.n} 步）`;
    formulaEl.textContent = `t_LLM = ${mb[0]}s + ${mb[1]}s · Out_k + ${mb[2]}s · Ctx_100k   (多元 R² = ${regObj.mult_r2})`;
  } else {
    const sig = currentData.regressions.sigmoid_probability;
    pts = sig.points || [];
    const w = sig.weights || [0, 0, 0, 0];
    xLabel = '项目总交互轮数对数 ln(N_tree)';
    yLabel = '高质量且耗用率受控概率 P_CE (%)';
    titleEl.textContent = `在线 IRLS 逻辑斯蒂概率生死线（分类准确率 ${sig.accuracy}%）`;
    formulaEl.textContent = `logit(P_CE) = ${w[0]} ${w[1] >= 0 ? '+' : ''}${w[1]}·ln(N) ${w[2] >= 0 ? '+' : ''}${w[2]}·Ctx_100k ${w[3] >= 0 ? '+' : ''}${w[3]}·Comp   |   N_50% = ${sig.n_crit_50} 轮`;
  }

  if (!pts.length && currentRegMode !== 'phase') {
    svg.innerHTML = `<rect x="0" y="0" width="${W}" height="${H}" fill="#080c14" rx="8"/><text x="450" y="205" text-anchor="middle" fill="#64748b">当前筛选条件下样本不足 3 条</text>`;
    return;
  }

  let minX, maxX, minY, maxY;
  if (currentRegMode === 'phase') {
    minX = -45; maxX = 70;
    minY = -55; maxY = Math.max(185, ...(pts.map((p) => p.y)), 160);
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
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="#080c14" rx="8"/>`;

  for (let i = 0; i <= 5; i++) {
    const xv = minX + (maxX - minX) * (i / 5);
    const px = sx(xv);
    const xTickText = currentRegMode === 'sigmoid'
      ? `${xv.toFixed(1)} (${Math.round(Math.exp(xv))}轮)`
      : currentRegMode === 'phase' ? `${xv >= 0 ? '+' : ''}${Math.round(xv)}%` : xv.toFixed(1);
    out += `<line x1="${px}" y1="${pad.t}" x2="${px}" y2="${pad.t + plotH}" stroke="rgba(148,163,184,0.1)" stroke-width="1"/>`;
    out += `<text x="${px}" y="${H - 24}" text-anchor="middle" fill="#64748b" font-size="11">${xTickText}</text>`;

    const yv = minY + (maxY - minY) * (i / 5);
    const py = sy(yv);
    const yTickText = currentRegMode === 'phase' ? `${yv >= 0 ? '+' : ''}${Math.round(yv)}%` : yv.toFixed(currentRegMode === 'sigmoid' ? 0 : 1);
    out += `<line x1="${pad.l}" y1="${py}" x2="${pad.l + plotW}" y2="${py}" stroke="rgba(148,163,184,0.1)" stroke-width="1"/>`;
    out += `<text x="${pad.l - 9}" y="${py + 4}" text-anchor="end" fill="#64748b" font-size="11">${yTickText}</text>`;
  }

  out += `<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="none" stroke="rgba(148,163,184,0.22)" stroke-width="1"/>`;
  out += `<text x="${pad.l + plotW / 2}" y="${H - 5}" text-anchor="middle" fill="#94a3b8" font-size="12" font-weight="600">${escapeHtml(xLabel)}</text>`;
  out += `<text x="16" y="${pad.t + plotH / 2}" text-anchor="middle" fill="#94a3b8" font-size="12" font-weight="600" transform="rotate(-90 16 ${pad.t + plotH / 2})">${escapeHtml(yLabel)}</text>`;

  out += `<g clip-path="url(#plotClip)">`;

  if (currentRegMode === 'phase') {
    const tc = currentData.regressions.burn_vs_speed_phase?.theory_curves || [];
    const x0 = sx(0), y0 = sy(0);
    out += `<line x1="${x0}" y1="${pad.t}" x2="${x0}" y2="${pad.t + plotH}" stroke="rgba(148,163,184,0.28)" stroke-dasharray="4 4" stroke-width="1"/>`;
    out += `<line x1="${pad.l}" y1="${y0}" x2="${pad.l + plotW}" y2="${y0}" stroke="rgba(148,163,184,0.28)" stroke-dasharray="4 4" stroke-width="1"/>`;
    if (tc.length >= 2) {
      const neutralPoly = tc.map((c) => `${sx(c.s_pct).toFixed(1)},${sy(c.neutral_burn_pct).toFixed(1)}`).join(' ');
      const aerPoly = tc.map((c) => `${sx(c.s_pct).toFixed(1)},${sy(c.aer15_burn_pct).toFixed(1)}`).join(' ');
      out += `<polyline points="${neutralPoly}" fill="none" stroke="#10b981" stroke-width="2.4"/>`;
      out += `<polyline points="${aerPoly}" fill="none" stroke="#f43f5e" stroke-width="2.2" stroke-dasharray="6 4"/>`;
      out += `<text x="${pad.l + 12}" y="${pad.t + 22}" fill="#fb7185" font-size="11.5" font-weight="600">- - 捡芝麻丢西瓜红线 (AER = 1.5, 上方为耗用率失控区)</text>`;
      out += `<text x="${pad.l + 12}" y="${pad.t + 40}" fill="#34d399" font-size="11.5" font-weight="600">── 等总成本零溢价边界 ΔC_dot = s_T/(1-s_T) (下方既快又省)</text>`;
    }
  }

  if (currentRegMode === 'sigmoid') {
    const sig = currentData.regressions.sigmoid_probability;
    const y50 = sy(50);
    out += `<line x1="${pad.l}" y1="${y50}" x2="${pad.l + plotW}" y2="${y50}" stroke="rgba(148,163,184,0.35)" stroke-dasharray="4 4" stroke-width="1"/>`;
    const xCrit = sx(Math.log(Math.max(2, sig.n_crit_50 || 45)));
    out += `<line x1="${xCrit}" y1="${pad.t}" x2="${xCrit}" y2="${pad.t + plotH}" stroke="#f59e0b" stroke-width="2.2" stroke-dasharray="6 4"/>`;
    out += `<text x="${xCrit + 7}" y="${pad.t + 20}" fill="#fbbf24" font-size="11.5" font-weight="600">50% 生死线 = ${sig.n_crit_50} 轮</text>`;
    if (sig.curve?.length >= 2) {
      const cleanPoly = sig.curve.map((c) => `${sx(c.lnN).toFixed(1)},${sy(c.p_clean).toFixed(1)}`).join(' ');
      const compPoly = sig.curve.map((c) => `${sx(c.lnN).toFixed(1)},${sy(c.p_comp).toFixed(1)}`).join(' ');
      out += `<polyline points="${cleanPoly}" fill="none" stroke="#10b981" stroke-width="2.8"/>`;
      out += `<polyline points="${compPoly}" fill="none" stroke="#f43f5e" stroke-width="2.2" stroke-dasharray="6 4"/>`;
    }
  }

  if (regObj.band && regObj.band.length >= 2) {
    const upper = regObj.band.map((b) => `${sx(b.x).toFixed(1)},${sy(b.hi).toFixed(1)}`).join(' ');
    const lower = [...regObj.band].reverse().map((b) => `${sx(b.x).toFixed(1)},${sy(b.lo).toFixed(1)}`).join(' ');
    out += `<polygon points="${upper} ${lower}" fill="rgba(56, 189, 248, 0.13)" />`;
    const b0 = regObj.band[0];
    const bLast = regObj.band[regObj.band.length - 1];
    out += `<line x1="${sx(b0.x)}" y1="${sy(b0.y)}" x2="${sx(bLast.x)}" y2="${sy(bLast.y)}" stroke="#38bdf8" stroke-width="2.4"/>`;
  }

  if (currentRegMode === 'power' && regObj.band?.length) {
    const b0 = regObj.band[0];
    const bLast = regObj.band[regObj.band.length - 1];
    const yEndSlope1 = b0.y + 1.0 * (bLast.x - b0.x);
    out += `<line x1="${sx(b0.x)}" y1="${sy(b0.y)}" x2="${sx(bLast.x)}" y2="${sy(yEndSlope1)}" stroke="#10b981" stroke-dasharray="6 4" stroke-width="1.6"/>`;
  }

  pts.forEach((pt, idx) => {
    const cx = sx(pt.x);
    const cy = sy(pt.y);
    let fill = PLATFORM_COLORS[pt.platform] || '#38bdf8';
    let r = pt.is_sub ? 3.6 : 5.4;
    if (currentRegMode === 'latency') r = 4.0;
    if (currentRegMode === 'phase') {
      fill = pt.bad ? '#f43f5e' : '#10b981';
      r = 6.8;
    } else if ((currentRegMode === 'quality' || currentRegMode === 'sigmoid') && pt.comp > 0) {
      fill = '#f43f5e';
      r = 5.8;
    }
    out += `<circle class="pt-dot" data-idx="${idx}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}" fill-opacity="0.88" stroke="#080c14" stroke-width="1.2"/>`;
    // 在因果相图上直接标注真实对话名称（彻底告别只看十六进制编号！）
    if (currentRegMode === 'phase' && idx < 8) {
      const shortTitle = String(pt.name || '').slice(0, 14);
      out += `<text x="${(cx + 9).toFixed(1)}" y="${(cy + 4).toFixed(1)}" fill="#cbd5e1" font-size="11" font-weight="600">${escapeHtml(shortTitle)} (${pt.dq >= 0 ? '+' : ''}${pt.dq})</text>`;
    }
  });

  out += `</g>`;
  svg.innerHTML = out;

  svg.querySelectorAll('.pt-dot').forEach((circle) => {
    circle.addEventListener('mouseenter', (ev) => {
      const idx = Number(circle.getAttribute('data-idx'));
      const pt = pts[idx];
      if (currentRegMode === 'phase') {
        tooltip.innerHTML = `
          <div style="font-weight:700;font-size:13px;margin-bottom:2px">${escapeHtml(pt.name)} <span style="color:#64748b;font-family:var(--font-mono);font-size:11px">#${escapeHtml(shortUid(pt.uid))}</span></div>
          <div style="color:#38bdf8;font-size:11px;margin-bottom:4px">${escapeHtml(pt.scope || '')} · ${escapeHtml(pt.verdict)}</div>
          <div style="color:#94a3b8;font-size:11.5px;margin-bottom:4px">${escapeHtml(pt.title)}</div>
          <div>质量变化 ΔQ: <strong>${pt.dq >= 0 ? '+' : ''}${pt.dq} 分</strong> · 省时: <strong>${pt.x}%</strong> · 耗用率: <strong class="text-bad">${pt.y >= 0 ? '+' : ''}${pt.y}%</strong></div>
        `;
      } else {
        tooltip.innerHTML = `
          <div style="font-weight:700;font-size:13px;margin-bottom:2px">${escapeHtml(pt.name || pt.title)} <span style="color:#64748b;font-family:var(--font-mono);font-size:11px">#${escapeHtml(shortUid(pt.uid))}</span></div>
          <div style="color:#94a3b8;font-size:11.5px;margin:2px 0">${escapeHtml(pt.platform)} · ${escapeHtml(pt.title || '')}</div>
          <div>坐标: (${pt.x}, ${pt.y})</div>
        `;
      }
      tooltip.classList.remove('hidden');
      const rect = svg.parentElement.getBoundingClientRect();
      tooltip.style.left = `${Math.min(rect.width - 310, Math.max(10, ev.clientX - rect.left + 14))}px`;
      tooltip.style.top = `${Math.max(10, ev.clientY - rect.top - 24)}px`;
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
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
    a.download = `qtc_v13_${currentRegMode}_${stamp}.svg`;
    a.click();
    return;
  }
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1800; canvas.height = 820;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#080c14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `qtc_v13_${currentRegMode}_${stamp}.png`;
    a.click();
  };
  img.src = url;
}

/**
 * 构建自由 A vs B 对照选择池（全面使用实时对话名称 + #短编号！）
 */
function buildCustomComparatorPool(data) {
  const prevBKey = selectableUnits[Number(document.getElementById('cmpBaseSelect')?.value)]?.key;
  const prevAKey = selectableUnits[Number(document.getElementById('cmpTargetSelect')?.value)]?.key;

  selectableUnits = [];
  for (const cp of (data.counterfactual_pairs || [])) {
    if (cp.pair_id.startsWith('intra:')) {
      const sh = shortUid(cp.base.uid);
      selectableUnits.push({
        key: `${cp.pair_id}#B`,
        name: `「${cp.display_name}」· ${cp.base.label.replace('本任务 · ', '')} (#${sh})`,
        T_min: cp.base.T_min,
        C_u: cp.base.C_u,
        burn_uh: cp.base.burn_uh,
        Q_task: cp.base.Q_task,
      });
      selectableUnits.push({
        key: `${cp.pair_id}#A`,
        name: `「${cp.display_name}」· ${cp.target.label.replace('本任务 · ', '')} (#${sh})`,
        T_min: cp.target.T_min,
        C_u: cp.target.C_u,
        burn_uh: cp.target.burn_uh,
        Q_task: cp.target.Q_task,
      });
    }
  }
  for (const p of (data.projects || [])) {
    if (p.session_role === 'probe') continue;
    const sh = shortUid(p.session_uid);
    selectableUnits.push({
      key: `sess:${p.session_uid}`,
      name: `「${p.display_name}」· [${PLATFORM_LABELS[p.platform] || p.platform} · ${p.tree_turns}轮 · #${sh}]`,
      T_min: p.T_min,
      C_u: p.C_units,
      burn_uh: p.burn_uh,
      Q_task: p.Q_final,
    });
  }

  const selB = document.getElementById('cmpBaseSelect');
  const selA = document.getElementById('cmpTargetSelect');
  if (!selB || !selA) return;

  const optsHtml = selectableUnits.map((u, i) => `<option value="${i}">${escapeHtml(u.name)}</option>`).join('');
  selB.innerHTML = optsHtml;
  selA.innerHTML = optsHtml;

  if (selectableUnits.length >= 2) {
    const idxB = selectableUnits.findIndex((u) => u.key === prevBKey);
    const idxA = selectableUnits.findIndex((u) => u.key === prevAKey);
    selB.value = idxB >= 0 ? String(idxB) : '0';
    selA.value = idxA >= 0 ? String(idxA) : '1';
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

  let pillCls = 'pill-good';
  let tag = '正向合算改进';
  if (dq <= -8 || a.Q_task < 65) { pillCls = 'pill-bad'; tag = '质量失守翻车'; }
  else if (costPct > 25 && sPct <= 0) { pillCls = 'pill-bad'; tag = '双输恶化 (未省时且更贵)'; }
  else if (costPct > 25 && sPct > 0 && (costPct / Math.max(1, sPct)) > 1.5) { pillCls = 'pill-warn'; tag = '捡芝麻丢西瓜 (微弱省时·耗用率剧增)'; }

  resEl.innerHTML = `
    <div class="score-col">
      <span class="sc-lbl">任务完成质量对比</span>
      <span class="sc-main">${b.Q_task} → ${a.Q_task} 分 <span class="${dq >= -2 ? 'text-good' : 'text-bad'}">(${dq >= 0 ? '+' : ''}${dq.toFixed(1)})</span></span>
      <span class="sc-sub">${dq >= -2 ? '完成质量保持达标' : '警告：完成质量退步'}</span>
    </div>
    <div class="score-col">
      <span class="sc-lbl">等量耗时与提速</span>
      <span class="sc-main">${unitTimeB.toFixed(1)}m → ${unitTimeA.toFixed(1)}m</span>
      <span class="sc-sub">真实省时率: <strong class="${sPct > 0 ? 'text-good' : 'text-bad'}">${sPct >= 0 ? '+' : ''}${sPct.toFixed(1)}%</strong></span>
    </div>
    <div class="score-col">
      <span class="sc-lbl">额度耗用率 (烧钱功率)</span>
      <span class="sc-main">${b.burn_uh} → <span class="text-accent">${a.burn_uh} U/h</span></span>
      <span class="sc-sub">增幅 <strong class="${burnPct > neutralBurn + 20 ? 'text-bad' : 'text-good'}">${burnPct >= 0 ? '+' : ''}${burnPct.toFixed(1)}%</strong> (零溢价上限 +${neutralBurn.toFixed(1)}%)</span>
    </div>
    <div class="score-col">
      <span class="sc-lbl">单位总成本 &amp; 裁决</span>
      <span class="sc-main"><span class="${costPct > 20 ? 'text-bad' : 'text-good'}">${costPct >= 0 ? '+' : ''}${costPct.toFixed(1)}%</span> &nbsp;<span class="pill ${pillCls}">${tag}</span></span>
      <span class="sc-sub">总额 ${unitCostB.toFixed(2)}U → ${unitCostA.toFixed(2)}U</span>
    </div>
  `;
}

function renderCounterfactualTable(data) {
  const tbody = document.querySelector('#sesameTable tbody');
  const catFilter = document.getElementById('pairCategoryFilter')?.value || 'all';
  const allPairs = data.counterfactual_pairs || [];
  const list = catFilter === 'all' ? allPairs : allPairs.filter((x) => x.pair_category === catFilter);

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--fg-muted);padding:24px">当前筛选下暂无受控对照记录，可在上方自由验算台中指定任意两个对话进行比对。</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((cp) => {
    const d = cp.deltas;
    const isBloat = cp.pair_category === 'bloat_drift';
    const isCross = cp.pair_category === 'cross_project';
    const qCls = d.delta_Q >= -2 ? 'text-good' : 'text-bad';
    const qNote = d.delta_Q >= 0.5 ? '质量提升' : d.delta_Q >= -2.5 ? '质量稳住' : '质量退步';
    const pillCls = cp.verdict_code === 'pareto-win'
      ? 'pill-good'
      : (cp.verdict_code === 'quality-collapse' || cp.verdict_code === 'lose-lose') ? 'pill-bad' : 'pill-warn';
    const cleanVerdict = cp.verdict_label.replace(/^[🟢🟠🔴]\s*/, '');

    const titleHeader = isCross
      ? `<span class="conv-title-text">${escapeHtml(cp.base_display_name)}</span> <span style="color:var(--fg-muted)">→</span> <span class="conv-title-text">${escapeHtml(cp.display_name)}</span>`
      : `<span class="conv-title-text">${escapeHtml(cp.display_name)}</span>`;

    return `
      <tr>
        <td>
          <div class="conv-identity">
            <div class="conv-title-row">
              ${platPill(cp.platform)}
              ${titleHeader}
              ${idChipHtml(cp.target.uid)}
            </div>
            <div class="conv-sub-meta">${escapeHtml(cp.comparison_scope)}</div>
            <div class="pair-steps">
              <div><strong>基线 B：</strong>${escapeHtml(cp.base.label)} (${cp.base.turns}轮${cp.base.sub_count ? ` + ${cp.base.sub_count}子代理` : ''})</div>
              <div><strong>实验 A：</strong>${escapeHtml(cp.target.label)} (${cp.target.turns}轮${cp.target.sub_count ? ` + ${cp.target.sub_count}子代理` : ''})</div>
            </div>
          </div>
        </td>
        <td class="num">
          <div style="font-weight:700">${cp.base.Q_task} → ${cp.target.Q_task} 分</div>
          <div class="${qCls}" style="font-size:11.5px;font-weight:600">ΔQ = ${d.delta_Q >= 0 ? '+' : ''}${d.delta_Q} (${qNote})</div>
        </td>
        <td class="num">
          <div>${cp.base.T_min}m → ${cp.target.T_min}m</div>
          <div style="font-size:11.5px;color:var(--fg-secondary)">${isBloat ? '单轮均速' : '省时率'}: <strong class="${d.time_saved_pct > 0 ? 'text-good' : 'text-bad'}">${d.time_saved_pct >= 0 ? '+' : ''}${d.time_saved_pct}%</strong></div>
        </td>
        <td class="num">
          <div><code>${cp.base.burn_uh}</code> → <strong class="text-accent">${cp.target.burn_uh} U/h</strong> (<strong class="${d.burn_surge_pct > d.neutral_burn_limit_pct + 20 ? 'text-bad' : 'text-good'}">${d.burn_surge_pct >= 0 ? '+' : ''}${d.burn_surge_pct}%</strong>)</div>
          <div style="font-size:11px;color:var(--fg-muted)">零溢价耗用率上限 +${d.neutral_burn_limit_pct}%</div>
          <div style="font-size:11.5px;margin-top:2px">${cp.base.C_u}U → <strong>${cp.target.C_u}U</strong> (成本 <strong>${d.cost_surge_pct >= 0 ? '+' : ''}${d.cost_surge_pct}%</strong>)</div>
        </td>
        <td>
          <div><span class="pill ${pillCls}">${escapeHtml(cleanVerdict)}</span></div>
          ${d.excess_cost_u > 0 ? `<div style="margin-top:5px;font-size:11.5px">超额多花 <strong class="text-warn">${d.excess_cost_u} U</strong></div>` : `<div style="margin-top:5px;font-size:11.5px;color:var(--fg-muted)">无超额浪费</div>`}
        </td>
        <td style="font-size:12px;color:var(--fg-secondary)">
          ${(cp.reasons || []).map((r) => `<div style="margin-bottom:3px">• ${escapeHtml(r)}</div>`).join('')}
        </td>
      </tr>
    `;
  }).join('');
}

function renderPrescriptions(data) {
  const pr = data.prescriptions;
  const ec = pr.empirical_constants;
  const bf = ec.burn_formula_beta || [0, 0, 0, 0];
  document.getElementById('constStrip').innerHTML = `
    <span><strong>实时回归物理常数 (n = ${pr.sample_basis_count})</strong></span>
    <span>轮数膨胀指数 β = <strong>${ec.turn_cost_exponent}</strong> (翻倍成本 ×${ec.double_turns_cost_mult})</span>
    <span>小时耗用率方程: <code>C_dot = ${bf[0]} + ${bf[1]}·μ + ${bf[2]}·Ctx_100k + ${bf[3]}·Sub/h</code></span>
    <span>50% 性价比生死线 = <strong class="text-warn">${ec.dynamic_n_crit_50} 轮</strong></span>
  `;

  const mA = pr.mode_extreme_cost_effectiveness;
  document.getElementById('modeCeBox').innerHTML = `
    <div class="section-head" style="margin-bottom:6px"><h2>${escapeHtml(mA.title)}</h2></div>
    <div class="rule-callout">${escapeHtml(mA.core_math_rule)}</div>
    <p style="font-size:12px;color:var(--fg-secondary)">单窗口建议上限 <code>≤ ${mA.recommended_max_turns_per_session} 轮</code> · 上下文水位 <code>≤ ${mA.recommended_context_ceiling_k}k</code> · 单轮并发工具 <code>≥ ${mA.min_parallel_tools_per_turn} 个</code></p>
    <ul class="rule-list">
      ${[...mA.model_routing_strategy, ...mA.execution_tactics].map((x) => `<li>${escapeHtml(x)}</li>`).join('')}
    </ul>
  `;

  const mB = pr.mode_extreme_output_quality;
  document.getElementById('modeQualBox').innerHTML = `
    <div class="section-head" style="margin-bottom:6px"><h2>${escapeHtml(mB.title)}</h2></div>
    <div class="rule-callout" style="border-left-color:var(--accent);background:rgba(56,189,248,0.08)">${escapeHtml(mB.core_math_rule)}</div>
    <p style="font-size:12px;color:var(--fg-secondary)">分模块独立窗口周期 <code>${mB.recommended_stage_turns} 轮/模块</code> · <code>${escapeHtml(mB.zero_compaction_mandate)}</code></p>
    <ul class="rule-list">
      ${[...mB.model_routing_strategy, ...mB.execution_tactics].map((x) => `<li>${escapeHtml(x)}</li>`).join('')}
    </ul>
  `;
}

function renderSamplesTable(data) {
  const kw = (document.getElementById('searchBox')?.value || '').trim().toLowerCase();
  const roleVal = document.getElementById('roleFilter')?.value || 'all';

  const rows = (data.projects || []).filter((p) => {
    if (roleVal !== 'all' && p.session_role !== roleVal) return false;
    if (!kw) return true;
    return `${p.display_name} ${p.title} ${p.session_uid} ${p.platform} ${p.primary_model} ${p.domain} ${p.project_key}`.toLowerCase().includes(kw);
  });

  const tbody = document.querySelector('#projectsTable tbody');
  tbody.innerHTML = rows.slice(0, 150).map((p) => {
    const showPreview = p.title && p.title !== p.display_name;
    return `
      <tr>
        <td>
          <div class="conv-identity">
            <div class="conv-title-row">
              <span class="conv-title-text">${escapeHtml(p.display_name)}</span>
              ${idChipHtml(p.session_uid)}
            </div>
            ${showPreview ? `<div class="conv-sub-meta" title="${escapeHtml(p.title)}">首句: ${escapeHtml(p.title.slice(0, 56))}${p.title.length > 56 ? '…' : ''}</div>` : ''}
            ${p.project_key ? `<div class="conv-sub-meta" style="color:var(--accent)">📁 ${escapeHtml(p.project_key)}</div>` : ''}
          </div>
        </td>
        <td>${platPill(p.platform)}<div style="margin-top:4px">${rolePill(p.session_role)}</div></td>
        <td><code style="font-size:11px">${escapeHtml(p.primary_model.slice(0, 24))}</code></td>
        <td class="num">${p.root_turns}${p.sub_turns ? ` <span style="color:var(--fg-muted)">+${p.sub_turns} (${p.sub_count}子)</span>` : ''}</td>
        <td class="num">${p.T_min}m</td>
        <td class="num"><strong>${p.C_units} U</strong></td>
        <td class="num"><code>${p.burn_uh} U/h</code></td>
        <td class="num">
          <div class="q-edit-group">
            <input type="number" class="q-input" min="0" max="100" step="0.5" value="${p.Q_final}" data-uid="${escapeHtml(p.session_uid)}" />
            <button class="btn ghost sm btn-save-q" data-uid="${escapeHtml(p.session_uid)}">校准</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

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
        showStatus(`已校准完成质量分 (${val} 分)，全局对照差分与回归参数已重训。`);
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
    <div class="score-col">
      <span class="sc-lbl">预估任务完成质量</span>
      <span class="sc-main">${res.pred_Q} 分 <span class="${res.delta_Q >= -2 ? 'text-good' : 'text-bad'}">(ΔQ=${res.delta_Q >= 0 ? '+' : ''}${res.delta_Q})</span></span>
      <span class="sc-sub">有效执行 ${res.effective_turns} 轮 · 压缩 ${res.est_compactions} 次</span>
    </div>
    <div class="score-col">
      <span class="sc-lbl">预估耗时与省时率</span>
      <span class="sc-main">${res.pred_T_min} 分钟</span>
      <span class="sc-sub">相对标准基线省时: <strong class="${res.time_saved_pct > 0 ? 'text-good' : 'text-bad'}">${res.time_saved_pct >= 0 ? '+' : ''}${res.time_saved_pct}%</strong></span>
    </div>
    <div class="score-col">
      <span class="sc-lbl">额度耗用率 (功率)</span>
      <span class="sc-main">${res.base_burn_uh} → <span class="text-accent">${res.pred_burn_uh} U/h</span></span>
      <span class="sc-sub">功率变化: <strong>${res.burn_surge_pct >= 0 ? '+' : ''}${res.burn_surge_pct}%</strong></span>
    </div>
    <div class="score-col">
      <span class="sc-lbl">预估总额度 &amp; 合算概率</span>
      <span class="sc-main">${res.pred_C_units} U (${res.cost_surge_pct >= 0 ? '+' : ''}${res.cost_surge_pct}%)</span>
      <span class="sc-sub">合算概率 P_CE = <strong class="text-accent">${res.prob_ce_pct}%</strong></span>
    </div>
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
  renderSamplesTable(data);
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
          const isRename = String(msg.source || '').includes('rename') || String(msg.source || '').includes('summary');
          flashLiveBadge(isRename ? `⚡ 已实时同步最新对话名称 (v${msg.version})` : `⚡ 已捕获新步进并更新模型 (v${msg.version})`);
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
          const isRename = String(vInfo.source || '').includes('rename') || String(vInfo.source || '').includes('summary');
          flashLiveBadge(isRename ? `⚡ 已实时同步最新对话名称 (v${vInfo.version})` : `⚡ 已捕获新步进并更新模型 (v${vInfo.version})`);
        }
      } catch {}
    }, 2200);
  }
}

function bindEvents() {
  // 全局委托：点击 #短编号 一键复制完整会话 ID
  document.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.id-chip');
    if (chip && chip.dataset.copyId) {
      navigator.clipboard?.writeText(chip.dataset.copyId).catch(() => {});
      showStatus(`已复制完整对话 ID: ${chip.dataset.copyId}`, 2200);
    }
  });

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'regression') renderRegressionChart();
    });
  });

  document.querySelectorAll('#regSelector .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#regSelector .seg-btn').forEach((b) => b.classList.remove('active'));
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
    showStatus('正在同步全平台最新对话日志与实时对话名称…', 0);
    const plat = document.getElementById('platformFilter').value;
    const d = await callBackend('sync', { force: false, platform: plat });
    renderAll(d);
    updateSimulator();
    const si = d.sync_info || {};
    showStatus(`同步完成：扫描 ${si.scanned_files || 0} 份日志，更新 ${si.updated_sessions || 0} 条记录 (${si.elapsed_ms || 0}ms)`);
  });

  document.getElementById('btnExport').addEventListener('click', async () => {
    const r = await callBackend('export', {});
    showStatus(`已导出 CSV 数据集: ${r.csv_path} (${r.row_count} 条记录)`);
  });

  document.getElementById('searchBox').addEventListener('input', () => {
    if (currentData) renderSamplesTable(currentData);
  });

  document.getElementById('roleFilter').addEventListener('change', () => {
    if (currentData) renderSamplesTable(currentData);
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
    mcpApp = new App({ name: 'QTC Observatory', version: '1.3.0' }, {});
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
