# QTC Observatory — 跨 AI Agent 零干扰任务监测与性价比研究台

**QTC Observatory** 是一款遵循 **100% 物理级零干扰原则（Zero-Interference Principle）** 的跨平台 AI Agent 遥测监测与计量经济学分析工具（支持作为 **Google Antigravity 原生 MCP App 插件**运行，亦可作为**独立本地 Web 服务与 CLI** 运行）。

它持续以只读旁路方式收集本机各类 AI Agent 的任务轨迹，实证建模 **完成质量 ($Q$)**、**时间成本 ($T$)** 与 **金钱/额度成本 ($C$)** 三者的定量数学关系，自动抓捕“用大部分金钱成本换取小部分时间成本（捡芝麻丢西瓜）”的不合算行为，并实时推算在追求**极致性价比**或**极致产出质量**时 AI Agent 的最优工作参数。

---

## 核心特性

### 1. 严格的观察者隔离（对 AI Agent 100% 零影响）
- **零提示词注入（No `rules/`）**：不向任何 AI Agent 的系统提示词或上下文窗口写入任何字符。
- **零执行流拦截（No `hooks.json`）**：不挂接 `PreInvocation` / `PreToolUse` / `Stop` 钩子，绝不干扰 Agent 的思考、审批或自主判断。
- **MCP 工具隐身隔离**：所有数据拉取、人工评分、回归重算与 CSV 导出工具均声明 `visibility: ["app"]`，对大模型完全隐形（0 Schema Token 占用）。
- **毫秒级只读增量扫描**：基于 Node.js `v22.5+` 原生 `node:sqlite` 与 `node:zlib`（支持内存直解 `.jsonl.zstd`），通过 `(mtime_ms, size_bytes)` 水位指纹增量同步，未变动文件扫描耗时 `< 30ms`，所有采集数据仅保存在本地 `.data/` 目录（已被 `.gitignore` 严格排除，零隐私外泄）。

### 2. 开箱支持主流本地 AI Agent 平台 + 开放接入
- **Google Antigravity**：自动关联主会话与派生子代理项目树，精确分离 LLM 推理打字时间、同步命令时间、后台排队时间与 KV-Cache 缓存重读税。
- **DeepSeek Harness (DSH)**：原生只读解压 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，串联 `parentSession` 委托树与毫秒级步骤延迟。
- **Claude Code**：解析 `~/.claude/projects/**/*.jsonl` 中的精确缓存创建/读取 Token 与工具状态。
- **OpenAI Codex CLI / Desktop**：解析 `~/.codex/sessions/**/*.jsonl` 中的 `token_count`、`duration_ms` 与工具调用链。
- **通用自定义 Agent 接入**：支持通过 `sdk/qtc_universal_sdk.py`、`POST http://127.0.0.1:18765/api/ingest` 或向 `.data/dropin/*.jsonl` 投递标准 JSON 行接入任意 LangGraph / AutoGen / CrewAI / 自研脚本。

### 3. 五大内置科研与决策模块
1. **跨 Agent 样本与账单拆解矩阵**：直观揭示历史上下文重复读取税（`Cache Read`）、新输入与实际有效产出的真实比例。
2. **交互式真实散点 OLS 回归实验室**：随样本增长实时重拟合双对数轮数膨胀幂律 $\ln C \text{ vs } \ln N$、加权上下文吞吐纯线性方程 $C \text{ vs } \mu N\bar{L}$、失忆降质负斜率回归 $Q \text{ vs } \ln N$ 及单位产出帕累托前沿。
3. **“捡芝麻丢西瓜”不合算行为抓捕雷达**：基于相对同领域基准的不对称交换比 $\text{AER} = \frac{\Delta C\%}{-\Delta T\%} > 1.5$，自动揪出“花大钱买微小提速”与“多花钱反而更慢（双输雪崩）”的异常任务，并拆解缓存税、子代理克隆税、报错重试税与失忆返工税。
4. **「极致性价比」vs「极致产出质量」双模式动态推算器 & What-If 沙盘**：基于库内前 25% 帕累托标杆项目动态推算最佳截断轮数、模型分层路由策略与单轮并行工具阈值，并提供事前参数预演计算器。
5. **人工真实质量校准台**：支持对任意任务手打 0–100 真实质量分，一键重算全库回归系数，并可随时导出 UTF-8 CSV 科研数据集。

---

## 安装与使用

### 环境要求
- **Node.js `>= 22.15.0`**（推荐 `v24+` / `v26+`，使用内置 `node:sqlite` 与 `zlib.zstdDecompressSync`，零原生 C++ 编译依赖）。

### 方式一：作为 Antigravity 插件安装
```bash
git clone https://github.com/tcbhls/qtc-observatory.git ~/.gemini/config/plugins/qtc-observatory
cd ~/.gemini/config/plugins/qtc-observatory
npm install
npm run build
```
安装后无需重启，直接在 Antigravity 左侧全局栏点击 **「QTC 跨Agent观测中心」** 或在右侧边栏 `+` 菜单选择 **「QTC 跨Agent监测台」** 即可打开。

### 方式二：作为独立本地 Web 看板与 CLI 运行（适用于任何环境）
```bash
# 1. 终端查看全机多 Agent 同步摘要与最新计量回归方程
npm run report

# 2. 启动本地独立 Web 交互大屏 (默认 http://127.0.0.1:18765)
npm run web

# 3. 导出脱敏结构化 CSV 科研数据集至 .data/qtc_multi_agent_dataset.csv
node server/cli.mjs export
```

---

## 隐私与数据安全说明
- 本工具为 **100% 纯本地离线分析引擎**，所有日志解析与 SQLite 数据库存储均在本地 `.data/` 完成，不发起任何外部遥测或联网请求。
- `.gitignore` 已默认屏蔽 `.data/`、`*.db`、`*.sqlite` 与 `*.csv`，防止二次开发提交时误传本地会话统计数据。

## License
[MIT](./LICENSE)
