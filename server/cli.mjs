#!/usr/bin/env node
/**
 * QTC Observatory v1.1.0 — 独立命令行与全天候无头守护进程管理入口
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
  console.log(' QTC 跨Agent实时监测与自修正回归台 v1.1.0 — 全机真实样本计量快照');
  console.log('========================================================================');
  console.log(`[增量采集] 扫描文件: ${syncRes.scanned_files} | 新增/更新会话: ${syncRes.updated_sessions} | 未变跳过: ${syncRes.skipped_unchanged} | 耗时: ${syncRes.elapsed_ms}ms`);
  console.log(`[总样本池] 总收录会话: ${dash.kpis.total_sessions} 个 (根任务项目: ${dash.kpis.root_projects}, 子代理: ${dash.kpis.subagent_sessions}) | 总轮数: ${dash.kpis.total_turns}`);
  console.log(`[活跃脉搏] 过去15分钟正在活跃跳动的实时会话数: ${dash.live_active_sessions.length} 个`);
  console.log(`[全局账单] 总Token: ${dash.kpis.total_tokens_M}M | 总额度: ${dash.kpis.total_weighted_cost_u}U (缓存重读占 ${dash.kpis.cost_shares_pct.cache_read}%, 输入占 ${dash.kpis.cost_shares_pct.fresh_input}%, 输出占 ${dash.kpis.cost_shares_pct.output}%)`);
  console.log(`[全局耗时] 总时长: ${dash.kpis.total_exec_hours} 小时 (后台等待 ${dash.kpis.time_shares_pct.async_wait}%, LLM推理 ${dash.kpis.time_shares_pct.llm_think}%, 同步工具 ${dash.kpis.time_shares_pct.sync_tool}%)`);

  console.log('\n--- 1. 跨 AI Agent 平台样本分布 ---');
  for (const p of dash.platform_summary) {
    console.log(
      `  • ${p.platform.padEnd(14)} | 会话=${String(p.total_sessions).padStart(4)} (主${String(p.root_sessions).padStart(3)}+子${String(p.sub_sessions).padStart(3)}) | 轮数=${String(p.total_turns).padStart(5)} | 质量均分=${String(p.avg_q).padStart(5)} | 耗时=${String(p.exec_hours).padStart(6)}h | 额度=${String(p.weighted_cost_u).padStart(7)}U`
    );
  }

  const r1 = dash.regressions.power_law_cost_vs_turns;
  const r2 = dash.regressions.linear_throughput;
  const r3 = dash.regressions.quality_vs_turns;
  const r4 = dash.regressions.turn_latency_vs_out;
  const ec = dash.prescriptions.empirical_constants;
  console.log('\n--- 2. 在线实时自修正数学模型 (OLS + Multiple OLS + Online IRLS Logistic) ---');
  console.log(`  [① 幂律膨胀] ln(C_raw) = ${r1.intercept} + ${r1.slope} * ln(N)  (n=${r1.n}, R²=${r1.r2}, p=${r1.pValue}) -> 轮数翻倍成本×${(2 ** r1.slope).toFixed(2)}`);
  console.log(`  [② 线性吞吐] C_weight  = ${r2.intercept} + ${r2.slope} * (μ·N·L_M) (n=${r2.n}, R²=${r2.r2}, p=${r2.pValue})`);
  console.log(`  [③ 质量退化] Q_final   = ${r3.intercept} + (${r3.slope}) * ln(N_tree) (n=${r3.n}, R²=${r3.r2}, p=${r3.pValue})`);
  console.log(`  [④ 单步延迟] t_LLM     = ${r4.mult_beta[0]} + ${r4.mult_beta[1]}*Out_k + ${r4.mult_beta[2]}*Ctx_100k (n=${r4.n}步, R²=${r4.mult_r2})`);
  console.log(`  [⑤ 在线IRLS] P_live 权重=[${ec.logit_live_weights.join(', ')}] (Acc=${ec.logit_live_accuracy}%) -> 动态50%生死线 N_50% = ${ec.dynamic_n_crit_50} 轮`);
  console.log(`  [⑥ 弹性边界] P_state 权重=[${ec.logit_state_weights.join(', ')}] -> 动态时间:金钱弹性比 = ${ec.time_cost_elasticity_ratio} : 1`);

  console.log(`\n--- 3. 抓获“捡芝麻丢西瓜 / 双输不合算”异常项目: 共 ${dash.sesame_alerts.length} 个 (累计可避免浪费 ${dash.kpis.total_estimated_waste_u}U) ---`);
  for (const a of dash.sesame_alerts.slice(0, 6)) {
    console.log(
      `  [${a.platform}] ${a.session_uid.slice(0, 16)} | ${a.type} | 超支+${a.cost_increase_pct}% vs 省时${a.time_saved_pct}% | C=${a.C_units}U, T=${a.T_min}m, Q=${a.Q_final} | 浪费≈${a.estimated_waste_u}U`
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
  console.log(`QTC 跨Agent实时流观测大屏已启动: ${url} (fs.watch 秒级监听 + SSE 无感热推中，按 Ctrl+C 停止)`);
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
} else if (cmd === 'daemon') {
  // 独立静默后台守护进程（脱离任何 IDE 持续实时监控全机所有 AI Agent）
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
