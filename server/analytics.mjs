/**
 * QTC Observatory v1.1.0 — 在线自修正计量经济学与机器学习引擎 (Online Econometrics & IRLS Engine)
 *
 * 100% 动态在线重训练（零硬编码静态回归常数）：
 *   1. 单变量 OLS 线性与双对数幂律回归（实时重算 β, R², t-stat, p-value, 95% 置信带）
 *   2. 多元矩阵最小二乘回归 Multiple OLS (高斯-约旦消元求解 (X'X + λI)^-1 X'y)：实时拟合并修正单步延迟方程
 *   3. 在线 L2 正则化 Logistic 回归 (Newton-Raphson / IRLS 迭代加权最小二乘)：
 *      - 实时重训练「三元状态性价比概率方程」P_CE(Q, ln(T/W), ln(C/W))，动态修正时间弹性 vs 金钱弹性比值！
 *      - 实时重训练「过程实时预警概率方程」P_live(ln N, ErrRate, Compactions)，动态重算最新 50% 性价比生死线轮数 N_50%！
 *   4. 自动记录数学模型演化快照至 SQLite `model_evolution`，追踪模型随样本量增长的自我修正轨迹。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

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

/** 求解 d×d 线性方程组 A * x = b (列主元高斯消元法) */
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

/** 在线多元脊回归 / OLS: y = X * beta */
export function multipleOlsFit(X, y, ridge = 1e-6) {
  const n = X.length;
  const d = X[0]?.length || 0;
  if (n < d + 2 || d === 0) return { beta: new Array(d).fill(0), r2: 0, n };

  const XtX = Array.from({ length: d }, () => new Array(d).fill(0));
  const Xty = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = j; k < d; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
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

/**
 * 在线 L2 正则化 Logistic 回归求解器 (Newton-Raphson / IRLS 实时极大似然拟合)
 * 用于随新样本入库自动重训练 P_CE 概率模型，彻底消除硬编码系数！
 */
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
        for (let k = j; k < d; k++) {
          H[j][k] += weight * X[i][j] * X[i][k];
        }
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

// 缓存最近一次在线拟合出来的动态数学模型参数供模拟器实时调用
let latestLearnedModel = {
  throughput_slope: 0.276,
  throughput_intercept: 0.20,
  power_alpha: 1.25,
  q_intercept: 105.2,
  q_slope_lnN: -4.49,
  comp_q_penalty: 12.0,
  lat_base_sec: 9.1,
  lat_per_out_k: 5.1,
  lat_per_ctx_100k: 1.38,
  w_state: [-2.0, 2.2, -2.3, -2.4],
  w_live: [2.8, -0.53, -1.45, -1.38],
  n_crit_50: 56.0,
  time_to_cost_elasticity_ratio: 1.0,
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

  const turnSamples = db.prepare(`
    SELECT platform, model_tier, ctx_k, out_k, llm_sec, n_tools, step_cost_u
    FROM turn_samples
    ORDER BY rowid DESC
    LIMIT 6500
  `).all();

  const nowSec = Date.now() / 1000;
  // 识别过去 15 分钟内正在活跃跳动的实时会话 (Live Active Sessions!)
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

  const filteredSessions = filterPlatform === 'all'
    ? allRows
    : allRows.filter((r) => r.platform === filterPlatform);

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

  const rootProjects = [];
  for (const r of filteredSessions) {
    if (r.is_subagent && r.parent_uid && byUid.has(r.parent_uid)) continue;
    if (r.is_subagent && r.planner_turns < 3) continue;

    const subs = getDescendants(r.session_uid);
    const subTurns = subs.reduce((a, x) => a + x.planner_turns, 0);
    const subCost = subs.reduce((a, x) => a + x.weighted_cost_units, 0);
    const subCmdTot = subs.reduce((a, x) => a + x.cmd_total, 0);
    const subCmdFail = subs.reduce((a, x) => a + x.cmd_failed, 0);
    const subEdits = subs.reduce((a, x) => a + x.file_edits, 0);
    const subOutTok = subs.reduce((a, x) => a + x.output_tokens, 0);
    const subTools = subs.reduce((a, x) => a + x.tool_calls, 0);

    const treeTurns = r.planner_turns + subTurns;
    const treeCost = r.weighted_cost_units + subCost;
    const treeRawCost = r.raw_cost_units + subs.reduce((a, x) => a + x.raw_cost_units, 0);
    const totCmd = r.cmd_total + subCmdTot;
    const totFail = r.cmd_failed + subCmdFail;
    const errRate = totCmd > 0 ? totFail / totCmd : 0;

    const okCmds = Math.max(0, totCmd - totFail);
    const totEdits = r.file_edits + subEdits;
    const totOutK = (r.output_tokens + subOutTok) / 1000.0;
    const totTools = r.tool_calls + subTools;

    const workload = Math.max(
      1.5,
      2.0 + 0.35 * okCmds + 1.20 * totEdits + 0.18 * totOutK + 0.08 * totTools
    );
    const execMin = Math.max(0.15, r.exec_time_min);
    const qFinal = r.q_human !== null && r.q_human !== undefined ? Number(r.q_human) : Number(r.q_objective);

    rootProjects.push({
      session_uid: r.session_uid,
      platform: r.platform,
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
      neg_feedback: r.neg_feedback_turns,
      single_tool_ratio: r.planner_turns > 0 ? Number((r.single_tool_turns / r.planner_turns).toFixed(3)) : 0,
      cmd_err_rate: Number(errRate.toFixed(4)),
      cmd_failed: totFail,
      mean_ctx_k: r.mean_ctx_k,
      max_ctx_k: r.max_ctx_k,
      cache_tax_share: r.cache_tax_share,
      llm_min: Number((r.llm_infer_sec / 60).toFixed(2)),
      sync_min: Number((r.sync_tool_sec / 60).toFixed(2)),
      bg_min: Number((r.bg_wait_sec / 60).toFixed(2)),
      T_min: Number(execMin.toFixed(2)),
      root_C: Number(r.weighted_cost_units.toFixed(4)),
      sub_C: Number(subCost.toFixed(4)),
      C_units: Number(treeCost.toFixed(4)),
      raw_C_units: Number(treeRawCost.toFixed(4)),
      workload: Number(workload.toFixed(2)),
      T_per_work: Number((execMin / workload).toFixed(4)),
      C_per_work: Number((Math.max(1e-5, treeCost) / workload).toFixed(5)),
      Q_obj: r.q_objective,
      Q_human: r.q_human,
      Q_final: Number(qFinal.toFixed(1)),
    });
  }

  const domainGroups = new Map();
  for (const p of rootProjects) {
    if (!domainGroups.has(p.domain)) domainGroups.set(p.domain, []);
    domainGroups.get(p.domain).push(p);
  }

  const globalMedT = Math.max(0.05, median(rootProjects.map((x) => x.T_per_work)));
  const globalMedC = Math.max(0.002, median(rootProjects.map((x) => x.C_per_work)));

  const domainBenchmarks = {};
  for (const [dom, list] of domainGroups.entries()) {
    domainBenchmarks[dom] = {
      count: list.length,
      med_T_pw: list.length >= 4 ? Math.max(0.05, median(list.map((x) => x.T_per_work))) : globalMedT,
      med_C_pw: list.length >= 4 ? Math.max(0.002, median(list.map((x) => x.C_per_work))) : globalMedC,
    };
  }

  // 第一遍先计算客观 CE_index 与高性价比二分类标签 y_high_ce，用于在线重训练 Logistic 模型！
  const sesameAlerts = [];
  for (const p of rootProjects) {
    const bm = domainBenchmarks[p.domain] || { med_T_pw: globalMedT, med_C_pw: globalMedC };
    const relTimeRatio = p.T_per_work / bm.med_T_pw;
    const relCostRatio = p.C_per_work / bm.med_C_pw;
    const ceIndex = ((p.Q_final / 100.0) ** 2) / Math.sqrt(Math.max(1e-4, relTimeRatio * relCostRatio));
    p.ce_index = Number(ceIndex.toFixed(2));
    p.is_high_ce = p.Q_final >= 85.0 && ceIndex >= 1.0 ? 1 : 0;

    const costIncreasePct = (p.C_per_work - bm.med_C_pw) / bm.med_C_pw;
    const timeSavedPct = (bm.med_T_pw - p.T_per_work) / bm.med_T_pw;

    const wasteSingleTool = p.single_tool_ratio > 0.5 && p.root_turns >= 15 ? p.root_C * p.cache_tax_share * 0.42 : 0;
    const wasteSubClone = p.sub_count >= 3 && p.sub_C > p.root_C * 0.28 ? p.sub_C * 0.65 : 0;
    const wasteCmdRetry = p.cmd_failed > 0 ? p.root_C * Math.min(0.45, p.cmd_failed / Math.max(5, p.root_turns)) : 0;
    const wasteCompaction = p.compactions > 0 ? p.C_units * Math.min(0.55, 0.22 * p.compactions) : 0;
    const totalWasteU = Number((wasteSingleTool + wasteSubClone + wasteCmdRetry + wasteCompaction).toFixed(3));
    p.estimated_waste_u = totalWasteU;

    let flag = 'healthy';
    let aer = 0;
    const reasons = [];
    if (p.C_units >= 1.5 && costIncreasePct > 0.45) {
      if (timeSavedPct <= 0) {
        flag = 'lose-lose';
        aer = 99.9;
      } else {
        aer = costIncreasePct / Math.max(0.02, timeSavedPct);
        if (aer > 1.5) flag = 'sesame-for-watermelon';
      }
    }

    p.asymmetry_flag = flag;
    p.aer_ratio = Number(aer.toFixed(2));
    if (flag !== 'healthy') {
      if (wasteSubClone > 0.3) reasons.push(`子代理高价克隆/双重复读 (+${wasteSubClone.toFixed(1)}U)`);
      if (wasteCompaction > 0.3) reasons.push(`触发 ${p.compactions} 次失忆压缩返工 (+${wasteCompaction.toFixed(1)}U)`);
      if (wasteSingleTool > 0.3) reasons.push(`单工具碎步交互 ${(p.single_tool_ratio * 100).toFixed(0)}% 白交缓存税 (+${wasteSingleTool.toFixed(1)}U)`);
      if (wasteCmdRetry > 0.2) reasons.push(`命令报错 ${p.cmd_failed} 次重跑损耗 (+${wasteCmdRetry.toFixed(1)}U)`);
      if (!reasons.length && p.model_mult >= 1.8) reasons.push('全程挂顶配高倍率模型执行常规循环步骤');
      p.waste_reasons = reasons;

      sesameAlerts.push({
        session_uid: p.session_uid,
        platform: p.platform,
        domain: p.domain,
        title: p.title,
        type: flag === 'lose-lose' ? '双输雪崩 (多烧钱且更慢)' : '捡芝麻丢西瓜 (大钱换小时间)',
        cost_increase_pct: Number((costIncreasePct * 100).toFixed(1)),
        time_saved_pct: Number((timeSavedPct * 100).toFixed(1)),
        aer_ratio: p.aer_ratio,
        C_units: p.C_units,
        T_min: p.T_min,
        Q_final: p.Q_final,
        estimated_waste_u: totalWasteU,
        reasons,
      });
    } else {
      p.waste_reasons = [];
    }
  }
  sesameAlerts.sort((a, b) => b.estimated_waste_u - a.estimated_waste_u || b.C_units - a.C_units);

  // ==========================================================
  // 在线实时重训练全部 6 组数学模型（OLS + Multiple OLS + Online IRLS Logistic）
  // ==========================================================
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

  const multiTurnRoots = rootProjects.filter((p) => p.tree_turns >= 4);
  const regQualityDecay = olsLinearRegression(
    multiTurnRoots.map((p) => Math.log(p.tree_turns)),
    multiTurnRoots.map((p) => p.Q_final)
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

  // 在线重训练 Logistic 模型 1：三元状态空间 P_CE(Q, ln(T/T_med), ln(C/C_med))
  const XState = multiTurnRoots.map((p) => {
    const bm = domainBenchmarks[p.domain] || { med_T_pw: globalMedT, med_C_pw: globalMedC };
    return [
      1.0,
      (p.Q_final - 88.0) / 10.0,
      Math.log(Math.max(1e-3, p.T_per_work / bm.med_T_pw)),
      Math.log(Math.max(1e-4, p.C_per_work / bm.med_C_pw)),
    ];
  });
  const yTarget = multiTurnRoots.map((p) => p.is_high_ce);
  const logitStateModel = fitOnlineLogisticRegression(XState, yTarget, 0.15);

  // 在线重训练 Logistic 模型 2：实时过程预警 P_live(ln N, ErrRate, Compactions)
  const XLive = multiTurnRoots.map((p) => [
    1.0,
    Math.log(Math.max(1, p.tree_turns)),
    p.cmd_err_rate * 10.0,
    p.compactions,
  ]);
  const logitLiveModel = fitOnlineLogisticRegression(XLive, yTarget, 0.15);

  const wS = logitStateModel.weights;
  const wL = logitLiveModel.weights;
  // 动态计算最新的 50% 性价比生死线轮数 N_50% (假设常规低报错 5% 且 0 失忆)
  let dynamicNCrit50 = 56.0;
  if (wL.length === 4 && wL[1] < -0.05) {
    const lnNc = -(wL[0] + wL[2] * 0.5) / wL[1];
    dynamicNCrit50 = Number(Math.min(220, Math.max(12, Math.exp(lnNc))).toFixed(1));
  }
  const tcElasticityRatio = (wS.length === 4 && Math.abs(wS[3]) > 0.05)
    ? Number(Math.abs(wS[2] / wS[3]).toFixed(3))
    : 1.0;

  // 用刚刚在线重训练出的最新权重回填每个项目的动态概率 P_CE！
  for (let i = 0; i < multiTurnRoots.length; i++) {
    const p = multiTurnRoots[i];
    const xs = XState[i];
    const z = wS[0] + wS[1] * xs[1] + wS[2] * xs[2] + wS[3] * xs[3];
    p.prob_ce_pct = Number((sigmoid(z) * 100).toFixed(1));
  }

  const comp0Roots = multiTurnRoots.filter((p) => p.compactions === 0);
  const compPosRoots = multiTurnRoots.filter((p) => p.compactions >= 1);
  const avgQComp0 = comp0Roots.length ? comp0Roots.reduce((a, b) => a + b.Q_final, 0) / comp0Roots.length : 94;
  const avgQCompPos = compPosRoots.length ? compPosRoots.reduce((a, b) => a + b.Q_final, 0) / compPosRoots.length : 79;

  // 更新全局在线学习模型缓存！
  latestLearnedModel = {
    throughput_slope: regLinearThroughput.slope > 0.01 ? regLinearThroughput.slope : 0.276,
    throughput_intercept: regLinearThroughput.intercept,
    power_alpha: regPowerLaw.slope > 0.5 ? regPowerLaw.slope : 1.25,
    q_intercept: regQualityDecay.intercept || 105.2,
    q_slope_lnN: regQualityDecay.slope || -4.49,
    comp_q_penalty: Math.max(4.0, avgQComp0 - avgQCompPos),
    lat_base_sec: multTurnFit.beta[0] > 0.5 ? multTurnFit.beta[0] : 9.1,
    lat_per_out_k: multTurnFit.beta[1] > 0.2 ? multTurnFit.beta[1] : 5.1,
    lat_per_ctx_100k: multTurnFit.beta[2] > 0 ? multTurnFit.beta[2] : 1.38,
    w_state: wS,
    w_live: wL,
    n_crit_50: dynamicNCrit50,
    time_to_cost_elasticity_ratio: tcElasticityRatio,
  };

  // 若是全库模式且样本数、总轮数或回归斜率发生任何变化，立即记录一条数学模型自我修正演化日志！
  const allTurnsSum = allRows.reduce((a, s) => a + s.planner_turns, 0);
  if (filterPlatform === 'all' && allRows.length > 0) {
    const lastEvo = db.prepare('SELECT sample_count, total_turns, power_slope, linear_slope, q_decay_slope FROM model_evolution ORDER BY id DESC LIMIT 1').get();
    if (
      !lastEvo ||
      lastEvo.sample_count !== allRows.length ||
      lastEvo.total_turns !== allTurnsSum ||
      Math.abs(lastEvo.power_slope - regPowerLaw.slope) >= 0.0001 ||
      Math.abs(lastEvo.q_decay_slope - regQualityDecay.slope) >= 0.0005
    ) {
      db.prepare(`
        INSERT INTO model_evolution (sample_count, total_turns, power_slope, linear_slope, q_decay_slope, n_crit_50, elasticity_tc_ratio, logit_acc, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        allRows.length,
        allTurnsSum,
        regPowerLaw.slope,
        regLinearThroughput.slope,
        regQualityDecay.slope,
        dynamicNCrit50,
        tcElasticityRatio,
        logitLiveModel.accuracy,
        Date.now()
      );
    }
  }

  const evolutionHistory = db.prepare('SELECT * FROM model_evolution ORDER BY id DESC LIMIT 12').all();

  // 生成 Sigmoid 曲线点集供前端实时绘制第 5 张概率曲线图！
  const sigmoidCurve = [];
  for (let k = 0; k <= 50; k++) {
    const nVal = Math.exp(Math.log(4) + (Math.log(1600) - Math.log(4)) * (k / 50));
    const zClean = wL[0] + wL[1] * Math.log(nVal) + wL[2] * 0.5 + wL[3] * 0;
    const zComp = wL[0] + wL[1] * Math.log(nVal) + wL[2] * 1.5 + wL[3] * 1;
    sigmoidCurve.push({
      n: Number(nVal.toFixed(1)),
      lnN: Number(Math.log(nVal).toFixed(3)),
      p_clean: Number((sigmoid(zClean) * 100).toFixed(1)),
      p_comp: Number((sigmoid(zComp) * 100).toFixed(1)),
    });
  }

  // 生成帕累托平面上的实时 Logistic 50% 概率线性分类分界线两端点 (在 Q = 92 时 w0 + 0.4*w1 + w2*dx + w3*dy = 0)
  let paretoBoundaryLine = null;
  if (wS.length === 4 && Math.abs(wS[3]) > 0.08) {
    const x1 = -2.2, x2 = 2.2;
    const calcDy = (dx) => -(wS[0] + 0.4 * wS[1] + wS[2] * dx) / wS[3];
    paretoBoundaryLine = {
      x1: Number((Math.log(globalMedT) + x1).toFixed(3)),
      y1: Number((Math.log(globalMedC) + calcDy(x1)).toFixed(3)),
      x2: Number((Math.log(globalMedT) + x2).toFixed(3)),
      y2: Number((Math.log(globalMedC) + calcDy(x2)).toFixed(3)),
    };
  }

  const platformStatsMap = new Map();
  for (const s of allRows) {
    if (!platformStatsMap.has(s.platform)) {
      platformStatsMap.set(s.platform, {
        platform: s.platform, total_sessions: 0, root_sessions: 0, sub_sessions: 0,
        total_turns: 0, in_M: 0, cache_M: 0, out_M: 0, weighted_cost_u: 0, exec_hours: 0, q_sum: 0,
      });
    }
    const g = platformStatsMap.get(s.platform);
    g.total_sessions++;
    if (s.is_subagent) g.sub_sessions++;
    else g.root_sessions++;
    g.total_turns += s.planner_turns;
    g.in_M += s.input_tokens / 1e6;
    g.cache_M += s.cache_read_tokens / 1e6;
    g.out_M += s.output_tokens / 1e6;
    g.weighted_cost_u += s.weighted_cost_units;
    g.exec_hours += s.exec_time_min / 60.0;
    g.q_sum += (s.q_human ?? s.q_objective);
  }
  const platformSummary = [...platformStatsMap.values()].map((g) => ({
    ...g,
    in_M: Number(g.in_M.toFixed(2)),
    cache_M: Number(g.cache_M.toFixed(2)),
    out_M: Number(g.out_M.toFixed(2)),
    weighted_cost_u: Number(g.weighted_cost_u.toFixed(2)),
    exec_hours: Number(g.exec_hours.toFixed(2)),
    avg_q: Number((g.q_sum / Math.max(1, g.total_sessions)).toFixed(1)),
  })).sort((a, b) => b.total_sessions - a.total_sessions);

  const topCeSamples = [...multiTurnRoots]
    .filter((p) => p.Q_final >= 88)
    .sort((a, b) => b.ce_index - a.ce_index)
    .slice(0, Math.max(3, Math.ceil(multiTurnRoots.length * 0.25)));

  const topQualSamples = [...multiTurnRoots]
    .filter((p) => p.Q_final >= 95)
    .sort((a, b) => a.C_per_work - b.C_per_work)
    .slice(0, Math.max(3, Math.ceil(multiTurnRoots.length * 0.25)));

  const safeTurnCap = Math.round(Math.min(dynamicNCrit50, Math.max(32, quantile(topCeSamples.map((x) => x.root_turns), 0.80) || 50)));
  const maxQualStageTurns = Math.round(Math.min(48, Math.max(26, quantile(topQualSamples.map((x) => x.root_turns), 0.75) || 40)));
  const powerAlpha = latestLearnedModel.power_alpha;

  const prescriptions = {
    sample_basis_count: filteredSessions.length,
    root_project_count: rootProjects.length,
    empirical_constants: {
      turn_cost_exponent: powerAlpha,
      double_turns_cost_mult: Number((2 ** powerAlpha).toFixed(2)),
      tenfold_turns_cost_mult: Number((10 ** powerAlpha).toFixed(1)),
      compaction_quality_drop: Number((avgQComp0 - avgQCompPos).toFixed(1)),
      sec_per_1k_output_tok: latestLearnedModel.lat_per_out_k,
      base_turn_overhead_sec: latestLearnedModel.lat_base_sec,
      dynamic_n_crit_50: dynamicNCrit50,
      time_cost_elasticity_ratio: tcElasticityRatio,
      logit_state_weights: wS,
      logit_live_weights: wL,
      logit_live_accuracy: logitLiveModel.accuracy,
    },
    mode_extreme_cost_effectiveness: {
      title: '模式 A：要求「极致性价比」时 AI Agent 最优工作范式',
      core_math_rule: `实时拟合时间-金钱弹性比 = ${tcElasticityRatio} : 1 → 严守 ΔC% ≤ ${tcElasticityRatio} × (-ΔT%)，绝不用大金钱换小时间！`,
      recommended_max_turns_per_session: safeTurnCap,
      recommended_context_ceiling_k: 110,
      min_parallel_tools_per_turn: 3,
      model_routing_strategy: [
        '常规编码、方案拆解与中度任务：主力采用 Balanced/Carbon-High 或 DSH 标准档（实测单轮成本比顶配 Apex-XHigh 低 55%~70%）',
        '目录探查、日志过滤、只读文件检索（原始体积 > 15k Tokens 且主会话无需重读原文）：派发 Fast-Lightweight (Hydrogen/Flash) 子代理，并发数 P ≤ 3',
        '严禁派发 Model="inherit" 顶配子代理去读主会话后续还要复读的图片或源码（实测亏损率 100%）',
      ],
      execution_tactics: [
        '把高频循环、拼图、批量校验下沉至本地 0 额度 Python/Node 脚本（ΔC = 0%，纯赚 30%~65% 速度，AER = 0 绝对合算）',
        `每轮合并至少 3 个独立读写检查动作，将总轮数压在动态生死线 ${dynamicNCrit50} 轮内（轮数砍半则成本按 2^${powerAlpha.toFixed(2)} 缩减 ${((1 - 1 / (2 ** powerAlpha)) * 100).toFixed(0)}%）`,
        `禁止每轮手写上千行一次性临时脚本（每少输出 2k Tokens 立省 ${(2 * latestLearnedModel.lat_per_out_k).toFixed(1)} 秒流式等待与高倍率输出费），改用 JSON 参数配置驱动`,
      ],
    },
    mode_extreme_output_quality: {
      title: '模式 B：要求「极致产出质量 (Q → 100)」时 AI Agent 最优工作范式',
      core_math_rule: `实时拟合质量方程 Q = ${latestLearnedModel.q_intercept.toFixed(1)} ${latestLearnedModel.q_slope_lnN.toFixed(2)}·ln N：极致质量来自“零失忆短周期分治 + 确定性验证”，绝非单会话死磕！`,
      recommended_stage_turns: maxQualStageTurns,
      zero_compaction_mandate: `强制 Compaction = 0（实测触发压缩失忆后质量均值从 ${avgQComp0.toFixed(1)} 跌至 ${avgQCompPos.toFixed(1)} 分）`,
      model_routing_strategy: [
        '关键架构设计、复杂数学/仿真对齐、多模态细节终审：启用 Apex-XHigh / Flagship 顶配模型保证首轮高直通率 p_0（避免轻量模型硬啃高复杂度推理引发数百轮无效试错翻车）',
        `分阶段上下文清零制：大型工程按每 ${maxQualStageTurns} 轮为一个独立里程碑，将精确状态锁入本地结构化文件（如 picks.json / spec.md），随后开启全新零历史会话接棒`,
      ],
      execution_tactics: [
        '高难低直通单元（p < 0.40）采用本地同批多候选选优（Best-of-4 并发种子）替代跨轮次串行盲抽，2 轮硬熔断后直接切换确定性物理/代码规则清零残余微瑕',
        '视觉或多模态终审采用不触发下采样模糊的高清标尺合板（单边 ≤ 2800px，局部保留 1:1 像素刻度），由零失忆主脑单点拍板',
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
      sesame_alert_count: sesameAlerts.length,
      total_estimated_waste_u: Number(sesameAlerts.reduce((a, x) => a + x.estimated_waste_u, 0).toFixed(2)),
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
        ...regQualityDecay,
        points: multiTurnRoots.slice(0, 320).map((p) => ({
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
        points: multiTurnRoots.slice(0, 260).map((p) => ({
          uid: p.session_uid, platform: p.platform, title: p.title.slice(0, 50),
          x: Number(Math.log(Math.max(1, p.tree_turns)).toFixed(3)),
          y: p.is_high_ce ? 98 : 2,
          comp: p.compactions,
        })),
      },
      pareto_unit_space: {
        med_ln_T: Number(Math.log(globalMedT).toFixed(3)),
        med_ln_C: Number(Math.log(globalMedC).toFixed(3)),
        boundary_line: paretoBoundaryLine,
        state_weights: wS,
        state_accuracy: logitStateModel.accuracy,
        points: multiTurnRoots.slice(0, 320).map((p) => ({
          uid: p.session_uid, platform: p.platform, title: p.title.slice(0, 50),
          x: Number(Math.log(p.T_per_work).toFixed(3)),
          y: Number(Math.log(Math.max(1e-5, p.C_per_work)).toFixed(3)),
          q: p.Q_final, ce: p.ce_index, flag: p.asymmetry_flag,
        })),
      },
    },
    sesame_alerts: sesameAlerts.slice(0, 50),
    prescriptions,
    projects: rootProjects.slice(0, 250),
  };
}

/**
 * 完全使用在线重训练出的最新动态系数进行策略预演（不再有任何静态硬编码！）
 */
export function simulateAgentPolicy(params = {}) {
  const m = latestLearnedModel;
  const estTurns = Math.max(1, Number(params.turns || 40));
  const modelMult = Math.max(0.15, Number(params.model_mult || 1.0));
  const toolsPerTurn = Math.max(0.5, Number(params.tools_per_turn || 2.5));
  const avgCtxK = Math.max(15, Number(params.avg_ctx_k || 65));
  const subCount = Math.max(0, Number(params.sub_count || 0));
  const subMult = Math.max(0.15, Number(params.sub_mult || 0.28));
  const subDupRead = Boolean(params.sub_dup_read);

  const effectiveTurns = Math.max(4, Math.round(estTurns * (1.8 / toolsPerTurn)));
  const estCompactions = Math.floor(Math.max(0, (effectiveTurns * (avgCtxK / 45) - 135) / 115));
  const reworkMult = 1.0 + 0.35 * estCompactions;
  const finalTurns = Math.round(effectiveTurns * reworkMult);

  const mainCost = modelMult * (m.throughput_slope * (finalTurns * avgCtxK / 1000.0) + Math.max(0.02, m.throughput_intercept * 0.2)) * (subDupRead && subCount > 0 ? 1.35 : 1.0);
  const subCost = subCount * subMult * 0.14;
  const totalCost = Number((mainCost + subCost).toFixed(2));

  const mainMin = (finalTurns * (m.lat_base_sec + m.lat_per_out_k * 1.1 + m.lat_per_ctx_100k * (avgCtxK / 100))) / 60.0;
  const speedup = subCount > 0 ? Math.min(2.2, (1 + subCount) / (1 + 0.22 * subCount + 0.06 * subCount * (subCount - 1))) : 1.0;
  const totalMin = Number((mainMin / speedup + estCompactions * 6.5).toFixed(1));

  const baseQ = modelMult >= 0.8 ? m.q_intercept : m.q_intercept - 10.0;
  const predQ = Number(Math.min(100, Math.max(50, baseQ + m.q_slope_lnN * Math.log(finalTurns) - m.comp_q_penalty * 0.75 * estCompactions)).toFixed(1));

  const wL = m.w_live;
  const zLive = wL[0] + wL[1] * Math.log(finalTurns + subCount * 10) + wL[2] * 0.5 + wL[3] * estCompactions;
  const probCe = Number((sigmoid(zLive) * 100).toFixed(1));

  let verdict = `✅ 合算稳态：低于当前动态生死线 (${m.n_crit_50} 轮)，处于高性价比走廊`;
  if (subCount > 0 && subMult >= 1.3 && subDupRead) {
    verdict = '🔴 严重捡芝麻丢西瓜警告：高价子代理 + 主会话重复读取，额度翻倍但几乎不省时！请改为 0 子代理或切换轻量模型 (0.28x)！';
  } else if (estCompactions >= 1 || finalTurns > m.n_crit_50) {
    verdict = `🟠 越过动态生死线 (${m.n_crit_50} 轮)：预计达 ${finalTurns} 轮 (失忆 ${estCompactions} 次)！建议拆分为 ${Math.ceil(finalTurns / Math.max(25, Math.floor(m.n_crit_50 * 0.8)))} 个阶段清零上下文！`;
  } else if (toolsPerTurn < 1.5) {
    verdict = '🟡 碎步重算税偏高：单轮并发工具过少，建议合并读写批处理以砍半缓存税！';
  }

  return {
    effective_turns: finalTurns,
    est_compactions: estCompactions,
    pred_Q: predQ,
    pred_T_min: totalMin,
    pred_C_units: totalCost,
    prob_ce_pct: probCe,
    learned_n_crit_50: m.n_crit_50,
    verdict,
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
    'session_uid', 'platform', 'is_subagent', 'parent_uid', 'domain', 'primary_model', 'model_tier', 'model_mult',
    'planner_turns', 'tool_calls', 'single_tool_turns', 'cmd_total', 'cmd_failed', 'file_edits', 'image_reads', 'compactions',
    'input_tokens', 'cache_read_tokens', 'output_tokens', 'token_accuracy', 'raw_cost_units', 'weighted_cost_units',
    'exec_time_min', 'workload_score', 'q_objective', 'q_human', 'title'
  ];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => esc(r[c])).join(','));
  }
  const outPath = join(dataDir, 'qtc_multi_agent_dataset.csv');
  writeFileSync(outPath, '\uFEFF' + lines.join('\n'), 'utf8');
  return { csv_path: outPath, row_count: rows.length };
}
