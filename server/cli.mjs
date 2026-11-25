#!/usr/bin/env node
/**
 * QTC Observatory v1.2.0 — 独立命令行与全天候无头守护进程管理入口
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { openObservatoryDb, syncAllAgentSources } from './collector.mjs';
import { computeObservatoryAnalytics, exportObservatoryCsv } from './analytics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const DATA_DIR = join(PLUGIN_ROOT, '.data');
const INDEX_SCRIPT = join(__dirname, 'index.mjs');

const cmd = process.argv[2] || 'report';

if (cmd === 'sync' || cmd === 'report') {
  const db = openObservatoryDb(DATA_DIR);
  const force = process.argv.includes('--force');
  const syncRes = syncAllAgentSources(db, DATA_DIR, force);
  const dash = computeObservatoryAnalytics(db, 'all');

  console.log('========================================================================');
  console.log(' QTC 跨Agent实时监测与因果对照研究台 v1.2.0 — 耗用率守恒与完成质量快照');
  console.log('========================================================================');
  console.log(`[增量采集] 扫描文件: ${syncRes.scanned_files} | 新增/更新会话: ${syncRes.updated_sessions} | 未变跳过: ${syncRes.skipped_unchanged} | 耗时: ${syncRes.elapsed_ms}ms`);
  console.log(`[总样本池] 总收录会话: ${dash.kpis.total_sessions} 个 (根任务项目: ${dash.kpis.root_projects}, 子代理: ${dash.kpis.subagent_sessions}) | 总轮数: ${dash.kpis.total_turns}`);
  console.log(`[受控对照] 已构建有效因果对照实验对: ${dash.kpis.paired_experiment_count} 组 | 其中不合算/质量失守: ${dash.kpis.sesame_alert_count} 组 (超额损耗 ${dash.kpis.total_estimated_waste_u}U)`);

  console.log('\n--- 1. 跨 AI Agent 平台样本与任务完成质量分布 ---');
  for (const p of dash.platform_summary) {
    console.log(
      `  • ${p.platform.padEnd(14)} | 会话=${String(p.total_sessions).padStart(4)} (主${String(p.root_sessions).padStart(3)}+子${String(p.sub_sessions).padStart(3)}) | 完成质量均分=${String(p.avg_q).padStart(5)} | 平均耗用率=${String(p.avg_burn_uh).padStart(6)} U/h | 总额度=${String(p.weighted_cost_u).padStart(7)}U`
    );
  }

  const r1 = dash.regressions.power_law_cost_vs_turns;
  const r2 = dash.regressions.linear_throughput;
  const r3 = dash.regressions.quality_vs_turns;
  const r4 = dash.regressions.turn_latency_vs_out;
  const ec = dash.prescriptions.empirical_constants;
  console.log('\n--- 2. 在线实时自修正数学模型 ---');
  console.log(`  [① 幂律膨胀] ln(C_raw) = ${r1.intercept} + ${r1.slope} * ln(N)  (n=${r1.n}, R²=${r1.r2}) -> 轮数翻倍成本×${(2 ** r1.slope).toFixed(2)}`);
  console.log(`  [② 线性吞吐] C_weight  = ${r2.intercept} + ${r2.slope} * (μ·N·L_M) (n=${r2.n}, R²=${r2.r2})`);
  console.log(`  [③ 完成质量] Q_task    = ${r3.intercept} + (${r3.slope}) * ln(N_tree) (n=${r3.n}, R²=${r3.r2})`);
  console.log(`  [④ 单步延迟] t_LLM     = ${r4.mult_beta[0]} + ${r4.mult_beta[1]}*Out_k + ${r4.mult_beta[2]}*Ctx_100k (n=${r4.n}步, R²=${r4.mult_r2})`);
  console.log(`  [⑤ 耗用功率] C_dot(U/h)= ${ec.burn_formula_beta[0]} + ${ec.burn_formula_beta[1]}*μ + ${ec.burn_formula_beta[2]}*Ctx_100k + ${ec.burn_formula_beta[3]}*Sub/h (R²=${ec.burn_formula_r2})`);

  console.log(`\n--- 3. 受控因果对照实验榜 (明确【实验组 A】对比【基线 B】：质量 ΔQ / 省时率 / 耗用率增幅 / 成本变化) ---`);
  for (const cp of dash.counterfactual_pairs.slice(0, 10)) {
    const d = cp.deltas;
    console.log(
      `  [${cp.comparison_scope}] ${cp.base.uid.slice(0, 14)}\n` +
      `     基线B: T=${cp.base.T_min}m, C=${cp.base.C_u}U, 耗用率=${cp.base.burn_uh}U/h, Q_task=${cp.base.Q_task}\n` +
      `     实验A: T=${cp.target.T_min}m, C=${cp.target.C_u}U, 耗用率=${cp.target.burn_uh}U/h, Q_task=${cp.target.Q_task}\n` +
      `     差分结论: ${cp.verdict_label} | 质量 ΔQ=${d.delta_Q >= 0 ? '+' : ''}${d.delta_Q} | 省时=${d.time_saved_pct}% | 耗用率=${d.burn_surge_pct >= 0 ? '+' : ''}${d.burn_surge_pct}% (零溢价上限+${d.neutral_burn_limit_pct}%) | 单位成本=${d.cost_surge_pct >= 0 ? '+' : ''}${d.cost_surge_pct}%`
    );
  }
} else if (cmd === 'export') {
  const db = openObservatoryDb(DATA_DIR);
  syncAllAgentSources(db, DATA_DIR, false);
  const res = exportObservatoryCsv(db, DATA_DIR);
  console.log(`已导出 CSV 科研数据集: ${res.csv_path} (共 ${res.row_count} 条会话记录)`);
} else if (cmd === 'web') {
  process.argv.push('--no-mcp');
  const { startLocalWebMirror } = await import('./index.mjs');
  const port = 18765;
  startLocalWebMirror(port, true);
  const url = `http://127.0.0.1:${port}`;
  console.log(`QTC 跨Agent实时流观测大屏已启动: ${url}`);
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
} else if (cmd === 'daemon') {
  const child = spawn(process.execPath, [INDEX_SCRIPT, '--no-mcp', '--daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log(`[QTC Daemon] 已在后台静默拉起全天候 fs.watch 实时守护进程 (PID=${child.pid}, Web/SSE=http://127.0.0.1:18765)`);
} else if (cmd === 'autostart') {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const startupDir = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    mkdirSync(startupDir, { recursive: true });
    const vbsPath = join(startupDir, 'qtc-observatory-realtime-daemon.vbs');
    if (process.argv.includes('--remove')) {
      if (existsSync(vbsPath)) unlinkSync(vbsPath);
      console.log(`[QTC Autostart] 已移除开机自启守护脚本: ${vbsPath}`);
    } else {
      const escapedNode = process.execPath.replace(/"/g, '""');
      const escapedIdx = INDEX_SCRIPT.replace(/"/g, '""');
      const vbs = [
        'Set WshShell = CreateObject("WScript.Shell")',
        `WshShell.Run """${escapedNode}"" ""${escapedIdx}"" --no-mcp --daemon", 0, False`,
      ].join('\r\n');
      writeFileSync(vbsPath, vbs, 'utf8');
      console.log(`[QTC Autostart] 已写入零弹窗开机静默自启实时守护: ${vbsPath}`);
    }
  } else {
    console.log('当前平台请使用 pm2 / systemd / launchd 托管 `node server/index.mjs --no-mcp --daemon`。');
  }
}
