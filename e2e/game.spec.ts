import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 双客户端 E2E：两个独立浏览器上下文（互不共享 localStorage）完整走一局，
 * 并验证刷新重连、隐藏信息不泄露、非法易位可重选。
 *
 * 运行：npx playwright install chromium && npm run build && npm run e2e
 * 若无法安装浏览器，请使用 npm run test:integration（双 Socket.IO 客户端等价覆盖）。
 */

/** 收集页面收到的所有 Socket.IO 下行文本（用于泄漏扫描） */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: string[] };
    w.__frames = [];
    const OrigWS = window.WebSocket;
    // 仅记录 websocket 帧文本；socket.io 走 websocket 传输
    class Spy extends OrigWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (ev) => {
          try {
            const data = typeof ev.data === 'string' ? ev.data : '';
            if (data && w.__frames.length < 4000) w.__frames.push(data);
          } catch {
            /* ignore */
          }
        });
      }
    }
    window.WebSocket = Spy as unknown as typeof WebSocket;
  });
}

async function framesOf(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __frames: string[] }).__frames ?? []);
}

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('昵称（最长 12 字）').fill(name);
  await page.getByTestId('create-room').click();
  const code = page.getByTestId('room-code');
  await expect(code).toBeVisible();
  const roomId = (await code.textContent())?.trim() ?? '';
  expect(roomId).toMatch(/^[A-Z0-9]{4}$/);
  return roomId;
}

async function joinRoom(page: Page, name: string, roomId: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('昵称（最长 12 字）').fill(name);
  await page.getByTestId('room-id-input').fill(roomId);
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(roomId);
}

async function startGame(a: Page, b: Page): Promise<void> {
  // 双方入座后均可点开始（需要双方 ready）
  await expect(a.getByTestId('start-game')).toBeEnabled();
  await a.getByTestId('start-game').click();
  await expect(a.getByTestId('turn-indicator')).toBeVisible();
  await expect(b.getByTestId('turn-indicator')).toBeVisible();
}

/** 判断某个页面是否轮到它行动 */
async function isMyTurn(page: Page): Promise<boolean> {
  return (await page.getByTestId('turn-indicator').textContent())?.includes('轮到你了') ?? false;
}

test.describe('翻转左轮 · 双客户端联机', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let a: Page;
  let b: Page;

  test.beforeEach(async ({ browser }) => {
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    a = await ctxA.newPage();
    b = await ctxB.newPage();
    await instrument(a);
    await instrument(b);
  });

  test.afterEach(async () => {
    await ctxA.close();
    await ctxB.close();
  });

  test('创建/加入房间并完整走完一轮，隐藏信息不泄露', async () => {
    const roomId = await createRoom(a, '甲');
    await joinRoom(b, '乙', roomId);
    await startGame(a, b);

    // ---------- 翻转阶段：双方都不显示任何牌面/牌背 ----------
    for (const page of [a, b]) {
      const slots = page.locator('[data-testid^="my-slot-"]');
      await expect(slots).toHaveCount(4);
      // 盲选：不得出现 cardback / cardface
      await expect(page.locator('[data-testid^="my-slot-"] .cardback')).toHaveCount(0);
      await expect(page.locator('[data-testid^="my-slot-"] .cardface')).toHaveCount(0);
    }

    // 双方各完成翻转（选 1 号位，恒定合法）
    for (let guard = 0; guard < 2; guard++) {
      const page = (await isMyTurn(a)) ? a : b;
      await page.getByTestId('my-slot-1').click();
      await a.waitForTimeout(250);
    }

    // ---------- 易位阶段：仍不显示任何牌信息 ----------
    for (const page of [a, b]) {
      await expect(page.locator('[data-testid^="my-slot-"] .cardback')).toHaveCount(0);
      await expect(page.locator('[data-testid^="my-slot-"] .cardface')).toHaveCount(0);
    }

    // 易位：尝试全部组合直到成功（非法组合会被服务端拒绝并要求重选）
    for (const page of [a, b]) {
      for (let i = 1; i <= 4; i++) {
        for (let j = i + 1; j <= 4; j++) {
          const before = await page.getByTestId('swap-hint').textContent();
          await page.getByTestId(`my-slot-${i}`).click();
          await page.getByTestId(`my-slot-${j}`).click();
          await page.waitForTimeout(160);
          const hint = await page.getByTestId('swap-hint').textContent();
          // 成功时该玩家不再轮到自己；hint 会清空
          if (hint === before && !(await isMyTurn(page))) break;
        }
        if (!(await isMyTurn(page))) break;
      }
      await a.waitForTimeout(150);
    }

    // ---------- 下注阶段：能看到自己的牌，且总注/明牌数已公开 ----------
    await expect(a.getByTestId('faceup-total')).not.toHaveText('—');
    await expect(a.getByTestId('ante-value')).toBeVisible();
    await expect(a.getByTestId('pot-value')).toBeVisible();

    // 自己的牌区渲染 4 张（明或暗）
    const mySlots = a.locator('[data-testid^="my-slot-"]');
    await expect(mySlots).toHaveCount(4);
    const faces = await a.locator('[data-testid^="my-slot-"] .cardface').count();
    const backs = await a.locator('[data-testid^="my-slot-"] .cardback').count();
    expect(faces + backs).toBe(4);

    // 对手牌区永远是盲的（4 个空槽，无牌背/牌面）
    await expect(a.locator('[data-testid^="foe-slot-"] .cardback')).toHaveCount(0);
    await expect(a.locator('[data-testid^="foe-slot-"] .cardface')).toHaveCount(0);

    // 下注：先手停注 → 后手停注 → 结算
    const betPage = (await isMyTurn(a)) ? a : b;
    await betPage.getByTestId('bet-stop').click();
    await a.waitForTimeout(250);
    const second = betPage === a ? b : a;
    await second.getByTestId('bet-stop').click();

    // ---------- 结算：结果可见，且不自动公开牌面 ----------
    await expect(a.getByTestId('settlement')).toBeVisible();
    await expect(a.getByTestId('settlement-scores')).toBeVisible();
    await expect(a.getByTestId('settlement-verdict')).toBeVisible();
    await expect(a.locator('[data-testid^="my-slot-"] .cardface')).toHaveCount(0);

    // ---------- 泄漏扫描：翻转/易位阶段的下行帧不含任何牌字段 ----------
    for (const page of [a, b]) {
      const frames = await framesOf(page);
      const flipSwapFrames = frames.filter((f) => f.includes('"phase":"flip"') || f.includes('"phase":"swap"'));
      for (const f of flipSwapFrames) {
        expect(f).not.toContain('"cards"');
        expect(f).not.toContain('"faceUp"');
        expect(f).not.toContain('"board"');
      }
      // 任何帧都不应出现牌的内部 id
      for (const f of frames) {
        expect(f).not.toContain('"id":"A1"');
        expect(f).not.toContain('"id":"B1"');
      }
    }
  });

  test('刷新页面自动回座位，牌局状态保持一致', async () => {
    const roomId = await createRoom(a, '甲');
    await joinRoom(b, '乙', roomId);
    await startGame(a, b);

    // 甲完成一次翻转后刷新
    const first = (await isMyTurn(a)) ? a : b;
    await first.getByTestId('my-slot-2').click();
    await a.waitForTimeout(300);

    const roundBefore = await a.getByTestId('round-indicator').textContent();
    await a.reload();

    // 刷新后应自动回到房间与座位
    await expect(a.getByTestId('room-code')).toHaveText(roomId);
    await expect(a.getByTestId('round-indicator')).toBeVisible();
    await expect(a.getByTestId('round-indicator')).toHaveText(roundBefore ?? '');
  });

  test('第三人无法加入已满房间', async ({ browser }) => {
    const roomId = await createRoom(a, '甲');
    await joinRoom(b, '乙', roomId);

    const ctxC = await browser.newContext();
    const c = await ctxC.newPage();
    await c.goto('/');
    await c.getByLabel('昵称（最长 12 字）').fill('丙');
    await c.getByTestId('room-id-input').fill(roomId);
    await c.getByTestId('join-room').click();

    await expect(c.locator('.alert.error')).toContainText('房间已满');
    await ctxC.close();
  });
});
