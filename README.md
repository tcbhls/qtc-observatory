# QTC Observatory v1.1 — 跨 AI Agent 零干扰实时任务监测与自修正研究台

**QTC Observatory** 是一款遵循 **100% 物理级零干扰原则（Zero-Interference Principle）** 的跨平台 AI Agent 实时遥测监测与在线自修正计量经济学分析系统（支持作为 **Google Antigravity 原生 MCP App 插件**运行，亦可作为 **全天候无头守护进程 (`daemon`)、本地 SSE 实时 Web 大屏与 CLI** 运行）。

它通过内核级 `fs.watch` 递归文件流实时监听本机所有 AI Agent 的会话轨迹，**每当新增一轮对话或任务样本，立即在后台增量入库、在线重训练全部最小二乘（OLS / Multiple-OLS）与逻辑斯蒂极大似然（Newton-Raphson IRLS）数学模型，并通过 SSE / MCP 心跳无感热推刷新全部回归曲线与决策边界**。

---

## 核心特性

### 1. 秒级全链路实时闭环（v1.1 实时流架构）
- **内核级 `fs.watch` 秒级捕获（~1.2s 响应）**：直接挂载操作系统的目录变更通知（`ReadDirectoryChangesW` / `FSEvents`），任意正在运行的 Agent 每落盘一步日志，1.2 秒防抖合并后自动完成增量解析入库（0% 空闲轮询 CPU 开销）。
- **100% 在线自修正数学模型（零静态硬编码常数）**：
  - 单变量与多元矩阵最小二乘回归（高斯列主元消元实时求解 $(\mathbf{X}^\top \mathbf{X} + \lambda \mathbf{I})^{-1}\mathbf{X}^\top \mathbf{y}$）。
  - 在线 L2 正则化 Newton-Raphson / IRLS 逻辑斯蒂回归：随每一轮新数据动态重训练状态性价比模型 $P_{\text{CE}}(Q, T/W, C/W)$ 与过程实时预警模型 $P_{\text{live}}(\ln N, \text{Err}, \text{Comp})$，自动更新**时间-金钱弹性比**与**动态 50% 性价比生死线 $N_{50\%}$**，并将每次参数演化记入 `model_evolution` 轨迹表。
- **SSE (`/api/events`) 与 MCP App 双通道无感热推**：无需手动刷新网页或重开面板，全部 6 张交互式 SVG 回归图、活跃会话脉搏条与策略沙盘均随新数据自动跳动重绘，并支持一键导出 2x 高清 PNG 与矢量 SVG（亦可通过 `.data/local_hooks.json` 挂载本地科研大图自动重绘脚本）。
- **脱离单一 IDE 的开机静默守护 (`daemon` / `autostart`)**：即使关闭所有编辑器，后台无头守护进程依然实时监测全机 CLI / 终端 Agent。

### 2. 严格的观察者隔离（对 AI Agent 100% 零影响）
- **零提示词注入（No `rules/`）**：不向任何 AI Agent 的系统提示词或上下文窗口写入任何字符。
- **零执行流拦截（No `hooks.json`）**：不挂接 `PreInvocation` / `PreToolUse` / `Stop` 钩子，绝不干扰 Agent 的思考、审批或自主判断。
- **MCP 工具隐身隔离**：所有数据拉取、版本心跳、人工评分、回归重算与 CSV 导出工具均声明 `visibility: ["app"]`，对大模型完全隐形（0 Schema Token 占用）。

### 3. 开箱支持主流本地 AI Agent 平台 + 开放接入
- **Google Antigravity**：自动关联主会话与派生子代理项目树，精确分离 LLM 推理打字时间、同步命令时间、后台排队时间与 KV-Cache 缓存重读税。
- **DeepSeek Harness (DSH)**：原生只读解压 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，串联 `parentSession` 委托树与毫秒级步骤延迟。
- **Claude Code**：解析 `~/.claude/projects/**/*.jsonl` 中的精确缓存创建/读取 Token 与工具状态。
- **OpenAI Codex CLI / Desktop**：解析 `~/.codex/sessions/**/*.jsonl` 中的 `token_count`、`duration_ms` 与工具调用链。
- **通用自定义 Agent 接入**：支持通过 `sdk/qtc_universal_sdk.py`、`POST http://127.0.0.1:18765/api/ingest` 或向 `.data/dropin/*.jsonl` 投递标准 JSON 行接入任意 LangGraph / AutoGen / CrewAI / 自研脚本。

### 4. 内置 6 大实时回归图表与双模式推算模块
1. **① $\ln C \text{ vs } \ln N$ 双对数轮数幂律膨胀回归**（含 95% 置信区间带与 $\beta=1$ 无膨胀基准线）。
2. **② $C \text{ vs } (\mu \cdot N \cdot \bar{L})$ 物理计费吞吐纯线性回归**。
3. **③ $Q \text{ vs } \ln N_{\text{tree}}$ 拖长失忆降质负斜率回归**（高亮标记触发上下文压缩失忆会话）。
4. **④ $t_{\text{LLM}} \text{ vs } \text{Out}_k$ 微观单步流式延迟多元回归**（实时分离固定底噪、输出流式耗时与百k上下文扫描耗时）。
5. **⑤ $P_{\text{CE}}(N)$ 在线 IRLS Sigmoid 概率生死线**（对比零失忆与压缩失忆双曲线，实时标定 50% 性价比临界轮数 $N_{50\%}$）。
6. **⑥ 单位产出 $(\ln(T/W), \ln(C/W))$ 帕累托空间 + 实时 Logistic 线性分类分界线**，配合“捡芝麻丢西瓜”雷达与「极致性价比 vs 极致产出质量」双模式动态推算沙盘。

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

### 方式二：开启全天候后台实时守护与流式 Web 大屏
```bash
# 1. 启动后台无头 fs.watch 实时守护进程 (监听全机 Agent + 提供 http://127.0.0.1:18765 SSE 大屏)
npm run daemon

# 2. (可选) 注册开机零弹窗静默自启守护 (--remove 可随时卸载)
npm run autostart

# 3. 终端打印当前全机样本与全部 6 组在线自修正数学方程快照
npm run report

# 4. 导出脱敏结构化 CSV 科研数据集至 .data/qtc_multi_agent_dataset.csv
node server/cli.mjs export
```

---

## 隐私与数据安全说明
- 本工具为 **100% 纯本地离线分析引擎**，所有日志解析与 SQLite 数据库存储均在本地 `.data/` 完成，不发起任何外部遥测或联网请求。
- `.gitignore` 已默认屏蔽 `.data/`、`*.db`、`*.sqlite` 与 `*.csv`，防止二次开发提交时误传本地会话统计数据。

## License
[MIT](./LICENSE)
