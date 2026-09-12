# 翻转左轮 · 联机对局服务

2 人房间制的浏览器回合制棋牌游戏。**服务端权威**，翻转/易位阶段不传输任何牌信息，支持断线重连。

- 规则规格：`docs/rules-spec.md`
- 规则引擎：`shared/src/rules.ts`（零依赖纯函数，99 项单元测试覆盖）
- 联机服务：`server/`（Express + Socket.IO，单进程同时托管前端）
- 前端：`client/`（Vite + React + TypeScript）

---

## 1. 快速开始

```bash
# 安装依赖（Node 20+；Windows 上若 npm.ps1 被执行策略拦截，请用 npm.cmd）
npm install

# 跑单元测试（规则引擎）
npm test

# 开发模式（服务端 3000 + 前端 5173，Vite 已配置代理）
npm run dev
# 浏览器打开 http://localhost:5173
```

一名玩家点「创建房间」得到 4 位房间号，另一名玩家输入房间号加入，双方点「我准备好了」后由任一方点「开始对局」。

## 2. 生产构建与运行

```bash
npm run build     # 产出 shared/dist、client/dist、server/dist/index.cjs
npm start         # 单进程同时托管前端与 Socket.IO，默认端口 3000
# 打开 http://localhost:3000
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `NODE_ENV` | `development` | `production` 时托管 `client/dist` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `CLIENT_DIR` | `<cwd>/client/dist` | 自定义前端构建目录 |

健康检查：`GET /healthz` → `{ ok, uptime, rooms, env, version }`
房间查询：`GET /api/room/:roomId`

## 3. 测试

```bash
npm test                 # Vitest：规则引擎 99 项（含结算/破平/赔付/下注上限/隐藏信息）
npm run test:integration # 双 Socket.IO 客户端联机测试（36 项，需要服务已启动）
npm run typecheck        # shared / server / client 全量类型检查
npm run verify           # 依次执行 test → build → test:integration
```

### E2E（Playwright 双浏览器上下文）

```bash
npm run e2e:install      # 下载 Chromium（需要能访问 Playwright CDN）
npm run e2e
```

> **当前环境说明**：本机 `playwright install chromium` 因 CDN 下载超时未完成，
> 因此 E2E 规格已就绪但未在本机实际执行。按计划中的降级方案，
> 联机与隐藏信息的等价覆盖由 `npm run test:integration` 承担（35+ 项断言，
> 包含协议级泄漏扫描与断线重连）。网络可用时直接 `npm run e2e:install && npm run e2e` 即可补齐浏览器端验证。

## 4. 部署（Render / Railway / Fly.io）

单 Node 服务即可，无需数据库（房间在内存中）。

**Render**（仓库已含 `render.yaml`）：

1. 新建 Blueprint，指向本仓库；或手动创建 Web Service。
2. Build Command：`npm install && npm run build`
3. Start Command：`npm start`
4. 环境变量：`NODE_ENV=production`（`PORT` 由平台注入）
5. 健康检查路径：`/healthz`

**Railway / Fly.io**：同样的 build/start 命令。平台需支持 WebSocket（三者均支持）。
不建议用 Vercel/Netlify 的 Serverless 方案托管 Socket.IO。

> 免费实例可能休眠，首次连接会慢几秒。

## 5. 联机协议（摘要）

客户端 → 服务端：`room:create` `room:join` `room:ready` `room:start` `room:leave`
`game:action` `session:resume` `game:rematch`

服务端 → 客户端：`room:state` `room:error` `player:connected` `player:disconnected`
`game:settled` `game:over` `log:append` `session:bound`

`game:action` 载荷：

```ts
{ action: { type: 'flip', slot: 1|2|3|4 }, actionId?: string }
{ action: { type: 'swap', slots: [1|2|3|4, 1|2|3|4] }, actionId?: string }
{ action: { type: 'bet', action: 'call' | 'raise' | 'stop', amount?: number }, actionId?: string }
```

### 可见性规则（硬性）

| 阶段 | 自己可见 | 对手可见 | 系统额外告知 |
|---|---|---|---|
| 翻转 | 无任何牌信息 | 无 | 无（对手选择的牌位也不公开） |
| 易位 | 无任何牌信息 | 无 | 对手易位的两个牌号、全部非法易位记录（不含明暗状态） |
| 下注 | 自己的牌（明牌显示点数，暗牌只看牌背） | 无 | 双方明牌总数、底注、双方投注、总注 N |
| 结算 | 结果 | 结果 | 比分、胜负、赔付、扣除（不自动公开牌面） |

实现方式是**白名单投影**（`shared/src/view.ts` 的 `getStateForPlayer`），
而不是"序列化后删字段"；`shared` 内的牌对象从不整体下发，`id` 字段永不出网。

## 6. 断线重连

- 创建/加入时返回 `{ roomId, playerToken, seat }`，前端存入 `localStorage`。
- 刷新或断网后 Socket 自动重连，并自动发送 `session:resume` 恢复座位与完整状态。
- 房间在双方都离线后保留 **10 分钟**，期间对手掉线则对局暂停、**不自动代打**。
- 对手离线时任何动作都会被拒绝（`OPPONENT_OFFLINE`）。

## 7. 项目结构

```
D:\game
├─ shared/src/         规则引擎（types / constants / rules / view / protocol）
├─ server/src/         Express + Socket.IO（index / roomManager / socketHandlers / log）
├─ client/src/         React 前端（pages / components / store / socket）
├─ tests/              Vitest 单元测试（6 个文件 / 99 项）
├─ scripts/            双客户端 Socket.IO 集成测试
├─ e2e/                Playwright 双浏览器 E2E
├─ docs/rules-spec.md  规则规格说明书（状态机、伪码、不变量、边界清单）
├─ render.yaml         一键部署配置
└─ playwright.config.ts
```

## 8. 已知口径与待确认项

实现中有一处**规则文档自相矛盾**的地方，已按文档字面实现并在此标注（详见 `docs/rules-spec.md` §4.5.3）：

> 文档规定「败方支付 `ceil(N·a/(a+b))`」「胜方扣除 `ceil(N/(a+b))`」「胜方实收 = 支付 − 扣除」。
> 当 `a = b` 时两个公式都等于 `ceil(N/2)`，于是**胜方实收为 0**：胜方不赔不赚、败方净亏，
> 筹码随扣除缓慢减少（每轮净减少 `deduction`）。
>
> 这是文档公式的直接推论，已按字面实现。若希望"胜方一定盈利"，
> 在 `shared/src/rules.ts` 的 `settleRound` 中把 `winnerReceive` 改为
> `Math.max(0, N - actualPaid)` 即可（胜方收下整池，扣除由胜方侧承担），一处切换。
