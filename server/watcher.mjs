/**
 * QTC Observatory v1.1.0 — `fs.watch` 秒级流式文件监听器 (Real-Time File Watcher)
 *
 * 监听全机四大 AI Agent 会话目录 + 自定义 dropin 目录：
 * 一旦任意正在运行的 AI Agent 写入新的一步日志（transcript.jsonl / session.v4.jsonl.zstd / *.jsonl），
 * 经过 1200ms 防抖合并后立即执行增量解析入库、在线重训练数学模型，并通过回调向所有打开的 SSE / UI 视图实时广播！
 */
import { existsSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

export function createRealtimeAgentWatcher(dataDir, onDetectedChange) {
  const watchTargets = [
    { name: 'antigravity', dir: join(HOME, '.gemini', 'antigravity', 'brain') },
    { name: 'dsh', dir: join(HOME, '.dsh', 'sessions') },
    { name: 'claude-code', dir: join(HOME, '.claude', 'projects') },
    { name: 'codex', dir: join(HOME, '.codex', 'sessions') },
    { name: 'custom', dir: join(dataDir, 'dropin') },
  ];

  const watchers = [];
  let debounceTimer = null;
  let dirtySource = '';

  function triggerSync(srcName, filename) {
    if (!filename) return;
    const f = String(filename).toLowerCase();
    // 仅对会话日志文件变更响应，忽略临时锁或无关缓存
    if (!f.endsWith('.jsonl') && !f.endsWith('.zstd')) return;
    dirtySource = `${srcName}:${filename}`;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        onDetectedChange(dirtySource);
      } catch {
        // 严守零干扰原则，任何解析瞬间竞争异常全部静默吸收
      }
    }, 1200);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  for (const item of watchTargets) {
    if (!existsSync(item.dir)) continue;
    try {
      // Windows 原生支持 recursive: true 内核级 ReadDirectoryChangesW 监听，0% CPU 轮询开销！
      const w = watch(item.dir, { recursive: true, persistent: false }, (_eventType, filename) => {
        triggerSync(item.name, filename);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // 某些受限目录不支持 recursive 时静默降级至定时增量兜底
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
