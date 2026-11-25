import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

let mcpApp = null;
let useHttpFallback = false;
let currentData = null;
let currentRegMode = 'power';

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

async function callBackend(action, payload = {}) {
  if (!useHttpFallback && mcpApp) {
    const toolMap = {
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
  // 独立本地 Web 浏览器模式
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
      <div class="sub">自动增量监测所有本地 Agent</div>
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

function renderRegressionChart() {
  if (!currentData) return;
  const svg = document.getElementById('regSvg');
  const tooltip = document.getElementById('chartTooltip');
  const titleEl = document.getElementById('regTitle');
  const formulaEl = document.getElementById('regFormula');

  const W = 860, H = 400;
  const pad = { l: 64, r: 28, t: 24, b: 48 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  let regObj, xLabel, yLabel, pts = [];
  if (currentRegMode === 'power') {
    regObj = currentData.regressions.power_law_cost_vs_turns;
    pts = regObj.points || [];
    xLabel = '交互轮数自然对数 ln(N)';
    yLabel = '原始额度对数 ln(C_raw)';
    titleEl.textContent = `双对数幂律膨胀回归 (n = ${regObj.n} 个真实会话)：轮数每翻倍，成本增至 ${(2 ** regObj.slope).toFixed(2)}×`;
    formulaEl.textContent = `ln(C) = ${regObj.slope} · ln(N) ${regObj.intercept >= 0 ? '+' : ''} ${regObj.intercept}   |   R² = ${regObj.r2}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'linear') {
    regObj = currentData.regressions.linear_throughput;
    pts = regObj.points || [];
    xLabel = '加权上下文总吞吐量 μ · N · L_mean (百万加权 Tokens)';
    yLabel = '实际加权额度消耗 C (Units)';
    titleEl.textContent = `物理计费吞吐纯线性回归 (n = ${regObj.n} 个真实会话)`;
    formulaEl.textContent = `C = ${regObj.slope} · (μ·N·L) ${regObj.intercept >= 0 ? '+' : ''} ${regObj.intercept}   |   R² = ${regObj.r2}   |   p = ${regObj.pValue}`;
  } else if (currentRegMode === 'quality') {
    regObj = currentData.regressions.quality_vs_turns;
    pts = regObj.points || [];
    xLabel = '项目总交互轮数对数 ln(N_tree)';
    yLabel = '真实质量得分 Q_final (0~100)';
    titleEl.textContent = `质量随轮数退化回归 (n = ${regObj.n} 个根项目)：红点为触发失忆压缩会话`;
    formulaEl.textContent = `Q = ${regObj.intercept} ${regObj.slope >= 0 ? '+' : ''} ${regObj.slope} · ln(N_tree)   |   r = ${regObj.r}   |   R² = ${regObj.r2}   |   p = ${regObj.pValue}`;
  } else {
    const pSpace = currentData.regressions.pareto_unit_space;
    pts = pSpace.points || [];
    regObj = { band: [] };
    xLabel = '单位产出时间对数 ln(T / W)  [越左越快 ←]';
    yLabel = '单位产出额度对数 ln(C / W)  [越下越省 ↓]';
    titleEl.textContent = `单位产出 (T/W, C/W) 帕累托空间分布 (左下角为高性价比黄金区，红点为捡芝麻丢西瓜异常)`;
    formulaEl.textContent = `中位十字基准线: ln(T/W) = ${pSpace.med_ln_T},  ln(C/W) = ${pSpace.med_ln_C}  |  悬停任意散点查看会话明细`;
  }

  if (!pts.length) {
    svg.innerHTML = `<text x="430" y="200" text-anchor="middle" fill="#94a3b8">当前筛选条件下样本不足 3 条</text>`;
    return;
  }

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxX - minX < 1e-3) { minX -= 1; maxX += 1; }
  if (maxY - minY < 1e-3) { minY -= 1; maxY += 1; }
  const dx = (maxX - minX) * 0.06;
  const dy = (maxY - minY) * 0.08;
  minX -= dx; maxX += dx; minY -= dy; maxY += dy;

  const sx = (v) => pad.l + ((v - minX) / (maxX - minX)) * plotW;
  const sy = (v) => pad.t + plotH - ((v - minY) / (maxY - minY)) * plotH;

  let out = '';
  // 网格线与刻度
  for (let i = 0; i <= 5; i++) {
    const xv = minX + (maxX - minX) * (i / 5);
    const px = sx(xv);
    out += `<line x1="${px}" y1="${pad.t}" x2="${px}" y2="${pad.t + plotH}" stroke="#334155" stroke-dasharray="3 3" stroke-width="1"/>`;
    out += `<text x="${px}" y="${H - 22}" text-anchor="middle" fill="#94a3b8" font-size="11">${xv.toFixed(1)}</text>`;

    const yv = minY + (maxY - minY) * (i / 5);
    const py = sy(yv);
    out += `<line x1="${pad.l}" y1="${py}" x2="${pad.l + plotW}" y2="${py}" stroke="#334155" stroke-dasharray="3 3" stroke-width="1"/>`;
    out += `<text x="${pad.l - 8}" y="${py + 4}" text-anchor="end" fill="#94a3b8" font-size="11">${yv.toFixed(1)}</text>`;
  }

  out += `<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="none" stroke="#475569" stroke-width="1.2"/>`;
  out += `<text x="${pad.l + plotW / 2}" y="${H - 4}" text-anchor="middle" fill="#cbd5e1" font-size="12" font-weight="600">${escapeHtml(xLabel)}</text>`;
  out += `<text x="16" y="${pad.t + plotH / 2}" text-anchor="middle" fill="#cbd5e1" font-size="12" font-weight="600" transform="rotate(-90 16 ${pad.t + plotH / 2})">${escapeHtml(yLabel)}</text>`;

  // 若是帕累托视图，画十字中位基准线
  if (currentRegMode === 'pareto') {
    const pSpace = currentData.regressions.pareto_unit_space;
    const mx = sx(pSpace.med_ln_T);
    const my = sy(pSpace.med_ln_C);
    out += `<line x1="${mx}" y1="${pad.t}" x2="${mx}" y2="${pad.t + plotH}" stroke="#38bdf8" stroke-dasharray="5 4" stroke-width="1.4"/>`;
    out += `<line x1="${pad.l}" y1="${my}" x2="${pad.l + plotW}" y2="${my}" stroke="#38bdf8" stroke-dasharray="5 4" stroke-width="1.4"/>`;
  }

  // 95% 置信区间阴影与 OLS 回归直线
  if (regObj.band && regObj.band.length >= 2) {
    const upper = regObj.band.map((b) => `${sx(b.x).toFixed(1)},${sy(b.hi).toFixed(1)}`).join(' ');
    const lower = [...regObj.band].reverse().map((b) => `${sx(b.x).toFixed(1)},${sy(b.lo).toFixed(1)}`).join(' ');
    out += `<polygon points="${upper} ${lower}" fill="rgba(244, 63, 94, 0.18)" />`;
    const b0 = regObj.band[0];
    const bLast = regObj.band[regObj.band.length - 1];
    out += `<line x1="${sx(b0.x)}" y1="${sy(b0.y)}" x2="${sx(bLast.x)}" y2="${sy(bLast.y)}" stroke="#f43f5e" stroke-width="2.6"/>`;
  }

  // 在双对数视图叠加斜率=1.0 理想无膨胀参考线
  if (currentRegMode === 'power' && regObj.band?.length) {
    const b0 = regObj.band[0];
    const bLast = regObj.band[regObj.band.length - 1];
    const yEndSlope1 = b0.y + 1.0 * (bLast.x - b0.x);
    out += `<line x1="${sx(b0.x)}" y1="${sy(b0.y)}" x2="${sx(bLast.x)}" y2="${sy(yEndSlope1)}" stroke="#10b981" stroke-dasharray="6 4" stroke-width="1.8"/>`;
  }

  // 真实会话散点
  pts.forEach((pt, idx) => {
    const cx = sx(pt.x);
    const cy = sy(pt.y);
    if (cx < pad.l || cx > pad.l + plotW || cy < pad.t || cy > pad.t + plotH) return;
    let fill = PLATFORM_COLORS[pt.platform] || '#38bdf8';
    let r = pt.is_sub ? 3.8 : 5.6;
    if (currentRegMode === 'quality' && pt.comp > 0) { fill = '#ef4444'; r = 6.5; }
    if (currentRegMode === 'pareto') {
      fill = pt.flag === 'healthy' ? '#10b981' : '#ef4444';
      r = 6.0;
    }
    out += `<circle class="pt-dot" data-idx="${idx}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}" fill-opacity="0.82" stroke="#0f172a" stroke-width="1"/>`;
  });

  svg.innerHTML = out;

  svg.querySelectorAll('.pt-dot').forEach((circle) => {
    circle.addEventListener('mouseenter', (ev) => {
      const idx = Number(circle.getAttribute('data-idx'));
      const pt = pts[idx];
      tooltip.innerHTML = `
        <div><strong>${escapeHtml(pt.platform)}</strong> · ${escapeHtml(pt.uid.slice(0, 16))}</div>
        <div style="color:#94a3b8;margin:2px 0">${escapeHtml(pt.title || '')}</div>
        <div>坐标: (${pt.x}, ${pt.y}) ${pt.ce ? `| CE=${pt.ce}` : ''} ${pt.comp !== undefined ? `| 失忆=${pt.comp}` : ''}</div>
      `;
      tooltip.classList.remove('hidden');
      const rect = svg.parentElement.getBoundingClientRect();
      tooltip.style.left = `${Math.min(rect.width - 260, Math.max(10, ev.clientX - rect.left + 12))}px`;
      tooltip.style.top = `${Math.max(10, ev.clientY - rect.top - 20)}px`;
    });
    circle.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });
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
    <span><strong>实时回归标定常数 (基于 ${pr.sample_basis_count} 个真实样本)：</strong></span>
    <span>轮数膨胀指数 β = <strong>${ec.turn_cost_exponent}</strong> (轮数翻倍成本 ×${ec.double_turns_cost_mult})</span>
    <span>失忆压缩质量断崖 ΔQ = <strong style="color:#fb7185">-${ec.compaction_quality_drop} 分</strong></span>
    <span>单轮底噪 = <strong>${ec.base_turn_overhead_sec}s</strong> + <strong>${ec.sec_per_1k_output_tok}s</strong>/千输出Token</span>
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
      <td><span class="tag ${p.ce_index >= 1.0 ? 'tag-ok' : 'tag-bad'}">${p.ce_index}x</span></td>
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
        showStatus(`已保存会话 ${uid} 的人工真实质量分 (${val} 分)，并重算全库回归模型！`);
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
      <strong>预估实际轮数:</strong> ${res.effective_turns} 轮 (失忆 ${res.est_compactions} 次) &nbsp;|&nbsp;
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
  renderOverview(data);
  renderRegressionChart();
  renderSesameAlerts(data);
  renderPrescriptions(data);
  renderSamplesTable(data, document.getElementById('searchBox').value);
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

  document.getElementById('platformFilter').addEventListener('change', async (e) => {
    const d = await callBackend('dashboard', { platform: e.target.value });
    renderAll(d);
  });

  document.getElementById('btnSync').addEventListener('click', async () => {
    showStatus('正在只读扫描全机所有 AI Agent 最新会话日志...', 0);
    const plat = document.getElementById('platformFilter').value;
    const d = await callBackend('sync', { force: false, platform: plat });
    renderAll(d);
    const si = d.sync_info || {};
    showStatus(`增量同步完成！扫描 ${si.scanned_files || 0} 个文件，新增/更新 ${si.updated_sessions || 0} 条样本 (${si.elapsed_ms || 0}ms)`);
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
  // 判断当前是在 Antigravity MCP App iframe 内，还是独立本地 HTTP 浏览器内
  const isStandaloneHttp = window.location.protocol.startsWith('http') && window.parent === window;
  if (isStandaloneHttp) {
    useHttpFallback = true;
    const d = await callBackend('dashboard', { platform: 'all' });
    renderAll(d);
    updateSimulator();
    return;
  }

  try {
    mcpApp = new App({ name: 'QTC Observatory', version: '1.0.0' }, {});
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
  } catch {
    useHttpFallback = true;
    const d = await callBackend('dashboard', { platform: 'all' });
    renderAll(d);
    updateSimulator();
  }
}

boot();
