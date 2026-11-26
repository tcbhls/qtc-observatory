#!/usr/bin/env node
/**
 * QTC Observatory v1.1.0 — 零干扰跨 Agent 实时监测台 (fs.watch 秒级流 + 在线 IRLS 自修正 + SSE 热推)
 *
 * 零干扰隔离保证：
 * 1. 所有分析、同步、心跳、打分、推演工具均标记 visibility: ["app"]，对大模型 100% 隐形（0 Prompt Token 占用）。
 * 2. 唯一面板入口 open_qtc_observatory 为非 eager 工具，挂载侧栏与全局导航栏供人类研究者直接点开。
 * 3. 内置内核级 fs.watch 递归文件监听 + SSE (/api/events) 秒级广播 + 可选本地科研图表异步重绘钩子 (.data/local_hooks.json)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openObservatoryDb, syncAllAgentSources } from './collector.mjs';
import {
  computeObservatoryAnalytics,
  exportObservatoryCsv,
  simulateAgentPolicy,
} from './analytics.mjs';
import { createRealtimeAgentWatcher } from './watcher.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const APP_URI = 'ui://qtc-observatory/app.html';
const HTML_PATH = join(PLUGIN_ROOT, 'dist', 'app.html');

function getArg(prefix, fallback) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const DATA_DIR = getArg('--data_dir=', join(PLUGIN_ROOT, '.data'));
const WEB_PORT = Number(getArg('--port=', '18765'));
const IS_DAEMON = process.argv.includes('--daemon');

const db = openObservatoryDb(DATA_DIR);

let dataVersion = 1;
let lastUpdatedAt = new Date().toISOString();
let lastChangedSource = 'boot';
let lastSyncSummary = { scanned_files: 0, updated_sessions: 0, skipped_unchanged: 0, elapsed_ms: 0 };
let cachedAllAnalytics = null;
const sseClients = new Set();

let plotHookTimer = null;
let plotHookRunning = false;

/**
 * 若本地 .data/local_hooks.json 配置了科研图表刷新脚本（不进入 Git 仓库），则在样本变更后静默后台重绘 PNG
 */
function triggerLocalPlotHook() {
  const hookPath = join(DATA_DIR, 'local_hooks.json');
  if (!existsSync(hookPath)) return;
  if (plotHookTimer) clearTimeout(plotHookTimer);
  plotHookTimer = setTimeout(() => {
    plotHookTimer = null;
    if (plotHookRunning) return;
    try {
      const cfg = JSON.parse(readFileSync(hookPath, 'utf8'));
      if (!cfg.python_exe || !cfg.script_path || !existsSync(cfg.script_path)) return;
      plotHookRunning = true;
      const child = spawn(cfg.python_exe, [cfg.script_path, '--db', join(DATA_DIR, 'qtc_observatory.db')], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('close', () => { plotHookRunning = false; });
      child.on('error', () => { plotHookRunning = false; });
      if (child.unref) child.unref();
    } catch {
      plotHookRunning = false;
    }
  }, 1500);
  if (plotHookTimer.unref) plotHookTimer.unref();
}

function broadcastSseUpdate(summary) {
  if (!sseClients.size) return;
  const payload = JSON.stringify({
    version: dataVersion,
    updated_at: lastUpdatedAt,
    source: lastChangedSource,
    updated_sessions: summary?.updated_sessions || 0,
    total_sessions: cachedAllAnalytics?.kpis?.total_sessions || 0,
    total_turns: cachedAllAnalytics?.kpis?.total_turns || 0,
    n_crit_50: cachedAllAnalytics?.kpis?.dynamic_n_crit_50 || 0,
  });
  for (const res of sseClients) {
    try {
      res.write(`event: update\ndata: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

export function safeRealtimeSync(sourceTag = 'poll', force = false) {
  try {
    const syncRes = syncAllAgentSources(db, DATA_DIR, force);
    lastSyncSummary = syncRes;
    if (!cachedAllAnalytics || force || syncRes.updated_sessions > 0) {
      cachedAllAnalytics = computeObservatoryAnalytics(db, 'all');
      if (syncRes.updated_sessions > 0 || force) {
        dataVersion++;
        lastUpdatedAt = new Date().toISOString();
        lastChangedSource = sourceTag;
        broadcastSseUpdate(syncRes);
        triggerLocalPlotHook();
      }
      if (IS_DAEMON) {
        try {
          writeFileSync(
            join(DATA_DIR, 'daemon.status.json'),
            JSON.stringify({
              pid: process.pid,
              port: WEB_PORT,
              version: dataVersion,
              updated_at: lastUpdatedAt,
              last_source: lastChangedSource,
              total_sessions: cachedAllAnalytics.kpis.total_sessions,
              total_turns: cachedAllAnalytics.kpis.total_turns,
            }, null, 2),
            'utf8'
          );
        } catch {}
      }
    }
  } catch {
    // 严守零干扰原则，绝不向 stdout/stderr 抛出噪音破坏 MCP 协议帧
  }
  return lastSyncSummary;
}

// 启动首次同步 + 内核级 fs.watch 秒级递归监听 + 10 秒兜底巡检
const agentWatcher = createRealtimeAgentWatcher(DATA_DIR, (dirtySrc) => {
  safeRealtimeSync(`fswatch:${dirtySrc}`, false);
});
setTimeout(() => safeRealtimeSync('boot', false), 30).unref();
const heartbeatTimer = setInterval(() => safeRealtimeSync('heartbeat', false), 10000);
if (!IS_DAEMON && heartbeatTimer.unref) heartbeatTimer.unref();

function getDashboardPayload(platform = 'all') {
  const data = (platform === 'all' && cachedAllAnalytics)
    ? cachedAllAnalytics
    : computeObservatoryAnalytics(db, platform || 'all');
  return {
    ...data,
    realtime_meta: {
      version: dataVersion,
      updated_at: lastUpdatedAt,
      source: lastChangedSource,
      watched_dirs: agentWatcher.watchedCount,
      sse_clients: sseClients.size,
    },
    sync_info: lastSyncSummary,
    web_url: `http://127.0.0.1:${WEB_PORT}`,
  };
}

function getHtmlContent() {
  if (existsSync(HTML_PATH)) {
    return readFileSync(HTML_PATH, 'utf8');
  }
  return '<!doctype html><html><body><h3>QTC Observatory UI 未构建，请运行 npm run build</h3></body></html>';
}

// 启动本地独立 Web 镜像 + SSE 实时流端口
export function startLocalWebMirror(port = WEB_PORT, keepAliveRef = false) {
  const httpSrv = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtmlContent());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({
        version: dataVersion,
        updated_at: lastUpdatedAt,
        watched_dirs: agentWatcher.watchedCount,
      })}\n\n`);
      sseClients.add(res);
      const ka = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { sseClients.delete(res); clearInterval(ka); }
      }, 15000);
      if (ka.unref) ka.unref();
      req.on('close', () => {
        sseClients.delete(res);
        clearInterval(ka);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/version') {
      safeRealtimeSync('http-version', false);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        version: dataVersion,
        updated_at: lastUpdatedAt,
        source: lastChangedSource,
        watched_dirs: agentWatcher.watchedCount,
        total_sessions: cachedAllAnalytics?.kpis?.total_sessions || 0,
        total_turns: cachedAllAnalytics?.kpis?.total_turns || 0,
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      safeRealtimeSync('http-dashboard', false);
      const plat = url.searchParams.get('platform') || 'all';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getDashboardPayload(plat)));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        if (req.method === 'POST' && url.pathname === '/api/sync') {
          safeRealtimeSync('manual-sync', Boolean(payload.force));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(getDashboardPayload(payload.platform || 'all')));
        } else if (req.method === 'POST' && url.pathname === '/api/rate') {
          db.prepare(`
            INSERT INTO human_ratings (session_uid, q_human, note, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_uid) DO UPDATE SET
              q_human = excluded.q_human, note = excluded.note, updated_at = excluded.updated_at
          `).run(String(payload.session_uid), Number(payload.q_human), String(payload.note || ''), Date.now());
          cachedAllAnalytics = computeObservatoryAnalytics(db, 'all');
          dataVersion++;
          lastUpdatedAt = new Date().toISOString();
          lastChangedSource = `human-rate:${payload.session_uid}`;
          broadcastSseUpdate({ updated_sessions: 1 });
          triggerLocalPlotHook();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(getDashboardPayload(payload.platform || 'all')));
        } else if (req.method === 'POST' && url.pathname === '/api/simulate') {
          if (!cachedAllAnalytics) cachedAllAnalytics = computeObservatoryAnalytics(db, 'all');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(simulateAgentPolicy(payload)));
        } else if (req.method === 'POST' && url.pathname === '/api/export') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(exportObservatoryCsv(db, DATA_DIR)));
        } else if (req.method === 'POST' && url.pathname === '/api/ingest') {
          mkdirSync(join(DATA_DIR, 'dropin'), { recursive: true });
          const dropFile = join(DATA_DIR, 'dropin', 'http_ingest.jsonl');
          appendFileSync(dropFile, JSON.stringify(payload) + '\n', 'utf8');
          safeRealtimeSync('http-ingest', false);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, version: dataVersion }));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
  });

  httpSrv.on('error', () => {
    // 若守护进程或另一实例已监听 18765，MCP 实例静默退让端口，共享同一 WAL SQLite 库
    if (IS_DAEMON) process.exit(0);
  });
  httpSrv.listen(port, '127.0.0.1', () => {
    if (IS_DAEMON) {
      try { writeFileSync(join(DATA_DIR, 'daemon.pid'), String(process.pid), 'utf8'); } catch {}
    }
  });
  if (!keepAliveRef && !IS_DAEMON) {
    httpSrv.unref();
  }
  return httpSrv;
}

if (IS_DAEMON) {
  startLocalWebMirror(WEB_PORT, true);
} else if (!process.argv.includes('--no-mcp')) {
  startLocalWebMirror(WEB_PORT, false);

  const server = new McpServer({
    name: 'qtc-observatory',
    version: '1.4.0',
  });

  registerAppResource(
    server,
    'QTC 跨Agent实时任务监测与性价比研究台',
    APP_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: '跨 AI Agent (Antigravity / DSH / Claude Code / Codex) 秒级实时样本流、在线 IRLS 自修正回归与性价比推算工作台',
      _meta: {
        ui: { prefersBorder: false },
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: getHtmlContent(),
        },
      ],
    })
  );

  registerAppTool(
    server,
    'open_qtc_observatory',
    {
      title: 'QTC 跨Agent监测台',
      description: '仅当操作者明确要求打开 QTC 任务监测面板时调用。严禁在执行普通任务时主动调用。',
      inputSchema: {
        platform: z.string().optional().describe('可选平台过滤: all / antigravity / dsh / claude-code / codex'),
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'QTC 跨Agent监测台' },
            { type: 'global', title: 'QTC 跨Agent观测中心' },
          ],
        },
      },
    },
    async ({ platform }) => {
      safeRealtimeSync('mcp-open', false);
      const payload = getDashboardPayload(platform || 'all');
      return {
        content: [
          {
            type: 'text',
            text: `已打开 QTC 跨Agent实时监测台 v1.1.0（当前实时监听 ${agentWatcher.watchedCount} 个日志源，收录 ${payload.kpis.total_sessions} 个真实会话，本地流式大屏 http://127.0.0.1:${WEB_PORT}）。`,
          },
        ],
        structuredContent: payload,
      };
    }
  );

  // 以下所有 UI 通信与心跳工具严格标记 visibility: ["app"]，对宿主大模型 100% 隐形！
  const APP_ONLY_META = { ui: { visibility: ['app'] } };

  registerAppTool(
    server,
    'qtc_check_version',
    {
      title: '轻量级实时版本心跳检测',
      inputSchema: {},
      _meta: APP_ONLY_META,
    },
    async () => {
      safeRealtimeSync('app-heartbeat', false);
      return {
        content: [{ type: 'text', text: 'v' }],
        structuredContent: {
          version: dataVersion,
          updated_at: lastUpdatedAt,
          source: lastChangedSource,
          watched_dirs: agentWatcher.watchedCount,
        },
      };
    }
  );

  registerAppTool(
    server,
    'qtc_get_dashboard',
    {
      title: '获取最新 QTC 实时回归数据',
      inputSchema: { platform: z.string().optional() },
      _meta: APP_ONLY_META,
    },
    async ({ platform }) => {
      safeRealtimeSync('app-dashboard', false);
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: getDashboardPayload(platform || 'all') };
    }
  );

  registerAppTool(
    server,
    'qtc_sync_sources',
    {
      title: '强制全量/增量扫描所有 AI Agent 日志',
      inputSchema: { force: z.boolean().optional(), platform: z.string().optional() },
      _meta: APP_ONLY_META,
    },
    async ({ force, platform }) => {
      safeRealtimeSync('app-force-sync', Boolean(force));
      return { content: [{ type: 'text', text: 'synced' }], structuredContent: getDashboardPayload(platform || 'all') };
    }
  );

  registerAppTool(
    server,
    'qtc_rate_session',
    {
      title: '人工标注会话真实质量得分并在线重训练模型',
      inputSchema: {
        session_uid: z.string(),
        q_human: z.number().min(0).max(100),
        note: z.string().optional(),
        platform: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ session_uid, q_human, note, platform }) => {
      db.prepare(`
        INSERT INTO human_ratings (session_uid, q_human, note, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_uid) DO UPDATE SET
          q_human = excluded.q_human, note = excluded.note, updated_at = excluded.updated_at
      `).run(session_uid, q_human, note || '', Date.now());
      cachedAllAnalytics = computeObservatoryAnalytics(db, 'all');
      dataVersion++;
      lastUpdatedAt = new Date().toISOString();
      lastChangedSource = `human-rate:${session_uid}`;
      broadcastSseUpdate({ updated_sessions: 1 });
      triggerLocalPlotHook();
      return { content: [{ type: 'text', text: 'rated' }], structuredContent: getDashboardPayload(platform || 'all') };
    }
  );

  registerAppTool(
    server,
    'qtc_simulate_policy',
    {
      title: '预演测试 Agent 工作策略',
      inputSchema: {
        turns: z.number().optional(),
        model_mult: z.number().optional(),
        tools_per_turn: z.number().optional(),
        avg_ctx_k: z.number().optional(),
        sub_count: z.number().optional(),
        sub_mult: z.number().optional(),
        sub_dup_read: z.boolean().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      if (!cachedAllAnalytics) cachedAllAnalytics = computeObservatoryAnalytics(db, 'all');
      return {
        content: [{ type: 'text', text: 'simulated' }],
        structuredContent: simulateAgentPolicy(args),
      };
    }
  );

  registerAppTool(
    server,
    'qtc_export_csv',
    {
      title: '导出全量跨 Agent 样本库为 CSV',
      inputSchema: {},
      _meta: APP_ONLY_META,
    },
    async () => ({
      content: [{ type: 'text', text: 'exported' }],
      structuredContent: exportObservatoryCsv(db, DATA_DIR),
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
