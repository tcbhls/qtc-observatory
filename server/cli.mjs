#!/usr/bin/env node
/**
 * QTC Observatory 独立命令行与守护模式入口（不依赖任何单一 IDE 即可监控全机所有 AI Agent）
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openObservatoryDb, syncAllAgentSources } from './collector.mjs';
import { computeObservatoryAnalytics, exportObservatoryCsv } from './analytics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const DATA_DIR = join(PLUGIN_ROOT, '.data');

const cmd = process.argv[2] || 'report';
const db = openObservatoryDb(DATA_DIR);

if (cmd === 'sync' || cmd === 'report') {
  const force = process.argv.includes('--force');
  const syncRes = syncAllAgentSources(db, DATA_DIR, force);
  const dash = computeObservatoryAnalytics(db, 'all');

  console.log('========================================================================');
  console.log(' QTC 跨Agent任务监测与性价比研究台 — 全机真实样本同步与计量回归快照');
  console.log('========================================================================');
  console.log(`[增量采集] 扫描文件: ${syncRes.scanned_files} | 新增/更新会话: ${syncRes.updated_sessions} | 未变跳过: ${syncRes.skipped_unchanged} | 耗时: ${syncRes.elapsed_ms}ms`);
  console.log(`[总样本池] 总收录会话: ${dash.kpis.total_sessions} 个 (根任务项目: ${dash.kpis.root_projects}, 子代理: ${dash.kpis.subagent_sessions}) | 总轮数: ${dash.kpis.total_turns}`);
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
  console.log('\n--- 2. 全机最新动态计量回归方程 ---');
  console.log(`  [幂律膨胀] ln(C_raw) = ${r1.intercept} + ${r1.slope} * ln(N)  (n=${r1.n}, R²=${r1.r2}, p=${r1.pValue}) -> 轮数翻倍成本×${(2 ** r1.slope).toFixed(2)}`);
  console.log(`  [线性吞吐] C_weight  = ${r2.intercept} + ${r2.slope} * (μ·N·L_M) (n=${r2.n}, R²=${r2.r2}, p=${r2.pValue})`);
  console.log(`  [质量退化] Q_final   = ${r3.intercept} + (${r3.slope}) * ln(N_tree) (n=${r3.n}, R²=${r3.r2}, p=${r3.pValue})`);

  console.log(`\n--- 3. 抓获“捡芝麻丢西瓜 / 双输不合算”异常项目: 共 ${dash.sesame_alerts.length} 个 (累计可避免浪费 ${dash.kpis.total_estimated_waste_u}U) ---`);
  for (const a of dash.sesame_alerts.slice(0, 8)) {
    console.log(
      `  [${a.platform}] ${a.session_uid.slice(0, 16)} | ${a.type} | 超支+${a.cost_increase_pct}% vs 省时${a.time_saved_pct}% | C=${a.C_units}U, T=${a.T_min}m, Q=${a.Q_final} | 浪费≈${a.estimated_waste_u}U | ${a.reasons[0] || ''}`
    );
  }
} else if (cmd === 'export') {
  syncAllAgentSources(db, DATA_DIR, false);
  const res = exportObservatoryCsv(db, DATA_DIR);
  console.log(`已导出 CSV 科研数据集: ${res.csv_path} (共 ${res.row_count} 条会话记录)`);
} else if (cmd === 'web') {
  process.argv.push('--no-mcp');
  const { startLocalWebMirror } = await import('./index.mjs');
  const port = 18765;
  const srv = startLocalWebMirror(port);
  srv.ref();
  const url = `http://127.0.0.1:${port}`;
  console.log(`QTC 跨Agent观测大屏已启动: ${url} (按 Ctrl+C 停止，每 45 秒自动静默同步全机 Agent 日志)`);
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}
