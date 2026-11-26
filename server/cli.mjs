#!/usr/bin/env node
/**
 * QTC Observatory v1.3.0 — 独立命令行与全天候无头守护进程管理入口
 */
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { openObservatoryDb, syncAllAgentSources } from './collector.mjs';
import { computeObservatoryAnalytics, exportObservatoryCsv } from './analytics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const HOST_PLUGIN_DATA = join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'qtc-observatory');
const DATA_DIR = (existsSync(HOST_PLUGIN_DATA) || existsSync(join(homedir(), '.gemini', 'antigravity', 'plugin_data')))
  ? HOST_PLUGIN_DATA
  : join(PLUGIN_ROOT, '.data');
const INDEX_SCRIPT = join(__dirname, 'index.mjs');

const cmd = process.argv[2] || 'report';

if (cmd === 'sync' || cmd === 'report') {
  const db = openObservatoryDb(DATA_DIR);
  const force = process.argv.includes('--force');
  const syncRes = syncAllAgentSources(db, DATA_DIR, force);
  const dash = computeObservatoryAnalytics(db, 'all');

  console.log('========================================================================');
  console.log(' QTC 观测中心 v1.4.0 — 五维证据累积型质量评分与受控因果对照快照');
  console.log('========================================================================');
  console.log(`[增量采集] 扫描日志: ${syncRes.scanned_files} | 新增/改名/重评: ${syncRes.updated_sessions} | 耗时: ${syncRes.elapsed_ms}ms`);
  console.log(`[总样本池] 总收录会话: ${dash.kpis.total_sessions} 个 (主对话: ${dash.kpis.root_projects}, 子代理: ${dash.kpis.subagent_sessions}) | 受控对照: ${dash.kpis.paired_experiment_count} 组`);

  const tierCounts = {};
  for (const p of dash.projects) {
    tierCounts[p.q_tier_label] = (tierCounts[p.q_tier_label] || 0) + 1;
  }
  console.log(`[质量分层] ${Object.entries(tierCounts).map(([k, v]) => `${k}: ${v}个`).join(' | ')}`);

  console.log('\n--- 1. 正在活跃对话脉搏 (实时显示最新对话名 + #短编号) ---');
  for (const s of dash.live_active_sessions) {
    const sh = (s.session_uid.split(':')[1] || s.session_uid).replace(/^session-/, '').slice(0, 8);
    console.log(`  • [${s.platform}] 「${s.display_name}」 (#${sh}) | ${s.turns}轮 · Ctx=${s.ctx_k}k · ${s.cost_u}U · ${s.seconds_ago}s前`);
  }

  console.log(`\n--- 2. 受控因果对照实验榜 (前 8 组) ---`);
  for (const cp of dash.counterfactual_pairs.slice(0, 8)) {
    const d = cp.deltas;
    const sh = (cp.target.uid.split(':')[1] || cp.target.uid).replace(/^session-/, '').slice(0, 8);
    console.log(
      `  • 「${cp.display_name}」 (#${sh}) [${cp.comparison_scope}]\n` +
      `     基线B (${cp.base.label}): T=${cp.base.T_min}m, C=${cp.base.C_u}U, 耗用率=${cp.base.burn_uh}U/h, Q=${cp.base.Q_task}\n` +
      `     实验A (${cp.target.label}): T=${cp.target.T_min}m, C=${cp.target.C_u}U, 耗用率=${cp.target.burn_uh}U/h, Q=${cp.target.Q_task}\n` +
      `     结论: ${cp.verdict_label} | ΔQ=${d.delta_Q >= 0 ? '+' : ''}${d.delta_Q} | 省时=${d.time_saved_pct}% | 耗用率=${d.burn_surge_pct >= 0 ? '+' : ''}${d.burn_surge_pct}% | 成本=${d.cost_surge_pct >= 0 ? '+' : ''}${d.cost_surge_pct}%`
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
