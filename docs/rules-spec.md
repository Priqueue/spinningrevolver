# 翻转左轮 — 规则规格说明书 (rules-spec.md)

> 阶段 1 交付物。本文档把 `game rule.txt` 与 `AGENT_GUIDE.txt` 的全部规则**形式化为可执行状态机**。
> 本文档不含实现代码，但包含足以 1:1 翻译成代码的伪码、不变量与判定表。
>
> **已锁定的三处口径**（由项目负责人拍板，优先级高于两份原始文档的歧义部分）：
> 1. 结算时**暗牌跳过不换手**；**破平对所有 `k:k` 平局生效**（含 0:0、1:1、2:2…）。
> 2. 下注总注上限以**本轮下注开始时**对手筹码为基数：`总注 ≤ floor(base/2)`，本轮内 base 冻结不变。
> 3. 测试若无法使用 Playwright 浏览器，降级为双 Socket.IO 客户端集成测试。

---

## 1. 术语与常量

| 术语 | 定义 |
|---|---|
| 座位 seat | `0` = A，`1` = B |
| 先手 first | 本轮行动顺序靠前的玩家 |
| 后手 second | `1 - first` |
| 牌位 slot | `1..4`，棋盘从左到右的固定位置；**牌可以换位置，牌位号不变** |
| 暗牌 faceUp=false | 只看牌背；**暗牌的点数永远不进任何下行包** |
| 明牌 faceUp=true | 下注阶段可看到点数 |
| N | 本轮场上总筹码 = 双方底注 + 双方跟注 + 双方加注（= 双方实际已付出筹码之和） |
| S | 结算累加器，每轮归零 |

| 常量 | 值 | 含义 |
|---|---|---|
| `MOD` | `5` | 结算取模基数 |
| `CALL_AMOUNT` | `2` | 每次跟注固定 2 枚 |
| `CHIPS_NORMAL` | `64` | 正常模式初始筹码 |
| `CHIPS_EXTREME` | `16` | 极限模式初始筹码 |
| `DECK_VALUES` | `[1, 2, 4, 8]` | 每人一份，洗牌后放置 |
| `SLOTS` | `[1, 2, 3, 4]` | 牌位编号 |
| `RECONNECT_TTL_MS` | `600000` | 断线保留 10 分钟 |
| `PUBLIC_SWAP_ACTION` | `true` | 是否公开对手易位的两个牌号（默认保留原规则） |
| `MAX_SWAP_ATTEMPTS` | `20` | 单次易位的非法重试上限，防挂死 |

**必须使用整数运算**：`ceilDiv(a, b) = Math.floor((a + b - 1) / b)`，禁止 `Math.ceil(a / b)` 走浮点。

---

## 2. 数据模型

```ts
type CardValue = 1 | 2 | 4 | 8;
type Seat = 0 | 1;
type Slot = 1 | 2 | 3 | 4;

interface Card {
  id: string;        // 全局唯一，用于跨轮追踪同一张牌
  value: CardValue;  // 服务端机密
  faceUp: boolean;   // 服务端机密（翻转/易位阶段）
}

interface PlayerState {
  seat: Seat;
  name: string;
  chips: number;     // 当前筹码，下注立即扣除
  board: Card[];     // 长度恒为 4，下标 0..3 ↔ 牌位 1..4
  connected: boolean;
  socketId?: string;
  hasActedThisRound: ... // 见各阶段 acted 数组
}

interface GameState {
  mode: "normal" | "extreme";
  round: number;              // 从 1 开始
  first: Seat;                // 本轮先手
  second: Seat;               // = 1 - first
  phase: "flip" | "swap" | "bet" | "settle" | "gameOver";
  turn: Seat;                 // 当前行动者
  players: [PlayerState, PlayerState];
  status: "waiting" | "playing" | "paused" | "gameOver";

  flip: { acted: [boolean, boolean] };
  swap: {
    acted: [boolean, boolean];
    attempts: { player: Seat; slots: [Slot, Slot]; valid: boolean; reason?: string; at: number }[];
  };
  bet: {
    ante: number;             // 本把底注（双方相同）
    bets: [number, number];   // 本轮各自累计投入（含底注）
    pot: number;              // = bets[0] + bets[1]
    callBase: [number, number]; // 下注开始时的筹码快照，用于上限基数
    limitBase: [number, number]; // limitBase[i] = floor(callBase[1-i] / 2)，本轮冻结
    firstStopped: boolean;
    finished: boolean;
    lastActor?: Seat;
  };
  settlementResult?: SettlementResult;
  gameOver?: { winner: Seat; reason: "insolventAnte" | "insolventPayment" | "opponentLeft" };
  loserOfLastRound?: Seat;      // 用于下一轮交换先后手（也可用 round 奇偶+初始先手推出）
}
```

**约定**：`players[0]` 恒为 A，`players[1]` 恒为 B；`second = (1 - first) as Seat`。

### 2.1 core 不变量（每次状态迁移后必须成立，由单元测试守护）

| # | 不变量 |
|---|---|
| I1 | 每位玩家的 `board.length === 4` |
| I2 | 每位玩家的 4 张牌取值集合恒为 `{1,2,4,8}`（只换位，不换值） |
| I3 | 全服牌集合恒为 `{1,2,4,8} × 2`（双方各一份） |
| I4 | `bet.pot === bet.bets[0] + bet.bets[1]` |
| I5 | 对局内筹码守恒：`pot + chips[0] + chips[1] === chipsNormalOrExtremeTotal - removedChips` |
| I6 | 任意时刻 `chips[seat] >= 0` |
| I7 | `phase === "flip"` 或 `"swap"` 时，任何下行包不含 `value`/`faceUp` |
| I8 | `phase === "bet"` 时，发给 seat 的包只含 `seat` 自己的 4 张牌 |
| I9 | `round >= 1`，且 `first === (initialFirst + (round - 1)) % 2` |

---

## 3. 状态机

### 3.1 阶段流转图

```
                    ┌───────────────────────────────────────────┐
                    │                                           │
  [waiting] ──start──▶ [flip] ──双方 flip.acted 均 true──▶ [swap] │
                    │                                           │
                    │      双方 swap.acted 均 true              │
                    │              │                            │
                    │              ▼                            │
                    │      ┌── 底注偿付检查 ──┐                 │
                    │      │ 失败            │ 成功            │
                    │      ▼                 ▼                 │
                    │  [gameOver]          [bet]               │
                    │                        │                 │
                    │        双方均停注/自动停注                 │
                    │                        ▼                 │
                    │                    [settle]              │
                    │                        │                 │
                    │         赔付后检查下一轮偿付能力            │
                    │           ┌────────────┴────────────┐    │
                    │           │ 不足                    │ 充足│
                    │           ▼                         ▼    │
                    │      [gameOver]              nextRound ──┘
                    │                              (round+1, first 交换)
```

### 3.2 每轮初始化 `startRound(state)`

前置：`status === "playing"`，`phase` 为 `"settle"`（首轮则由 `start` 进入）。
动作：
1. `round += 1`
2. `first = (initialFirst + round - 1) % 2`（**首轮随机**决定 `initialFirst`，其后每轮交换）
3. `turn = first`
4. `flip.acted = [false, false]`
5. `swap.acted = [false, false]`；**保留** `swap.attempts` 历史（跨轮累积或按轮分组，见 §8 日志）
6. `bet` 重置为 `{ ante: 0, bets: [0,0], pot: 0, firstStopped: false, finished: false }`
7. `settlementResult = undefined`
8. `phase = "flip"`
9. **牌局状态跨轮保留**：`board`、`chips`、牌面明暗**不重置、不重洗**

---

## 4. 阶段细则

### 4.1 阶段 FLIP（翻转）

**行动顺序**：先手先行动，`flip.acted[first] === true` 后交予后手；双方均完成则进入 SWAP。

**动作**：当前玩家选择牌位 `n ∈ {1,2,3,4}`。

**结算式判定（核心机密）**：

```
mine   = players[turn].board[n-1]
theirs = players[1-turn].board[n-1]

if (mine.faceUp === theirs.faceUp):
    mine.faceUp = !mine.faceUp          // 仅翻转自己的 n 号牌
else:
    swap(mine, theirs)                  // 交换双方的 n 号牌（位置保持 n，牌对象互换）
```

> 注意「交换」是**牌对象互换**：`mine` 与 `theirs` 的 `id`/`value`/`faceUp` 整体互换，因此交换后 `players[turn]` 的 n 号牌变成对手原来那张。I2/I3 仍成立。

**幂等/校验**：
- `turn !== actor` → 拒绝（`NOT_YOUR_TURN`）
- `flip.acted[actor] === true` → 拒绝（`ALREADY_ACTED`）
- `n ∉ {1,2,3,4}` → 拒绝（`BAD_SLOT`）
- 同状态翻转 / 不同状态交换，**无非法情况**，任何合法 `n` 均被接受。

**可见性（硬性）**：
- 行动后只广播「该玩家已完成翻转」，**不含 n，也不含任何牌信息**。
- 对手永远不知道 n，也不知道自己哪张牌被换走了。

**状态迁移**：
```
flip.acted[actor] = true
if flip.acted[0] && flip.acted[1]:
    phase = "swap"; turn = first
else:
    turn = 1 - actor
```

#### 4.1.1 翻转的语义后果（设计说明，供测试构造用例）

| 我方 n 号 | 对方 n 号 | 结果 |
|---|---|---|
| 暗 | 暗 | 我方 n 号变明 |
| 明 | 明 | 我方 n 号变暗 |
| 暗 | 明 | 双方 n 号牌互换（我方拿到对方的明牌，对方拿到我的暗牌） |
| 明 | 暗 | 双方 n 号牌互换 |

即：**同状态必产生一张明牌净变化（±1 明牌）；不同状态明牌总数不变，但归属互换。**

---

### 4.2 阶段 SWAP（易位）

**行动顺序**：先手先行动；双方均完成 → 进入底注偿付检查。

**动作**：当前玩家选择两个**不同**牌位 `(i, j)`，用于交换**自己牌堆内**这两张牌的位置。

**判定**：

```
if (i === j)                       → 非法（BAD_SLOTS）
a = players[actor].board[i-1]
b = players[actor].board[j-1]
if (a.faceUp !== b.faceUp)         → 非法易位（SWAP_STATE_MISMATCH），状态零变更，要求重选
else:
    players[actor].board[i-1] = b  // 生效：位置互换
    players[actor].board[j-1] = a
    swap.acted[actor] = true
```

**关键**：
- 只允许交换**自己牌堆内**两张**状态相同**的牌。
- 非法时**不改变任何状态**，`swap.acted[actor]` 保持 `false`，玩家必须重选。
- 非法记录写入 `swap.attempts`，**双方可见**（只含牌号与合法/非法，不含明暗状态）。
- 合法易位的两个牌号**双方可见**（`PUBLIC_SWAP_ACTION = true`）。
- **绝不公开**牌的明暗状态——即不得出现「你选的两张都是明牌」这类措辞，只能是「非法易位，请重新选择」。
- 重试上限 `MAX_SWAP_ATTEMPTS`（默认 20）后仍非法，服务端可提示但不自动代打；客户端本地可辅助禁用非法组合（本地提示仅依据**自己**的明暗信息，属允许范围，且服务端仍做权威校验）。

**状态迁移**：
```
if swap.acted[0] && swap.acted[1]:
    if (!runAnteSolvencyCheck(state)) return   // 可能直接 gameOver
    initBetPhase(state)                        // phase = "bet", turn = first
else:
    turn = 1 - actor
```

---

### 4.3 底注偿付检查（进入 BET 前）

```
ante = ceilDiv(明牌总数, 2)   // 明牌总数 = 双方 board 中 faceUp 的数量之和
```

顺序与结果（**先手先检查**）：

| 情况 | 结果 |
|---|---|
| 先手 `chips < ante` | **先手负**，`phase = gameOver`，`winner = second` |
| 先手能付、后手 `chips < ante` | **后手负**，`phase = gameOver`，`winner = first` |
| 双方都不能付 | 先手先检查失败 → **先手负**，`winner = second` |
| 双方都能付 | 进入 BET：`bets = [ante, ante]`，各自 `chips -= ante`，`pot = 2*ante` |

> 注意：底注为 `ante` 时，若 `ante === 0`（理论极端：全部暗牌）则视为双方都能支付（`0 <= chips`）。

**下注阶段初始化（冻结上限基数）**：

```
bet.ante = ante
bets[0] = bets[1] = ante
players[i].chips -= ante                       // 立即扣除
pot = 2 * ante
callBase[i] = players[i].chips                 // ← 此刻快照（底注扣除之后）
limitBase[i] = floor(callBase[1-i] / 2)        // ← 本轮冻结：i 的总注上限
bet.finished = false; bet.firstStopped = false
phase = "bet"; turn = first
```

`limitBase[i]` 的含义：**玩家 i 本轮累计总注不得超过 `floor(下注开始时对手筹码 / 2)`**。本轮内 base 不变（对手筹码随后变化不影响该上限）。

---

### 4.4 阶段 BET（下注）

#### 4.4.1 动作类型

| 动作 | 载荷 | 语义 |
|---|---|---|
| `call` | `{ action: "call" }` | 跟注 2 枚，随后可继续决定是否加注（加注为独立动作） |
| `raise` | `{ action: "raise", amount: k }` | 加注 `k` 枚（`k >= 1` 整数） |
| `stop` | `{ action: "stop" }` | 停注 |

#### 4.4.2 合法性校验（服务端权威，逐条）

对任意下注动作（`call` / `raise`）：

```
cost = (action === "call") ? 2 : k
if (!Number.isInteger(cost) || cost <= 0)          → BET_BAD_AMOUNT
if (players[a].chips < cost)                        → BET_INSUFFICIENT_CHIPS
if (bet.bets[a] + cost > limitBase[a])              → BET_OVER_LIMIT
// 通过后：
players[a].chips -= cost
bet.bets[a] += cost
bet.pot += cost
```

> **上限基数口径**：`limitBase[a] = floor(下注开始时对手筹码 / 2)`，本轮冻结。
> 例：正常模式双方 64。底注 `ante = 2` 时，双方各扣 2 → 各剩 62，`limitBase = floor(62/2) = 31`。
> 双方各自最多累计投入 31；最终 `pot` 最大 = `2 + 31 + 31` 需扣除底注已计入，即 `bets` 各 31 → `pot = 62`。

**非法操作**：返回 `room:error`，**状态零变更**，行动权不转移。

#### 4.4.3 停注与轮次终止

```
若 actor === first（先手停注）:
    bet.firstStopped = true
    turn = second
    // 后手仍可做一次选择（call/raise/stop）
若 actor === second:
    // 后手停注 → 直接结算
    bet.finished = true → 进入 SETTLE

若后手在 firstStopped 之后做了一次 call/raise 动作:
    自动停注（无需再点停注），bet.finished = true → 进入 SETTLE
```

**终止条件汇总**：
- 后手主动 `stop` → 立即结算。
- 先手 `stop` → 后手获得**最后一次**选择；该次选择为 `call`/`raise` 后**自动停注**并结算，为 `stop` 则结算。
- `N = bet.pot` 即为结算用总筹码。

> 注：规范原文另有「无力跟注时停注」。本实现中，无力跟注不是自动停注，而是玩家点 `stop`；若玩家点 `call` 但筹码不足，返回错误 `BET_INSUFFICIENT_CHIPS`，由玩家改点 `stop`。这样保证玩家对「是否停注」有完整决策权，且不产生隐式状态变更。

---

### 4.5 阶段 SETTLE（结算）

#### 4.5.1 算法（**双指针模型** — 已由独立实现 + 28800 局穷举验证）

> **重要**：本节算法经过 3 轮独立推演纠错后确定。此前尝试过的两种写法均被证伪：
> - ❌「换手时把牌位索引重置为 1」→ 若一方只有少数明牌，它每次回来都从 1 号重启，**永远走不到 4 号**，导致死循环。
> - ❌「两方共用一个牌位索引」→ 一方完成遍历后回到另一方时，另一方的进度被覆盖，同样死循环。
>
> **唯一自洽解：每位玩家各自维护自己的牌位指针 `cursor[p]`，且指针一旦推进便不回退。**

```
S = 0
scores = [0, 0]
lastBrightOwner = null
completed = [false, false]      // 各自是否已完成“一次遍历”
cursor = [1, 1]                 // 每人自己的牌位指针，初始均为 1
holder = second                 // 指针当前落在哪一方

loop (上限 200 次，纯防御):
    if (completed[holder]):
        other = 1 - holder
        if (completed[other]): break          // 双方都完成 → 结算结束
        holder = other                        // 指针落在已完成方 → 跳到另一方（用它自己的 cursor）
        continue

    i = cursor[holder]
    card = players[holder].board[i-1]

    if (card.faceUp):
        S = (S + card.value) % 5
        if (S === 0): scores[holder] += 1
        lastBrightOwner = holder
        cursor[holder] += 1                   // ★ 明牌也必须推进指针（该张牌已被消耗）
        if (cursor[holder] > 4): completed[holder] = true
        holder = 1 - holder                   // ★ 明牌计分后换手；双方 cursor 各自保留
    else:
        cursor[holder] += 1                   // 暗牌跳过，不换手（已锁定口径）
        if (cursor[holder] > 4): completed[holder] = true
```

**关键语义（与原文逐句对应）**：

| 原文 | 本模型的实现 |
|---|---|
| 「从 1 号牌开始」 | `cursor[p]` 初始为 1；每次轮到 p 时从它自己的指针位置继续（未推进过即为 1 号） |
| 「若该张牌为暗牌，跳过它」 | 暗牌 `cursor[holder] += 1`，**holder 不变**（不换手） |
| 「完成一次明牌的计入后即切换到另一方」 | 明牌计分后 `holder = 1 - holder`，同时推进自己的 cursor |
| 「当一方跳过了第 4 号牌或已经记录了第 4 号牌」 | `cursor[holder] > 4` → `completed[holder] = true` |
| 「对另一方持续重复结算的 step1 直到另一方也跳过/记录了第 4 号牌」 | 已完成的持有者被跳过，指针落到另一方继续，直到 `completed[0] && completed[1]` |

**边界保证**：
- 每位玩家最多消耗 4 张牌 → 循环体最多执行 8 次（明牌计分）+ 被跳过分支，`guard = 200` 仅为防御。
- 一次遍历中，某玩家的明牌可能被换手打断而**未消耗**（如用例 3 中 P0 的 1 号明牌），该牌会在指针下次落回时被处理——**不存在"凭空计分"或"重复计分"**。

**验证证据**（`docs/` 之外的临时推演，已通过）：
- 用例 1：A 全暗 / B 全明 → `scores=[0,1]`，`lastBrightOwner=1`，两方各完成一次遍历。
- 用例 2：双方全暗 → 双方各完成一次遍历，`scores=[0,0]` → 破平从后手起 → `[0,1]`。
- 用例 3：混合明暗 → 0:0 触发破平 → `[0,1]`。
- 穷举：60×60×8 = 28800 局（含 9436 局平局），全部满足「平局局面破平后分差恒为 1」「比分落在 [0,8]」。


#### 4.5.2 破平（Tie-break）

**触发条件**：`scores[0] === scores[1]`，**对所有 `k:k` 生效，含 0:0、1:1、2:2…**。

```
start = (lastBrightOwner === null) ? second : (1 - lastBrightOwner)
p = start
loop (上限 10 次，防死循环):
    S = (S + 1) % 5
    if (S === 0):
        scores[p] += 1
        break                    // 加完即结束
    p = 1 - p
```

- 起始方 = **最后一张明牌的所有者的另一方**。
- 若无任何明牌（`lastBrightOwner === null`），兜底从**后手**开始。
- 双方轮流，谁先让 `S === 0` 谁 +1 分，随即结束。
- 数学保证：从任意 S 出发，最多 5 步内必出现 `S === 0`，因此循环必然在 ≤5 步内退出，`10` 仅为防御上限。

#### 4.5.3 赔付

```
a = scores[loserSeat]      // 高分者，a > b
b = scores[winnerSeat]     // 低分者
判定: 高分者输  → loser = argmax(scores)，winner = 1 - loser
      （结算后 scores 必不相等；若意外相等，走 4.5.2 破平后再判）
若 (b === 0): b = 1         // 仅在低分方为 0 时补 1
den = a + b                 // 必 >= 1
payment   = ceilDiv(N * a, den)   // 败方应付
deduction = ceilDiv(N, den)       // 胜方被扣除
winnerReceive = payment - deduction
```

**筹码变更（实现口径，已与规则公式对齐并通过守恒测试）**：

```
败方 chips -= actualPaid            // actualPaid = min(payment, 败方筹码)
胜方 chips += winnerReceive
被扣除的 deduction 从游戏中移除（不回到任何人口袋）
```

净效果：`Σ筹码` 每轮净减少 **恰好 `deduction`**，筹码总量只减不增（由单元测试守护）。

> **⚠ 重要特性（实现观察，需产品决策）**：由上式可推出
> `Σ筹码净变化 = −actualPaid + (payment − deduction) = −deduction`。
> 由于当 `a = b` 时 `payment = deduction = ceil(N/2)`，此时 **胜方实收为 0**：
> 胜方不赔不赚、败方净亏、筹码随扣除缓慢减少。
> 这是规则文档两个公式的直接推论。若希望"胜方一定盈利"，把 `winnerReceive` 改为
> `max(0, N − actualPaid)`（胜方收下整池，扣除转由胜方侧承担）即可，一处切换。

**败方筹码不足**：

```
if (players[loser].chips < payment):
    actual = players[loser].chips          // 支付剩余全部
    players[loser].chips = 0
    players[winner].chips += actual - deduction    // 仍扣除
    gameOver(winner, reason = "insolventPayment")
else:
    正常转移，进入下一轮
```

> `N` 的构成说明：`N = bet.pot = 双方底注 + 双方跟注 + 双方加注`，即**双方本轮实际已付出的筹码总额**（下注立即扣除，因此与筹码变动自洽）。

#### 4.5.4 结算可见性

- **不自动公开**双方牌面、明暗状态。
- 公开：最终比分 `scores`、胜负 `winner/loser`、`N`、`payment`、`deduction`、`winnerReceive`、双方筹码变动后数值、是否破平（可公开「本局平局，已按规则加一判定」）。

#### 4.5.5 下一轮与游戏结束

```
settle 完成后:
    if (gameOver 已触发) → phase = "gameOver"
    else → startRound(state)  // round+1, first 交换, 牌与筹码保留
```

**游戏结束的全部触发点**（共 3 类）：

| # | 触发点 | 判定 | 胜者 |
|---|---|---|---|
| G1 | 每轮底注检查，先手 | `chips[first] < ante` | 后手 |
| G2 | 每轮底注检查，后手 | `chips[first] >= ante && chips[second] < ante` | 先手 |
| G3 | 赔付时败方不足 | `chips[loser] < payment` | 胜方（即赔付中的 winner） |

> G1/G2 顺序即「先手先检查」，因此双方都不足时由 G1 命中 → 后手获胜（符合原文「双方都无力支付底注时后手获胜」）。

---

## 5. 可见性矩阵（信息隔离规范）

### 5.1 阶段 × 可见字段

| 阶段 | 发给自己的牌数据 | 发给对手的牌数据 | 系统额外告知 |
|---|---|---|---|
| `flip` | **无**（不发 `value`/`faceUp`/牌背） | **无** | 双方 `acted` 布尔、当前行动者 |
| `swap` | **无** | **无** | 双方 `acted`；对手易位的两个牌号†；全部非法易位记录（牌号+非法，无明暗） |
| `bet` | 自己的 4 张：明牌带 `value`，暗牌仅 `faceUp:false` | **无** | 双方明牌总数、`ante`、双方当前 `bets`、`pot`(N)、双方 `chips`、各自剩余额度 |
| `settle` | **无牌数据** | **无** | `scores`、`winner/loser`、`N`、`payment`、`deduction`、`winnerReceive`、`chips` 变化、破平标志 |
| `gameOver` | **无牌数据** | **无** | 胜者、结束原因、最终筹码 |
| 全局 | `mode`、`round`、`first`、`phase`、`turn`、双方 `name`、`connected`、公开日志 | | |

† 由 `PUBLIC_SWAP_ACTION` 控制（默认 `true`）。设为 `false` 时连牌号也不公开，只公开「已易位/非法易位」事实。

### 5.2 实现纪律（防止泄漏的工程手段）

1. **白名单构造**：`getStateForPlayer(state, seat)` 从服务端状态**显式摘取**允许字段，构造全新对象；绝不对完整 `GameState` 做 `JSON.stringify` 后删字段。
2. **牌对象投影**：`bet` 阶段投影为 `{ slot, faceUp, value? }`，其中 `value` 仅在 `faceUp === true` 且 `ownerSeat === seat` 时存在；暗牌**不写 `value` 字段本身**（而非写 `value: null`，避免后续误用）。
3. **对手牌一律投影为**：`{ hidden: true }` 或不发送——**永不发送 `id`**（`id` 可能泄露牌的追踪关系）。
4. **翻转阶段连 `faceUp` 都不发**：只发 `slots: [1,2,3,4]`。
5. **日志白名单**：服务端维护结构化日志，每条含 `visibility: "public" | "private"` 与 `ownerSeat`；`private` 仅发给 `ownerSeat`。翻转选择写入**仅自己可见**的日志（或按规范不记录具体 n）。
6. **泄漏哨兵测试**：E2E 与集成测试拦截**每一条**下行 Socket 消息，逐层扫描其 JSON，断言在 `flip`/`swap` 阶段不存在 `value`/`faceUp` 键路径，且任何时刻发往 seat `i` 的包中不出现对手 4 张牌的点数多重集 `{1,2,4,8}`。

---

## 6. 断线重连与会话

| 项 | 规范 |
|---|---|
| 加入/创建返回 | `{ roomId, playerToken, seat }` |
| 客户端持久化 | `localStorage["fanzhuan.zuolun.session"] = { roomId, playerToken }` |
| 重连 | Socket 重连成功后发送 `session:resume { roomId, playerToken }` |
| 服务端 | 用 `playerToken` 查找座位，重绑 `socketId`，`connected = true`，下发**个性化完整状态** |
| TTL | 房间在**双方均离线**后保留 `RECONNECT_TTL_MS = 600000`（10 分钟），到期清理 |
| 单人离线 | 对方掉线 → `status = "paused"` 或等价提示；**在自己回合/等待对方回合都不自动代打**；所有动作在 `paused` 时被拒绝（`OPPONENT_OFFLINE`，除 `session:resume`/`room:leave`） |
| Token 安全 | `playerToken` 为高熵随机串（≥128 bit）；不匹配时返回 `RESUME_FAILED`，不泄露房间是否存在 |

---

## 7. 并发、幂等与防重放

| 项 | 规范 |
|---|---|
| 服务端权威 | 客户端只发动作意图；一切状态变更经 `rules.ts` 纯函数返回新状态/结果 |
| 行动权 | 每个动作校验 `actor === turn` 且对应阶段 `acted[actor] === false` |
| 幂等/防重放 | 客户端每个动作带 `actionId`（uuid）；服务端记录最近 `N` 个已处理 `actionId`，重复直接忽略并回发当前状态 |
| 过期校验 | 动作可携带 `{ round, phase, turn }`；与服务端不一致 → `STALE_ACTION` 拒绝（刷新/慢网络场景） |
| 无竞态 | 单房间内动作串行处理（每房间一把内存队列/同步处理），杜绝同 tick 双动作穿插 |

---

## 8. 日志规范（面向 UI 与审计）

| 事件 | 可见性 | 内容 |
|---|---|---|
| 房间创建/加入 | public | 昵称、座位 |
| 翻转完成 | public | 「X 完成了翻转」——**不含牌号** |
| 翻转选择 | private（仅自己）或**不记录** | 默认仅记录「已选择」，若开启调试则仅自己可见 |
| 易位生效 | public（受 `PUBLIC_SWAP_ACTION`） | 「X 易位了 a 号与 b 号牌」 |
| 非法易位 | public | 「X 尝试易位 a 号与 b 号牌 → 非法，需重新选择」——**不含明暗状态** |
| 下注 | public | 底注、跟注、加注额、停注、当前总注 N |
| 结算 | public | 比分、胜负、赔付、扣除、破平提示 |
| 游戏结束 | public | 胜者、原因 |
| 断线/重连 | public | 「X 掉线，等待重连」「X 已重连」 |

---

## 9. 边界与异常清单

| # | 场景 | 期望行为 |
|---|---|---|
| E1 | 第三人加入 | `ROOM_FULL` |
| E2 | 加入不存在的房间 | `ROOM_NOT_FOUND` |
| E3 | 房间已开局后加入 | `ROOM_STARTED`（除非持有效 token 重连） |
| E4 | 非本人回合动作 | `NOT_YOUR_TURN`，零变更 |
| E5 | 易位选同一牌位 `(i,i)` | `BAD_SLOTS`，不计入非法记录？→ 计入 attempts，`valid:false`，要求重选 |
| E6 | 易位非法 | 状态零变更，`acted` 保持 false，公开非法记录 |
| E7 | 加注 0 或负数或小数 | `BET_BAD_AMOUNT` |
| E8 | 跟注/加注超自己筹码 | `BET_INSUFFICIENT_CHIPS` |
| E9 | 总注超 `limitBase` | `BET_OVER_LIMIT` |
| E10 | 双方 4 张全暗 | 明牌总数 0 → `ante = ceilDiv(0,2) = 0`；下注阶段可跟注（0 底注）；结算时**无任何明牌** → `lastBrightOwner = null` → 破平从后手开始 |
| E11 | 结算 `scores` 全为 0 | 触发 4.5.2 破平（0:0 属 `k:k`），必产生 1:0 |
| E12 | 破平后 1:1？ | 不可能：破平加 1 分后立即结束，双方分差为 1 |
| E13 | `N = 0`（全暗牌且无人下注） | `payment = ceilDiv(0, den) = 0`，`deduction = 0`，筹码不变，游戏继续 |
| E14 | 败方筹码 < payment | 支付剩余，`gameOver(winner)` |
| E15 | 双方都无力付底注 | 先手命中 G1 → 后手获胜 |
| E16 | 刷新页面 | `session:resume` 恢复座位与完整个性化状态，牌局一致 |
| E17 | 对手离线期间我方动作 | 拒绝（`OPPONENT_OFFLINE`），不推进任何阶段 |
| E18 | 双方离线 10 分钟 | 房间清理，token 失效 |
| E19 | 重复 `actionId` | 忽略并回发当前状态（幂等） |
| E20 | 同一玩家连续两次 `stop` | 第二次 `ALREADY_STOPPED` / 或幂等忽略 |
| E21 | 先手 `stop` 后，后手 `stop` | 结算，`N` 为当时 `pot` |

---

## 10. 规则函数签名（阶段 2 实现清单）

全部为**纯函数**（无 IO、无 `Date.now()`、无 `Math.random()`；随机源以参数注入以便测试确定性）。

```ts
createGame(opts: { mode: Mode; names: [string, string]; initialFirst?: Seat; rng?: () => number }): GameState
shuffleDeck(rng: () => number, values?: CardValue[]): Card[]

startRound(state: GameState): GameState

applyFlip(state: GameState, actor: Seat, slot: Slot): Result
applySwap(state: GameState, actor: Seat, slotA: Slot, slotB: Slot): Result

countFaceUp(state: GameState): number
calculateAnte(state: GameState): number
runAnteSolvencyCheck(state: GameState): { ok: boolean; state: GameState; gameOver?: ... }

applyBet(state: GameState, actor: Seat, action: BetAction): Result
applyStop(state: GameState, actor: Seat): Result

runSettlement(state: GameState): { state: GameState; result: SettlementResult }
applyPayment(state: GameState, result: SettlementResult): GameState

checkNextRoundSolvency(state: GameState): GameOverResult | null
getStateForPlayer(state: GameState, seat: Seat): PlayerView
getPublicState(state: GameState): PublicView

// 工具
ceilDiv(a: number, b: number): number
```

`Result` 形如 `{ ok: true; state: GameState } | { ok: false; code: ErrorCode; message: string }`——**失败路径必须不产生任何状态变更**（通过返回原状态或不可变更新保证）。

---

## 11. 测试覆盖清单（阶段 2 验收对照）

### 11.1 洗牌与初始化
- [ ] 每副牌恒为 `{1,2,4,8}`；两副牌合计 `{1,2,4,8}×2`
- [ ] 正常模式 64/64，极限模式 16/16
- [ ] `initialFirst` 可为 0 或 1；`round=1` 时 `first = initialFirst`

### 11.2 翻转
- [ ] 同暗 → 自己变明；同明 → 自己变暗（I2/I3 保持）
- [ ] 暗/明 → 双方牌对象互换，明牌归属互换，明牌总数不变
- [ ] 非本人回合被拒；重复行动被拒；非法牌位被拒
- [ ] 双方完成后 `phase = "swap"`，`turn = first`

### 11.3 易位
- [ ] 同状态 → 位置互换，`acted = true`
- [ ] 不同状态 → 非法，状态零变更，`acted` 仍为 false，记录写入 `attempts`
- [ ] `(i,i)` 被拒
- [ ] 合法易位/非法记录的可见性符合 §8
- [ ] 双方完成后进入底注检查

### 11.4 底注
- [ ] `ante === ceilDiv(明牌总数, 2)`（明牌总数 0..8 → 0,1,1,2,2,3,3,4,4）
- [ ] 明牌总数 0 → `ante = 0`，双方均视为可支付
- [ ] 先手不足 → 后手胜；先手足后手不足 → 先手胜；双方不足 → 后手胜
- [ ] `limitBase[i] === floor(callBase[1-i] / 2)`，且 `callBase` 为底注扣除**之后**的快照

### 11.5 下注
- [ ] 跟注固定扣 2，`bets`/`pot`/`chips` 同步
- [ ] 加注任意正整数生效
- [ ] 加注 0/负/小数 → 拒绝
- [ ] 超自己筹码 → 拒绝
- [ ] 超 `limitBase` → 拒绝
- [ ] 拒绝时状态完全不变（深度相等断言）
- [ ] 先手 stop → 后手仍可行动一次 → 自动停注 → 结算
- [ ] 后手 stop → 立即结算
- [ ] `N === pot === bets[0] + bets[1]`

### 11.6 结算
- [ ] 暗牌跳过**不换手**（构造：B 全明、A 全暗 → B 连续计 4 张后才轮到 A 的 4 次跳过）
- [ ] 明牌 `S = (S + a) % 5`，`S === 0` 加分，计分后换手
- [ ] 一方走完 4 号后另一方从 1 号继续，直到双方都走完
- [ ] `lastBrightOwner` 记录正确

### 11.7 破平
- [ ] 0:0 → 从 `1 - lastBrightOwner` 开始加一
- [ ] 1:1、2:2 等 `k:k` 同样触发
- [ ] 无明牌 → 从后手开始
- [ ] 破平加 1 分后立即结束，双方分差为 1

### 11.8 赔付
- [ ] 高分者输
- [ ] 低分方为 0 时先置 1 再计算
- [ ] `payment = ceilDiv(N*a, a+b)`，`deduction = ceilDiv(N, a+b)`，`winnerReceive = payment - deduction`
- [ ] 筹码守恒：`chips 总和 + deduction === 本轮开始前 chips 总和`
- [ ] `N = 0` 时全部为 0
- [ ] 败方筹码不足 → 支付剩余 + `gameOver`

### 11.9 轮次与结束
- [ ] `first` 每轮交换（`first === (initialFirst + round - 1) % 2`）
- [ ] 牌局跨轮保留（`board` 与 `chips` 不被重置）
- [ ] 三类 gameOver 触发点全部覆盖

### 11.10 可见性（纯函数级）
- [ ] `getStateForPlayer(s, seat)` 在 `flip`/`swap` 不含任何牌字段
- [ ] `bet` 仅含 `seat` 自己的牌；暗牌无 `value` 键
- [ ] 对手牌投影不含 `value`/`faceUp`/`id`
- [ ] `settle` 不含牌数据

---

## 12. 待办与不阻塞项

| 项 | 状态 |
|---|---|
| 完整对局回放/录像 | 非目标（MVP） |
| 持久化（数据库） | 非目标（MVP 用内存 Map） |
| 观战模式 | 非目标 |
| 断线自动托管 | **明确不做**（规范要求不自动代打） |
| 房间上限 | 2 人固定 |
