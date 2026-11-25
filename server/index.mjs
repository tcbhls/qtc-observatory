#!/usr/bin/env node
/**
 * QTC Observatory — 零干扰跨 Agent 监测台 MCP App Server + 本地 Web 服务
 *
 * 零干扰隔离保证：
 * 1. 所有分析、同步、打分、推演工具均标记 visibility: ["app"]，对大模型 100% 隐形（0 Prompt Token 占用）。
 * 2. 唯一面板入口 open_qtc_observatory 为非 eager 工具，挂载侧栏与全局导航栏供人类研究者直接点开。
 * 3. 同时尝试在 127.0.0.1:18765 提供本地只读看板与通用 POST /api/ingest 接入，方便监控 DSH / Claude / Codex。
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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openObservatoryDb, syncAllAgentSources } from './collector.mjs';
import {
  computeObservatoryAnalytics,
  exportObservatoryCsv,
  simulateAgentPolicy,
} from './analytics.mjs';

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

const db = openObservatoryDb(DATA_DIR);

// 启动后异步执行首次增量采集，随后每 45 秒静默增量刷新（unref 不阻塞退出）
let lastSyncSummary = { scanned_files: 0, updated_sessions: 0, skipped_unchanged: 0, elapsed_ms: 0 };
function safeBackgroundSync(force = false) {
  try {
    lastSyncSummary = syncAllAgentSources(db, DATA_DIR, force);
  } catch {
    // 静默容错，绝不向 stdio 乱写破坏 MCP 协议帧
  }
  return lastSyncSummary;
}

setTimeout(() => safeBackgroundSync(false), 50).unref();
setInterval(() => safeBackgroundSync(false), 45000).unref();

function getHtmlContent() {
  if (existsSync(HTML_PATH)) {
    return readFileSync(HTML_PATH, 'utf8');
  }
  return '<!doctype html><html><body><h3>QTC Observatory UI 未构建，请运行 npm run build</h3></body></html>';
}

// 启动本地独立 Web 镜像端口（供监控 DSH / Claude Code / Codex 时浏览器直接打开，端口占用时静默跳过）
export function startLocalWebMirror(port = WEB_PORT) {
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

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      safeBackgroundSync(false);
      const plat = url.searchParams.get('platform') || 'all';
      const data = computeObservatoryAnalytics(db, plat);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...data, sync_info: lastSyncSummary }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        if (req.method === 'POST' && url.pathname === '/api/sync') {
          const s = safeBackgroundSync(Boolean(payload.force));
          const data = computeObservatoryAnalytics(db, payload.platform || 'all');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ...data, sync_info: s }));
        } else if (req.method === 'POST' && url.pathname === '/api/rate') {
          db.prepare(`
            INSERT INTO human_ratings (session_uid, q_human, note, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_uid) DO UPDATE SET
              q_human = excluded.q_human, note = excluded.note, updated_at = excluded.updated_at
          `).run(String(payload.session_uid), Number(payload.q_human), String(payload.note || ''), Date.now());
          const data = computeObservatoryAnalytics(db, payload.platform || 'all');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(data));
        } else if (req.method === 'POST' && url.pathname === '/api/simulate') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(simulateAgentPolicy(payload)));
        } else if (req.method === 'POST' && url.pathname === '/api/export') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(exportObservatoryCsv(db, DATA_DIR)));
        } else if (req.method === 'POST' && url.pathname === '/api/ingest') {
          // 通用外部 AI Agent 零阻塞 HTTP 样本投递接口
          mkdirSync(join(DATA_DIR, 'dropin'), { recursive: true });
          const dropFile = join(DATA_DIR, 'dropin', 'http_ingest.jsonl');
          appendFileSync(dropFile, JSON.stringify(payload) + '\n', 'utf8');
          safeBackgroundSync(false);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
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
    // 若已有另一个 MCP 实例占用了 18765，静默复用即可，绝不报错中断 MCP
  });
  httpSrv.listen(port, '127.0.0.1');
  httpSrv.unref();
  return httpSrv;
}

// 若直接作为 MCP Server 启动
if (!process.argv.includes('--no-mcp')) {
  startLocalWebMirror(WEB_PORT);

  const server = new McpServer({
    name: 'qtc-observatory',
    version: '1.0.0',
  });

  registerAppResource(
    server,
    'QTC 跨Agent任务监测与性价比研究台',
    APP_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: '跨 AI Agent (Antigravity / DSH / Claude Code / Codex) 质量-时间-金钱实证回归与性价比推算工作台',
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

  // 1. 面板启动入口（支持左侧栏 Global 与右侧栏 + Aux Pane 直接点开）
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
      const syncInfo = safeBackgroundSync(false);
      const data = computeObservatoryAnalytics(db, platform || 'all');
      return {
        content: [
          {
            type: 'text',
            text: `已打开 QTC 跨Agent监测台（当前收录 ${data.kpis.total_sessions} 个真实会话样本，本地镜像 http://127.0.0.1:${WEB_PORT}）。`,
          },
        ],
        structuredContent: { ...data, sync_info: syncInfo, web_url: `http://127.0.0.1:${WEB_PORT}` },
      };
    }
  );

  // 2. 以下所有交互工具均严格设置 visibility: ["app"]，对 AI Agent 模型完全隐身！
  const APP_ONLY_META = { ui: { visibility: ['app'] } };

  registerAppTool(
    server,
    'qtc_get_dashboard',
    {
      title: '获取最新 QTC 回归数据',
      inputSchema: { platform: z.string().optional() },
      _meta: APP_ONLY_META,
    },
    async ({ platform }) => {
      const s = safeBackgroundSync(false);
      const data = computeObservatoryAnalytics(db, platform || 'all');
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ...data, sync_info: s } };
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
      const s = safeBackgroundSync(Boolean(force));
      const data = computeObservatoryAnalytics(db, platform || 'all');
      return { content: [{ type: 'text', text: 'synced' }], structuredContent: { ...data, sync_info: s } };
    }
  );

  registerAppTool(
    server,
    'qtc_rate_session',
    {
      title: '人工标注会话真实质量得分',
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
      const data = computeObservatoryAnalytics(db, platform || 'all');
      return { content: [{ type: 'text', text: 'rated' }], structuredContent: data };
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
    async (args) => ({
      content: [{ type: 'text', text: 'simulated' }],
      structuredContent: simulateAgentPolicy(args),
    })
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
