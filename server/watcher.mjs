/**
 * QTC Observatory v1.3.0 — `fs.watch` 秒级流式日志与实时会话改名监听器
 *
 * 同时监听：
 *   1. 四大 AI Agent 实时推理步进日志 (*.jsonl / *.zstd)
 *   2. 会话重命名与标题元数据目录：
 *      - Antigravity 用户改名注解目录: ~/.gemini/antigravity/annotations (*.pbtxt)
 *      - Antigravity 标题摘要库: ~/.gemini/antigravity/conversation_summaries.db(-wal)
 *      - OpenAI Codex 会话标题索引: ~/.codex/session_index.jsonl
 * 用户在客户端修改对话名字后 ~800ms 内自动捕获并热推刷新全站界面！
 */
import { existsSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

export function createRealtimeAgentWatcher(dataDir, onDetectedChange) {
  const watchTargets = [
    { name: 'antigravity', dir: join(HOME, '.gemini', 'antigravity', 'brain'), recursive: true },
    { name: 'agy-rename', dir: join(HOME, '.gemini', 'antigravity', 'annotations'), recursive: false },
    { name: 'agy-summary', dir: join(HOME, '.gemini', 'antigravity'), recursive: false },
    { name: 'dsh', dir: join(HOME, '.dsh', 'sessions'), recursive: true },
    { name: 'claude-code', dir: join(HOME, '.claude', 'projects'), recursive: true },
    { name: 'claude-meta', dir: join(HOME, '.claude', 'sessions'), recursive: false },
    { name: 'codex', dir: join(HOME, '.codex', 'sessions'), recursive: true },
    { name: 'codex-rename', dir: join(HOME, '.codex'), recursive: false },
    { name: 'custom', dir: join(dataDir, 'dropin'), recursive: true },
  ];

  const watchers = [];
  let debounceTimer = null;
  let dirtySource = '';

  function isRelevantFile(srcName, filename) {
    if (!filename) return false;
    const f = String(filename).toLowerCase();
    if (srcName === 'agy-rename') return f.endsWith('.pbtxt');
    if (srcName === 'agy-summary') return f.startsWith('conversation_summaries.db');
    if (srcName === 'codex-rename') return f === 'session_index.jsonl';
    if (srcName === 'claude-meta') return f.endsWith('.json') || f.endsWith('.jsonl');
    return f.endsWith('.jsonl') || f.endsWith('.zstd');
  }

  function triggerSync(srcName, filename) {
    if (!isRelevantFile(srcName, filename)) return;
    dirtySource = `${srcName}:${filename}`;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        onDetectedChange(dirtySource);
      } catch {
        // 严守零干扰原则，任何瞬间读写竞争静默吸收
      }
    }, 800);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  for (const item of watchTargets) {
    if (!existsSync(item.dir)) continue;
    try {
      const w = watch(item.dir, { recursive: item.recursive, persistent: false }, (_eventType, filename) => {
        triggerSync(item.name, filename);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // 受限目录静默降级至心跳兜底
    }
  }

  return {
    watchedCount: watchers.length,
    closeAll() {
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const w of watchers) {
        try { w.close(); } catch {}
      }
    },
  };
}
