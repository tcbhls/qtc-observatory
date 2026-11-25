import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

let mcpApp = null;
let useHttpFallback = false;
let currentData = null;
let currentRegMode = 'power';
let currentDataVersion = 0;
let sseConnection = null;
let appPollTimer = null;

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
  if (autoHideMs > 0) {
    setTimeout(() => el.classList.add('hidden'), autoHideMs);
  }
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
      <span style="color:#94a3b8">| 最近模型重算时间: ${timeStr} | 当前过去15分钟无正在写入的活跃会话，一旦任意 Agent 运行将自动秒级捕获并刷新全部图表！</span>
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
      <div class="sub">${k.root_projects} 个主项目 + ${k.subagent_sessions} 个子代理</div>
    </div>
    <div class="kpi">
      <div class="lbl">累计采集推理轮数</div>
      <div class="val">${k.total_turns.toLocaleString()}</div>
      <div class="sub">动态 50% 生死线: <strong style="color:#fbbf24">${k.dynamic_n_crit_50 || 56} 轮</strong></div>
    </div>
    <div class="kpi">
      <div class="lbl">累计吞吐总 Tokens</div>
      <div class="val">${k.total_tokens_M} M</div>
      <div class="sub">缓存重读占比 ${k.cost_shares_pct.cache_read}%</div>
    </div>
    <div class="kpi">
      <div class="lbl">累计加权总额度 C</div>
      <div class="val">${k.total_weighted_cost_u} U</div>
      <div class="sub">有效代码/文本输出仅占 ${k.cost_shares_pct.output}%</div>
    </div>
    <div class="kpi">
      <div class="lbl">累计任务执行时长 T</div>
      <div class="val">${k.total_exec_hours} h</div>
      <div class="sub">LLM思考 ${k.time_shares_pct.llm_think}% · 后台 ${k.time_shares_pct.async_wait}%</div>
    </div>
    <div class="kpi">
      <div class="lbl">抓获“捡芝麻丢西瓜”</div>
      <div class="val" style="color:#fb7185">${k.sesame_alert_count} 项</div>
      <div class="sub">可避免冤枉浪费 ≈ ${k.total_estimated_waste_u} U</div>
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
      <td><strong>${p.avg_q}</strong> 分</td>
      <td>${p.exec_hours} h</td>
      <td><strong>${p.weighted_cost_u} U</strong></td>
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
      <td><code>${r.elasticity_tc_ratio} : 1</code></td>
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
  const pad = { l: 66, r: 30, t: 26, b: 50 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  let regObj = { band: [] };
  let xLabel = '', yLabel = '', pts = [];

  if (currentRegMode === 'power') {
    regObj = currentData.regressions.power_law_cost_vs_turns;
    pts = regObj.points || [];
    xLabel = '交互轮数自然对数 ln(N)';
    yLabel = '原始额度对数 ln(C_raw)';
    titleEl.textContent = `① 双对数幂律膨胀实时回归 (n = ${regObj.n} 个会话)：轮数每翻倍，成本增至 ${(2 ** regObj.slope).toFixed(2)}×`;
    formulaEl.textContent = `ln(C) = ${regObj.slope} · ln(N) ${regObj.intercept >= 0 ? '+' : ''} ${regObj.intercept}   |   R² = ${regObj.r2}   |   t = ${regObj.tStat}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'linear') {
    regObj = currentData.regressions.linear_throughput;
    pts = regObj.points || [];
    xLabel = '加权上下文总吞吐量 μ · N · L_mean (百万加权 Tokens)';
    yLabel = '实际加权额度消耗 C (Units)';
    titleEl.textContent = `② 物理计费吞吐纯线性实时回归 (n = ${regObj.n} 个会话)`;
    formulaEl.textContent = `C = ${regObj.slope} · (μ·N·L) ${regObj.intercept >= 0 ? '+' : ''} ${regObj.intercept}   |   R² = ${regObj.r2}   |   t = ${regObj.tStat}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'quality') {
    regObj = currentData.regressions.quality_vs_turns;
    pts = regObj.points || [];
    xLabel = '项目总交互轮数对数 ln(N_tree)';
    yLabel = '真实质量得分 Q_final (0~100)';
    titleEl.textContent = `③ 质量随轮数退化实时回归 (n = ${regObj.n} 个根项目)：红点为触发失忆压缩会话`;
    formulaEl.textContent = `Q = ${regObj.intercept} ${regObj.slope >= 0 ? '+' : ''} ${regObj.slope} · ln(N_tree)   |   r = ${regObj.r}   |   R² = ${regObj.r2}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'latency') {
    regObj = currentData.regressions.turn_latency_vs_out;
    pts = regObj.points || [];
    const mb = regObj.mult_beta || [0, 0, 0];
    xLabel = '单步模型输出量 Out_k (千 Tokens)';
    yLabel = '单步 LLM 推理耗时 t_LLM (秒)';
    titleEl.textContent = `④ 微观单步延迟多元最小二乘实时回归 (n = ${regObj.n} 个推理步)`;
    formulaEl.textContent = `多元方程: t_LLM = ${mb[0]}s + ${mb[1]}s·Out_k + ${mb[2]}s·Ctx_100k  (多元R²=${regObj.mult_r2})  |  单变量斜率=${regObj.slope}s/k`;
  } else if (currentRegMode === 'sigmoid') {
    const sig = currentData.regressions.sigmoid_probability;
    pts = sig.points || [];
    const w = sig.weights || [0, 0, 0, 0];
    xLabel = '项目总交互轮数对数 ln(N_tree)  [刻度附真实轮数]';
    yLabel = '高性价比任务概率 P_CE (%)';
    titleEl.textContent = `⑤ 在线 Newton-Raphson (IRLS) 逻辑斯蒂概率曲线 (分类准确率 = ${sig.accuracy}%)`;
    formulaEl.textContent = `logit(P_CE) = ${w[0]} ${w[1] >= 0 ? '+' : ''}${w[1]}·ln(N) ${w[2] >= 0 ? '+' : ''}${w[2]}·10Err ${w[3] >= 0 ? '+' : ''}${w[3]}·Comp  |  实时50%生死线 N_50% = ${sig.n_crit_50} 轮`;
  } else {
    const pSpace = currentData.regressions.pareto_unit_space;
    pts = pSpace.points || [];
    const ws = pSpace.state_weights || [0, 0, 0, 0];
    xLabel = '单位产出时间对数 ln(T / W)  [越左越快 ←]';
    yLabel = '单位产出额度对数 ln(C / W)  [越下越省 ↓]';
    titleEl.textContent = `⑥ 单位产出帕累托空间 + 在线 IRLS 50% 概率线性分类边界 (准确率 = ${pSpace.state_accuracy}%)`;
    formulaEl.textContent = `状态权重 w=[${ws.join(', ')}]  |  金色斜线为 Q=92 时 P_CE=50% 实时决策分界线 (左下绿区合算，右上红区捡芝麻丢西瓜)`;
  }

  if (!pts.length) {
    svg.innerHTML = `<text x="440" y="205" text-anchor="middle" fill="#94a3b8">当前筛选条件下样本不足 3 条</text>`;
    return;
  }

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = currentRegMode === 'sigmoid' ? -4 : Math.min(...ys);
  let maxY = currentRegMode === 'sigmoid' ? 104 : Math.max(...ys);

  if (currentRegMode === 'sigmoid') {
    minX = Math.min(minX, Math.log(4));
    maxX = Math.max(maxX, Math.log(1200));
  }
  if (maxX - minX < 1e-3) { minX -= 1; maxX += 1; }
  if (maxY - minY < 1e-3) { minY -= 1; maxY += 1; }
  const dx = (maxX - minX) * 0.05;
  const dy = currentRegMode === 'sigmoid' ? 2 : (maxY - minY) * 0.08;
  minX -= dx; maxX += dx; minY -= dy; maxY += dy;

  const sx = (v) => pad.l + ((v - minX) / (maxX - minX)) * plotW;
  const sy = (v) => pad.t + plotH - ((v - minY) / (maxY - minY)) * plotH;

  let out = `<defs><clipPath id="plotClip"><rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}"/></clipPath></defs>`;
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="#0b1120" rx="6"/>`;

  for (let i = 0; i <= 5; i++) {
    const xv = minX + (maxX - minX) * (i / 5);
    const px = sx(xv);
    const xTickText = currentRegMode === 'sigmoid'
      ? `${xv.toFixed(1)} (${Math.round(Math.exp(xv))}轮)`
      : xv.toFixed(1);
    out += `<line x1="${px}" y1="${pad.t}" x2="${px}" y2="${pad.t + plotH}" stroke="#334155" stroke-dasharray="3 3" stroke-width="1"/>`;
    out += `<text x="${px}" y="${H - 24}" text-anchor="middle" fill="#94a3b8" font-size="11">${xTickText}</text>`;

    const yv = minY + (maxY - minY) * (i / 5);
    const py = sy(yv);
    out += `<line x1="${pad.l}" y1="${py}" x2="${pad.l + plotW}" y2="${py}" stroke="#334155" stroke-dasharray="3 3" stroke-width="1"/>`;
    out += `<text x="${pad.l - 8}" y="${py + 4}" text-anchor="end" fill="#94a3b8" font-size="11">${yv.toFixed(currentRegMode === 'sigmoid' ? 0 : 1)}</text>`;
  }

  out += `<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="none" stroke="#475569" stroke-width="1.2"/>`;
  out += `<text x="${pad.l + plotW / 2}" y="${H - 5}" text-anchor="middle" fill="#cbd5e1" font-size="12" font-weight="600">${escapeHtml(xLabel)}</text>`;
  out += `<text x="16" y="${pad.t + plotH / 2}" text-anchor="middle" fill="#cbd5e1" font-size="12" font-weight="600" transform="rotate(-90 16 ${pad.t + plotH / 2})">${escapeHtml(yLabel)}</text>`;

  out += `<g clip-path="url(#plotClip)">`;

  // 帕累托中位十字基准 + 实时 IRLS 线性决策分界线
  if (currentRegMode === 'pareto') {
    const pSpace = currentData.regressions.pareto_unit_space;
    const mx = sx(pSpace.med_ln_T);
    const my = sy(pSpace.med_ln_C);
    out += `<line x1="${mx}" y1="${pad.t}" x2="${mx}" y2="${pad.t + plotH}" stroke="#38bdf8" stroke-dasharray="5 4" stroke-width="1.3"/>`;
    out += `<line x1="${pad.l}" y1="${my}" x2="${pad.l + plotW}" y2="${my}" stroke="#38bdf8" stroke-dasharray="5 4" stroke-width="1.3"/>`;
    if (pSpace.boundary_line) {
      const bl = pSpace.boundary_line;
      out += `<line x1="${sx(bl.x1)}" y1="${sy(bl.y1)}" x2="${sx(bl.x2)}" y2="${sy(bl.y2)}" stroke="#fbbf24" stroke-width="2.8" stroke-dasharray="8 4"/>`;
    }
  }

  // Sigmoid 双曲线 + 50% 水平阈值 + 实时 N_50% 垂直生死线
  if (currentRegMode === 'sigmoid') {
    const sig = currentData.regressions.sigmoid_probability;
    const y50 = sy(50);
    out += `<line x1="${pad.l}" y1="${y50}" x2="${pad.l + plotW}" y2="${y50}" stroke="#94a3b8" stroke-dasharray="4 4" stroke-width="1.2"/>`;
    const xCrit = sx(Math.log(Math.max(2, sig.n_crit_50 || 56)));
    out += `<line x1="${xCrit}" y1="${pad.t}" x2="${xCrit}" y2="${pad.t + plotH}" stroke="#fbbf24" stroke-width="2.4" stroke-dasharray="7 3"/>`;
    out += `<text x="${xCrit + 6}" y="${pad.t + 20}" fill="#fbbf24" font-size="11.5" font-weight="700">实时生死线 N_50% = ${sig.n_crit_50} 轮</text>`;

    if (sig.curve?.length >= 2) {
      const cleanPoly = sig.curve.map((c) => `${sx(c.lnN).toFixed(1)},${sy(c.p_clean).toFixed(1)}`).join(' ');
      const compPoly = sig.curve.map((c) => `${sx(c.lnN).toFixed(1)},${sy(c.p_comp).toFixed(1)}`).join(' ');
      out += `<polyline points="${cleanPoly}" fill="none" stroke="#10b981" stroke-width="3"/>`;
      out += `<polyline points="${compPoly}" fill="none" stroke="#f43f5e" stroke-width="2.4" stroke-dasharray="6 4"/>`;
      out += `<text x="${pad.l + plotW - 14}" y="${pad.t + 22}" text-anchor="end" fill="#10b981" font-size="11.5" font-weight="700">── 零失忆压缩 (Comp=0)</text>`;
      out += `<text x="${pad.l + plotW - 14}" y="${pad.t + 40}" text-anchor="end" fill="#f43f5e" font-size="11.5" font-weight="700">- - 触发失忆压缩 (Comp≥1)</text>`;
    }
  }

  // OLS 95% 置信区间带与回归直线
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

  // 真实散点
  pts.forEach((pt, idx) => {
    const cx = sx(pt.x);
    const cy = sy(pt.y);
    let fill = PLATFORM_COLORS[pt.platform] || '#38bdf8';
    let r = pt.is_sub ? 3.8 : 5.4;
    if (currentRegMode === 'latency') r = 4.2;
    if ((currentRegMode === 'quality' || currentRegMode === 'sigmoid') && pt.comp > 0) {
      fill = '#ef4444';
      r = 6.0;
    }
    if (currentRegMode === 'pareto') {
      fill = pt.flag === 'healthy' ? '#10b981' : '#ef4444';
      r = 5.8;
    }
    out += `<circle class="pt-dot" data-idx="${idx}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}" fill-opacity="0.82" stroke="#0f172a" stroke-width="1"/>`;
  });

  out += `</g>`;
  svg.innerHTML = out;

  svg.querySelectorAll('.pt-dot').forEach((circle) => {
    circle.addEventListener('mouseenter', (ev) => {
      const idx = Number(circle.getAttribute('data-idx'));
      const pt = pts[idx];
      tooltip.innerHTML = `
        <div><strong>${escapeHtml(pt.platform)}</strong> · ${escapeHtml(String(pt.uid).slice(0, 18))}</div>
        <div style="color:#94a3b8;margin:2px 0">${escapeHtml(pt.title || '')}</div>
        <div>坐标: (${pt.x}, ${pt.y}) ${pt.ce ? `| CE=${pt.ce}` : ''} ${pt.comp !== undefined ? `| 失忆=${pt.comp}` : ''}</div>
      `;
      tooltip.classList.remove('hidden');
      const rect = svg.parentElement.getBoundingClientRect();
      tooltip.style.left = `${Math.min(rect.width - 270, Math.max(10, ev.clientX - rect.left + 12))}px`;
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
  if (!svgStr.includes('xmlns=')) {
    svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (format === 'svg') {
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `qtc_realtime_${currentRegMode}_${stamp}.svg`;
    a.click();
    return;
  }
  const img = new Image();
  const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1760;
    canvas.height = 820;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `qtc_realtime_${currentRegMode}_${stamp}.png`;
    a.click();
  };
  img.src = url;
}

function renderSesameAlerts(data) {
  const tbody = document.querySelector('#sesameTable tbody');
  const list = data.sesame_alerts || [];
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#34d399;padding:18px">当前筛选条件下未检测到“捡芝麻丢西瓜”不合算异常任务！</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((a) => `
    <tr>
      <td>${platBadge(a.platform)}<br/><small>${escapeHtml(a.session_uid.split(':')[1]?.slice(0, 10) || a.session_uid)}</small></td>
      <td><strong>[${escapeHtml(a.domain)}]</strong><br/>${escapeHtml(a.title.slice(0, 48))}</td>
      <td><span class="tag tag-bad">${escapeHtml(a.type)}</span></td>
      <td>多花成本 <strong style="color:#fb7185">+${a.cost_increase_pct}%</strong><br/>换得省时 <strong>${a.time_saved_pct}%</strong></td>
      <td>C = <strong>${a.C_units}U</strong><br/>T = ${a.T_min}m | Q = ${a.Q_final}</td>
      <td><strong style="color:#f59e0b">${a.estimated_waste_u} U</strong></td>
      <td>${(a.reasons || []).map((r) => `• ${escapeHtml(r)}`).join('<br/>')}</td>
    </tr>
  `).join('');
}

function renderPrescriptions(data) {
  const pr = data.prescriptions;
  const ec = pr.empirical_constants;
  document.getElementById('constStrip').innerHTML = `
    <span><strong>在线重训最新常数 (样本 n=${pr.sample_basis_count})：</strong></span>
    <span>轮数膨胀指数 β = <strong>${ec.turn_cost_exponent}</strong> (翻倍成本 ×${ec.double_turns_cost_mult})</span>
    <span>动态50%生死线 = <strong style="color:#fbbf24">${ec.dynamic_n_crit_50} 轮</strong></span>
    <span>时间:金钱弹性比 = <strong style="color:#38bdf8">${ec.time_cost_elasticity_ratio} : 1</strong></span>
    <span>失忆质量断崖 ΔQ = <strong style="color:#fb7185">-${ec.compaction_quality_drop} 分</strong></span>
    <span>单轮延迟 = <strong>${ec.base_turn_overhead_sec}s</strong> + <strong>${ec.sec_per_1k_output_tok}s</strong>/kOut</span>
  `;

  const mA = pr.mode_extreme_cost_effectiveness;
  document.getElementById('modeCeBox').innerHTML = `
    <h3>🎯 ${escapeHtml(mA.title)}</h3>
    <div class="rule-highlight">${escapeHtml(mA.core_math_rule)}</div>
    <p><strong>动态推算硬阈值：</strong>单会话截断上限 <code>≤ ${mA.recommended_max_turns_per_session} 轮</code> | 上下文红线 <code>≤ ${mA.recommended_context_ceiling_k}k</code> | 单轮并发工具 <code>≥ ${mA.min_parallel_tools_per_turn} 个</code></p>
    <ul class="rule-list">
      ${[...mA.model_routing_strategy, ...mA.execution_tactics].map((x) => `<li>${escapeHtml(x)}</li>`).join('')}
    </ul>
  `;

  const mB = pr.mode_extreme_output_quality;
  document.getElementById('modeQualBox').innerHTML = `
    <h3>🏆 ${escapeHtml(mB.title)}</h3>
    <div class="rule-highlight" style="border-left-color:#38bdf8;background:rgba(56,189,248,0.1)">${escapeHtml(mB.core_math_rule)}</div>
    <p><strong>动态推算硬阈值：</strong>分阶段清零周期 <code>${mB.recommended_stage_turns} 轮/阶段</code> | <code>${escapeHtml(mB.zero_compaction_mandate)}</code></p>
    <ul class="rule-list">
      ${[...mB.model_routing_strategy, ...mB.execution_tactics].map((x) => `<li>${escapeHtml(x)}</li>`).join('')}
    </ul>
  `;
}

function renderSamplesTable(data, keyword = '') {
  const kw = keyword.trim().toLowerCase();
  const rows = (data.projects || []).filter((p) => {
    if (!kw) return true;
    return `${p.session_uid} ${p.platform} ${p.title} ${p.primary_model} ${p.domain}`.toLowerCase().includes(kw);
  });

  const tbody = document.querySelector('#projectsTable tbody');
  tbody.innerHTML = rows.slice(0, 120).map((p) => `
    <tr>
      <td>${platBadge(p.platform)}<br/><small>${escapeHtml(p.session_uid.split(':')[1]?.slice(0, 10) || p.session_uid)}</small></td>
      <td title="${escapeHtml(p.title)}"><strong>[${escapeHtml(p.domain.slice(0, 4))}]</strong> ${escapeHtml(p.title.slice(0, 42))}</td>
      <td><small>${escapeHtml(p.primary_model.slice(0, 22))}</small></td>
      <td>${p.root_turns}${p.sub_turns ? ` + ${p.sub_turns} (${p.sub_count}子)` : ''}</td>
      <td>${p.compactions > 0 ? `<span class="tag tag-bad">${p.compactions}次</span>` : '0'}</td>
      <td>${p.T_min}m</td>
      <td><strong>${p.C_units}U</strong></td>
      <td>
        <span class="tag ${p.ce_index >= 1.0 ? 'tag-ok' : 'tag-bad'}">${p.ce_index}x</span>
        ${p.prob_ce_pct !== undefined ? `<small style="color:#38bdf8"> (${p.prob_ce_pct}%)</small>` : ''}
      </td>
      <td>
        <input type="number" class="q-input" min="0" max="100" value="${p.Q_final}" data-uid="${escapeHtml(p.session_uid)}" />
        <button class="btn sm btn-save-q" data-uid="${escapeHtml(p.session_uid)}">保存</button>
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
        showStatus(`已保存会话 ${uid} 的真实质量分 (${val} 分)，全库 OLS 与 IRLS 模型已完成在线重训！`);
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
      <strong>预估实际轮数:</strong> ${res.effective_turns} 轮 (失忆 ${res.est_compactions} 次 | 生死线 ${res.learned_n_crit_50} 轮) &nbsp;|&nbsp;
      <strong>预估质量 Q:</strong> ${res.pred_Q} 分 &nbsp;|&nbsp;
      <strong>预估耗时 T:</strong> ${res.pred_T_min} 分钟 &nbsp;|&nbsp;
      <strong>预估额度 C:</strong> ${res.pred_C_units} U &nbsp;|&nbsp;
      <strong>高性价比概率 P_CE:</strong> <span style="color:#38bdf8;font-weight:800">${res.prob_ce_pct}%</span>
    </div>
    <div style="font-weight:700">${escapeHtml(res.verdict)}</div>
  `;
}

function renderAll(data) {
  if (!data || !data.kpis) return;
  currentData = data;
  if (data.realtime_meta?.version) {
    currentDataVersion = data.realtime_meta.version;
  }
  renderLivePulseStrip(data);
  renderOverview(data);
  renderRegressionChart();
  renderEvolutionTable(data);
  renderSesameAlerts(data);
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
        // 若用户正在输入质量分，暂不覆盖输入框焦点
        if (document.activeElement && document.activeElement.classList.contains('q-input')) return;
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

  document.getElementById('btnSync').addEventListener('click', async () => {
    showStatus('正在扫描全机所有 AI Agent 最新会话日志并在线重训全部数学模型...', 0);
    const plat = document.getElementById('platformFilter').value;
    const d = await callBackend('sync', { force: false, platform: plat });
    renderAll(d);
    updateSimulator();
    const si = d.sync_info || {};
    showStatus(`同步与重训完成！扫描 ${si.scanned_files || 0} 个文件，更新 ${si.updated_sessions || 0} 条样本 (${si.elapsed_ms || 0}ms)`);
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
    mcpApp = new App({ name: 'QTC Observatory', version: '1.1.0' }, {});
    mcpApp.ontoolresult = (result) => {
      if (result?.structuredContent?.kpis) {
        renderAll(result.structuredContent);
      }
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
