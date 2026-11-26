// QTC Observatory v1.4.0 — 跨 AI Agent 零干扰只读采集、五维证据累积型任务完成质量(Q_task)评估与因果切片引擎
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
import { basename, dirname, join } from 'node:path';

const HOME = homedir();
const SCHEMA_VERSION = 7;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const WIN_PATH_RE = /(?<![a-zA-Z0-9\\])[c-zC-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\?){1,6}/g;
const TOOL_TS_RE = /Created At:\s*(\S+)\s+Completed At:\s*(\S+)/;

/**
 * 解析 protobuf pbtxt 中的对话标题与隐式行为标注（archived / starred / pinned / last_user_view_time）
 */
function parsePbtxtAnnotation(buf) {
  const rawStr = buf.toString('utf8');
  let title = '';
  const m = /title:\s*"((?:[^"\\]|\\.)*)"/.exec(rawStr);
  if (m) {
    let inner = m[1];
    if (/\\[0-7]{3}/.test(inner)) {
      inner = inner.replace(/((?:\\[0-7]{3})+)/g, (seq) => {
        const bytes = seq.split('\\').filter(Boolean).map((oct) => parseInt(oct, 8));
        return Buffer.from(bytes).toString('utf8');
      });
    }
    title = inner.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\').trim();
  }
  const compact = rawStr.replace(/\s+/g, '');
  const archived = compact.includes('archived:true');
  const starred = compact.includes('starred:true') || compact.includes('pinned:true');
  const vm = /last_user_view_time:\{seconds:(\d+)/.exec(compact);
  const lastViewSec = vm ? Number(vm[1]) : 0;
  return { title, archived, starred, lastViewSec };
}

/**
 * 毫秒级只读拉取全平台最新「用户自定义对话名称 / 侧栏实时标题 / 归档加星回访信号」
 * 优先级：用户手动重命名 (annotations/*.pbtxt | session_index.jsonl) > 客户端自动摘要标题 (conversation_summaries.db) > 首句提炼
 */
export function loadLiveExternalTitles() {
  const titleMap = new Map(); // session_uid -> { displayName, parentUid, agentName, workspacePath, archived, starred, lastViewSec, annMtimeMs }

  // 1A. Antigravity conversation_summaries.db (只读非锁模式读取侧栏生成标题与子代理角色关系)
  const csDbPath = join(HOME, '.gemini', 'antigravity', 'conversation_summaries.db');
  if (existsSync(csDbPath)) {
    let csDb = null;
    try {
      csDb = new DatabaseSync(csDbPath, { open: true, readOnly: true });
      const rows = csDb.prepare(`
        SELECT conversation_id, title, parent_conversation_id, agent_name, workspace_uris
        FROM conversation_summaries
      `).all();
      for (const r of rows) {
        if (!r.conversation_id) continue;
        const uid = `agy:${String(r.conversation_id).toLowerCase()}`;
        let wsPath = '';
        if (r.workspace_uris) {
          try {
            const arr = JSON.parse(r.workspace_uris);
            if (Array.isArray(arr) && arr[0]) {
              wsPath = decodeURIComponent(String(arr[0]).replace(/^file:\/\/\/?/i, ''));
            }
          } catch {}
        }
        titleMap.set(uid, {
          displayName: String(r.title || '').trim(),
          parentUid: r.parent_conversation_id ? `agy:${String(r.parent_conversation_id).toLowerCase()}` : '',
          agentName: String(r.agent_name || '').trim(),
          workspacePath: wsPath,
          archived: false,
          starred: false,
          lastViewSec: 0,
          annMtimeMs: 0,
        });
      }
    } catch {
      // 若宿主正在瞬间切库，静默跳过等下次心跳
    } finally {
      try { if (csDb) csDb.close(); } catch {}
    }
  }

  // 1B. Antigravity annotations/*.pbtxt (最高优先级：用户手动修改对话名、归档、加星、回访查阅时间！)
  const annDir = join(HOME, '.gemini', 'antigravity', 'annotations');
  if (existsSync(annDir)) {
    try {
      for (const fn of readdirSync(annDir)) {
        if (!fn.endsWith('.pbtxt')) continue;
        const cid = fn.slice(0, -6).toLowerCase();
        const uid = `agy:${cid}`;
        const fp = join(annDir, fn);
        let mtime = 0;
        try { mtime = Math.floor(statSync(fp).mtimeMs); } catch {}
        const parsed = parsePbtxtAnnotation(readFileSync(fp));
        const prev = titleMap.get(uid) || {
          displayName: '', parentUid: '', agentName: '', workspacePath: '',
          archived: false, starred: false, lastViewSec: 0, annMtimeMs: 0,
        };
        if (parsed.title) prev.displayName = parsed.title;
        prev.archived = parsed.archived;
        prev.starred = parsed.starred;
        prev.lastViewSec = parsed.lastViewSec;
        prev.annMtimeMs = mtime;
        titleMap.set(uid, prev);
      }
    } catch {}
  }

  // 2. OpenAI Codex ~/.codex/session_index.jsonl (按行追加，最后一行即为最新改名！)
  const codexIdxPath = join(HOME, '.codex', 'session_index.jsonl');
  if (existsSync(codexIdxPath)) {
    try {
      const lines = readFileSync(codexIdxPath, 'utf8').split('\n').filter(Boolean);
      for (const ln of lines) {
        try {
          const o = JSON.parse(ln);
          if (o.id && o.thread_name) {
            const uid = `codex:${String(o.id)}`;
            const prev = titleMap.get(uid) || {
              displayName: '', parentUid: '', agentName: '', workspacePath: '',
              archived: false, starred: false, lastViewSec: 0, annMtimeMs: 0,
            };
            prev.displayName = String(o.thread_name).trim();
            titleMap.set(uid, prev);
          }
        } catch {}
      }
    } catch {}
  }

  // 3. Claude Code ~/.claude/sessions/*.json
  const claudeSessDir = join(HOME, '.claude', 'sessions');
  if (existsSync(claudeSessDir)) {
    try {
      for (const fn of readdirSync(claudeSessDir)) {
        if (!fn.endsWith('.json')) continue;
        try {
          const o = JSON.parse(readFileSync(join(claudeSessDir, fn), 'utf8'));
          const sid = o.sessionId || o.id || basename(fn, '.json');
          const nm = o.title || o.name || o.customTitle || '';
          if (sid && nm) {
            titleMap.set(`claude:${sid}`, {
              displayName: String(nm).trim(), parentUid: '', agentName: '', workspacePath: o.cwd || '',
              archived: Boolean(o.archived), starred: Boolean(o.starred), lastViewSec: 0, annMtimeMs: 0,
            });
          }
        } catch {}
      }
    } catch {}
  }

  return titleMap;
}

/**
 * 为缺乏独立客户端标题的会话自动提炼干净可读的短标题（去除路径引号与冗余前缀）
 */
function buildCleanFallbackName(rawPrompt = '', platform = '', shortId = '') {
  let s = String(rawPrompt || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/Current runtime context\.[^]*$/i, '')
    .replace(/\[IMAGE_COMMENT\][^\n]*/gi, '图片细节审校批注')
    .replace(/[a-zA-Z]:\\[^\s"'，。；,;)）]+/g, (p) => {
      const segs = p.split('\\').filter(Boolean);
      return segs[segs.length - 1] || p;
    })
    .replace(/["'“”`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.startsWith('[')) {
    const pName = platform === 'dsh' ? 'DSH 会话' : platform === 'codex' ? 'Codex 会话' : platform === 'claude-code' ? 'Claude 会话' : 'Agent 会话';
    return `${pName} #${shortId}`;
  }
  return s.length > 32 ? `${s.slice(0, 32)}…` : s;
}

// ============================================================================
// 五维证据累积型「任务完成质量 (Q_task)」评估准则 (v1.4.0)
// 理论依据：AgentSWE (后置确定性核验 vs 空心交付)、SPUR (隐式采纳行为准则)、ACM SIGIR (沉默弃用与有效回访区分)
// 中性待验基准分 Q_0 = 62.0：无后续反馈与后置验证的沉默结案停留在 60~66 待定区；唯有具备客观核验与下游采纳证据方可进入 85~98 卓越区。
// ============================================================================
const ABORT_WORSE_RE = /不要再生成|直接停止|比你?之前.*更差|效果更差|彻底重做|完全不对|全错|根本不能用|白屏|闪退|崩溃/i;
const STRONG_UNMET_RE = /质量还是不行|没有时间给你改|很生气|大问题|很虚|没什么用|问题很大|违背了.*初衷|预览不了|体验不行|打不开|乱码|莫名其妙|太粗糙|太儿戏|没有理解我的意思|没理解.*意思/i;
const MID_REFINE_RE = /不对|有问题|有bug|卡顿|太杂|有点丑|六个脚趾|四只脚趾|好好审核|优化不行|太麻烦|还是找不到|依旧没有|漏了|少了|重新|再改|不是这个意思|不要只说|先优化|看不清|没生效|为什么还是|还是不对|\[IMAGE_COMMENT\]/i;
const REPEAT_STUCK_RE = /还是找不到|依旧没有|还是不行|还是有bug|没改好|又出现了|还是报错|依旧报错/i;
const STRONG_ACCEPT_RE = /总结.*经验|更新.*经验|写进.*经验|沉淀.*规范|开源|同步到.*github|提交到.*github|没问题了|不用改了|很棒|完美|搞定|非常满意/i;
const POLITE_CLOSE_RE = /^(?:好的|收到|谢谢|多谢|辛苦了|明白|可以了)[！!。.~～\s]*$/i;

// 确定性后置核验与生产落库命令模式（严格匹配真实测试/编译/自检命令，绝不误匹配普通摘要词）
const VERIFY_CMD_RE = /\b(?:pytest|npm\s+test|npm\s+run\s+build|pnpm\s+build|yarn\s+build|build-ui|esbuild|gradlew|tsc|cargo\s+(?:check|test)|go\s+test|py_compile|vitest|jest|eslint|node\s+--check|agp\.mjs\s+selfcheck)\b/i;
const SHIP_CMD_RE = /\b(?:git\s+commit|git\s+push|gh\s+repo\s+create|adb\s+install|assembleDebug|assembleRelease|autostart|npm\s+publish)\b/i;
const MEDIA_EXT_RE = /\.(png|jpg|jpeg|webp|pdf|svg)\b/i;

// 会话内「优化方案注入 / 同型新批次实验对比」触发信号 (严格对称可比实验)
const EXPLICIT_OPT_SHIFT_RE = /总方案|加速方案|加速引擎|master_plan|fast_engine|优化方案|为这个.*上色|重新上色|换一套方案/i;
// 外部元诊断/咨询顾问会话识别（专门替别的会话出主意、查进度，本身不是被测生产任务）
const ADVISOR_META_RE = /有没有什么办法.*快点|给几个方案|判断一下.*还有多久|监测一下.*还有多久|看一下我和.*的对话|阅读这个对话/i;
const TRIVIAL_PROBE_RE = /^跑\s*cmd\s*\/c\s*"?echo\s+/i;

/**
 * 统一模型档位费率映射（以标准均衡 High 档 1M Input = 1.0 Unit 为锚点）
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

/**
 * 提取会话所操作的具体工程目录标识 project_key（用于跨会话同项目严谨 A/B 对照）
 */
function normalizeProjectKey(cwd = '', candidatePaths = []) {
  const genericRoots = new Set([
    homeNorm(),
    'c:/users',
  ]);
  function homeNorm() {
    return HOME.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  }
  function cleanDir(raw) {
    if (!raw) return '';
    let p = String(raw).replace(/\\\\/g, '/').replace(/\\/g, '/').trim();
    p = p.replace(/^["']+|["']+$/g, '').toLowerCase();
    // 若是具体文件路径，取其父目录（最多保留前 4 层有意义工程目录）
    if (/\.[a-z0-9]{1,6}$/i.test(p)) {
      const idx = p.lastIndexOf('/');
      if (idx > 2) p = p.slice(0, idx);
    }
    // 排除系统临时/日志目录
    if (p.includes('/.gemini/') || p.includes('/appdata/') || p.includes('/.dsh/sessions')) return '';
    const segs = p.split('/').filter(Boolean);
    if (segs.length >= 4) p = segs.slice(0, 4).join('/');
    return p.replace(/\/+$/, '');
  }

  const counter = new Map();
  for (const cp of candidatePaths) {
    const k = cleanDir(cp);
    if (k && k.length >= 6 && !genericRoots.has(k)) {
      counter.set(k, (counter.get(k) || 0) + 1);
    }
  }
  let bestPath = '';
  let bestCnt = 0;
  for (const [k, v] of counter.entries()) {
    if (v > bestCnt) { bestPath = k; bestCnt = v; }
  }
  if (bestPath) return bestPath;

  const cNorm = cleanDir(cwd);
  if (cNorm && !genericRoots.has(cNorm)) return cNorm;
  return '';
}

export function classifyQualityTier(score, isHuman = false) {
  if (isHuman) return { code: 'human', label: '人工校准' };
  if (score >= 88.0) return { code: 'excellent', label: '卓越闭环' };
  if (score >= 76.0) return { code: 'verified', label: '验证达标' };
  if (score >= 60.0) return { code: 'unverified', label: '无反馈待定' };
  if (score >= 45.0) return { code: 'flawed', label: '有瑕待修' };
  return { code: 'failed', label: '失败叫停' };
}

/**
 * 五维贝叶斯证据累积型「任务完成质量 Q_task (0~100)」评估引擎 (v1.4.0)
 * 中性待验先验 Q_0 = 62.0：
 *   1. 实质交付深度 (0 ~ +8.0)
 *   2. 独立客观核验 (-12.0 ~ +13.0)
 *   3. 真实采纳与下游转化 (-5.0 ~ +14.0)
 *   4. 意图对齐与纠偏摩擦 (-38.0 ~ +4.0)
 *   5. 人工校准最高覆盖权 (q_human)
 */
export function evaluateTaskCompletionQuality({
  userTexts = [],
  plannerTurnsAfterLastNeg = 0,
  plannerTurnsAfterLastUser = 0,
  fileEdits = 0,
  outputTokens = 0,
  cmdTotal = 0,
  cmdFailed = 0,
  plannerTurns = 0,
  lastCmdSucceeded = true,
  ranVerifySuiteOk = false,
  ranCmdAfterEditOk = false,
  inspectedOutputMedia = false,
  allStepsDone = false,
  hasUnfinishedSteps = false,
  usedSubagentVerify = false,
  shippedGitOrPkg = false,
  abruptEnd = false,
  isActivelyRunning = false,
  archived = false,
  starred = false,
  lastViewSec = 0,
  endedAtSec = 0,
  isTrivialProbe = false,
}) {
  const BASE = 62.0;
  if (plannerTurns <= 0) {
    return {
      score: 58.0,
      tier_code: 'flawed',
      tier_label: '有瑕待修',
      base: BASE,
      items: [{ dim: 'base', tag: '无有效响应', delta: -4.0 }],
    };
  }

  let q = BASE;
  const items = [];
  const okCmds = Math.max(0, cmdTotal - cmdFailed);

  // ── 维度 1：实质交付深度 (0 ~ +8.0) ────────────────────────────────────────
  if (fileEdits >= 12 || (fileEdits >= 6 && outputTokens >= 25000)) {
    q += 8.0;
    items.push({ dim: 'substance', tag: '深度工程交付', delta: 8.0 });
  } else if (fileEdits >= 4) {
    q += 6.0;
    items.push({ dim: 'substance', tag: '多文件实质交付', delta: 6.0 });
  } else if (fileEdits >= 1) {
    q += 3.5;
    items.push({ dim: 'substance', tag: '实质文件落盘', delta: 3.5 });
  } else if (!isTrivialProbe && okCmds >= 2 && plannerTurns >= 3) {
    q += 1.5;
    items.push({ dim: 'substance', tag: '终端实操核查', delta: 1.5 });
  } else {
    items.push({ dim: 'substance', tag: '纯问答无落盘', delta: 0 });
  }

  // ── 维度 2：独立客观核验闭环 (-12.0 ~ +13.0) ────────────────────────────────
  let vPts = 0.0;
  if (ranVerifySuiteOk) {
    vPts += 5.5;
    items.push({ dim: 'verify', tag: '构建/测试断言全绿', delta: 5.5 });
  } else if (ranCmdAfterEditOk) {
    vPts += 3.5;
    items.push({ dim: 'verify', tag: '改后实跑验证通过', delta: 3.5 });
  } else if (fileEdits === 0 && !isTrivialProbe && okCmds >= 2 && lastCmdSucceeded) {
    vPts += 2.0;
    items.push({ dim: 'verify', tag: '诊断命令全绿', delta: 2.0 });
  } else if (fileEdits >= 3 && cmdTotal === 0 && !inspectedOutputMedia && !isActivelyRunning) {
    vPts -= 4.0;
    items.push({ dim: 'verify', tag: '改后零验证(空心交付)', delta: -4.0 });
  }

  if (inspectedOutputMedia) {
    vPts += 3.5;
    items.push({ dim: 'verify', tag: '成品视觉/版式自检', delta: 3.5 });
  }
  if (allStepsDone) {
    vPts += 2.5;
    items.push({ dim: 'verify', tag: '计划清单100%完结', delta: 2.5 });
  } else if (hasUnfinishedSteps && !isActivelyRunning) {
    vPts -= 3.5;
    items.push({ dim: 'verify', tag: '计划步骤半途遗留', delta: -3.5 });
  }
  if (usedSubagentVerify && !abruptEnd) {
    vPts += 1.5;
    items.push({ dim: 'verify', tag: '子代理交叉核验', delta: 1.5 });
  }
  if (!lastCmdSucceeded && cmdTotal > 0 && !isActivelyRunning) {
    vPts -= 8.0;
    items.push({ dim: 'verify', tag: '终局命令报错未修', delta: -8.0 });
  }
  if (abruptEnd && !isActivelyRunning) {
    vPts -= 6.0;
    items.push({ dim: 'verify', tag: '未收口异常中断', delta: -6.0 });
  }
  q += Math.max(-12.0, Math.min(13.0, vPts));

  // ── 维度 3：真实采纳与下游转化 (-6.0 ~ +14.0) ──────────────────────────────
  const followUps = userTexts.slice(1);
  const lastUserTxt = userTexts.length ? String(userTexts[userTexts.length - 1] || '').trim() : '';
  const endedWithAbort = userTexts.length > 1 && ABORT_WORSE_RE.test(lastUserTxt);
  const endedWithStrongNeg = userTexts.length > 1 && STRONG_UNMET_RE.test(lastUserTxt);
  const endedWithStrongAccept = STRONG_ACCEPT_RE.test(lastUserTxt) && !endedWithAbort && !endedWithStrongNeg;
  const endedWithPoliteClose = !endedWithStrongAccept && POLITE_CLOSE_RE.test(lastUserTxt);

  // 若会话正在实时运行中，排除当前正在执行的最新一轮用户指令再统计历史跟进
  const completedFollowUps = (isActivelyRunning && followUps.length > 0 && plannerTurnsAfterLastUser <= 8)
    ? followUps.slice(0, -1)
    : followUps;

  let aPts = 0.0;
  if (shippedGitOrPkg) {
    aPts += 6.0;
    items.push({ dim: 'adopt', tag: 'Git/安装包生产落库', delta: 6.0 });
  }
  if (endedWithStrongAccept) {
    aPts += 5.0;
    items.push({ dim: 'adopt', tag: '终局显式认可/沉淀', delta: 5.0 });
  } else if (endedWithPoliteClose) {
    aPts += 2.5;
    items.push({ dim: 'adopt', tag: '结案致谢确认', delta: 2.5 });
  }
  if (starred) {
    aPts += 3.5;
    items.push({ dim: 'adopt', tag: '客户端加星/置顶', delta: 3.5 });
  }

  const constructiveTurns = completedFollowUps.filter(
    (t) => t && !ABORT_WORSE_RE.test(t) && !STRONG_UNMET_RE.test(t) && !MID_REFINE_RE.test(t)
  ).length;

  if (!isTrivialProbe && constructiveTurns >= 3) {
    aPts += 4.0;
    items.push({ dim: 'adopt', tag: '多轮顺畅下游推进', delta: 4.0 });
  } else if (!isTrivialProbe && constructiveTurns >= 1) {
    aPts += 2.0;
    items.push({ dim: 'adopt', tag: '后续顺畅跟进', delta: 2.0 });
  } else if (userTexts.length <= 1 && !shippedGitOrPkg && !starred) {
    items.push({ dim: 'adopt', tag: '单轮无反馈沉默结案', delta: 0 });
  }

  // 客户端隐式查阅与归档信号
  if (archived && !shippedGitOrPkg && !endedWithStrongAccept) {
    aPts -= 5.0;
    items.push({ dim: 'adopt', tag: '归档弃置未采纳', delta: -5.0 });
  } else if (!archived && lastViewSec > 0 && endedAtSec > 0) {
    if (lastViewSec > endedAtSec + 3600) {
      aPts += 2.0;
      items.push({ dim: 'adopt', tag: '事后回访查阅复用', delta: 2.0 });
    } else if (!isActivelyRunning && (Date.now() / 1000 - endedAtSec) > 1800 && lastViewSec < endedAtSec - 90) {
      aPts -= 3.0;
      items.push({ dim: 'adopt', tag: '生成完未再查阅', delta: -3.0 });
    }
  }
  q += Math.max(-6.0, Math.min(14.0, aPts));

  // ── 维度 4：需求对齐与纠偏摩擦 (-38.0 ~ +4.0) ──────────────────────────────
  let abortCnt = 0, strongNegCnt = 0, refineNegCnt = 0, stuckCnt = 0;
  for (const txt of completedFollowUps) {
    if (ABORT_WORSE_RE.test(txt)) abortCnt++;
    else if (STRONG_UNMET_RE.test(txt)) strongNegCnt++;
    else if (MID_REFINE_RE.test(txt)) refineNegCnt++;
    if (REPEAT_STUCK_RE.test(txt)) stuckCnt++;
  }

  // 非正在执行中的会话才判定“终局停留在未闭环负向指令”
  const idleEndedAbort = !isActivelyRunning && endedWithAbort;
  const idleEndedStrongNeg = !isActivelyRunning && endedWithStrongNeg;
  const idleEndedMidNeg = !isActivelyRunning && userTexts.length > 1 && MID_REFINE_RE.test(lastUserTxt);
  const hasClosedLoopFix = plannerTurnsAfterLastNeg >= 5 && (ranCmdAfterEditOk || fileEdits >= 2 || inspectedOutputMedia) && !idleEndedAbort;

  if (idleEndedAbort) {
    const d = -(34.0 + Math.min(6.0, Math.max(0, abortCnt - 1) * 3.0));
    q = Math.min(42.0, q + d);
    items.push({ dim: 'align', tag: '终局质量倒退叫停', delta: d });
  } else if (idleEndedStrongNeg && !hasClosedLoopFix) {
    const d = -(18.0 + Math.min(8.0, Math.max(0, strongNegCnt - 1) * 3.0));
    q = Math.min(56.0, q + d);
    items.push({ dim: 'align', tag: '终局严重偏差未闭环', delta: d });
  } else {
    if (completedFollowUps.length >= 1 && abortCnt === 0 && strongNegCnt === 0 && refineNegCnt === 0 && fileEdits >= 1) {
      q += 4.0;
      items.push({ dim: 'align', tag: '多轮一次对齐零返工', delta: 4.0 });
    } else {
      let pen = 0.0;
      if (abortCnt > 0 || strongNegCnt > 0) {
        pen += (hasClosedLoopFix || endedWithStrongAccept || shippedGitOrPkg)
          ? Math.min(7.5, abortCnt * 3.0 + strongNegCnt * 1.8)
          : Math.min(18.0, abortCnt * 8.0 + strongNegCnt * 6.0);
      }
      if (refineNegCnt > 0) {
        if (endedWithStrongAccept || shippedGitOrPkg) {
          pen += Math.min(2.5, refineNegCnt * 0.5);
        } else if (idleEndedMidNeg && plannerTurnsAfterLastNeg < 3) {
          pen += Math.min(12.0, 5.0 + refineNegCnt * 1.5);
        } else {
          pen += Math.min(5.5, refineNegCnt * 1.1);
        }
      }
      if (stuckCnt >= 2) {
        pen += 3.5;
        items.push({ dim: 'align', tag: '连续重复卡壳', delta: -3.5 });
      }
      if (pen > 0) {
        const cappedPen = Number(Math.min(22.0, pen).toFixed(1));
        q -= cappedPen;
        const closedTag = (hasClosedLoopFix || endedWithStrongAccept || shippedGitOrPkg)
          ? '中途纠偏已闭环修复'
          : '多轮返工摩擦';
        items.push({ dim: 'align', tag: closedTag, delta: -(cappedPen - (stuckCnt >= 2 ? 3.5 : 0)) });
      }
    }
  }

  if (isActivelyRunning) {
    items.push({ dim: 'status', tag: '实时执行中', delta: 0 });
  }

  const finalScore = Number(Math.max(25.0, Math.min(98.5, q)).toFixed(1));
  const tier = classifyQualityTier(finalScore, false);
  return {
    score: finalScore,
    tier_code: tier.code,
    tier_label: tier.label,
    base: BASE,
    items: items.map((it) => ({ ...it, delta: Number(Number(it.delta).toFixed(1)) })),
  };
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
      session_role TEXT DEFAULT 'execution',
      project_key TEXT DEFAULT '',
      linked_uids TEXT DEFAULT '[]',
      domain TEXT NOT NULL,
      primary_model TEXT NOT NULL,
      model_tier TEXT NOT NULL,
      model_mult REAL NOT NULL,
      started_at REAL DEFAULT 0,
      ended_at REAL DEFAULT 0,
      cwd TEXT DEFAULT '',
      display_name TEXT DEFAULT '',
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
      q_objective REAL DEFAULT 62,
      q_breakdown TEXT DEFAULT '{}',
      source_path TEXT DEFAULT '',
      sub_ref_ids TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS session_phases (
      session_uid TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      split_kind TEXT NOT NULL,
      trigger_summary TEXT DEFAULT '',
      b_label TEXT NOT NULL,
      b_turns INTEGER NOT NULL,
      b_sub_uids TEXT DEFAULT '[]',
      b_exec_min REAL NOT NULL,
      b_main_cost_u REAL NOT NULL,
      b_deliverables REAL NOT NULL,
      b_q_task REAL NOT NULL,
      b_q_breakdown TEXT DEFAULT '{}',
      a_label TEXT NOT NULL,
      a_turns INTEGER NOT NULL,
      a_sub_uids TEXT DEFAULT '[]',
      a_exec_min REAL NOT NULL,
      a_main_cost_u REAL NOT NULL,
      a_deliverables REAL NOT NULL,
      a_q_task REAL NOT NULL,
      a_q_breakdown TEXT DEFAULT '{}'
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

  // 平滑迁移旧表缺失列，并在算法大版本升级时自动清空一次水位触发全库重算 Q_task 与阶段对照
  const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  if (!cols.has('session_role')) db.exec("ALTER TABLE sessions ADD COLUMN session_role TEXT DEFAULT 'execution'");
  if (!cols.has('project_key')) db.exec("ALTER TABLE sessions ADD COLUMN project_key TEXT DEFAULT ''");
  if (!cols.has('linked_uids')) db.exec("ALTER TABLE sessions ADD COLUMN linked_uids TEXT DEFAULT '[]'");
  if (!cols.has('display_name')) db.exec("ALTER TABLE sessions ADD COLUMN display_name TEXT DEFAULT ''");
  if (!cols.has('q_breakdown')) db.exec("ALTER TABLE sessions ADD COLUMN q_breakdown TEXT DEFAULT '{}'");

  const pCols = new Set(db.prepare('PRAGMA table_info(session_phases)').all().map((c) => c.name));
  if (!pCols.has('b_q_breakdown')) db.exec("ALTER TABLE session_phases ADD COLUMN b_q_breakdown TEXT DEFAULT '{}'");
  if (!pCols.has('a_q_breakdown')) db.exec("ALTER TABLE session_phases ADD COLUMN a_q_breakdown TEXT DEFAULT '{}'");

  const curVer = db.prepare('PRAGMA user_version').get()?.user_version || 0;
  if (curVer < SCHEMA_VERSION) {
    db.exec('DELETE FROM file_watermarks; DELETE FROM session_phases;');
    try { db.exec('DELETE FROM model_evolution;'); } catch {}
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}

function finalizeCommonMetrics(rec, qEvalInput) {
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

  // 有效交付动作量（文件修改 + 阶段核验通过），不再把失败报错计入产出
  const okCmds = Math.max(0, rec.cmd_total - rec.cmd_failed);
  rec.workload_score = Number(
    Math.max(1.0, 1.0 + 1.25 * rec.file_edits + 0.20 * okCmds + 0.12 * (rec.output_tokens / 1000.0)).toFixed(3)
  );

  if (qEvalInput && typeof qEvalInput === 'object') {
    rec.q_objective = Number(qEvalInput.score);
    rec.q_breakdown = JSON.stringify(qEvalInput);
  } else {
    const numQ = Number(qEvalInput ?? 62.0);
    const qt = classifyQualityTier(numQ, false);
    rec.q_objective = numQ;
    rec.q_breakdown = JSON.stringify({ score: numQ, tier_code: qt.code, tier_label: qt.label, base: 62.0, items: [] });
  }
  rec.domain = classifyTaskDomain(`${rec.display_name || ''} ${rec.title || ''}`, `${rec.cwd} ${rec.project_key}`, rec.image_reads);
  if (!rec.display_name) {
    rec.display_name = buildCleanFallbackName(rec.title, rec.platform, rec.raw_id.slice(0, 8));
  }
  if (!rec.session_role) rec.session_role = 'execution';
  if (!rec.project_key) rec.project_key = '';
  if (!rec.linked_uids) rec.linked_uids = '[]';
  return rec;
}

/**
 * 在单个 Antigravity 根执行会话内检测「优化方案介入 / 并发策略切换 / 同会话多批次对照」分界点
 */
function extractAntigravityIntraPhase(sortedSteps, cid, primaryMult) {
  const pIndices = [];
  for (let i = 0; i < sortedSteps.length; i++) {
    if (sortedSteps[i].type === 'PLANNER_RESPONSE') pIndices.push(i);
  }
  if (pIndices.length < 28) return null;

  let splitStepArrayIdx = -1;
  let splitKind = '';
  let triggerSummary = '';

  // 1. 优先搜索用户显式下达「加速方案 / 优化方案 / 新一轮同型生产批次」分界点 (Category I: 等效目标策略对照)
  for (let i = 10; i < sortedSteps.length - 10; i++) {
    const s = sortedSteps[i];
    if (s.type !== 'USER_INPUT') continue;
    const ct = String(s.content || '');
    const clean = ct.includes('<USER_REQUEST>')
      ? ct.split('<USER_REQUEST>')[1].split('</USER_REQUEST>')[0].trim()
      : ct.trim();
    if (!clean) continue;
    const turnsBefore = pIndices.filter((k) => k < i).length;
    const turnsAfter = pIndices.filter((k) => k > i).length;
    if (
      turnsBefore >= 14 &&
      turnsAfter >= 14 &&
      EXPLICIT_OPT_SHIFT_RE.test(clean) &&
      !/原对话|当时让|阅读这个对话/.test(clean)
    ) {
      splitStepArrayIdx = i;
      splitKind = /上色/.test(clean) ? '同会话前后两批任务方案对照' : '同任务中途注入加速/优化方案前后对照';
      triggerSummary = clean.replace(/\s+/g, ' ').slice(0, 88);
      break;
    }
  }

  // 2. 次优搜索长会话 (>85轮) 的「前期清爽上下文基线段 vs 后期重度累积/子代理膨胀段」耗用率自对照
  if (splitStepArrayIdx < 0 && pIndices.length >= 85) {
    const targetTurnPos = Math.floor(pIndices.length * 0.35);
    splitStepArrayIdx = pIndices[targetTurnPos];
    splitKind = '同会话前期清爽基线 vs 后期长上下文耗用率对照';
    triggerSummary = `前 ${targetTurnPos} 轮清爽基线段 vs 后 ${pIndices.length - targetTurnPos} 轮高水位上下文段`;
  }

  if (splitStepArrayIdx < 0) return null;

  const fullLastUser = [...sortedSteps].reverse().find((s) => s.type === 'USER_INPUT');
  const fullLastTxt = String(fullLastUser?.content || '');
  const parentAccepted = STRONG_ACCEPT_RE.test(fullLastTxt) && !ABORT_WORSE_RE.test(fullLastTxt);

  function summarizeSegment(segSteps, isBaselineHalf = false) {
    // 若最末尾存在隔了 >2 小时仅要求“做总结/归档”的后置收尾轮，只采纳其正向验收信号，不把次日总结时间混入主生产耗时
    let workEnd = segSteps.length;
    for (let j = segSteps.length - 1; j > 5; j--) {
      if (segSteps[j].type === 'USER_INPUT') {
        const tPrev = parseIsoSec(segSteps[j - 1].created_at) || 0;
        const tCur = parseIsoSec(segSteps[j].created_at) || 0;
        const uTxt = String(segSteps[j].content || '');
        if (tCur - tPrev > 7200 && STRONG_ACCEPT_RE.test(uTxt) && !ABORT_WORSE_RE.test(uTxt)) {
          workEnd = j;
          break;
        }
      }
    }

    let llmSec = 0, syncSec = 0, bgSec = 0;
    let inW = 0, caW = 0, ouW = 0, ouRaw = 0;
    let turns = 0, edits = 0, tools = 0, milestones = 0;
    let cmdTot = 0, cmdFail = 0, lastCmdOk = true;
    let lastEditIdx = -1, lastProduceIdx = -1;
    let ranVerifySuiteOk = false, ranCmdAfterEditOk = false, inspectedOutputMedia = false;
    let allStepsDone = false, hasUnfinishedSteps = false, shippedGitOrPkg = false;
    let segEndTs = 0;
    const subUids = new Set();

    for (let i = 0; i < workEnd; i++) {
      const s = segSteps[i];
      const ts = parseIsoSec(s.created_at);
      if (ts && ts > segEndTs) segEndTs = ts;
      const nxtTs = i + 1 < workEnd ? parseIsoSec(segSteps[i + 1].created_at) : null;
      const ct = String(s.content || '');

      if (s.type === 'GENERIC') {
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
          cmdTot++;
          lastCmdOk = ct.includes('Command exited with code 0');
          if (!lastCmdOk) cmdFail++;
          else if (lastEditIdx >= 0 && i > lastEditIdx) ranCmdAfterEditOk = true;
        }
      } else if (s.type === 'PLANNER_RESPONSE') {
        turns++;
        const { mult } = resolveModelPricing(s.model || '', 'antigravity');
        const mUse = mult || primaryMult;
        const outTok = Number(s.output_tokens || 0);
        ouRaw += outTok;
        inW += Number(s.input_tokens || 0) * mUse;
        caW += Number(s.cache_read_tokens || 0) * mUse;
        ouW += outTok * mUse;

        const tcs = Array.isArray(s.tool_calls) ? s.tool_calls : [];
        tools += tcs.length;
        if (tcs.length === 0) milestones++;

        let hasSub = false;
        for (const tc of tcs) {
          const tn = tc.name || tc.tool_name || '';
          const rawArgs = JSON.stringify(tc.args || tc.arguments || '');
          if (tn === 'write_file' || tn === 'edit_file') {
            edits++;
            lastEditIdx = i;
            lastProduceIdx = i;
          } else if (tn === 'run_command') {
            lastProduceIdx = i;
            const argsObj = tc.args || tc.arguments || {};
            const cmdLine = String(argsObj.CommandLine || argsObj.command || '');
            const isVer = lastEditIdx >= 0 && VERIFY_CMD_RE.test(cmdLine);
            const isShip = SHIP_CMD_RE.test(cmdLine);
            if (isVer || isShip) {
              for (let k = i + 1; k < Math.min(workEnd, i + 6); k++) {
                if (String(segSteps[k].content || '').includes('Command exited with code 0')) {
                  if (isVer) ranVerifySuiteOk = true;
                  if (isShip) shippedGitOrPkg = true;
                  break;
                }
              }
            }
          } else if (tn === 'read_file' && lastProduceIdx >= 0 && i > lastProduceIdx && MEDIA_EXT_RE.test(rawArgs)) {
            inspectedOutputMedia = true;
          } else if (tn === 'update_steps') {
            const sts = [...rawArgs.matchAll(/"status"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
            if (sts.length) {
              allStepsDone = sts.every((x) => x === 'done' || x === 'skipped');
              hasUnfinishedSteps = sts.some((x) => x === 'in_progress' || x === 'pending' || x === 'failed');
            }
          }
          if (tn === 'invoke_subagent' || tn === 'swarm' || tn === 'run_workflow') hasSub = true;
        }
        if (hasSub) {
          for (let k = i + 1; k < Math.min(workEnd, i + 8); k++) {
            if (segSteps[k].type === 'PLANNER_RESPONSE') break;
            const ms = String(segSteps[k].content || '').match(UUID_RE) || [];
            for (const u of ms) {
              if (u.toLowerCase() !== cid.toLowerCase()) subUids.add(`agy:${u.toLowerCase()}`);
            }
          }
        }
        if (ts !== null && nxtTs !== null) {
          const dt = nxtTs - ts;
          if (tcs.length > 0 && dt >= 0.3 && dt <= 240) llmSec += dt;
          else if (tcs.length === 0 && dt > 0 && dt <= 7200 && segSteps[i + 1].type !== 'USER_INPUT') bgSec += dt;
        }
      }
    }

    const uTexts = [];
    let lastNegTs = 0;
    let lastUserTs = 0;
    for (const s of segSteps) {
      if (s.type === 'USER_INPUT') {
        const ct = String(s.content || '');
        const clean = ct.includes('<USER_REQUEST>')
          ? ct.split('<USER_REQUEST>')[1].split('</USER_REQUEST>')[0].trim() || ct
          : ct;
        const tsU = parseIsoSec(s.created_at) || 0;
        if (tsU > lastUserTs) lastUserTs = tsU;
        uTexts.push(clean);
        if (uTexts.length > 1 && (ABORT_WORSE_RE.test(clean) || STRONG_UNMET_RE.test(clean) || MID_REFINE_RE.test(clean))) {
          lastNegTs = Math.max(lastNegTs, tsU);
        }
      }
    }
    const turnsAfterNeg = lastNegTs > 0
      ? segSteps.filter((s) => s.type === 'PLANNER_RESPONSE' && (parseIsoSec(s.created_at) || 0) > lastNegTs).length
      : turns;
    const turnsAfterLastUser = lastUserTs > 0
      ? segSteps.filter((s) => s.type === 'PLANNER_RESPONSE' && (parseIsoSec(s.created_at) || 0) > lastUserTs).length
      : turns;
    const segActive = segEndTs > 0 && (Date.now() / 1000 - segEndTs) < 600;

    const qEval = evaluateTaskCompletionQuality({
      userTexts: uTexts,
      plannerTurnsAfterLastNeg: turnsAfterNeg,
      plannerTurnsAfterLastUser: turnsAfterLastUser,
      fileEdits: edits,
      outputTokens: ouRaw,
      cmdTotal: cmdTot,
      cmdFailed: cmdFail,
      plannerTurns: turns,
      lastCmdSucceeded: lastCmdOk,
      ranVerifySuiteOk,
      ranCmdAfterEditOk,
      inspectedOutputMedia,
      allStepsDone,
      hasUnfinishedSteps: isBaselineHalf ? false : hasUnfinishedSteps,
      usedSubagentVerify: subUids.size > 0,
      shippedGitOrPkg: shippedGitOrPkg || (isBaselineHalf && parentAccepted && (edits >= 2 || inspectedOutputMedia)),
      abruptEnd: false,
      isActivelyRunning: segActive,
      endedAtSec: segEndTs,
    });

    const execMin = Math.max(1.0, (llmSec + syncSec + bgSec) / 60.0);
    const mainCostU = (inW + 0.2 * caW + 5.0 * ouW) / 1e6;
    const deliverables = Math.max(1.0, edits * 0.6 + milestones * 0.8);

    return {
      turns,
      subUids: [...subUids],
      execMin: Number(execMin.toFixed(2)),
      mainCostU: Number(mainCostU.toFixed(4)),
      deliverables: Number(deliverables.toFixed(2)),
      qTask: qEval.score,
      qBreakdown: JSON.stringify(qEval),
    };
  }

  const segB = summarizeSegment(sortedSteps.slice(0, splitStepArrayIdx), true);
  const segA = summarizeSegment(sortedSteps.slice(splitStepArrayIdx), false);
  if (segB.execMin < 4.0 || segA.execMin < 4.0 || segB.turns < 10 || segA.turns < 10) return null;

  return {
    session_uid: `agy:${cid.toLowerCase()}`,
    platform: 'antigravity',
    split_kind: splitKind,
    trigger_summary: triggerSummary,
    b_label: `优化/切换前基线段 (${segB.turns}轮)`,
    b_turns: segB.turns,
    b_sub_uids: JSON.stringify(segB.subUids),
    b_exec_min: segB.execMin,
    b_main_cost_u: segB.mainCostU,
    b_deliverables: segB.deliverables,
    b_q_task: segB.qTask,
    b_q_breakdown: segB.qBreakdown,
    a_label: `优化/切换后实验段 (${segA.turns}轮)`,
    a_turns: segA.turns,
    a_sub_uids: JSON.stringify(segA.subUids),
    a_exec_min: segA.execMin,
    a_main_cost_u: segA.mainCostU,
    a_deliverables: segA.deliverables,
    a_q_task: segA.qTask,
    a_q_breakdown: segA.qBreakdown,
  };
}

/** 1. 解析 Antigravity transcript.jsonl */
function parseAntigravityFile(filePath, cid, extMeta = null) {
  const text = readFileSync(filePath, 'utf8');
  const rawSteps = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rawSteps.push(JSON.parse(t)); } catch {}
  }
  if (!rawSteps.length) return null;
  const steps = [...rawSteps].sort((a, b) => Number(a.step_index ?? 0) - Number(b.step_index ?? 0));

  let userTurns = 0, negTurns = 0, plannerTurns = 0, toolCalls = 0, singleToolTurns = 0;
  let cmdTotal = 0, cmdFailed = 0, fileEdits = 0, imageReads = 0, compactions = 0;
  let inSum = 0, caSum = 0, ouSum = 0;
  let llmSec = 0, syncSec = 0, bgSec = 0;
  let firstUser = '', cwd = '', startTs = null, endTs = null;
  let lastCmdOk = true;
  let lastNegTs = 0, lastUserTs = 0;
  let lastEditIdx = -1, lastProduceIdx = -1;
  let ranVerifySuiteOk = false, ranCmdAfterEditOk = false, inspectedOutputMedia = false;
  let allStepsDone = false, hasUnfinishedSteps = false, shippedGitOrPkg = false;
  const ctxArr = [];
  const modelCounts = new Map();
  const subRefIds = new Set();
  const linkedUids = new Set();
  const pathCandidates = [];
  const userTexts = [];
  const turns = [];
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
      if (ts !== null && ts > lastUserTs) lastUserTs = ts;
      if (ct.includes('<ADDITIONAL_METADATA>')) hasHumanMetadata = true;
      let clean = ct;
      if (ct.includes('<USER_REQUEST>')) {
        clean = ct.split('<USER_REQUEST>')[1].split('</USER_REQUEST>')[0].trim();
      }
      if (!clean && ct.includes('Comments on the file')) {
        clean = `[IMAGE_COMMENT] ${ct}`;
      }
      if (!firstUser && clean) firstUser = clean.replace(/\s+/g, ' ').slice(0, 140);
      const evalTxt = clean || ct;
      userTexts.push(evalTxt);

      for (const mp of (evalTxt.match(WIN_PATH_RE) || [])) pathCandidates.push(mp);
      for (const uid of (evalTxt.match(UUID_RE) || [])) {
        if (uid.toLowerCase() !== cid.toLowerCase()) linkedUids.add(`agy:${uid.toLowerCase()}`);
      }

      if (userTurns > 1 && (ABORT_WORSE_RE.test(evalTxt) || STRONG_UNMET_RE.test(evalTxt) || MID_REFINE_RE.test(evalTxt) || ct.includes('Comments on the file'))) {
        negTurns++;
        if (ts !== null) lastNegTs = Math.max(lastNegTs, ts);
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
        lastCmdOk = ct.includes('Command exited with code 0');
        if (!lastCmdOk) cmdFailed++;
        else if (lastEditIdx >= 0 && i > lastEditIdx) ranCmdAfterEditOk = true;
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
        const rawArgs = JSON.stringify(tc.args || tc.arguments || '');
        const astr = rawArgs.toLowerCase();
        if (tn === 'read_file' && /\.(png|jpg|jpeg|webp)/.test(astr)) imageReads++;
        if (tn === 'read_file' && lastProduceIdx >= 0 && i > lastProduceIdx && MEDIA_EXT_RE.test(astr)) {
          inspectedOutputMedia = true;
        }
        if (tn === 'write_file' || tn === 'edit_file') {
          fileEdits++;
          lastEditIdx = i;
          lastProduceIdx = i;
          for (const mp of (rawArgs.replace(/\\\\/g, '\\').match(WIN_PATH_RE) || [])) pathCandidates.push(mp);
        } else if (tn === 'run_command') {
          lastProduceIdx = i;
          const argsObj = tc.args || tc.arguments || {};
          const cmdLine = String(argsObj.CommandLine || argsObj.command || '');
          const isVer = lastEditIdx >= 0 && VERIFY_CMD_RE.test(cmdLine);
          const isShip = SHIP_CMD_RE.test(cmdLine);
          if (isVer || isShip) {
            for (let k = i + 1; k < Math.min(steps.length, i + 6); k++) {
              if (String(steps[k].content || '').includes('Command exited with code 0')) {
                if (isVer) ranVerifySuiteOk = true;
                if (isShip) shippedGitOrPkg = true;
                break;
              }
            }
          }
        } else if (tn === 'update_steps') {
          const sts = [...rawArgs.matchAll(/"status"\s*:\s*"([^"]+)"/g)].map((x) => x[1]);
          if (sts.length) {
            allStepsDone = sts.every((x) => x === 'done' || x === 'skipped');
            hasUnfinishedSteps = sts.some((x) => x === 'in_progress' || x === 'pending' || x === 'failed');
          }
        }
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
  if (hasHumanMetadata && !firstUser && plannerTurns <= 6) return null;

  let domModel = 'unknown', bestCnt = -1;
  for (const [k, v] of modelCounts.entries()) {
    if (v > bestCnt) { domModel = k; bestCnt = v; }
  }

  const isSub = hasHumanMetadata ? 0 : 1;
  const isTrivialProbe = TRIVIAL_PROBE_RE.test(firstUser);
  let role = isSub ? 'subagent' : 'execution';
  if (!isSub) {
    if ((plannerTurns <= 6 && fileEdits === 0) || isTrivialProbe) {
      role = 'probe';
    } else if (ADVISOR_META_RE.test(firstUser) && linkedUids.size > 0 && imageReads < 10) {
      role = 'advisor';
    }
  }

  const turnsAfterNeg = lastNegTs > 0
    ? steps.filter((s) => s.type === 'PLANNER_RESPONSE' && (parseIsoSec(s.created_at) || 0) > lastNegTs).length
    : plannerTurns;
  const turnsAfterLastUser = lastUserTs > 0
    ? steps.filter((s) => s.type === 'PLANNER_RESPONSE' && (parseIsoSec(s.created_at) || 0) > lastUserTs).length
    : plannerTurns;

  const isActivelyRunning = endTs !== null && (Date.now() / 1000 - endTs) < 600;
  let lastExecStep = null;
  for (let k = steps.length - 1; k >= 0; k--) {
    if (steps[k].type === 'PLANNER_RESPONSE' || steps[k].type === 'GENERIC') {
      lastExecStep = steps[k];
      break;
    }
  }
  const abruptEnd = Boolean(
    lastExecStep && (lastExecStep.type !== 'PLANNER_RESPONSE' || (Array.isArray(lastExecStep.tool_calls) && lastExecStep.tool_calls.length > 0))
  );

  const qEval = evaluateTaskCompletionQuality({
    userTexts,
    plannerTurnsAfterLastNeg: turnsAfterNeg,
    plannerTurnsAfterLastUser: turnsAfterLastUser,
    fileEdits,
    outputTokens: ouSum,
    cmdTotal,
    cmdFailed,
    plannerTurns,
    lastCmdSucceeded: lastCmdOk,
    ranVerifySuiteOk,
    ranCmdAfterEditOk,
    inspectedOutputMedia,
    allStepsDone,
    hasUnfinishedSteps,
    usedSubagentVerify: subRefIds.size > 0,
    shippedGitOrPkg,
    abruptEnd,
    isActivelyRunning,
    archived: Boolean(extMeta?.archived),
    starred: Boolean(extMeta?.starred),
    lastViewSec: Number(extMeta?.lastViewSec || 0),
    endedAtSec: endTs || 0,
    isTrivialProbe,
  });

  const meanCtxK = ctxArr.length ? ctxArr.reduce((a, b) => a + b, 0) / ctxArr.length / 1000 : 0;
  const maxCtxK = ctxArr.length ? Math.max(...ctxArr) / 1000 : 0;
  const projKey = normalizeProjectKey(cwd, pathCandidates);
  const { mult: domMult } = resolveModelPricing(domModel, 'antigravity');

  const phaseSplit = (!isSub && role === 'execution')
    ? extractAntigravityIntraPhase(steps, cid, domMult)
    : null;

  const rec = finalizeCommonMetrics({
    session_uid: `agy:${cid.toLowerCase()}`,
    platform: 'antigravity',
    raw_id: cid.toLowerCase(),
    parent_uid: '',
    is_subagent: isSub,
    session_role: role,
    project_key: projKey,
    linked_uids: JSON.stringify([...linkedUids]),
    primary_model: domModel,
    started_at: startTs || 0,
    ended_at: endTs || 0,
    cwd,
    display_name: extMeta?.displayName || '',
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
  }, qEval);

  return { rec, turns, phaseSplit };
}

/** 2. 解析 DSH session.v4.jsonl(.zstd) */
function parseDshFile(filePath) {
  let rawText = '';
  try {
    const buf = readFileSync(filePath);
    rawText = filePath.endsWith('.zstd') ? zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8');
  } catch {
    return null;
  }

  let sessionId = basename(dirname(filePath));
  let parentUid = '', isSub = 0, cwd = '', title = '', modelName = 'deepseek-dsh';
  let userTurns = 0, negTurns = 0, plannerTurns = 0, toolCalls = 0, singleToolTurns = 0;
  let cmdTotal = 0, cmdFailed = 0, fileEdits = 0, imageReads = 0, compactions = 0;
  let runningCtxTokens = 0, inSum = 0, caSum = 0, ouSum = 0;
  let exactUsageFound = false, llmSec = 0, syncSec = 0;
  let startTs = null, endTs = null, lastStepStartSec = null, lastNegTs = 0, lastUserTs = 0, lastCmdOk = true;
  let hasEdited = false, hasProduced = false;
  let ranVerifySuiteOk = false, ranCmdAfterEditOk = false, inspectedOutputMedia = false;
  let allStepsDone = false, hasUnfinishedSteps = false, shippedGitOrPkg = false, usedSubagentVerify = false;
  const pendingTools = new Map();
  const stepToolCounter = new Map();
  const ctxArr = [];
  const userTexts = [];
  const pathCandidates = [];
  const turns = [];
  const plannerTimestamps = [];

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
      if (o.parentSession) { parentUid = `dsh:${o.parentSession}`; isSub = 1; }
      else if (Number(o.delegationDepth || 0) > 0) isSub = 1;
    } else if (tp === 'model/selection' || tp === 'request/context') {
      if (d.model) modelName = `${d.provider ? d.provider + '/' : ''}${d.model}`;
    } else if (tp === 'session/title' && d.title) {
      // 不设 !title 限制：用户在 DSH 中每次重命名都会追加新的 session/title 事件，取最新一次！
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
      if (ts !== null && ts > lastUserTs) lastUserTs = ts;
      const rawStr = JSON.stringify(d.content || d.message || '');
      if (rawStr.includes('image/')) imageReads++;
      const txtMatch = /"text"\s*:\s*"([^"]{2,300})"/.exec(rawStr);
      const cleanU = txtMatch ? txtMatch[1].replace(/\\n/g, ' ') : rawStr.slice(0, 200);
      if (!title && txtMatch && !cleanU.startsWith('<') && !cleanU.startsWith('Current runtime')) {
        title = cleanU.slice(0, 120);
      }
      userTexts.push(cleanU);
      for (const mp of (cleanU.replace(/\\\\/g, '\\').match(WIN_PATH_RE) || [])) pathCandidates.push(mp);
      if (userTurns > 1 && (ABORT_WORSE_RE.test(cleanU) || STRONG_UNMET_RE.test(cleanU) || MID_REFINE_RE.test(cleanU))) {
        negTurns++;
        if (ts !== null) lastNegTs = Math.max(lastNegTs, ts);
      }
      const tok = estimateTokensFromText(rawStr);
      runningCtxTokens += tok;
      inSum += tok;
    } else if (tp === 'assistant/message') {
      plannerTurns++;
      if (ts !== null) plannerTimestamps.push(ts);
      const stepKey = `${d.turn || 0}:${d.step || plannerTurns}`;
      stepToolCounter.set(stepKey, 0);

      const msgStr = JSON.stringify(d.message || '');
      const outTok = Number(d.usage?.output_tokens || d.message?.usage?.output_tokens || estimateTokensFromText(msgStr));
      if (d.usage?.input_tokens || d.message?.usage?.input_tokens) {
        exactUsageFound = true;
        const u = d.usage || d.message.usage;
        const inp = Number(u.input_tokens || 0);
        const cac = Number(u.cache_read_input_tokens || u.cached_tokens || 0);
        inSum += inp; caSum += cac; ouSum += outTok;
        ctxArr.push(inp + cac);
      } else {
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
      const rawArgs = JSON.stringify(d.input || d.arguments || d);
      if (tname.includes('write') || tname.includes('edit') || tname.includes('patch')) {
        fileEdits++;
        hasEdited = true;
        hasProduced = true;
      }
      if ((tname.includes('read') || tname.includes('view')) && hasProduced && MEDIA_EXT_RE.test(rawArgs)) {
        inspectedOutputMedia = true;
      }
      if (tname.includes('task') || tname.includes('subagent') || tname.includes('delegate')) {
        usedSubagentVerify = true;
      }
      if (tname.includes('todo')) {
        const sts = [...rawArgs.matchAll(/"status"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
        if (sts.length) {
          allStepsDone = sts.every((x) => x === 'completed' || x === 'done' || x === 'cancelled');
          hasUnfinishedSteps = sts.some((x) => x === 'in_progress' || x === 'pending');
        }
      }
      if (tname === 'pwsh' || tname === 'bash' || tname.includes('shell') || tname.includes('exec')) {
        cmdTotal++;
        hasProduced = true;
        pendingTools.set(d.callId, {
          ts,
          isCmd: true,
          afterEdit: hasEdited,
          isVer: VERIFY_CMD_RE.test(rawArgs),
          isShip: SHIP_CMD_RE.test(rawArgs),
        });
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
        if (prev.isCmd) {
          const failed = /exit code [1-9]|exited with code [1-9]|"isError"\s*:\s*true|ParserError|CommandNotFoundException/i.test(resStr);
          lastCmdOk = !failed;
          if (failed) cmdFailed++;
          else {
            if (prev.afterEdit) ranCmdAfterEditOk = true;
            if (prev.afterEdit && prev.isVer) ranVerifySuiteOk = true;
            if (prev.isShip) shippedGitOrPkg = true;
          }
        }
        pendingTools.delete(cidCall);
      }
    }
  }

  if (plannerTurns === 0) return null;
  for (const cnt of stepToolCounter.values()) {
    if (cnt === 1) singleToolTurns++;
  }

  const turnsAfterNeg = lastNegTs > 0 ? plannerTimestamps.filter((t) => t > lastNegTs).length : plannerTurns;
  const turnsAfterLastUser = lastUserTs > 0 ? plannerTimestamps.filter((t) => t > lastUserTs).length : plannerTurns;
  const isActivelyRunning = endTs !== null && (Date.now() / 1000 - endTs) < 600;
  const role = isSub ? 'subagent' : (plannerTurns <= 5 && fileEdits === 0 ? 'probe' : 'execution');

  const qEval = evaluateTaskCompletionQuality({
    userTexts,
    plannerTurnsAfterLastNeg: turnsAfterNeg,
    plannerTurnsAfterLastUser: turnsAfterLastUser,
    fileEdits,
    outputTokens: ouSum,
    cmdTotal,
    cmdFailed,
    plannerTurns,
    lastCmdSucceeded: lastCmdOk,
    ranVerifySuiteOk,
    ranCmdAfterEditOk,
    inspectedOutputMedia,
    allStepsDone,
    hasUnfinishedSteps,
    usedSubagentVerify,
    shippedGitOrPkg,
    abruptEnd: pendingTools.size > 0,
    isActivelyRunning,
    endedAtSec: endTs || 0,
    isTrivialProbe: role === 'probe' && TRIVIAL_PROBE_RE.test(userTexts[0] || ''),
  });

  const meanCtxK = ctxArr.length ? ctxArr.reduce((a, b) => a + b, 0) / ctxArr.length / 1000 : 0;
  const maxCtxK = ctxArr.length ? Math.max(...ctxArr) / 1000 : 0;

  const rec = finalizeCommonMetrics({
    session_uid: `dsh:${sessionId}`,
    platform: 'dsh',
    raw_id: sessionId,
    parent_uid: parentUid,
    is_subagent: isSub,
    session_role: role,
    project_key: normalizeProjectKey(cwd, pathCandidates),
    linked_uids: '[]',
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
  }, qEval);

  return { rec, turns, phaseSplit: null };
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
  let startTs = null, endTs = null, prevTs = null, lastNegTs = 0, lastUserTs = 0, lastCmdOk = true;
  let hasEdited = false, hasProduced = false, pendingCmdMeta = null;
  let ranVerifySuiteOk = false, ranCmdAfterEditOk = false, inspectedOutputMedia = false;
  let allStepsDone = false, hasUnfinishedSteps = false, shippedGitOrPkg = false, usedSubagentVerify = false;
  const ctxArr = [];
  const userTexts = [];
  const plannerTimestamps = [];
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
        const failed = /exit code [1-9]|"is_error"\s*:\s*true/i.test(cStr);
        lastCmdOk = !failed;
        if (failed) cmdFailed++;
        else if (pendingCmdMeta) {
          if (pendingCmdMeta.afterEdit) ranCmdAfterEditOk = true;
          if (pendingCmdMeta.afterEdit && pendingCmdMeta.isVer) ranVerifySuiteOk = true;
          if (pendingCmdMeta.isShip) shippedGitOrPkg = true;
        }
        pendingCmdMeta = null;
        if (prevTs !== null && ts !== null && ts - prevTs <= 120 && ts >= prevTs) syncSec += (ts - prevTs);
      } else {
        userTurns++;
        if (ts !== null && ts > lastUserTs) lastUserTs = ts;
        if (!title && cStr) title = cStr.replace(/\s+/g, ' ').slice(0, 130);
        userTexts.push(cStr);
        if (userTurns > 1 && (ABORT_WORSE_RE.test(cStr) || STRONG_UNMET_RE.test(cStr) || MID_REFINE_RE.test(cStr))) {
          negTurns++;
          if (ts !== null) lastNegTs = Math.max(lastNegTs, ts);
        }
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
        if (ts !== null) plannerTimestamps.push(ts);
        inSum += inp; caSum += cac; ouSum += out;
        ctxArr.push(inp + cac);

        const cArr = Array.isArray(msg.content) ? msg.content : [];
        let tInTurn = 0;
        for (const blk of cArr) {
          if (blk && blk.type === 'tool_use') {
            tInTurn++;
            toolCalls++;
            const tn = String(blk.name || '').toLowerCase();
            const rawArgs = JSON.stringify(blk.input || '');
            if (tn.includes('edit') || tn.includes('write')) {
              fileEdits++;
              hasEdited = true;
              hasProduced = true;
            } else if (tn.includes('bash')) {
              cmdTotal++;
              hasProduced = true;
              pendingCmdMeta = {
                afterEdit: hasEdited,
                isVer: VERIFY_CMD_RE.test(rawArgs),
                isShip: SHIP_CMD_RE.test(rawArgs),
              };
            } else if (tn.includes('read') && hasProduced && MEDIA_EXT_RE.test(rawArgs)) {
              inspectedOutputMedia = true;
            } else if (tn.includes('task') || tn.includes('agent')) {
              usedSubagentVerify = true;
            } else if (tn.includes('todo')) {
              const sts = [...rawArgs.matchAll(/"status"\s*:\s*"([^"]+)"/g)].map((x) => x[1]);
              if (sts.length) {
                allStepsDone = sts.every((x) => x === 'completed' || x === 'done');
                hasUnfinishedSteps = sts.some((x) => x === 'in_progress' || x === 'pending');
              }
            }
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
  const turnsAfterNeg = lastNegTs > 0 ? plannerTimestamps.filter((t) => t > lastNegTs).length : plannerTurns;
  const turnsAfterLastUser = lastUserTs > 0 ? plannerTimestamps.filter((t) => t > lastUserTs).length : plannerTurns;
  const isActivelyRunning = endTs !== null && (Date.now() / 1000 - endTs) < 600;
  const role = isSub ? 'subagent' : (plannerTurns <= 4 && fileEdits === 0 ? 'probe' : 'execution');

  const qEval = evaluateTaskCompletionQuality({
    userTexts,
    plannerTurnsAfterLastNeg: turnsAfterNeg,
    plannerTurnsAfterLastUser: turnsAfterLastUser,
    fileEdits,
    outputTokens: ouSum,
    cmdTotal,
    cmdFailed,
    plannerTurns,
    lastCmdSucceeded: lastCmdOk,
    ranVerifySuiteOk,
    ranCmdAfterEditOk,
    inspectedOutputMedia,
    allStepsDone,
    hasUnfinishedSteps,
    usedSubagentVerify,
    shippedGitOrPkg,
    abruptEnd: Boolean(pendingCmdMeta),
    isActivelyRunning,
    endedAtSec: endTs || 0,
  });

  const meanCtxK = ctxArr.length ? ctxArr.reduce((a, b) => a + b, 0) / ctxArr.length / 1000 : 0;
  const maxCtxK = ctxArr.length ? Math.max(...ctxArr) / 1000 : 0;

  const rec = finalizeCommonMetrics({
    session_uid: `claude:${sessionId}`,
    platform: 'claude-code',
    raw_id: sessionId,
    parent_uid: '',
    is_subagent: isSub,
    session_role: role,
    project_key: normalizeProjectKey(cwd, []),
    linked_uids: '[]',
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
  }, qEval);
  return { rec, turns, phaseSplit: null };
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
  let durationSec = 0, startTs = null, endTs = null, lastNegTs = 0, lastUserTs = 0, lastCmdOk = true;
  let hasEdited = false, hasProduced = false, pendingCmdMeta = null;
  let ranVerifySuiteOk = false, ranCmdAfterEditOk = false, inspectedOutputMedia = false;
  let allStepsDone = false, hasUnfinishedSteps = false, shippedGitOrPkg = false, usedSubagentVerify = false;
  const ctxArr = [];
  const userTexts = [];
  const plannerTimestamps = [];
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
        if (ts !== null && ts > lastUserTs) lastUserTs = ts;
        const txt = JSON.stringify(pl.content || '');
        const m = /"text"\s*:\s*"([^"]{3,220})"/.exec(txt);
        const cleanU = m ? m[1].replace(/\\n/g, ' ') : txt.slice(0, 180);
        if (!title && m && !cleanU.startsWith('<')) title = cleanU.slice(0, 130);
        userTexts.push(cleanU);
        if (userTurns > 1 && (ABORT_WORSE_RE.test(cleanU) || STRONG_UNMET_RE.test(cleanU) || MID_REFINE_RE.test(cleanU))) {
          negTurns++;
          if (ts !== null) lastNegTs = Math.max(lastNegTs, ts);
        }
      } else if (pl.role === 'developer' && JSON.stringify(pl.content || '').includes('<multi_agent_role>')) {
        isSub = 1;
      }
    } else if (tp === 'response_item' && (pl.type === 'custom_tool_call' || pl.type === 'function_call')) {
      toolCalls++;
      const nm = String(pl.name || '').toLowerCase();
      const inpStr = String(pl.input || pl.arguments || '');
      if (nm.includes('patch') || nm.includes('write') || inpStr.includes('apply_patch')) {
        fileEdits++;
        hasEdited = true;
        hasProduced = true;
      } else if (nm.includes('exec') || nm.includes('shell') || inpStr.includes('exec_command')) {
        cmdTotal++;
        hasProduced = true;
        pendingCmdMeta = {
          afterEdit: hasEdited,
          isVer: VERIFY_CMD_RE.test(inpStr),
          isShip: SHIP_CMD_RE.test(inpStr),
        };
      } else if ((nm.includes('view_image') || nm.includes('read')) && hasProduced && MEDIA_EXT_RE.test(inpStr)) {
        inspectedOutputMedia = true;
      } else if (nm.includes('spawn_agent') || nm.includes('subagent')) {
        usedSubagentVerify = true;
      } else if (nm.includes('update_plan')) {
        const sts = [...inpStr.matchAll(/"status"\s*:\s*"([^"]+)"/g)].map((x) => x[1]);
        if (sts.length) {
          allStepsDone = sts.every((x) => x === 'completed' || x === 'done');
          hasUnfinishedSteps = sts.some((x) => x === 'in_progress' || x === 'pending');
        }
      }
    } else if (tp === 'response_item' && (pl.type === 'custom_tool_call_output' || pl.type === 'function_call_output')) {
      const outS = String(pl.output || '');
      const failed = /exit_code":\s*[1-9]|exited with code [1-9]|Error:/i.test(outS);
      lastCmdOk = !failed;
      if (failed) cmdFailed++;
      else if (pendingCmdMeta) {
        if (pendingCmdMeta.afterEdit) ranCmdAfterEditOk = true;
        if (pendingCmdMeta.afterEdit && pendingCmdMeta.isVer) ranVerifySuiteOk = true;
        if (pendingCmdMeta.isShip) shippedGitOrPkg = true;
      }
      pendingCmdMeta = null;
    } else if (tp === 'event_msg' && pl.type === 'compacted') {
      compactions++;
    } else if (tp === 'event_msg' && pl.type === 'token_count' && pl.info) {
      plannerTurns++;
      if (ts !== null) plannerTimestamps.push(ts);
      const tot = pl.info.total_token_usage || {};
      const last = pl.info.last_token_usage || {};
      const lIn = Math.max(0, Number(last.input_tokens || 0) - Number(last.cached_input_tokens || 0));
      const lCa = Number(last.cached_input_tokens || 0);
      const lOu = Number(last.output_tokens || 0);
      sumDeltaIn += lIn; sumDeltaCached += lCa; sumDeltaOut += lOu;
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

  const turnsAfterNeg = lastNegTs > 0 ? plannerTimestamps.filter((t) => t > lastNegTs).length : plannerTurns;
  const turnsAfterLastUser = lastUserTs > 0 ? plannerTimestamps.filter((t) => t > lastUserTs).length : plannerTurns;
  const isActivelyRunning = endTs !== null && (Date.now() / 1000 - endTs) < 600;
  const role = isSub ? 'subagent' : (plannerTurns <= 4 && fileEdits === 0 ? 'probe' : 'execution');

  const qEval = evaluateTaskCompletionQuality({
    userTexts,
    plannerTurnsAfterLastNeg: turnsAfterNeg,
    plannerTurnsAfterLastUser: turnsAfterLastUser,
    fileEdits,
    outputTokens: finalOu,
    cmdTotal,
    cmdFailed,
    plannerTurns,
    lastCmdSucceeded: lastCmdOk,
    ranVerifySuiteOk,
    ranCmdAfterEditOk,
    inspectedOutputMedia,
    allStepsDone,
    hasUnfinishedSteps,
    usedSubagentVerify,
    shippedGitOrPkg,
    abruptEnd: Boolean(pendingCmdMeta),
    isActivelyRunning,
    endedAtSec: endTs || 0,
  });

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
    session_role: role,
    project_key: normalizeProjectKey(cwd, []),
    linked_uids: '[]',
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
  }, qEval);
  return { rec, turns, phaseSplit: null };
}

/** 5. 解析通用自定义 Drop-in JSONL */
function parseCustomDropinFile(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const items = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (!o.session_id) continue;
      const qTask = o.q_task !== undefined ? Number(o.q_task) : 62.0;
      const rec = finalizeCommonMetrics({
        session_uid: `custom:${o.session_id}`,
        platform: o.platform || 'custom-agent',
        raw_id: String(o.session_id),
        parent_uid: o.parent_session_id ? `custom:${o.parent_session_id}` : '',
        is_subagent: o.is_subagent ? 1 : 0,
        session_role: o.session_role || 'execution',
        project_key: normalizeProjectKey(o.cwd || '', []),
        linked_uids: '[]',
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
      }, qTask);
      items.push({ rec, turns: [], phaseSplit: null });
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

export function syncAllAgentSources(db, dataDir, forceFull = false) {
  const t0 = Date.now();
  const extTitles = loadLiveExternalTitles();
  const wmMap = new Map();
  if (!forceFull) {
    for (const row of db.prepare('SELECT source_path, mtime_ms, size_bytes FROM file_watermarks').all()) {
      wmMap.set(row.source_path, { mtime: row.mtime_ms, size: row.size_bytes });
    }
  }

  const candidates = [];
  const agyBrain = join(HOME, '.gemini', 'antigravity', 'brain');
  if (existsSync(agyBrain)) {
    for (const cid of readdirSync(agyBrain)) {
      const tp = join(agyBrain, cid, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(tp)) candidates.push({ platform: 'antigravity', path: tp, cid });
    }
  }
  for (const fp of walkFiles(join(HOME, '.dsh', 'sessions'), (_, nm) => nm === 'session.v4.jsonl.zstd' || nm === 'session.v4.jsonl', 4)) {
    candidates.push({ platform: 'dsh', path: fp });
  }
  for (const fp of walkFiles(join(HOME, '.claude', 'projects'), (_, nm) => nm.endsWith('.jsonl'), 4)) {
    candidates.push({ platform: 'claude-code', path: fp });
  }
  for (const fp of walkFiles(join(HOME, '.codex', 'sessions'), (_, nm) => nm.endsWith('.jsonl'), 5)) {
    candidates.push({ platform: 'codex', path: fp });
  }
  for (const fp of walkFiles(join(HOME, '.codex', 'archived_sessions'), (_, nm) => nm.endsWith('.jsonl'), 5)) {
    candidates.push({ platform: 'codex', path: fp });
  }
  for (const fp of walkFiles(join(dataDir, 'dropin'), (_, nm) => nm.endsWith('.jsonl'), 2)) {
    candidates.push({ platform: 'custom', path: fp });
  }

  const upsertSess = db.prepare(`
    INSERT INTO sessions (
      session_uid, platform, raw_id, parent_uid, is_subagent, session_role, project_key, linked_uids,
      domain, primary_model, model_tier, model_mult, started_at, ended_at, cwd, display_name, title,
      user_turns, neg_feedback_turns, planner_turns, tool_calls, single_tool_turns,
      cmd_total, cmd_failed, file_edits, image_reads, compactions, input_tokens, cache_read_tokens, output_tokens,
      mean_ctx_k, max_ctx_k, token_accuracy, raw_cost_units, weighted_cost_units, cache_tax_share,
      llm_infer_sec, sync_tool_sec, bg_wait_sec, exec_time_min, workload_score, q_objective, q_breakdown, source_path, sub_ref_ids
    ) VALUES (
      $session_uid, $platform, $raw_id, $parent_uid, $is_subagent, $session_role, $project_key, $linked_uids,
      $domain, $primary_model, $model_tier, $model_mult, $started_at, $ended_at, $cwd, $display_name, $title,
      $user_turns, $neg_feedback_turns, $planner_turns, $tool_calls, $single_tool_turns,
      $cmd_total, $cmd_failed, $file_edits, $image_reads, $compactions, $input_tokens, $cache_read_tokens, $output_tokens,
      $mean_ctx_k, $max_ctx_k, $token_accuracy, $raw_cost_units, $weighted_cost_units, $cache_tax_share,
      $llm_infer_sec, $sync_tool_sec, $bg_wait_sec, $exec_time_min, $workload_score, $q_objective, $q_breakdown, $source_path, $sub_ref_ids
    ) ON CONFLICT(session_uid) DO UPDATE SET
      parent_uid = CASE WHEN excluded.parent_uid != '' THEN excluded.parent_uid ELSE sessions.parent_uid END,
      is_subagent = MAX(sessions.is_subagent, excluded.is_subagent),
      session_role = CASE WHEN MAX(sessions.is_subagent, excluded.is_subagent) = 1 THEN 'subagent' ELSE excluded.session_role END,
      project_key = CASE WHEN excluded.project_key != '' THEN excluded.project_key ELSE sessions.project_key END,
      linked_uids = excluded.linked_uids,
      domain = excluded.domain,
      primary_model = excluded.primary_model,
      model_tier = excluded.model_tier,
      model_mult = excluded.model_mult,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      display_name = excluded.display_name,
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
      q_breakdown = excluded.q_breakdown,
      sub_ref_ids = excluded.sub_ref_ids
  `);

  const upsertPhase = db.prepare(`
    INSERT INTO session_phases (
      session_uid, platform, split_kind, trigger_summary,
      b_label, b_turns, b_sub_uids, b_exec_min, b_main_cost_u, b_deliverables, b_q_task, b_q_breakdown,
      a_label, a_turns, a_sub_uids, a_exec_min, a_main_cost_u, a_deliverables, a_q_task, a_q_breakdown
    ) VALUES (
      $session_uid, $platform, $split_kind, $trigger_summary,
      $b_label, $b_turns, $b_sub_uids, $b_exec_min, $b_main_cost_u, $b_deliverables, $b_q_task, $b_q_breakdown,
      $a_label, $a_turns, $a_sub_uids, $a_exec_min, $a_main_cost_u, $a_deliverables, $a_q_task, $a_q_breakdown
    ) ON CONFLICT(session_uid) DO UPDATE SET
      split_kind = excluded.split_kind, trigger_summary = excluded.trigger_summary,
      b_label = excluded.b_label, b_turns = excluded.b_turns, b_sub_uids = excluded.b_sub_uids,
      b_exec_min = excluded.b_exec_min, b_main_cost_u = excluded.b_main_cost_u,
      b_deliverables = excluded.b_deliverables, b_q_task = excluded.b_q_task, b_q_breakdown = excluded.b_q_breakdown,
      a_label = excluded.a_label, a_turns = excluded.a_turns, a_sub_uids = excluded.a_sub_uids,
      a_exec_min = excluded.a_exec_min, a_main_cost_u = excluded.a_main_cost_u,
      a_deliverables = excluded.a_deliverables, a_q_task = excluded.a_q_task, a_q_breakdown = excluded.a_q_breakdown
  `);

  const upsertWm = db.prepare(`
    INSERT INTO file_watermarks (source_path, platform, mtime_ms, size_bytes, session_uid, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes,
      session_uid = excluded.session_uid, synced_at = excluded.synced_at
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
      const rawMtimeMs = Math.floor(st.mtimeMs);
      const extMeta = item.platform === 'antigravity' ? extTitles.get(`agy:${item.cid.toLowerCase()}`) : null;
      const mtimeMs = extMeta?.annMtimeMs ? Math.max(rawMtimeMs, extMeta.annMtimeMs) : rawMtimeMs;
      const sz = st.size;
      if (sz < 80) continue;

      const prev = wmMap.get(item.path);
      if (prev && prev.mtime === mtimeMs && prev.size === sz) {
        skipped++;
        continue;
      }

      let parsedList = [];
      if (item.platform === 'antigravity') {
        const res = parseAntigravityFile(item.path, item.cid, extMeta);
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
        const { rec, turns, phaseSplit } = pObj;
        lastUid = rec.session_uid;
        const bindParams = {};
        for (const [k, v] of Object.entries(rec)) bindParams[`$${k}`] = v;
        upsertSess.run(bindParams);

        if (phaseSplit) {
          const pBind = {};
          for (const [k, v] of Object.entries(phaseSplit)) pBind[`$${k}`] = v;
          upsertPhase.run(pBind);
        }

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

    const rowsWithRefs = db.prepare("SELECT session_uid, sub_ref_ids FROM sessions WHERE sub_ref_ids != '[]'").all();
    const markChild = db.prepare("UPDATE sessions SET parent_uid = ?, is_subagent = 1, session_role = 'subagent' WHERE session_uid = ?");
    for (const r of rowsWithRefs) {
      let refs = [];
      try { refs = JSON.parse(r.sub_ref_ids); } catch {}
      for (const childUid of refs) markChild.run(r.session_uid, childUid);
    }

    // 实时对齐全平台外部对话标题与用户手动重命名（即使 transcript.jsonl 未新增字节，改名也会在毫秒内立刻生效！）
    const allDbSess = db.prepare('SELECT session_uid, platform, raw_id, is_subagent, parent_uid, project_key, display_name, title FROM sessions').all();
    const updateNameStmt = db.prepare("UPDATE sessions SET display_name = ?, parent_uid = CASE WHEN ? != '' THEN ? ELSE parent_uid END, project_key = CASE WHEN project_key = '' AND ? != '' THEN ? ELSE project_key END WHERE session_uid = ?");

    // 第一遍：先更新所有主会话标题与外部父子关系
    const latestNameByUid = new Map();
    for (const s of allDbSess) {
      const ext = extTitles.get(s.session_uid);
      let nextName = s.display_name || buildCleanFallbackName(s.title, s.platform, s.raw_id.slice(0, 8));
      let nextParent = s.parent_uid || '';
      let nextProj = '';
      if (ext) {
        if (ext.displayName) nextName = ext.displayName;
        if (ext.parentUid && !nextParent) nextParent = ext.parentUid;
        if (ext.workspacePath && !s.project_key) nextProj = normalizeProjectKey(ext.workspacePath, []);
      }
      latestNameByUid.set(s.session_uid, nextName);
      if (nextName !== s.display_name || (nextParent && nextParent !== s.parent_uid) || nextProj) {
        updateNameStmt.run(nextName, nextParent, nextParent, nextProj, nextProj, s.session_uid);
        updated++;
      }
    }

    // 第二遍：为子代理补充直观归属名称（如「[子代理 · research] 归属：Local AI Manga Image Generation」）
    const subRows = db.prepare('SELECT session_uid, raw_id, parent_uid, display_name FROM sessions WHERE is_subagent = 1').all();
    const updSubName = db.prepare('UPDATE sessions SET display_name = ? WHERE session_uid = ?');
    for (const sr of subRows) {
      const ext = extTitles.get(sr.session_uid);
      const roleTag = ext?.agentName ? `子代理·${ext.agentName}` : '子代理';
      const pName = sr.parent_uid ? latestNameByUid.get(sr.parent_uid) : '';
      const desired = pName ? `[${roleTag}] ${pName}` : (ext?.displayName || `[${roleTag}] #${sr.raw_id.slice(0, 8)}`);
      if (desired !== sr.display_name) {
        updSubName.run(desired, sr.session_uid);
        updated++;
      }
    }

    // 兜底重评那些原始日志文件已被客户端清理/搬移的历史遗留会话，确保 100% 样本对齐 v1.4 五维标准
    const legacyRows = db.prepare("SELECT * FROM sessions WHERE q_breakdown = '{}' OR q_breakdown IS NULL").all();
    const updLegacy = db.prepare('UPDATE sessions SET q_objective = ?, q_breakdown = ? WHERE session_uid = ?');
    for (const lr of legacyRows) {
      const fakeUTexts = Array.from({ length: Math.max(1, lr.user_turns || 1) }, (_, idx) => (idx === 0 ? lr.title : '继续推进'));
      for (let k = 0; k < Math.min(fakeUTexts.length - 1, lr.neg_feedback_turns || 0); k++) {
        fakeUTexts[k + 1] = '不对，需要修改';
      }
      const qEv = evaluateTaskCompletionQuality({
        userTexts: fakeUTexts,
        plannerTurnsAfterLastNeg: 6,
        plannerTurnsAfterLastUser: 4,
        fileEdits: lr.file_edits || 0,
        outputTokens: lr.output_tokens || 0,
        cmdTotal: lr.cmd_total || 0,
        cmdFailed: lr.cmd_failed || 0,
        plannerTurns: lr.planner_turns || 1,
        lastCmdSucceeded: (lr.cmd_failed || 0) < Math.max(1, lr.cmd_total || 0),
        ranCmdAfterEditOk: (lr.file_edits || 0) >= 1 && (lr.cmd_total || 0) > (lr.cmd_failed || 0),
        inspectedOutputMedia: (lr.image_reads || 0) >= 2 && (lr.file_edits || 0) >= 1,
      });
      updLegacy.run(qEv.score, JSON.stringify(qEv), lr.session_uid);
      updated++;
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
