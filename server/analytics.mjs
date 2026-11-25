/**
 * QTC Observatory v1.2.0 — 因果对照差分、额度耗用率微分守恒与在线自修正计量引擎
 *
 * 核心数学重构（解决“跟谁比”与“什么是任务完成质量”两大根本问题）：
 *   1. 任务完成质量 Q_task ∈ [0, 100]：严格度量任务交付达成度与终局用户验收，彻底剥离中间命令报错与压缩次数噪声；人工评分 q_human 拥有最高覆盖权。
 *   2. 严禁无基线瞎比！构建严格的【对照基线 B -> 实验组/新阶段 A】受控因果配对框架：
 *      - 一级自对照：同一长任务中途注入「加速/优化方案」或「新批次方案」前后对照 (Phase B -> Phase A)
 *      - 二级跨会话对照：同一工程目录 (project_key) 下先后迭代的两个独立执行会话对照 (Session B -> Session A)
 *      - 三级长会话膨胀审计：同一长任务 (>85轮) 前期清爽基线段 vs 后期上下文累积段耗用率漂移对照
 *   3. 功率-速度微分守恒定律：
 *      定义额度耗用率（功率） C_dot = C / T (U/h)，省时率 s_T = (T_B - T_A) / T_B，耗用率增幅 r_burn = (C_dot_A - C_dot_B) / C_dot_B。
 *      则相对总成本变化精确服从： C_A / C_B = (1 + r_burn) * (1 - s_T)
 *      等成本零溢价耗用率上限： r_burn_neutral(s_T) = s_T / (1 - s_T)
 *      一旦 r_burn >> s_T / (1 - s_T) 且 ΔQ ≈ 0，即构成精确数学意义上的「时间没省多少，额度耗用率反而剧增（捡芝麻丢西瓜）」！
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
}

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(z) {
  return 0.5 * (1.0 + erf(z / Math.SQRT2));
}

function sigmoid(z) {
  const cz = Math.max(-30, Math.min(30, z));
  return 1.0 / (1.0 + Math.exp(-cz));
}

function solveLinearSystem(A, b) {
  const d = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < d; col++) {
    let pivot = col;
    for (let r = col + 1; r < d; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) continue;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let j = col; j <= d; j++) M[col][j] /= div;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let j = col; j <= d; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map((row) => row[d]);
}

export function multipleOlsFit(X, y, ridge = 1e-6) {
  const n = X.length;
  const d = X[0]?.length || 0;
  if (n < d + 2 || d === 0) return { beta: new Array(d).fill(0), r2: 0, n };

  const XtX = Array.from({ length: d }, () => new Array(d).fill(0));
  const Xty = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = j; k < d; k++) XtX[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < d; j++) {
    for (let k = 0; k < j; k++) XtX[j][k] = XtX[k][j];
    if (j > 0) XtX[j][j] += ridge;
  }

  const beta = solveLinearSystem(XtX, Xty);
  const meanY = y.reduce((a, v) => a + v, 0) / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let j = 0; j < d; j++) pred += X[i][j] * beta[j];
    ssTot += (y[i] - meanY) ** 2;
    ssRes += (y[i] - pred) ** 2;
  }
  const r2 = ssTot > 1e-12 ? Math.max(0, Math.min(1, 1.0 - ssRes / ssTot)) : 0;
  return {
    beta: beta.map((v) => Number(v.toFixed(4))),
    r2: Number(r2.toFixed(4)),
    n,
  };
}

export function fitOnlineLogisticRegression(X, y, l2Lambda = 0.12, maxIter = 28) {
  const n = X.length;
  const d = X[0]?.length || 0;
  if (n < 6 || d === 0) {
    return { weights: new Array(d).fill(0), accuracy: 0, n, converged: false };
  }
  let w = new Array(d).fill(0);
  let converged = false;
  const posCount = y.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);
  const posRate = Math.min(0.92, Math.max(0.08, posCount / n));
  const cwPos = 0.5 / posRate;
  const cwNeg = 0.5 / (1.0 - posRate);

  for (let iter = 0; iter < maxIter; iter++) {
    const grad = new Array(d).fill(0);
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < d; j++) z += X[i][j] * w[j];
      const p = sigmoid(z);
      const sw = y[i] > 0 ? cwPos : cwNeg;
      const diff = sw * (p - y[i]);
      const weight = sw * Math.max(1e-5, p * (1.0 - p));
      for (let j = 0; j < d; j++) {
        grad[j] += X[i][j] * diff;
        for (let k = j; k < d; k++) H[j][k] += weight * X[i][j] * X[i][k];
      }
    }
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < j; k++) H[j][k] = H[k][j];
      if (j > 0) {
        grad[j] += 2.0 * l2Lambda * w[j];
        H[j][j] += 2.0 * l2Lambda;
      } else {
        H[j][j] += 1e-5;
      }
    }
    const step = solveLinearSystem(H, grad);
    let maxDelta = 0;
    for (let j = 0; j < d; j++) {
      w[j] -= step[j];
      if (Math.abs(step[j]) > maxDelta) maxDelta = Math.abs(step[j]);
    }
    if (maxDelta < 1e-5) {
      converged = true;
      break;
    }
  }

  let correct = 0;
  for (let i = 0; i < n; i++) {
    let z = 0;
    for (let j = 0; j < d; j++) z += X[i][j] * w[j];
    const pred = sigmoid(z) >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  return {
    weights: w.map((v) => Number(v.toFixed(4))),
    accuracy: Number(((correct / n) * 100).toFixed(1)),
    n,
    converged,
  };
}

export function olsLinearRegression(xs, ys, pointsForBand = 40) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) {
    return { n, slope: 0, intercept: 0, r: 0, r2: 0, pValue: 1, seSlope: 0, band: [] };
  }
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx <= 1e-12 || syy <= 1e-12) {
    return { n, slope: 0, intercept: meanY, r: 0, r2: 0, pValue: 1, seSlope: 0, band: [] };
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r = sxy / Math.sqrt(sxx * syy);
  const r2 = Math.max(0, Math.min(1, r * r));

  let sse = 0;
  for (let i = 0; i < n; i++) {
    const err = ys[i] - (intercept + slope * xs[i]);
    sse += err * err;
  }
  const dof = Math.max(1, n - 2);
  const sErr = Math.sqrt(sse / dof);
  const seSlope = sErr / Math.sqrt(sxx);
  const tStat = Math.abs(slope / Math.max(1e-12, seSlope));
  const pValue = Math.max(1e-99, 2.0 * (1.0 - normCdf(tStat)));

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const band = [];
  const z95 = 1.96;
  for (let k = 0; k < pointsForBand; k++) {
    const xv = minX + (maxX - minX) * (k / (pointsForBand - 1));
    const yHat = intercept + slope * xv;
    const ci = z95 * sErr * Math.sqrt(1.0 / n + ((xv - meanX) ** 2) / sxx);
    band.push({
      x: Number(xv.toFixed(4)),
      y: Number(yHat.toFixed(4)),
      lo: Number((yHat - ci).toFixed(4)),
      hi: Number((yHat + ci).toFixed(4)),
    });
  }

  return {
    n,
    slope: Number(slope.toFixed(5)),
    intercept: Number(intercept.toFixed(5)),
    r: Number(r.toFixed(4)),
    r2: Number(r2.toFixed(4)),
    tStat: Number(tStat.toFixed(2)),
    pValue: Number(pValue.toExponential(2)),
    seSlope: Number(seSlope.toFixed(5)),
    band,
  };
}

/**
 * 统一的「基线 B vs 实验组 A」因果差分与等质量性价比概率核
 * 严格遵循恒等式： (C_A / M_A) / (C_B / M_B) = (1 + r_burn) * (1 - s_T)
 */
export function evaluateCounterfactualPair({
  pairId,
  pairCategory,     // 'replacement' (等效任务提速/换方案对照) | 'cross_project' (同项目跨会话对照) | 'bloat_drift' (同会话上下文膨胀审计)
  comparisonScope,  // 人类可读的对照范围说明
  platform,
  domain,
  title,
  triggerNote = '',
  advisorInfo = null,
  base,   // { uid, label, turns, subCount, T_min, C_u, sub_C_u, Q_task, scaleM }
  target, // { uid, label, turns, subCount, T_min, C_u, sub_C_u, Q_task, scaleM }
}) {
  const mB = Math.max(0.1, Number(base.scaleM || 1.0));
  const mA = Math.max(0.1, Number(target.scaleM || 1.0));

  const burnB = base.C_u / Math.max(0.02, base.T_min / 60.0);     // U/h
  const burnA = target.C_u / Math.max(0.02, target.T_min / 60.0); // U/h
  const burnSurgePct = ((burnA - burnB) / Math.max(0.05, burnB)) * 100.0;

  // 若是同会话长上下文膨胀审计（前后阶段功能体量不同），按「单轮耗时 & 小时耗用率」对齐，绝不捏造虚假阶段总时长省时率！
  const unitTimeB = pairCategory === 'bloat_drift'
    ? base.T_min / Math.max(1, base.turns)
    : base.T_min / mB;
  const unitTimeA = pairCategory === 'bloat_drift'
    ? target.T_min / Math.max(1, target.turns)
    : target.T_min / mA;

  const unitCostB = pairCategory === 'bloat_drift'
    ? base.C_u / Math.max(1, base.turns)
    : base.C_u / mB;
  const unitCostA = pairCategory === 'bloat_drift'
    ? target.C_u / Math.max(1, target.turns)
    : target.C_u / mA;

  const timeSavedPct = ((unitTimeB - unitTimeA) / Math.max(1e-4, unitTimeB)) * 100.0;
  const costSurgePct = ((unitCostA - unitCostB) / Math.max(1e-5, unitCostB)) * 100.0;
  const deltaQ = target.Q_task - base.Q_task;

  // 等成本零溢价所能容忍的最大耗用率增幅： r_burn_neutral = s_T / (1 - s_T)
  const sFrac = Math.min(0.85, Math.max(-2.0, timeSavedPct / 100.0));
  const neutralBurnPct = sFrac > 0 ? (sFrac / (1.0 - sFrac)) * 100.0 : 0.0;

  // 等质量硬门控性价比概率 P_CE(A | B)
  // 1) 任务完成质量绝对达标门控: Q_A >= 80
  // 2) 任务完成质量不退步门控: ΔQ >= -3.0
  // 3) 耗用率-提速守恒核: 惩罚超出零溢价曲线的额外耗用率暴涨
  const gateAbsQ = sigmoid((target.Q_task - 76.0) / 4.5);
  const gateDeltaQ = sigmoid((deltaQ + 3.5) / 2.2);
  const excessCostLog = Math.log(Math.max(0.05, unitCostA / Math.max(1e-5, unitCostB)));
  const speedGainLog = Math.log(Math.max(0.05, unitTimeB / Math.max(1e-4, unitTimeA)));
  const tradeOffScore = 0.65 + 1.35 * speedGainLog - 2.15 * excessCostLog + 0.04 * deltaQ;
  const probCePct = Number((gateAbsQ * gateDeltaQ * sigmoid(tradeOffScore) * 100.0).toFixed(1));

  let aerRatio = 0;
  if (costSurgePct > 0 && timeSavedPct > 0) {
    aerRatio = Number((costSurgePct / Math.max(1.0, timeSavedPct)).toFixed(2));
  } else if (costSurgePct > 0 && timeSavedPct <= 0) {
    aerRatio = 99.9;
  }

  let verdictCode = 'pareto-win';
  let verdictLabel = '🟢 正向合算优化';
  const reasons = [];

  if (deltaQ <= -8.0 || target.Q_task < 65.0) {
    verdictCode = 'quality-collapse';
    verdictLabel = '🔴 质量失守翻车 (任务完成质量下降)';
    reasons.push(`任务完成质量从 ${base.Q_task} 分跌至 ${target.Q_task} 分 (ΔQ = ${deltaQ.toFixed(1)})，违背质量保持前提`);
  } else if (pairCategory === 'bloat_drift') {
    // 长会话膨胀审计中，后台编译/生图长等待不应误判为“变慢恶化”，仅当小时额度耗用率实质飙升时才告警
    if (burnSurgePct > 30.0 && costSurgePct > 20.0) {
      verdictCode = 'burn-surge';
      verdictLabel = '🟠 长会话上下文耗用率膨胀';
    }
  } else if (costSurgePct > 25.0 && timeSavedPct <= 0 && burnSurgePct > 10.0) {
    verdictCode = 'lose-lose';
    verdictLabel = '🔴 双输恶化 (未省时且耗用率/成本更高)';
  } else if (costSurgePct > 25.0 && timeSavedPct > 0 && aerRatio > 1.5) {
    verdictCode = 'sesame-for-watermelon';
    verdictLabel = '🟠 捡芝麻丢西瓜 (微弱省时但耗用率剧增)';
  } else if (burnSurgePct > 45.0 && costSurgePct > 20.0) {
    verdictCode = 'burn-surge';
    verdictLabel = '🟠 额度耗用率异常膨胀';
  }

  if (burnSurgePct > 25.0) {
    reasons.push(`小时额度耗用率从 ${burnB.toFixed(2)} U/h 飙升至 ${burnA.toFixed(2)} U/h (${burnSurgePct >= 0 ? '+' : ''}${burnSurgePct.toFixed(1)}%，零溢价容忍上限仅 +${neutralBurnPct.toFixed(1)}%)`);
  }
  if (target.sub_C_u > 0.5 && target.sub_C_u > base.sub_C_u + 0.5) {
    reasons.push(`新方案额外拉起 ${target.subCount} 个子代理并发吞吐，净增子代理账单 +${(target.sub_C_u - base.sub_C_u).toFixed(2)}U`);
  }
  if (pairCategory === 'bloat_drift' && costSurgePct > 25.0) {
    reasons.push(`长会话未分阶段清零历史上下文，单轮均摊成本从 ${unitCostB.toFixed(3)}U 涨至 ${unitCostA.toFixed(3)}U (+${costSurgePct.toFixed(1)}%)`);
  }
  if (advisorInfo) {
    reasons.push(`关联外部优化方案咨询会话 (${advisorInfo.uid.slice(0, 12)}) 额外消耗规划成本 +${advisorInfo.cost_u.toFixed(2)}U`);
  }
  if (!reasons.length) {
    reasons.push(`质量保持/提升 (ΔQ=${deltaQ >= 0 ? '+' : ''}${deltaQ.toFixed(1)})，耗用率与速度处于合理均衡区间`);
  }

  // 超出等成本基准线的净多花冤枉额度估算
  const fairCostForOutput = base.C_u * (pairCategory === 'bloat_drift' ? (target.turns / Math.max(1, base.turns)) : (mA / mB));
  const excessCostU = Math.max(0, Number((target.C_u - fairCostForOutput + (advisorInfo ? advisorInfo.cost_u : 0)).toFixed(2)));

  return {
    pair_id: pairId,
    pair_category: pairCategory,
    comparison_scope: comparisonScope,
    platform,
    domain,
    title,
    trigger_note: triggerNote,
    advisor_info: advisorInfo,
    base: {
      uid: base.uid,
      label: base.label,
      turns: base.turns,
      sub_count: base.subCount,
      T_min: Number(base.T_min.toFixed(1)),
      C_u: Number(base.C_u.toFixed(2)),
      burn_uh: Number(burnB.toFixed(2)),
      Q_task: Number(base.Q_task.toFixed(1)),
    },
    target: {
      uid: target.uid,
      label: target.label,
      turns: target.turns,
      sub_count: target.subCount,
      T_min: Number(target.T_min.toFixed(1)),
      C_u: Number(target.C_u.toFixed(2)),
      burn_uh: Number(burnA.toFixed(2)),
      Q_task: Number(target.Q_task.toFixed(1)),
    },
    deltas: {
      delta_Q: Number(deltaQ.toFixed(1)),
      time_saved_pct: Number(timeSavedPct.toFixed(1)),
      burn_surge_pct: Number(burnSurgePct.toFixed(1)),
      neutral_burn_limit_pct: Number(neutralBurnPct.toFixed(1)),
      cost_surge_pct: Number(costSurgePct.toFixed(1)),
      aer_ratio: aerRatio,
      excess_cost_u: excessCostU,
      prob_ce_pct: probCePct,
    },
    verdict_code: verdictCode,
    verdict_label: verdictLabel,
    is_bad_tradeoff: verdictCode !== 'pareto-win',
    reasons,
  };
}

let latestLearnedModel = {
  throughput_slope: 0.276,
  throughput_intercept: 0.20,
  power_alpha: 1.25,
  q_intercept: 95.0,
  q_slope_lnN: -1.5,
  lat_base_sec: 5.0,
  lat_per_out_k: 6.2,
  lat_per_ctx_100k: 1.1,
  burn_base_uh: 6.5,
  burn_per_sub_ratio: 14.0,
  w_live: [2.5, -0.6, -0.8, -0.4],
  n_crit_50: 45.0,
};

export function getLatestLearnedModel() {
  return latestLearnedModel;
}

export function computeObservatoryAnalytics(db, filterPlatform = 'all') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_evolution (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_count INTEGER NOT NULL,
      total_turns INTEGER DEFAULT 0,
      power_slope REAL NOT NULL,
      linear_slope REAL NOT NULL,
      q_decay_slope REAL NOT NULL,
      n_crit_50 REAL NOT NULL,
      elasticity_tc_ratio REAL NOT NULL,
      logit_acc REAL NOT NULL,
      recorded_at INTEGER NOT NULL
    );
  `);
  const evoCols = db.prepare('PRAGMA table_info(model_evolution)').all().map((c) => c.name);
  if (!evoCols.includes('total_turns')) {
    db.exec('ALTER TABLE model_evolution ADD COLUMN total_turns INTEGER DEFAULT 0');
  }

  const allRows = db.prepare(`
    SELECT s.*, h.q_human, h.note AS human_note
    FROM sessions s
    LEFT JOIN human_ratings h ON s.session_uid = h.session_uid
    ORDER BY s.ended_at DESC, s.started_at DESC
  `).all();

  const phaseRows = db.prepare('SELECT * FROM session_phases').all();
  const phaseByUid = new Map(phaseRows.map((p) => [p.session_uid, p]));

  const turnSamples = db.prepare(`
    SELECT platform, model_tier, ctx_k, out_k, llm_sec, n_tools, step_cost_u
    FROM turn_samples
    ORDER BY rowid DESC
    LIMIT 6500
  `).all();

  const nowSec = Date.now() / 1000;
  const liveActiveSessions = allRows
    .filter((r) => r.ended_at > 0 && (nowSec - r.ended_at) <= 900)
    .slice(0, 8)
    .map((r) => ({
      session_uid: r.session_uid,
      platform: r.platform,
      title: r.title,
      primary_model: r.primary_model,
      turns: r.planner_turns,
      ctx_k: r.max_ctx_k,
      cost_u: Number(r.weighted_cost_units.toFixed(3)),
      exec_min: r.exec_time_min,
      seconds_ago: Math.max(0, Math.round(nowSec - r.ended_at)),
    }));

  const byUid = new Map(allRows.map((r) => [r.session_uid, r]));
  const childrenMap = new Map();
  for (const r of allRows) {
    if (r.parent_uid && byUid.has(r.parent_uid)) {
      if (!childrenMap.has(r.parent_uid)) childrenMap.set(r.parent_uid, []);
      childrenMap.get(r.parent_uid).push(r);
    }
  }

  function getDescendants(uid, visited = new Set()) {
    const kids = childrenMap.get(uid) || [];
    for (const k of kids) {
      if (!visited.has(k.session_uid)) {
        visited.add(k.session_uid);
        getDescendants(k.session_uid, visited);
      }
    }
    return [...visited].map((id) => byUid.get(id));
  }

  // 识别指向特定目标会话的外部「优化方案咨询会话 (advisor)」，将其规划成本关联到目标会话上
  const advisorMap = new Map(); // target_uid -> { uid, cost_u, title }
  for (const r of allRows) {
    if (r.session_role === 'advisor') {
      let links = [];
      try { links = JSON.parse(r.linked_uids || '[]'); } catch {}
      for (const targetUid of links) {
        if (byUid.has(targetUid)) {
          advisorMap.set(targetUid, {
            uid: r.session_uid,
            cost_u: Number(r.weighted_cost_units.toFixed(3)),
            T_min: Number(r.exec_time_min.toFixed(1)),
            title: r.title,
          });
        }
      }
    }
  }

  const filteredSessions = filterPlatform === 'all'
    ? allRows
    : allRows.filter((r) => r.platform === filterPlatform);

  const rootProjects = [];
  for (const r of filteredSessions) {
    if (r.is_subagent && r.parent_uid && byUid.has(r.parent_uid)) continue;
    if (r.is_subagent && r.planner_turns < 3) continue;

    const subs = getDescendants(r.session_uid);
    const subTurns = subs.reduce((a, x) => a + x.planner_turns, 0);
    const subCost = subs.reduce((a, x) => a + x.weighted_cost_units, 0);
    const treeTurns = r.planner_turns + subTurns;
    const treeCost = r.weighted_cost_units + subCost;
    const treeRawCost = r.raw_cost_units + subs.reduce((a, x) => a + x.raw_cost_units, 0);
    const totCmd = r.cmd_total + subs.reduce((a, x) => a + x.cmd_total, 0);
    const totFail = r.cmd_failed + subs.reduce((a, x) => a + x.cmd_failed, 0);
    const errRate = totCmd > 0 ? totFail / totCmd : 0;

    const execMin = Math.max(0.15, r.exec_time_min);
    const burnRateUh = treeCost / Math.max(0.02, execMin / 60.0);
    const qTask = r.q_human !== null && r.q_human !== undefined ? Number(r.q_human) : Number(r.q_objective);

    rootProjects.push({
      session_uid: r.session_uid,
      platform: r.platform,
      session_role: r.session_role || 'execution',
      project_key: r.project_key || '',
      domain: r.domain,
      title: r.title,
      primary_model: r.primary_model,
      model_tier: r.model_tier,
      model_mult: r.model_mult,
      token_accuracy: r.token_accuracy,
      started_at: r.started_at,
      ended_at: r.ended_at,
      root_turns: r.planner_turns,
      sub_count: subs.length,
      sub_turns: subTurns,
      tree_turns: treeTurns,
      compactions: r.compactions,
      single_tool_ratio: r.planner_turns > 0 ? Number((r.single_tool_turns / r.planner_turns).toFixed(3)) : 0,
      cmd_err_rate: Number(errRate.toFixed(4)),
      mean_ctx_k: r.mean_ctx_k,
      max_ctx_k: r.max_ctx_k,
      cache_tax_share: r.cache_tax_share,
      T_min: Number(execMin.toFixed(2)),
      root_C: Number(r.weighted_cost_units.toFixed(4)),
      sub_C: Number(subCost.toFixed(4)),
      C_units: Number(treeCost.toFixed(4)),
      raw_C_units: Number(treeRawCost.toFixed(4)),
      burn_uh: Number(burnRateUh.toFixed(2)),
      Q_obj: r.q_objective,
      Q_human: r.q_human,
      Q_final: Number(qTask.toFixed(1)),
    });
  }

  // ==========================================================================
  // 构建受控因果对照实验对 (Counterfactual Pairs) —— 100% 明确「谁和谁比」！
  // ==========================================================================
  const counterfactualPairs = [];

  // 1. 一级对照：会话内策略变更 / 加速方案介入 / 长上下文膨胀对照
  for (const p of rootProjects) {
    const ph = phaseByUid.get(p.session_uid);
    if (!ph) continue;
    let bSubs = [], aSubs = [];
    try { bSubs = JSON.parse(ph.b_sub_uids || '[]'); } catch {}
    try { aSubs = JSON.parse(ph.a_sub_uids || '[]'); } catch {}

    const bSubCost = bSubs.reduce((acc, id) => acc + (byUid.get(id)?.weighted_cost_units || 0), 0);
    const aSubCost = aSubs.reduce((acc, id) => acc + (byUid.get(id)?.weighted_cost_units || 0), 0);

    // 若用户对整场会话手工标定了真实质量分 q_human，则按同比例平移校准两阶段质量分
    const humanShift = (p.Q_human !== null && p.Q_human !== undefined) ? (p.Q_human - p.Q_obj) : 0;
    const bQ = Math.min(100, Math.max(20, ph.b_q_task + humanShift));
    const aQ = Math.min(100, Math.max(20, ph.a_q_task + humanShift));

    const isBloatAudit = ph.split_kind.includes('长上下文耗用率对照');
    const pairCat = isBloatAudit ? 'bloat_drift' : 'replacement';
    const adv = !isBloatAudit ? (advisorMap.get(p.session_uid) || null) : null;

    counterfactualPairs.push(evaluateCounterfactualPair({
      pairId: `intra:${p.session_uid}`,
      pairCategory: pairCat,
      comparisonScope: ph.split_kind,
      platform: p.platform,
      domain: p.domain,
      title: p.title,
      triggerNote: ph.trigger_summary,
      advisorInfo: adv,
      base: {
        uid: p.session_uid,
        label: `【基线 B】本任务${ph.b_label}`,
        turns: ph.b_turns,
        subCount: bSubs.length,
        T_min: ph.b_exec_min,
        C_u: ph.b_main_cost_u + bSubCost,
        sub_C_u: bSubCost,
        Q_task: bQ,
        scaleM: 1.0,
      },
      target: {
        uid: p.session_uid,
        label: `【实验 A】本任务${ph.a_label}`,
        turns: ph.a_turns,
        subCount: aSubs.length,
        T_min: ph.a_exec_min,
        C_u: ph.a_main_cost_u + aSubCost,
        sub_C_u: aSubCost,
        Q_task: aQ,
        scaleM: 1.0,
      },
    }));
  }

  // 2. 二级对照：同一具体工程目录 (project_key) 下前后相邻的实质执行会话对照 (排除探针与咨询会话)
  const byProjectKey = new Map();
  for (const p of rootProjects) {
    if (p.session_role !== 'execution' || !p.project_key || p.root_turns < 15 || p.C_units < 0.8) continue;
    if (!byProjectKey.has(p.project_key)) byProjectKey.set(p.project_key, []);
    byProjectKey.get(p.project_key).push(p);
  }
  for (const [projKey, list] of byProjectKey.entries()) {
    if (list.length < 2) continue;
    const chron = [...list].sort((a, b) => a.started_at - b.started_at);
    for (let i = 1; i < chron.length; i++) {
      const prev = chron[i - 1];
      const curr = chron[i];
      // 仅当两场会话属于同量级任务（轮数比在 0.35x ~ 2.8x 内）时才构成跨会话等效任务对照，杜绝拿小修补跟大开发硬比！
      const turnRatio = curr.tree_turns / Math.max(1, prev.tree_turns);
      if (turnRatio < 0.35 || turnRatio > 2.8) continue;

      counterfactualPairs.push(evaluateCounterfactualPair({
        pairId: `cross:${prev.session_uid}->${curr.session_uid}`,
        pairCategory: 'cross_project',
        comparisonScope: `同一工程目录跨会话迭代对照 (${projKey})`,
        platform: curr.platform,
        domain: curr.domain,
        title: curr.title,
        triggerNote: `对比同目录前序会话 ${prev.session_uid.slice(0, 14)} (${prev.primary_model}) -> 当前 (${curr.primary_model})`,
        advisorInfo: advisorMap.get(curr.session_uid) || null,
        base: {
          uid: prev.session_uid,
          label: `【基线 B】同工程前序会话 ${prev.session_uid.split(':')[1]?.slice(0, 8) || prev.session_uid}`,
          turns: prev.tree_turns,
          subCount: prev.sub_count,
          T_min: prev.T_min,
          C_u: prev.C_units,
          sub_C_u: prev.sub_C,
          Q_task: prev.Q_final,
          scaleM: 1.0,
        },
        target: {
          uid: curr.session_uid,
          label: `【实验 A】同工程后续会话 ${curr.session_uid.split(':')[1]?.slice(0, 8) || curr.session_uid}`,
          turns: curr.tree_turns,
          subCount: curr.sub_count,
          T_min: curr.T_min,
          C_u: curr.C_units,
          sub_C_u: curr.sub_C,
          Q_task: curr.Q_final,
          scaleM: 1.0,
        },
      }));
    }
  }

  // 排序：优先展示一级同任务提速/方案对照与严重不合算案例
  counterfactualPairs.sort((a, b) => {
    const catRank = (x) => (x.pair_category === 'replacement' ? 0 : x.pair_category === 'cross_project' ? 1 : 2);
    if (a.is_bad_tradeoff !== b.is_bad_tradeoff) return a.is_bad_tradeoff ? -1 : 1;
    if (catRank(a) !== catRank(b)) return catRank(a) - catRank(b);
    return b.deltas.excess_cost_u - a.deltas.excess_cost_u;
  });

  const badPairs = counterfactualPairs.filter((x) => x.is_bad_tradeoff);

  // ==========================================================================
  // 在线实时重训练 6 组数学模型（OLS + Multiple OLS + 类别均衡 IRLS Logistic）
  // ==========================================================================
  const validSess = filteredSessions.filter((s) => s.planner_turns >= 2 && s.raw_cost_units > 1e-5);
  const regPowerLaw = olsLinearRegression(
    validSess.map((s) => Math.log(s.planner_turns)),
    validSess.map((s) => Math.log(s.raw_cost_units))
  );

  const nonOutlierSess = validSess.filter((s) => s.weighted_cost_units < 180);
  const regLinearThroughput = olsLinearRegression(
    nonOutlierSess.map((s) => (s.model_mult * s.planner_turns * s.mean_ctx_k) / 1000.0),
    nonOutlierSess.map((s) => s.weighted_cost_units)
  );

  const execRoots = rootProjects.filter((p) => p.session_role === 'execution' && p.tree_turns >= 6);
  const regQualityVsTurns = olsLinearRegression(
    execRoots.map((p) => Math.log(p.tree_turns)),
    execRoots.map((p) => p.Q_final)
  );

  const filtTurns = (filterPlatform === 'all' ? turnSamples : turnSamples.filter((t) => t.platform === filterPlatform))
    .filter((t) => t.out_k > 0.02 && t.out_k <= 14 && t.llm_sec >= 0.4 && t.llm_sec <= 160);
  const regTurnLatency = olsLinearRegression(
    filtTurns.map((t) => t.out_k),
    filtTurns.map((t) => t.llm_sec)
  );
  const multTurnFit = multipleOlsFit(
    filtTurns.map((t) => [1.0, t.out_k, t.ctx_k / 100.0]),
    filtTurns.map((t) => t.llm_sec)
  );

  // 为每个执行项目计算「等质量基准下的耗用率效率达标标签」：任务完成质量达标 (Q >= 88) 且未发生高耗用率失控
  const medBurnByDomain = new Map();
  for (const p of execRoots) {
    if (!medBurnByDomain.has(p.domain)) medBurnByDomain.set(p.domain, []);
    medBurnByDomain.get(p.domain).push(p.burn_uh);
  }
  for (const p of rootProjects) {
    const domBurns = medBurnByDomain.get(p.domain) || [8.0];
    const medBurn = Math.max(1.0, quantile(domBurns, 0.50));
    const burnRatio = p.burn_uh / medBurn;
    p.rel_burn_ratio = Number(burnRatio.toFixed(2));
    // 任务完成质量门控性价比指数：高完成质量且不盲目拉爆小时额度功率
    const qGate = p.Q_final >= 80 ? (p.Q_final / 100.0) ** 2 : (p.Q_final / 100.0) ** 4;
    p.ce_index = Number((qGate / Math.sqrt(Math.max(0.15, burnRatio))).toFixed(2));
    p.is_high_ce = (p.Q_final >= 88.0 && burnRatio <= 1.25) ? 1 : 0;
  }

  const XLive = execRoots.map((p) => [
    1.0,
    Math.log(Math.max(1, p.tree_turns)),
    p.max_ctx_k / 100.0,
    p.compactions,
  ]);
  const yLive = execRoots.map((p) => p.is_high_ce);
  const logitLiveModel = fitOnlineLogisticRegression(XLive, yLive, 0.15);
  const wL = logitLiveModel.weights;

  let dynamicNCrit50 = 48.0;
  if (wL.length === 4 && wL[1] < -0.05) {
    const lnNc = -(wL[0] + wL[2] * 0.65) / wL[1];
    dynamicNCrit50 = Number(Math.min(200, Math.max(18, Math.exp(lnNc))).toFixed(1));
  }

  for (let i = 0; i < execRoots.length; i++) {
    const p = execRoots[i];
    const xs = XLive[i];
    const z = wL[0] + wL[1] * xs[1] + wL[2] * xs[2] + wL[3] * xs[3];
    p.prob_ce_pct = Number((sigmoid(z) * 100).toFixed(1));
  }

  // 多元回归拟合「小时额度耗用率功率方程」: BurnRate(U/h) = β0 + β1 * ModelMult + β2 * MeanCtx_100k + β3 * SubDensity
  const burnFit = multipleOlsFit(
    execRoots.map((p) => [1.0, p.model_mult, p.mean_ctx_k / 100.0, p.sub_count / Math.max(1, p.T_min / 60.0)]),
    execRoots.map((p) => p.burn_uh)
  );

  latestLearnedModel = {
    throughput_slope: regLinearThroughput.slope > 0.01 ? regLinearThroughput.slope : 0.276,
    throughput_intercept: regLinearThroughput.intercept,
    power_alpha: regPowerLaw.slope > 0.5 ? regPowerLaw.slope : 1.25,
    q_intercept: regQualityVsTurns.intercept || 95.0,
    q_slope_lnN: regQualityVsTurns.slope || -1.2,
    lat_base_sec: multTurnFit.beta[0] > 0.5 ? multTurnFit.beta[0] : 5.0,
    lat_per_out_k: multTurnFit.beta[1] > 0.2 ? multTurnFit.beta[1] : 6.2,
    lat_per_ctx_100k: multTurnFit.beta[2] > 0 ? multTurnFit.beta[2] : 1.1,
    burn_beta: burnFit.beta,
    burn_r2: burnFit.r2,
    w_live: wL,
    n_crit_50: dynamicNCrit50,
  };

  // 记录数学模型随样本/轮数增长的自我修正轨迹
  const allTurnsSum = allRows.reduce((a, s) => a + s.planner_turns, 0);
  if (filterPlatform === 'all' && allRows.length > 0) {
    const lastEvo = db.prepare('SELECT sample_count, total_turns, power_slope, q_decay_slope FROM model_evolution ORDER BY id DESC LIMIT 1').get();
    if (
      !lastEvo ||
      lastEvo.sample_count !== allRows.length ||
      lastEvo.total_turns !== allTurnsSum ||
      Math.abs(lastEvo.power_slope - regPowerLaw.slope) >= 0.0001 ||
      Math.abs(lastEvo.q_decay_slope - regQualityVsTurns.slope) >= 0.0005
    ) {
      db.prepare(`
        INSERT INTO model_evolution (sample_count, total_turns, power_slope, linear_slope, q_decay_slope, n_crit_50, elasticity_tc_ratio, logit_acc, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        allRows.length,
        allTurnsSum,
        regPowerLaw.slope,
        regLinearThroughput.slope,
        regQualityVsTurns.slope,
        dynamicNCrit50,
        1.0,
        logitLiveModel.accuracy,
        Date.now()
      );
    }
  }
  const evolutionHistory = db.prepare('SELECT * FROM model_evolution ORDER BY id DESC LIMIT 12').all();

  const sigmoidCurve = [];
  for (let k = 0; k <= 50; k++) {
    const nVal = Math.exp(Math.log(4) + (Math.log(1500) - Math.log(4)) * (k / 50));
    const zClean = wL[0] + wL[1] * Math.log(nVal) + wL[2] * 0.60 + wL[3] * 0;
    const zHeavy = wL[0] + wL[1] * Math.log(nVal) + wL[2] * 1.80 + wL[3] * 2;
    sigmoidCurve.push({
      n: Number(nVal.toFixed(1)),
      lnN: Number(Math.log(nVal).toFixed(3)),
      p_clean: Number((sigmoid(zClean) * 100).toFixed(1)),
      p_comp: Number((sigmoid(zHeavy) * 100).toFixed(1)),
    });
  }

  // 第 6 张核心图：受控因果相图 —— 省时率 s_T(%) vs 额度耗用率增幅 ΔBurnRate(%) + 精确理论零溢价曲线 & AER=1.5 警戒红线！
  const theoryCurves = [];
  for (let sPct = -45; sPct <= 72; sPct += 3) {
    const s = sPct / 100.0;
    // 等总成本无溢价线: (1 + r_burn)*(1 - s) = 1  =>  r_burn = s / (1 - s)
    const neutralBurn = (s / (1.0 - s)) * 100.0;
    // AER = 1.5 捡芝麻丢西瓜警戒边界: (1 + r_burn)*(1 - s) - 1 = 1.5 * max(0, s)
    const aer15Burn = s > 0
      ? (((1.0 + 1.5 * s) / (1.0 - s)) - 1.0) * 100.0
      : 20.0;
    theoryCurves.push({
      s_pct: sPct,
      neutral_burn_pct: Number(neutralBurn.toFixed(1)),
      aer15_burn_pct: Number(aer15Burn.toFixed(1)),
    });
  }

  const platformStatsMap = new Map();
  for (const s of allRows) {
    if (!platformStatsMap.has(s.platform)) {
      platformStatsMap.set(s.platform, {
        platform: s.platform, total_sessions: 0, root_sessions: 0, sub_sessions: 0,
        total_turns: 0, in_M: 0, cache_M: 0, out_M: 0, weighted_cost_u: 0, exec_hours: 0, q_sum: 0, q_cnt: 0,
      });
    }
    const g = platformStatsMap.get(s.platform);
    g.total_sessions++;
    if (s.is_subagent) g.sub_sessions++;
    else {
      g.root_sessions++;
      g.q_sum += (s.q_human ?? s.q_objective);
      g.q_cnt++;
    }
    g.total_turns += s.planner_turns;
    g.in_M += s.input_tokens / 1e6;
    g.cache_M += s.cache_read_tokens / 1e6;
    g.out_M += s.output_tokens / 1e6;
    g.weighted_cost_u += s.weighted_cost_units;
    g.exec_hours += s.exec_time_min / 60.0;
  }
  const platformSummary = [...platformStatsMap.values()].map((g) => ({
    ...g,
    in_M: Number(g.in_M.toFixed(2)),
    cache_M: Number(g.cache_M.toFixed(2)),
    out_M: Number(g.out_M.toFixed(2)),
    weighted_cost_u: Number(g.weighted_cost_u.toFixed(2)),
    exec_hours: Number(g.exec_hours.toFixed(2)),
    avg_q: Number((g.q_sum / Math.max(1, g.q_cnt)).toFixed(1)),
    avg_burn_uh: Number((g.weighted_cost_u / Math.max(0.05, g.exec_hours)).toFixed(2)),
  })).sort((a, b) => b.total_sessions - a.total_sessions);

  const powerAlpha = latestLearnedModel.power_alpha;
  const prescriptions = {
    sample_basis_count: filteredSessions.length,
    root_project_count: rootProjects.length,
    empirical_constants: {
      turn_cost_exponent: powerAlpha,
      double_turns_cost_mult: Number((2 ** powerAlpha).toFixed(2)),
      sec_per_1k_output_tok: latestLearnedModel.lat_per_out_k,
      base_turn_overhead_sec: latestLearnedModel.lat_base_sec,
      dynamic_n_crit_50: dynamicNCrit50,
      burn_formula_beta: burnFit.beta,
      burn_formula_r2: burnFit.r2,
      logit_live_weights: wL,
      logit_live_accuracy: logitLiveModel.accuracy,
    },
    mode_extreme_cost_effectiveness: {
      title: '模式 A：要求「质量保持 + 极致性价比」时 AI Agent 最优工作范式',
      core_math_rule: '功率-速度守恒铁律：ΔC_total/C_B = (1 + ΔC_dot/C_dot_B)·(1 - s_T) - 1 ≤ 0  ⇒  任何加速方案的小时额度耗用率增幅绝不可超过 s_T/(1 - s_T)！',
      recommended_max_turns_per_session: Math.round(dynamicNCrit50),
      recommended_context_ceiling_k: 105,
      min_parallel_tools_per_turn: 3,
      model_routing_strategy: [
        '零额度硬件/算法加速永远优先于“堆 Agent 加速”：优先启用 SageAttention / 分桶批跑 / 本地 Python 队列脚本（此类方案 ΔC_dot = 0%，纯赚省时率 s_T，总成本反而下降！）',
        '严禁在单 GPU 物理瓶颈任务中狂开顶配 (2.0x Neon-XHigh) 子代理并发审图/轮询（实测阿姆达尔定律锁死省时仅 ~24%，但小时耗用率从 10.5 U/h 暴涨 +148.6% 至 26.1 U/h！）',
        '若确需子代理做分片初筛，必须强制指定轻量模型 (0.28x Hydrogen/Flash) 且并发度 ≤ 3，将子代理附加功率压在 +1.5 U/h 以内',
      ],
      execution_tactics: [
        '禁止高频轮询后台任务：等待 GPU/编译时使用精确超时回调或单次长阻塞脚本，杜绝主会话每 2 分钟唤醒重读一次百万级上下文',
        `跨阶段主动清零上下文：单窗口超过 ${Math.round(dynamicNCrit50)} 轮时将进度锁入本地 JSON/MD 后开启新窗口，防止单轮耗用率随上下文水位翻倍`,
      ],
    },
    mode_extreme_output_quality: {
      title: '模式 B：要求「极致任务完成质量 (Q_task → 98+)」时 AI Agent 最优工作范式',
      core_math_rule: '任务完成质量 Q_task 取决于「首轮母本精度 × 确定性核验标尺 × 终局闭环修复」，与盲目拉长单会话轮数或堆砌高价子代理无关！',
      recommended_stage_turns: 42,
      zero_compaction_mandate: '分话/分模块独立窗口交付（杜绝单会话破千步后规则遗忘与前后设定漂移）',
      model_routing_strategy: [
        '核心架构设计、复杂审美/解剖学终审、疑难根因定位：由零失忆主会话挂载顶配模型单点拍板，确保终局交付标准不妥协',
        '将重复性校验规则代码化（如 2.4x 像素坐标标尺切图、AST/单元测试断言、潜空间局部掩膜函数），用确定性代码守住 100% 下限',
      ],
      execution_tactics: [
        '遇到局部细节瑕疵（如多趾/色差/UI偏移）严禁整批推倒盲抽，直接走局部微创修补或确定性像素/代码修正，兼顾 97+ 完成质量与可控耗用率',
        '每完成一个独立子里程碑立即落盘验收，避免带病进入下一阶段引发连锁返工',
      ],
    },
  };

  const totalInM = filteredSessions.reduce((a, s) => a + s.input_tokens, 0) / 1e6;
  const totalCaM = filteredSessions.reduce((a, s) => a + s.cache_read_tokens, 0) / 1e6;
  const totalOuM = filteredSessions.reduce((a, s) => a + s.output_tokens, 0) / 1e6;
  const rawCostDenom = Math.max(1e-9, totalInM + 0.2 * totalCaM + 5.0 * totalOuM);

  const totalLlmMin = filteredSessions.reduce((a, s) => a + s.llm_infer_sec, 0) / 60;
  const totalSyncMin = filteredSessions.reduce((a, s) => a + s.sync_tool_sec, 0) / 60;
  const totalBgMin = filteredSessions.reduce((a, s) => a + s.bg_wait_sec, 0) / 60;
  const totTimeDenom = Math.max(1e-9, totalLlmMin + totalSyncMin + totalBgMin);

  return {
    generated_at: new Date().toISOString(),
    filter_platform: filterPlatform,
    live_active_sessions: liveActiveSessions,
    model_evolution: evolutionHistory,
    kpis: {
      total_sessions: filteredSessions.length,
      root_projects: rootProjects.length,
      subagent_sessions: filteredSessions.length - rootProjects.length,
      total_turns: filteredSessions.reduce((a, s) => a + s.planner_turns, 0),
      total_tokens_M: Number((totalInM + totalCaM + totalOuM).toFixed(2)),
      total_weighted_cost_u: Number(filteredSessions.reduce((a, s) => a + s.weighted_cost_units, 0).toFixed(2)),
      total_exec_hours: Number((totTimeDenom / 60).toFixed(2)),
      paired_experiment_count: counterfactualPairs.length,
      sesame_alert_count: badPairs.length,
      total_estimated_waste_u: Number(badPairs.reduce((a, x) => a + x.deltas.excess_cost_u, 0).toFixed(2)),
      dynamic_n_crit_50: dynamicNCrit50,
      cost_shares_pct: {
        cache_read: Number(((0.2 * totalCaM) / rawCostDenom * 100).toFixed(1)),
        fresh_input: Number((totalInM / rawCostDenom * 100).toFixed(1)),
        output: Number(((5.0 * totalOuM) / rawCostDenom * 100).toFixed(1)),
      },
      time_shares_pct: {
        async_wait: Number((totalBgMin / totTimeDenom * 100).toFixed(1)),
        llm_think: Number((totalLlmMin / totTimeDenom * 100).toFixed(1)),
        sync_tool: Number((totalSyncMin / totTimeDenom * 100).toFixed(1)),
      },
    },
    platform_summary: platformSummary,
    regressions: {
      power_law_cost_vs_turns: {
        ...regPowerLaw,
        points: validSess.slice(0, 360).map((s) => ({
          uid: s.session_uid, platform: s.platform, title: s.title.slice(0, 50), is_sub: s.is_subagent,
          x: Number(Math.log(s.planner_turns).toFixed(3)),
          y: Number(Math.log(s.raw_cost_units).toFixed(3)),
        })),
      },
      linear_throughput: {
        ...regLinearThroughput,
        points: nonOutlierSess.slice(0, 360).map((s) => ({
          uid: s.session_uid, platform: s.platform, title: s.title.slice(0, 50), is_sub: s.is_subagent,
          x: Number(((s.model_mult * s.planner_turns * s.mean_ctx_k) / 1000.0).toFixed(3)),
          y: Number(s.weighted_cost_units.toFixed(3)),
        })),
      },
      quality_vs_turns: {
        ...regQualityVsTurns,
        points: execRoots.slice(0, 320).map((p) => ({
          uid: p.session_uid, platform: p.platform, title: p.title.slice(0, 50), comp: p.compactions,
          x: Number(Math.log(p.tree_turns).toFixed(3)),
          y: p.Q_final,
        })),
      },
      turn_latency_vs_out: {
        ...regTurnLatency,
        mult_beta: multTurnFit.beta,
        mult_r2: multTurnFit.r2,
        points: filtTurns.slice(0, 420).map((t, idx) => ({
          uid: `${t.platform}#${idx}`, platform: t.platform, title: `${t.model_tier} (Ctx=${t.ctx_k}k)`,
          x: Number(t.out_k.toFixed(3)),
          y: Number(t.llm_sec.toFixed(2)),
        })),
      },
      sigmoid_probability: {
        weights: wL,
        accuracy: logitLiveModel.accuracy,
        n_crit_50: dynamicNCrit50,
        curve: sigmoidCurve,
        points: execRoots.slice(0, 260).map((p) => ({
          uid: p.session_uid, platform: p.platform, title: p.title.slice(0, 50),
          x: Number(Math.log(Math.max(1, p.tree_turns)).toFixed(3)),
          y: p.is_high_ce ? 98 : 2,
          comp: p.compactions,
        })),
      },
      burn_vs_speed_phase: {
        theory_curves: theoryCurves,
        points: counterfactualPairs.map((cp) => ({
          uid: cp.pair_id,
          platform: cp.platform,
          title: `${cp.title.slice(0, 34)} (${cp.comparison_scope})`,
          x: Math.max(-45, Math.min(72, cp.deltas.time_saved_pct)),
          y: Math.max(-60, Math.min(240, cp.deltas.burn_surge_pct)),
          dq: cp.deltas.delta_Q,
          cost_pct: cp.deltas.cost_surge_pct,
          bad: cp.is_bad_tradeoff,
          verdict: cp.verdict_label,
        })),
      },
    },
    counterfactual_pairs: counterfactualPairs,
    sesame_alerts: badPairs,
    prescriptions,
    projects: rootProjects.slice(0, 250),
  };
}

/**
 * 策略沙盘：直接对比「基线单兵方案 B」vs「所选加速/并发方案 A」在功率-速度守恒定律下的差分表现！
 */
export function simulateAgentPolicy(params = {}) {
  const m = latestLearnedModel;
  const estTurns = Math.max(6, Number(params.turns || 60));
  const modelMult = Math.max(0.15, Number(params.model_mult || 1.0));
  const toolsPerTurn = Math.max(0.5, Number(params.tools_per_turn || 2.5));
  const avgCtxK = Math.max(15, Number(params.avg_ctx_k || 65));
  const subCount = Math.max(0, Number(params.sub_count || 0));
  const subMult = Math.max(0.15, Number(params.sub_mult || 0.28));
  const subDupRead = Boolean(params.sub_dup_read);

  // 对照基线 B：同任务标准均衡模型 (1.0x)、单轮 2.0 工具、0 子代理、适中上下文 60k
  const baseTurns = estTurns;
  const baseCost = Number((1.0 * (m.throughput_slope * (baseTurns * 60 / 1000.0) + 0.05)).toFixed(2));
  const baseMin = Number(((baseTurns * (m.lat_base_sec + m.lat_per_out_k * 1.0 + m.lat_per_ctx_100k * 0.6)) / 60.0).toFixed(1));
  const baseBurnUh = Number((baseCost / Math.max(0.02, baseMin / 60.0)).toFixed(2));

  // 当前所选方案 A
  const effectiveTurns = Math.max(4, Math.round(estTurns * (2.0 / toolsPerTurn)));
  const estCompactions = Math.floor(Math.max(0, (effectiveTurns * (avgCtxK / 50) - 140) / 120));
  const finalTurns = Math.round(effectiveTurns * (1.0 + 0.28 * estCompactions));

  const mainCost = modelMult * (m.throughput_slope * (finalTurns * avgCtxK / 1000.0) + 0.05) * (subDupRead && subCount > 0 ? 1.32 : 1.0);
  const subCost = subCount * subMult * 0.36;
  const totalCost = Number((mainCost + subCost).toFixed(2));

  const mainMin = (finalTurns * (m.lat_base_sec + m.lat_per_out_k * 1.0 + m.lat_per_ctx_100k * (avgCtxK / 100))) / 60.0;
  // 阿姆达尔定律：硬件/外部串行占比 s_serial ≈ 0.55 时，狂堆子代理的真实提速存在硬天花板
  const speedup = subCount > 0 ? 1.0 / (0.55 + 0.45 / Math.min(4.0, 1 + 0.65 * subCount)) : 1.0;
  const totalMin = Number((mainMin / speedup + estCompactions * 5.0).toFixed(1));
  const predBurnUh = Number((totalCost / Math.max(0.02, totalMin / 60.0)).toFixed(2));

  const baseQ = 92.0;
  const predQ = Number(Math.min(98.5, Math.max(55.0,
    baseQ + (modelMult >= 1.3 ? 2.5 : modelMult <= 0.35 ? -4.5 : 0) - estCompactions * 3.5
  )).toFixed(1));

  const timeSavedPct = Number((((baseMin - totalMin) / Math.max(0.1, baseMin)) * 100).toFixed(1));
  const burnSurgePct = Number((((predBurnUh - baseBurnUh) / Math.max(0.1, baseBurnUh)) * 100).toFixed(1));
  const costSurgePct = Number((((totalCost - baseCost) / Math.max(0.05, baseCost)) * 100).toFixed(1));

  const pairEval = evaluateCounterfactualPair({
    pairId: 'sim',
    pairCategory: 'replacement',
    comparisonScope: '沙盘策略对比标准均衡基线',
    platform: 'sim',
    domain: '策略预演',
    title: '沙盘模拟',
    base: { uid: 'base', label: '标准基线 B', turns: baseTurns, subCount: 0, T_min: baseMin, C_u: baseCost, sub_C_u: 0, Q_task: baseQ, scaleM: 1 },
    target: { uid: 'sim', label: '当前方案 A', turns: finalTurns, subCount, T_min: totalMin, C_u: totalCost, sub_C_u: subCost, Q_task: predQ, scaleM: 1 },
  });

  return {
    effective_turns: finalTurns,
    est_compactions: estCompactions,
    pred_Q: predQ,
    delta_Q: Number((predQ - baseQ).toFixed(1)),
    pred_T_min: totalMin,
    pred_C_units: totalCost,
    pred_burn_uh: predBurnUh,
    base_burn_uh: baseBurnUh,
    time_saved_pct: timeSavedPct,
    burn_surge_pct: burnSurgePct,
    cost_surge_pct: costSurgePct,
    prob_ce_pct: pairEval.deltas.prob_ce_pct,
    learned_n_crit_50: m.n_crit_50,
    verdict: `${pairEval.verdict_label}：对比标准基线，质量 ΔQ=${predQ - baseQ >= 0 ? '+' : ''}${(predQ - baseQ).toFixed(1)}，省时 ${timeSavedPct}%，额度耗用率 ${baseBurnUh}→${predBurnUh} U/h (${burnSurgePct >= 0 ? '+' : ''}${burnSurgePct}%)，总成本 ${costSurgePct >= 0 ? '+' : ''}${costSurgePct}%`,
  };
}

export function exportObservatoryCsv(db, dataDir) {
  const rows = db.prepare(`
    SELECT s.*, h.q_human
    FROM sessions s
    LEFT JOIN human_ratings h ON s.session_uid = h.session_uid
    ORDER BY s.ended_at DESC, s.started_at DESC
  `).all();
  const cols = [
    'session_uid', 'platform', 'session_role', 'project_key', 'is_subagent', 'parent_uid', 'domain',
    'primary_model', 'model_tier', 'model_mult', 'planner_turns', 'tool_calls', 'file_edits', 'compactions',
    'input_tokens', 'cache_read_tokens', 'output_tokens', 'raw_cost_units', 'weighted_cost_units',
    'exec_time_min', 'q_objective', 'q_human', 'title',
  ];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  const outPath = join(dataDir, 'qtc_multi_agent_dataset.csv');
  writeFileSync(outPath, '\uFEFF' + lines.join('\n'), 'utf8');
  return { csv_path: outPath, row_count: rows.length };
}
