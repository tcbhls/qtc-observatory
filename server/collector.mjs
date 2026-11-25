// QTC Observatory — 跨 AI Agent 零干扰只读日志采集与 SQLite 科研样本库引擎
// 原生只读采集支持: Antigravity, DeepSeek Harness (DSH .zstd), Claude Code, OpenAI Codex, Custom Drop-in JSONL
// 严格保证：所有外部日志均以只读方式读取，绝不修改、加锁或干扰任何正在运行的 AI Agent。
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const HOME = homedir();
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NEG_FEEDBACK_RE = /不对|有问题|错误|报错|失败|打不开|没用|很虚|生气|脚趾|重做|重新|不行|太慢|卡住|漏了|少了|多了|没改|乱码|崩溃|闪退|白屏|不满意|好好审核|辩解|wrong|broken|error|failed|redo|fix this/i;
const TOOL_TS_RE = /Created At:\s*(\S+)\s+Completed At:\s*(\S+)/;

/**
 * 统一模型档位费率映射（以标准旗舰 High 档 1M Input = 1.0 Unit 为锚点）
 * Cache Read = 0.20x, Output = 5.0x
 */
export function resolveModelPricing(modelName = '', platform = '') {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('neon-xhigh') || m.includes('opus') || m.includes('o3') || m.includes('pro-preview')) {
    return { tier: 'Apex-XHigh', mult: 2.0 };
  }
  if (m.includes('neon-high') || m.includes('gpt-5') || m.includes('gpt-6') || m.includes('sonnet')) {
    return { tier: 'Flagship-High', mult: 1.35 };
  }
  if (m.includes('carbon') || m.includes('dfmodel') || m.includes('deepseek-reasoner') || m.includes('r1')) {
    return { tier: 'Balanced-High', mult: 1.0 };
  }
  if (
    m.includes('hydrogen') ||
    m.includes('flash') ||
    m.includes('haiku') ||
    m.includes('mini') ||
    m.includes('deepseek-chat') ||
    m.includes('v3') ||
    m.includes('v4')
  ) {
    return { tier: 'Fast-Lightweight', mult: 0.28 };
  }
  if (platform === 'dsh') return { tier: 'Balanced-High', mult: 0.65 };
  return { tier: 'Standard-Default', mult: 1.0 };
}

export function classifyTaskDomain(text = '', cwd = '', imgReads = 0) {
  const s = `${text} ${cwd}`.toLowerCase();
  if (
    imgReads >= 25 ||
    /生图|comfyui|lora|漫画|上色|分镜|出图|sdxl|inpaint|illustrious/.test(s)
  ) {
    return 'AI生图与视觉创作';
  }
  if (
    /app|安卓|android|手机|健身|听歌|开发|软件|详情页|画布|插件|前端|react|vue|vite|游戏|html|ui|mcp/.test(s)
  ) {
    return '软件工程与UI开发';
  }
  if (
    /逆向|破甲|rea|asar|hook|二进制|frida|注入|补丁|协议|抓包|破解/.test(s)
  ) {
    return '逆向分析与底层安全';
  }
  if (
    /仿真|作业|数学|回归|研究|论文|算法|统计|搜索全网|调研|分析/.test(s)
  ) {
    return '科研仿真与深度调研';
  }
  return '系统运维与日常问答';
}

function parseIsoSec(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    return val > 1e11 ? val / 1000.0 : val;
  }
  const ms = Date.parse(String(val));
  return Number.isNaN(ms) ? null : ms / 1000.0;
}

function estimateTokensFromText(str = '') {
  if (!str) return 0;
  // 混合中英文与代码经验折算：约 3.2 UTF-8 字节 ≈ 1 Token
  return Math.ceil(Buffer.byteLength(String(str), 'utf8') / 3.2);
}

export function openObservatoryDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'dropin'), { recursive: true });
  const dbPath = join(dataDir, 'qtc_observatory.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS file_watermarks (
      source_path TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      session_uid TEXT NOT NULL,
      synced_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_uid TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      raw_id TEXT NOT NULL,
      parent_uid TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      domain TEXT NOT NULL,
      primary_model TEXT NOT NULL,
      model_tier TEXT NOT NULL,
      model_mult REAL NOT NULL,
      started_at REAL DEFAULT 0,
      ended_at REAL DEFAULT 0,
      cwd TEXT DEFAULT '',
      title TEXT DEFAULT '',
      user_turns INTEGER DEFAULT 0,
      neg_feedback_turns INTEGER DEFAULT 0,
      planner_turns INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      single_tool_turns INTEGER DEFAULT 0,
      cmd_total INTEGER DEFAULT 0,
      cmd_failed INTEGER DEFAULT 0,
      file_edits INTEGER DEFAULT 0,
      image_reads INTEGER DEFAULT 0,
      compactions INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      mean_ctx_k REAL DEFAULT 0,
      max_ctx_k REAL DEFAULT 0,
      token_accuracy TEXT DEFAULT 'exact',
      raw_cost_units REAL DEFAULT 0,
      weighted_cost_units REAL DEFAULT 0,
      cache_tax_share REAL DEFAULT 0,
      llm_infer_sec REAL DEFAULT 0,
      sync_tool_sec REAL DEFAULT 0,
      bg_wait_sec REAL DEFAULT 0,
      exec_time_min REAL DEFAULT 0,
      workload_score REAL DEFAULT 1,
      q_objective REAL DEFAULT 100,
      source_path TEXT DEFAULT '',
      sub_ref_ids TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS human_ratings (
      session_uid TEXT PRIMARY KEY,
      q_human REAL NOT NULL,
      note TEXT DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_samples (
      session_uid TEXT NOT NULL,
      turn_idx INTEGER NOT NULL,
      platform TEXT NOT NULL,
      model_tier TEXT NOT NULL,
      ctx_k REAL NOT NULL,
      out_k REAL NOT NULL,
      llm_sec REAL NOT NULL,
      n_tools INTEGER NOT NULL,
      step_cost_u REAL NOT NULL,
      PRIMARY KEY (session_uid, turn_idx)
    );
  `);
  return db;
}

function finalizeCommonMetrics(rec) {
  const { tier, mult } = resolveModelPricing(rec.primary_model, rec.platform);
  rec.model_tier = tier;
  rec.model_mult = mult;

  const inM = rec.input_tokens / 1e6;
  const caM = rec.cache_read_tokens / 1e6;
  const ouM = rec.output_tokens / 1e6;
  const rawCost = inM * 1.0 + caM * 0.20 + ouM * 5.0;
  rec.raw_cost_units = Number(rawCost.toFixed(5));
  rec.weighted_cost_units = Number((rawCost * mult).toFixed(5));
  rec.cache_tax_share = rawCost > 1e-9 ? Number(((caM * 0.20) / rawCost).toFixed(4)) : 0;

  const execMin = Math.max(0.15, (rec.llm_infer_sec + rec.sync_tool_sec + rec.bg_wait_sec) / 60.0);
  rec.exec_time_min = Number(execMin.toFixed(2));

  const okCmds = Math.max(0, rec.cmd_total - rec.cmd_failed);
  rec.workload_score = Number(
    (2.0 + 0.35 * okCmds + 1.20 * rec.file_edits + 0.18 * (rec.output_tokens / 1000.0) + 0.08 * rec.tool_calls).toFixed(3)
  );

  const cmdOkRate = rec.cmd_total > 0 ? 1.0 - rec.cmd_failed / rec.cmd_total : 1.0;
  const userSatRate = 1.0 - rec.neg_feedback_turns / Math.max(1, rec.user_turns || 1);
  const memRate = Math.exp(-0.12 * rec.compactions);
  rec.q_objective = Number((100.0 * (0.40 * cmdOkRate + 0.40 * userSatRate + 0.20 * memRate)).toFixed(2));
  rec.domain = classifyTaskDomain(rec.title, rec.cwd, rec.image_reads);
  return rec;
}

/** 1. 解析 Antigravity transcript.jsonl */
function parseAntigravityFile(filePath, cid) {
  const text = readFileSync(filePath, 'utf8');
  const steps = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { steps.push(JSON.parse(t)); } catch {}
  }
  if (!steps.length) return null;

  let userTurns = 0, negTurns = 0, plannerTurns = 0, toolCalls = 0, singleToolTurns = 0;
  let cmdTotal = 0, cmdFailed = 0, fileEdits = 0, imageReads = 0, compactions = 0;
  let inSum = 0, caSum = 0, ouSum = 0;
  let llmSec = 0, syncSec = 0, bgSec = 0;
  let firstUser = '', cwd = '', startTs = null, endTs = null;
  const ctxArr = [];
  const modelCounts = new Map();
  const subRefIds = new Set();
  const turns = [];

  // 检查首条输入是否缺失 <ADDITIONAL_METADATA> (子代理判据之一)
  let hasHumanMetadata = false;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const ts = parseIsoSec(s.created_at);
    const nxtTs = i + 1 < steps.length ? parseIsoSec(steps[i + 1].created_at) : null;
    if (ts !== null) {
      if (startTs === null || ts < startTs) startTs = ts;
      if (endTs === null || ts > endTs) endTs = ts;
    }
    const st = s.type;
    const ct = String(s.content || '');

    if (st === 'CHECKPOINT') {
      compactions++;
    } else if (st === 'USER_INPUT') {
      userTurns++;
      if (ct.includes('<ADDITIONAL_METADATA>')) hasHumanMetadata = true;
      let clean = ct;
      if (ct.includes('<USER_REQUEST>')) {
        clean = ct.split('<USER_REQUEST>')[1].split('</USER_REQUEST>')[0].trim();
      }
      if (!firstUser && clean) firstUser = clean.replace(/\s+/g, ' ').slice(0, 140);
      if (userTurns > 1 && (NEG_FEEDBACK_RE.test(clean) || ct.includes('Comments on the file'))) {
        negTurns++;
      }
    } else if (st === 'GENERIC') {
      const mTs = TOOL_TS_RE.exec(ct);
      if (mTs) {
        const t0 = parseIsoSec(mTs[1]);
        const t1 = parseIsoSec(mTs[2]);
        if (t0 && t1 && t1 >= t0 && t1 - t0 <= 3600) {
          if (t1 - t0 <= 60) syncSec += (t1 - t0);
          else bgSec += (t1 - t0);
        }
      }
      if (ct.includes('Command exited with code ')) {
        cmdTotal++;
        if (!ct.includes('Command exited with code 0')) cmdFailed++;
      }
    } else if (st === 'PLANNER_RESPONSE') {
      plannerTurns++;
      const inp = Number(s.input_tokens || 0);
      const cac = Number(s.cache_read_tokens || 0);
      const out = Number(s.output_tokens || 0);
      inSum += inp;
      caSum += cac;
      ouSum += out;
      ctxArr.push(inp + cac);

      const m = s.model || 'unknown';
      modelCounts.set(m, (modelCounts.get(m) || 0) + 1);

      const tcs = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      toolCalls += tcs.length;
      if (tcs.length === 1) singleToolTurns++;

      let hasSubInvoke = false;
      for (const tc of tcs) {
        const tn = tc.name || tc.tool_name || '';
        const astr = JSON.stringify(tc.args || tc.arguments || '').toLowerCase();
        if (tn === 'read_file' && /\.(png|jpg|jpeg|webp)/.test(astr)) imageReads++;
        if (tn === 'write_file' || tn === 'edit_file') fileEdits++;
        if (tn === 'invoke_subagent' || tn === 'swarm' || tn === 'run_workflow') hasSubInvoke = true;
      }

      if (hasSubInvoke) {
        for (let k = i + 1; k < Math.min(steps.length, i + 8); k++) {
          if (steps[k].type === 'PLANNER_RESPONSE') break;
          const matches = String(steps[k].content || '').match(UUID_RE) || [];
          for (const uid of matches) {
            const low = uid.toLowerCase();
            if (low !== cid.toLowerCase()) subRefIds.add(`agy:${low}`);
          }
        }
      }

      if (ts !== null && nxtTs !== null) {
        const dt = nxtTs - ts;
        if (tcs.length > 0 && dt >= 0.3 && dt <= 240) {
          llmSec += dt;
          if (turns.length < 150) {
            const { tier, mult } = resolveModelPricing(m, 'antigravity');
            turns.push({
              turn_idx: plannerTurns,
              platform: 'antigravity',
              model_tier: tier,
              ctx_k: Number(((inp + cac) / 1000).toFixed(2)),
              out_k: Number((out / 1000).toFixed(3)),
              llm_sec: Number(dt.toFixed(2)),
              n_tools: tcs.length,
              step_cost_u: Number((mult * (inp + 0.2 * cac + 5.0 * out) / 1e6).toFixed(5)),
            });
          }
        } else if (tcs.length === 0 && dt > 0 && dt <= 7200 && steps[i + 1].type !== 'USER_INPUT') {
          bgSec += dt;
        }
      }
    }
  }

  if (plannerTurns === 0) return null;
  // 跳过无人类请求的后台 4 步空探针
  if (hasHumanMetadata && !firstUser && plannerTurns <= 6) return null;

  let domModel = 'unknown', bestCnt = -1;
  for (const [k, v] of modelCounts.entries()) {
    if (v > bestCnt) { domModel = k; bestCnt = v; }
  }

  const meanCtxK = ctxArr.length ? ctxArr.reduce((a, b) => a + b, 0) / ctxArr.length / 1000 : 0;
  const maxCtxK = ctxArr.length ? Math.max(...ctxArr) / 1000 : 0;

  const rec = finalizeCommonMetrics({
    session_uid: `agy:${cid.toLowerCase()}`,
    platform: 'antigravity',
    raw_id: cid.toLowerCase(),
    parent_uid: '',
    is_subagent: hasHumanMetadata ? 0 : 1,
    primary_model: domModel,
    started_at: startTs || 0,
    ended_at: endTs || 0,
    cwd,
    title: firstUser || `[Subagent] ${cid.slice(0, 8)}`,
    user_turns: userTurns,
    neg_feedback_turns: negTurns,
    planner_turns: plannerTurns,
    tool_calls: toolCalls,
    single_tool_turns: singleToolTurns,
    cmd_total: cmdTotal,
    cmd_failed: cmdFailed,
    file_edits: fileEdits,
    image_reads: imageReads,
    compactions,
    input_tokens: inSum,
    cache_read_tokens: caSum,
    output_tokens: ouSum,
    mean_ctx_k: Number(meanCtxK.toFixed(2)),
    max_ctx_k: Number(maxCtxK.toFixed(2)),
    token_accuracy: 'exact',
    llm_infer_sec: Number(llmSec.toFixed(2)),
    sync_tool_sec: Number(syncSec.toFixed(2)),
    bg_wait_sec: Number(bgSec.toFixed(2)),
    source_path: filePath,
    sub_ref_ids: JSON.stringify([...subRefIds]),
  });
  return { rec, turns };
}

/** 2. 解析 DSH session.v4.jsonl(.zstd) */
function parseDshFile(filePath) {
  let rawText = '';
  try {
    const buf = readFileSync(filePath);
    if (filePath.endsWith('.zstd')) {
      rawText = zstdDecompressSync(buf).toString('utf8');
    } else {
      rawText = buf.toString('utf8');
    }
  } catch {
    return null;
  }

  let sessionId = basename(dirname(filePath));
  let parentUid = '';
  let isSub = 0;
  let cwd = '';
  let title = '';
  let modelName = 'deepseek-dsh';
  let userTurns = 0, negTurns = 0, plannerTurns = 0, toolCalls = 0, singleToolTurns = 0;
  let cmdTotal = 0, cmdFailed = 0, fileEdits = 0, imageReads = 0, compactions = 0;
  let runningCtxTokens = 0;
  let inSum = 0, caSum = 0, ouSum = 0;
  let exactUsageFound = false;
  let llmSec = 0, syncSec = 0;
  let startTs = null, endTs = null;
  let lastStepStartSec = null;
  const pendingTools = new Map();
  const stepToolCounter = new Map();
  const ctxArr = [];
  const turns = [];

  for (const line of rawText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }

    const ts = parseIsoSec(o.time || o.createdAt);
    if (ts !== null) {
      if (startTs === null || ts < startTs) startTs = ts;
      if (endTs === null || ts > endTs) endTs = ts;
    }

    const tp = o.type || '';
    const d = o.data || {};

    if (tp === 'session') {
      if (o.id) sessionId = String(o.id);
      if (o.cwd) cwd = String(o.cwd);
      if (o.parentSession) {
        parentUid = `dsh:${o.parentSession}`;
        isSub = 1;
      } else if (Number(o.delegationDepth || 0) > 0) {
        isSub = 1;
      }
    } else if (tp === 'model/selection' || tp === 'request/context') {
      if (d.model) modelName = `${d.provider ? d.provider + '/' : ''}${d.model}`;
    } else if (tp === 'session/title' && d.title && !title) {
      title = String(d.title).slice(0, 140);
    } else if (tp.includes('compaction') || tp.includes('summary/replace')) {
      compactions++;
      runningCtxTokens = Math.floor(runningCtxTokens * 0.35);
    } else if (tp === 'step/start') {
      lastStepStartSec = ts;
    } else if (tp === 'system/message') {
      const tok = estimateTokensFromText(JSON.stringify(d.message || d));
      runningCtxTokens += tok;
      inSum += tok;
    } else if (tp === 'user/message') {
      userTurns++;
      const rawStr = JSON.stringify(d.content || d.message || '');
      if (rawStr.includes('image/')) imageReads++;
      if (!title) {
        const txtMatch = /"text"\s*:\s*"([^"]{4,160})"/.exec(rawStr);
        if (txtMatch) title = txtMatch[1].replace(/\\n/g, ' ').slice(0, 120);
      }
      if (userTurns > 1 && NEG_FEEDBACK_RE.test(rawStr)) negTurns++;
      const tok = estimateTokensFromText(rawStr);
      runningCtxTokens += tok;
      inSum += tok;
    } else if (tp === 'assistant/message') {
      plannerTurns++;
      const stepKey = `${d.turn || 0}:${d.step || plannerTurns}`;
      stepToolCounter.set(stepKey, 0);

      const msgStr = JSON.stringify(d.message || '');
      const outTok = Number(d.usage?.output_tokens || d.message?.usage?.output_tokens || estimateTokensFromText(msgStr));
      if (d.usage?.input_tokens || d.message?.usage?.input_tokens) {
        exactUsageFound = true;
        const u = d.usage || d.message.usage;
        const inp = Number(u.input_tokens || 0);
        const cac = Number(u.cache_read_input_tokens || u.cached_tokens || 0);
        inSum += inp;
        caSum += cac;
        ouSum += outTok;
        ctxArr.push(inp + cac);
      } else {
        // 累积历史作为本步缓存重读，新增输出进入下一轮上下文
        caSum += runningCtxTokens;
        ouSum += outTok;
        ctxArr.push(runningCtxTokens);
        runningCtxTokens += outTok;
      }

      if (lastStepStartSec !== null && ts !== null && ts >= lastStepStartSec && ts - lastStepStartSec <= 300) {
        const dt = ts - lastStepStartSec;
        llmSec += dt;
        if (turns.length < 100) {
          const { tier, mult } = resolveModelPricing(modelName, 'dsh');
          const curCtx = ctxArr[ctxArr.length - 1] || 0;
          turns.push({
            turn_idx: plannerTurns,
            platform: 'dsh',
            model_tier: tier,
            ctx_k: Number((curCtx / 1000).toFixed(2)),
            out_k: Number((outTok / 1000).toFixed(3)),
            llm_sec: Number(dt.toFixed(2)),
            n_tools: 1,
            step_cost_u: Number((mult * (0.2 * curCtx + 5.0 * outTok) / 1e6).toFixed(5)),
          });
        }
      }
    } else if (tp === 'tool/call') {
      toolCalls++;
      const stepKey = `${d.turn || 0}:${d.step || plannerTurns}`;
      stepToolCounter.set(stepKey, (stepToolCounter.get(stepKey) || 0) + 1);
      const tname = String(d.name || '').toLowerCase();
      if (tname.includes('write') || tname.includes('edit') || tname.includes('patch')) fileEdits++;
      if (tname === 'pwsh' || tname === 'bash' || tname.includes('shell') || tname.includes('exec')) {
        cmdTotal++;
        pendingTools.set(d.callId, { ts, isCmd: true });
      } else {
        pendingTools.set(d.callId, { ts, isCmd: false });
      }
    } else if (tp === 'tool/result') {
      const cidCall = d.message?.toolCallId || d.callId;
      const prev = pendingTools.get(cidCall);
      const resStr = JSON.stringify(d.message?.content || '');
      const tok = estimateTokensFromText(resStr);
      runningCtxTokens += tok;
      if (!exactUsageFound) inSum += tok;

      if (prev) {
        if (prev.ts !== null && ts !== null && ts >= prev.ts && ts - prev.ts <= 600) {
          syncSec += (ts - prev.ts);
        }
        if (prev.isCmd && (/exit code [1-9]|exited with code [1-9]|"isError"\s*:\s*true|ParserError|CommandNotFoundException/i.test(resStr))) {
          cmdFailed++;
        }
        pendingTools.delete(cidCall);
      }
    }
  }

  if (plannerTurns === 0) return null;
  for (const cnt of stepToolCounter.values()) {
    if (cnt === 1) singleToolTurns++;
  }

  const meanCtxK = ctxArr.length ? ctxArr.reduce((a, b) => a + b, 0) / ctxArr.length / 1000 : 0;
  const maxCtxK = ctxArr.length ? Math.max(...ctxArr) / 1000 : 0;

  const rec = finalizeCommonMetrics({
    session_uid: `dsh:${sessionId}`,
    platform: 'dsh',
    raw_id: sessionId,
    parent_uid: parentUid,
    is_subagent: isSub,
    primary_model: modelName,
    started_at: startTs || 0,
    ended_at: endTs || 0,
    cwd,
    title: title || `[DSH] ${sessionId.slice(0, 16)}`,
    user_turns: userTurns,
    neg_feedback_turns: negTurns,
    planner_turns: plannerTurns,
    tool_calls: toolCalls,
    single_tool_turns: singleToolTurns,
    cmd_total: cmdTotal,
    cmd_failed: cmdFailed,
    file_edits: fileEdits,
    image_reads: imageReads,
    compactions,
    input_tokens: inSum,
    cache_read_tokens: caSum,
    output_tokens: ouSum,
    mean_ctx_k: Number(meanCtxK.toFixed(2)),
    max_ctx_k: Number(maxCtxK.toFixed(2)),
    token_accuracy: exactUsageFound ? 'exact' : 'estimated',
    llm_infer_sec: Number(llmSec.toFixed(2)),
    sync_tool_sec: Number(syncSec.toFixed(2)),
    bg_wait_sec: 0,
    source_path: filePath,
    sub_ref_ids: '[]',
  });
  return { rec, turns };
}

/** 3. 解析 Claude Code JSONL */
function parseClaudeFile(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return null;

  let sessionId = basename(filePath, '.jsonl');
  let isSub = 0, cwd = '', title = '', modelName = 'claude';
  let userTurns = 0, negTurns = 0, plannerTurns = 0, toolCalls = 0, singleToolTurns = 0;
  let cmdTotal = 0, cmdFailed = 0, fileEdits = 0, imageReads = 0, compactions = 0;
  let inSum = 0, caSum = 0, ouSum = 0, llmSec = 0, syncSec = 0;
  let startTs = null, endTs = null, prevTs = null;
  const ctxArr = [];
  const turns = [];

  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = parseIsoSec(o.timestamp);
    if (ts !== null) {
      if (startTs === null || ts < startTs) startTs = ts;
      if (endTs === null || ts > endTs) endTs = ts;
    }
    if (o.sessionId) sessionId = o.sessionId;
    if (o.isSidechain) isSub = 1;
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.attachment?.snapshot?.workingDirectory && !cwd) cwd = o.attachment.snapshot.workingDirectory;

    if (o.type === 'summary' || o.type === 'compact_boundary') compactions++;

    const msg = o.message || {};
    if (o.type === 'user' && msg.role === 'user') {
      const cStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      if (cStr.includes('tool_result')) {
        if (/exit code [1-9]|"is_error"\s*:\s*true/i.test(cStr)) cmdFailed++;
        if (prevTs !== null && ts !== null && ts - prevTs <= 120 && ts >= prevTs) syncSec += (ts - prevTs);
      } else {
        userTurns++;
        if (!title && cStr) title = cStr.replace(/\s+/g, ' ').slice(0, 130);
        if (userTurns > 1 && NEG_FEEDBACK_RE.test(cStr)) negTurns++;
      }
      if (cStr.includes('image')) imageReads++;
    } else if (o.type === 'assistant' && msg.role === 'assistant') {
      const m = msg.model || '';
      if (m && m !== '<synthetic>') modelName = m;
      const u = msg.usage || {};
      let inp = Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
      let cac = Number(u.cache_read_input_tokens || 0);
      let out = Number(u.output_tokens || 0);
      const rawContentStr = JSON.stringify(msg.content || '');
      if (inp + cac + out === 0 && rawContentStr.length > 10) {
        out = estimateTokensFromText(rawContentStr);
        inp = Math.max(1200, out * 2);
      }
      if (inp + cac + out > 0) {
        plannerTurns++;
        inSum += inp;
        caSum += cac;
        ouSum += out;
        ctxArr.push(inp + cac);

        const cArr = Array.isArray(msg.content) ? msg.content : [];
        let tInTurn = 0;
        for (const blk of cArr) {
          if (blk && blk.type === 'tool_use') {
            tInTurn++;
            toolCalls++;
            const tn = String(blk.name || '').toLowerCase();
            if (tn.includes('bash')) cmdTotal++;
            if (tn.includes('edit') || tn.includes('write')) fileEdits++;
          }
        }
        if (tInTurn === 1) singleToolTurns++;

        if (prevTs !== null && ts !== null && ts >= prevTs && ts - prevTs <= 180) {
          const dt = ts - prevTs;
          llmSec += dt;
          if (turns.length < 100) {
            const { tier, mult } = resolveModelPricing(modelName, 'claude-code');
            turns.push({
              turn_idx: plannerTurns,
              platform: 'claude-code',
              model_tier: tier,
              ctx_k: Number(((inp + cac) / 1000).toFixed(2)),
              out_k: Number((out / 1000).toFixed(3)),
              llm_sec: Number(dt.toFixed(2)),
              n_tools: tInTurn,
              step_cost_u: Number((mult * (inp + 0.2 * cac + 5.0 * out) / 1e6).toFixed(5)),
            });
          }
        }
      }
    }
    if (ts !== null) prevTs = ts;
  }

  if (plannerTurns === 0) return null;
  const meanCtxK = ctxArr.length ? ctxArr.reduce((a, b) => a + b, 0) / ctxArr.length / 1000 : 0;
  const maxCtxK = ctxArr.length ? Math.max(...ctxArr) / 1000 : 0;

  const rec = finalizeCommonMetrics({
    session_uid: `claude:${sessionId}`,
    platform: 'claude-code',
    raw_id: sessionId,
    parent_uid: '',
    is_subagent: isSub,
    primary_model: modelName,
    started_at: startTs || 0,
    ended_at: endTs || 0,
    cwd,
    title: title || `[Claude] ${sessionId.slice(0, 12)}`,
    user_turns: Math.max(1, userTurns),
    neg_feedback_turns: negTurns,
    planner_turns: plannerTurns,
    tool_calls: toolCalls,
    single_tool_turns: singleToolTurns,
    cmd_total: cmdTotal,
    cmd_failed: cmdFailed,
    file_edits: fileEdits,
    image_reads: imageReads,
    compactions,
    input_tokens: inSum,
    cache_read_tokens: caSum,
    output_tokens: ouSum,
    mean_ctx_k: Number(meanCtxK.toFixed(2)),
    max_ctx_k: Number(maxCtxK.toFixed(2)),
    token_accuracy: 'exact',
    llm_infer_sec: Number(llmSec.toFixed(2)),
    sync_tool_sec: Number(syncSec.toFixed(2)),
    bg_wait_sec: 0,
    source_path: filePath,
    sub_ref_ids: '[]',
  });
  return { rec, turns };
}

/** 4. 解析 OpenAI Codex JSONL */
function parseCodexFile(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return null;

  let sessionId = basename(filePath, '.jsonl');
  let isSub = 0, cwd = '', title = '', modelName = 'codex-model';
  let userTurns = 0, negTurns = 0, plannerTurns = 0, toolCalls = 0;
  let cmdTotal = 0, cmdFailed = 0, fileEdits = 0, imageReads = 0, compactions = 0;
  let maxTotalIn = 0, maxTotalCached = 0, maxTotalOut = 0;
  let sumDeltaIn = 0, sumDeltaCached = 0, sumDeltaOut = 0;
  let durationSec = 0, startTs = null, endTs = null;
  const ctxArr = [];
  const turns = [];

  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = parseIsoSec(o.timestamp);
    if (ts !== null) {
      if (startTs === null || ts < startTs) startTs = ts;
      if (endTs === null || ts > endTs) endTs = ts;
    }

    const tp = o.type;
    const pl = o.payload || {};

    if (tp === 'session_meta') {
      if (pl.session_id) sessionId = pl.session_id;
      if (pl.cwd) cwd = pl.cwd;
    } else if (tp === 'world_state' && pl.state?.collaboration_mode?.model) {
      modelName = pl.state.collaboration_mode.model;
    } else if (tp === 'response_item' && pl.type === 'message') {
      if (pl.role === 'user') {
        userTurns++;
        const txt = JSON.stringify(pl.content || '');
        if (!title) {
          const m = /"text"\s*:\s*"([^"]{3,140})"/.exec(txt);
          if (m && !m[1].startsWith('<')) title = m[1].replace(/\\n/g, ' ');
        }
        if (userTurns > 1 && NEG_FEEDBACK_RE.test(txt)) negTurns++;
      } else if (pl.role === 'developer' && JSON.stringify(pl.content || '').includes('subagent')) {
        // 识别子代理角色提示
        if (JSON.stringify(pl.content || '').includes('You are `/root/') === false && JSON.stringify(pl.content || '').includes('<multi_agent_role>')) {
          isSub = 1;
        }
      }
    } else if (tp === 'response_item' && (pl.type === 'custom_tool_call' || pl.type === 'function_call')) {
      toolCalls++;
      const nm = String(pl.name || '').toLowerCase();
      const inpStr = String(pl.input || pl.arguments || '');
      if (nm.includes('exec') || nm.includes('shell') || inpStr.includes('exec_command')) cmdTotal++;
      if (nm.includes('patch') || nm.includes('write') || inpStr.includes('apply_patch')) fileEdits++;
    } else if (tp === 'response_item' && (pl.type === 'custom_tool_call_output' || pl.type === 'function_call_output')) {
      const outS = String(pl.output || '');
      if (/exit_code":\s*[1-9]|exited with code [1-9]|Error:/i.test(outS)) cmdFailed++;
    } else if (tp === 'event_msg' && pl.type === 'compacted') {
      compactions++;
    } else if (tp === 'event_msg' && pl.type === 'token_count' && pl.info) {
      plannerTurns++;
      const tot = pl.info.total_token_usage || {};
      const last = pl.info.last_token_usage || {};
      const lIn = Math.max(0, Number(last.input_tokens || 0) - Number(last.cached_input_tokens || 0));
      const lCa = Number(last.cached_input_tokens || 0);
      const lOu = Number(last.output_tokens || 0);
      sumDeltaIn += lIn;
      sumDeltaCached += lCa;
      sumDeltaOut += lOu;
      ctxArr.push(lIn + lCa);

      maxTotalIn = Math.max(maxTotalIn, Math.max(0, Number(tot.input_tokens || 0) - Number(tot.cached_input_tokens || 0)));
      maxTotalCached = Math.max(maxTotalCached, Number(tot.cached_input_tokens || 0));
      maxTotalOut = Math.max(maxTotalOut, Number(tot.output_tokens || 0));
    } else if (tp === 'event_msg' && pl.type === 'task_complete' && pl.duration_ms) {
      durationSec += Number(pl.duration_ms) / 1000.0;
    }
  }

  const finalIn = maxTotalIn || sumDeltaIn;
  const finalCa = maxTotalCached || sumDeltaCached;
  const finalOu = maxTotalOut || sumDeltaOut;
  if (plannerTurns === 0 && toolCalls === 0) return null;
  if (plannerTurns === 0) plannerTurns = Math.max(1, toolCalls);

  const wallSec = startTs && endTs && endTs > startTs ? Math.min(3600, endTs - startTs) : 10;
  const totalSec = durationSec > 0 ? durationSec : wallSec;
  const meanCtxK = ctxArr.length ? ctxArr.reduce((a, b) => a + b, 0) / ctxArr.length / 1000 : 0;
  const maxCtxK = ctxArr.length ? Math.max(...ctxArr) / 1000 : 0;

  const rec = finalizeCommonMetrics({
    session_uid: `codex:${sessionId}`,
    platform: 'codex',
    raw_id: sessionId,
    parent_uid: '',
    is_subagent: isSub,
    primary_model: modelName,
    started_at: startTs || 0,
    ended_at: endTs || 0,
    cwd,
    title: title || `[Codex] ${sessionId.slice(0, 14)}`,
    user_turns: Math.max(1, userTurns),
    neg_feedback_turns: negTurns,
    planner_turns: plannerTurns,
    tool_calls: toolCalls,
    single_tool_turns: Math.floor(plannerTurns * 0.4),
    cmd_total: cmdTotal,
    cmd_failed: cmdFailed,
    file_edits: fileEdits,
    image_reads: imageReads,
    compactions,
    input_tokens: finalIn,
    cache_read_tokens: finalCa,
    output_tokens: finalOu,
    mean_ctx_k: Number(meanCtxK.toFixed(2)),
    max_ctx_k: Number(maxCtxK.toFixed(2)),
    token_accuracy: 'exact',
    llm_infer_sec: Number((totalSec * 0.65).toFixed(2)),
    sync_tool_sec: Number((totalSec * 0.35).toFixed(2)),
    bg_wait_sec: 0,
    source_path: filePath,
    sub_ref_ids: '[]',
  });
  return { rec, turns };
}

/** 5. 解析通用自定义 Drop-in JSONL (供任意外部 Agent 接入) */
function parseCustomDropinFile(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const items = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (!o.session_id) continue;
      const rec = finalizeCommonMetrics({
        session_uid: `custom:${o.session_id}`,
        platform: o.platform || 'custom-agent',
        raw_id: String(o.session_id),
        parent_uid: o.parent_session_id ? `custom:${o.parent_session_id}` : '',
        is_subagent: o.is_subagent ? 1 : 0,
        primary_model: o.model || 'custom-model',
        started_at: parseIsoSec(o.started_at) || Date.now() / 1000,
        ended_at: parseIsoSec(o.ended_at) || Date.now() / 1000,
        cwd: o.cwd || '',
        title: String(o.title || o.session_id).slice(0, 140),
        user_turns: Number(o.user_turns || 1),
        neg_feedback_turns: Number(o.neg_feedback_turns || 0),
        planner_turns: Number(o.planner_turns || 1),
        tool_calls: Number(o.tool_calls || 0),
        single_tool_turns: Number(o.single_tool_turns || 0),
        cmd_total: Number(o.cmd_total || 0),
        cmd_failed: Number(o.cmd_failed || 0),
        file_edits: Number(o.file_edits || 0),
        image_reads: Number(o.image_reads || 0),
        compactions: Number(o.compactions || 0),
        input_tokens: Number(o.input_tokens || 0),
        cache_read_tokens: Number(o.cache_read_tokens || 0),
        output_tokens: Number(o.output_tokens || 0),
        mean_ctx_k: Number(o.mean_ctx_k || 0),
        max_ctx_k: Number(o.max_ctx_k || 0),
        token_accuracy: o.token_accuracy || 'exact',
        llm_infer_sec: Number(o.llm_infer_sec || 10),
        sync_tool_sec: Number(o.sync_tool_sec || 0),
        bg_wait_sec: Number(o.bg_wait_sec || 0),
        source_path: filePath,
        sub_ref_ids: '[]',
      });
      items.push({ rec, turns: [] });
    } catch {}
  }
  return items;
}

function walkFiles(rootDir, predicate, maxDepth = 6, depth = 0, out = []) {
  if (depth > maxDepth || !existsSync(rootDir)) return out;
  let entries;
  try { entries = readdirSync(rootDir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.pnpm-store' || ent.name === 'venv' || ent.name === 'cache') continue;
    const full = join(rootDir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, predicate, maxDepth, depth + 1, out);
    } else if (ent.isFile() && predicate(full, ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 增量扫描全机所有 AI Agent 日志源并同步入 SQLite（纯只读、毫秒级指纹跳过）
 */
export function syncAllAgentSources(db, dataDir, forceFull = false) {
  const t0 = Date.now();
  const wmMap = new Map();
  if (!forceFull) {
    for (const row of db.prepare('SELECT source_path, mtime_ms, size_bytes FROM file_watermarks').all()) {
      wmMap.set(row.source_path, { mtime: row.mtime_ms, size: row.size_bytes });
    }
  }

  const candidates = [];

  // 1. Antigravity
  const agyBrain = join(HOME, '.gemini', 'antigravity', 'brain');
  if (existsSync(agyBrain)) {
    for (const cid of readdirSync(agyBrain)) {
      const tp = join(agyBrain, cid, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(tp)) candidates.push({ platform: 'antigravity', path: tp, cid });
    }
  }

  // 2. DSH (.zstd & .jsonl)
  const dshSessions = join(HOME, '.dsh', 'sessions');
  for (const fp of walkFiles(dshSessions, (full, nm) => nm === 'session.v4.jsonl.zstd' || nm === 'session.v4.jsonl', 4)) {
    candidates.push({ platform: 'dsh', path: fp });
  }

  // 3. Claude Code
  const claudeProj = join(HOME, '.claude', 'projects');
  for (const fp of walkFiles(claudeProj, (full, nm) => nm.endsWith('.jsonl'), 4)) {
    candidates.push({ platform: 'claude-code', path: fp });
  }

  // 4. OpenAI Codex
  const codexSess = join(HOME, '.codex', 'sessions');
  for (const fp of walkFiles(codexSess, (full, nm) => nm.endsWith('.jsonl'), 5)) {
    candidates.push({ platform: 'codex', path: fp });
  }

  // 5. Custom Drop-in
  const dropinDir = join(dataDir, 'dropin');
  for (const fp of walkFiles(dropinDir, (full, nm) => nm.endsWith('.jsonl'), 2)) {
    candidates.push({ platform: 'custom', path: fp });
  }

  const upsertSess = db.prepare(`
    INSERT INTO sessions (
      session_uid, platform, raw_id, parent_uid, is_subagent, domain, primary_model, model_tier, model_mult,
      started_at, ended_at, cwd, title, user_turns, neg_feedback_turns, planner_turns, tool_calls, single_tool_turns,
      cmd_total, cmd_failed, file_edits, image_reads, compactions, input_tokens, cache_read_tokens, output_tokens,
      mean_ctx_k, max_ctx_k, token_accuracy, raw_cost_units, weighted_cost_units, cache_tax_share,
      llm_infer_sec, sync_tool_sec, bg_wait_sec, exec_time_min, workload_score, q_objective, source_path, sub_ref_ids
    ) VALUES (
      $session_uid, $platform, $raw_id, $parent_uid, $is_subagent, $domain, $primary_model, $model_tier, $model_mult,
      $started_at, $ended_at, $cwd, $title, $user_turns, $neg_feedback_turns, $planner_turns, $tool_calls, $single_tool_turns,
      $cmd_total, $cmd_failed, $file_edits, $image_reads, $compactions, $input_tokens, $cache_read_tokens, $output_tokens,
      $mean_ctx_k, $max_ctx_k, $token_accuracy, $raw_cost_units, $weighted_cost_units, $cache_tax_share,
      $llm_infer_sec, $sync_tool_sec, $bg_wait_sec, $exec_time_min, $workload_score, $q_objective, $source_path, $sub_ref_ids
    ) ON CONFLICT(session_uid) DO UPDATE SET
      parent_uid = CASE WHEN excluded.parent_uid != '' THEN excluded.parent_uid ELSE sessions.parent_uid END,
      is_subagent = MAX(sessions.is_subagent, excluded.is_subagent),
      domain = excluded.domain,
      primary_model = excluded.primary_model,
      model_tier = excluded.model_tier,
      model_mult = excluded.model_mult,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      title = excluded.title,
      user_turns = excluded.user_turns,
      neg_feedback_turns = excluded.neg_feedback_turns,
      planner_turns = excluded.planner_turns,
      tool_calls = excluded.tool_calls,
      single_tool_turns = excluded.single_tool_turns,
      cmd_total = excluded.cmd_total,
      cmd_failed = excluded.cmd_failed,
      file_edits = excluded.file_edits,
      image_reads = excluded.image_reads,
      compactions = excluded.compactions,
      input_tokens = excluded.input_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      output_tokens = excluded.output_tokens,
      mean_ctx_k = excluded.mean_ctx_k,
      max_ctx_k = excluded.max_ctx_k,
      token_accuracy = excluded.token_accuracy,
      raw_cost_units = excluded.raw_cost_units,
      weighted_cost_units = excluded.weighted_cost_units,
      cache_tax_share = excluded.cache_tax_share,
      llm_infer_sec = excluded.llm_infer_sec,
      sync_tool_sec = excluded.sync_tool_sec,
      bg_wait_sec = excluded.bg_wait_sec,
      exec_time_min = excluded.exec_time_min,
      workload_score = excluded.workload_score,
      q_objective = excluded.q_objective,
      sub_ref_ids = excluded.sub_ref_ids
  `);

  const upsertWm = db.prepare(`
    INSERT INTO file_watermarks (source_path, platform, mtime_ms, size_bytes, session_uid, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      session_uid = excluded.session_uid,
      synced_at = excluded.synced_at
  `);

  const upsertTurn = db.prepare(`
    INSERT INTO turn_samples (session_uid, turn_idx, platform, model_tier, ctx_k, out_k, llm_sec, n_tools, step_cost_u)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_uid, turn_idx) DO UPDATE SET
      ctx_k = excluded.ctx_k, out_k = excluded.out_k, llm_sec = excluded.llm_sec, step_cost_u = excluded.step_cost_u
  `);

  let scanned = 0, updated = 0, skipped = 0;
  db.exec('BEGIN');
  try {
    for (const item of candidates) {
      scanned++;
      let st;
      try { st = statSync(item.path); } catch { continue; }
      const mtimeMs = Math.floor(st.mtimeMs);
      const sz = st.size;
      if (sz < 80) continue;

      const prev = wmMap.get(item.path);
      if (prev && prev.mtime === mtimeMs && prev.size === sz) {
        skipped++;
        continue;
      }

      let parsedList = [];
      if (item.platform === 'antigravity') {
        const res = parseAntigravityFile(item.path, item.cid);
        if (res) parsedList.push(res);
      } else if (item.platform === 'dsh') {
        const res = parseDshFile(item.path);
        if (res) parsedList.push(res);
      } else if (item.platform === 'claude-code') {
        const res = parseClaudeFile(item.path);
        if (res) parsedList.push(res);
      } else if (item.platform === 'codex') {
        const res = parseCodexFile(item.path);
        if (res) parsedList.push(res);
      } else if (item.platform === 'custom') {
        parsedList = parseCustomDropinFile(item.path);
      }

      let lastUid = 'none';
      for (const pObj of parsedList) {
        const { rec, turns } = pObj;
        lastUid = rec.session_uid;
        const bindParams = {};
        for (const [k, v] of Object.entries(rec)) bindParams[`$${k}`] = v;
        upsertSess.run(bindParams);
        for (const tr of turns) {
          upsertTurn.run(
            rec.session_uid, tr.turn_idx, tr.platform, tr.model_tier,
            tr.ctx_k, tr.out_k, tr.llm_sec, tr.n_tools, tr.step_cost_u
          );
        }
        updated++;
      }
      upsertWm.run(item.path, item.platform, mtimeMs, sz, lastUid, Date.now());
    }

    // 回填 Antigravity 父子会话映射关系 (sub_ref_ids -> parent_uid & is_subagent=1)
    const rowsWithRefs = db.prepare("SELECT session_uid, sub_ref_ids FROM sessions WHERE sub_ref_ids != '[]'").all();
    const markChild = db.prepare('UPDATE sessions SET parent_uid = ?, is_subagent = 1 WHERE session_uid = ?');
    for (const r of rowsWithRefs) {
      let refs = [];
      try { refs = JSON.parse(r.sub_ref_ids); } catch {}
      for (const childUid of refs) {
        markChild.run(r.session_uid, childUid);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    scanned_files: scanned,
    updated_sessions: updated,
    skipped_unchanged: skipped,
    elapsed_ms: Date.now() - t0,
  };
}
