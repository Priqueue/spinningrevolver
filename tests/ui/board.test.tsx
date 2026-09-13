/**
 * 组件渲染测试：牌位号的显示规则。
 *
 * 背景（真实反馈）：早期实现里「牌位号」与「牌面/牌背」会同时渲染，
 * 数字压在牌上导致看不清。现在的规则是：
 *   - 该牌位没有牌面信息（盲选阶段 / 空位）→ 只显示牌位号；
 *   - 该牌位有牌（下注阶段）→ 只显示牌面或牌背，不显示牌位号。
 * 本测试把这条规则固化，防止回归。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Board } from '@client/components/Board';
import type { Slot } from '@zuolun/shared';

function html(props: Parameters<typeof Board>[0]): string {
  return renderToStaticMarkup(createElement(Board, props));
}

/**
 * 统计某个 class 作为**完整 class 名**出现的次数。
 * 不能用 /\bcardback\b/ 这类正则：连字符是词边界，
 * class="cardback-mark" 会被误判为含 cardback。
 */
function countClass(markup: string, cls: string): number {
  let n = 0;
  for (const m of markup.matchAll(/class="([^"]*)"/g)) {
    const names = m[1].split(/\s+/).filter(Boolean);
    if (names.includes(cls)) n += 1;
  }
  return n;
}

/** 取出某个牌位容器的 HTML 片段 */
function slotBlock(markup: string, slot: number): string {
  const re = new RegExp(`data-testid="[^"]*-${slot}"[\\s\\S]*?(?=data-testid="[^"]*-${slot + 1}"|$)`);
  return markup.match(re)?.[0] ?? '';
}

describe('Board 牌位号显示规则', () => {
  it('盲选模式：4 个牌位号，且不含任何牌面/牌背', () => {
    const markup = html({ blind: true, selected: [], testId: 'my-slot' });
    expect(countClass(markup, 'slot-no')).toBe(4);
    expect(countClass(markup, 'cardface')).toBe(0);
    expect(countClass(markup, 'cardback')).toBe(0);
    // 盲选阶段不得泄露任何点数
    expect(markup.includes('faceUp')).toBe(false);
  });

  it('下注阶段：明牌只显示点数，该牌位不显示牌位号', () => {
    const markup = html({
      cards: [{ slot: 2 as Slot, faceUp: true, value: 4 }],
      selected: [],
      testId: 'my-slot',
    });
    expect(countClass(markup, 'cardface')).toBe(1);
    expect(markup).toContain('>4<');
    // 2 号位有牌面 → 该牌位不得有牌位号
    expect(countClass(slotBlock(markup, 2), 'slot-no')).toBe(0);
    // 其余 3 个空位仍显示牌位号（供玩家清点牌位）
    expect(countClass(slotBlock(markup, 1), 'slot-no')).toBe(1);
    expect(countClass(slotBlock(markup, 3), 'slot-no')).toBe(1);
    expect(countClass(slotBlock(markup, 4), 'slot-no')).toBe(1);
  });

  it('下注阶段：暗牌只显示牌背与「暗」字，该牌位不显示牌位号', () => {
    const markup = html({
      cards: [{ slot: 1 as Slot, faceUp: false }],
      selected: [],
      testId: 'my-slot',
    });
    expect(countClass(markup, 'cardback')).toBe(1);
    expect(countClass(markup, 'cardback-mark')).toBe(1);
    expect(markup).toContain('暗');
    // 1 号位是暗牌 → 该牌位既无牌位号也无点数
    expect(countClass(slotBlock(markup, 1), 'slot-no')).toBe(0);
    expect(slotBlock(markup, 1).includes('"value"')).toBe(false);
  });

  it('混合局面：有牌的 3 个牌位无牌位号，空出的 1 个牌位显示牌位号', () => {
    const markup = html({
      cards: [
        { slot: 1 as Slot, faceUp: true, value: 1 },
        { slot: 2 as Slot, faceUp: false },
        { slot: 3 as Slot, faceUp: true, value: 8 },
      ],
      selected: [],
      testId: 'my-slot',
    });
    expect(countClass(markup, 'cardface')).toBe(2);
    expect(countClass(markup, 'cardback')).toBe(1);
    // 只有 4 号位（没有牌对象）显示牌位号
    expect(countClass(markup, 'slot-no')).toBe(1);
    expect(markup).toContain('>4</div>');
  });

  it('牌位号与牌面绝不共存于同一牌位（防重叠回归）', () => {
    const markup = html({
      cards: [
        { slot: 1 as Slot, faceUp: true, value: 2 },
        { slot: 2 as Slot, faceUp: false },
        { slot: 3 as Slot, faceUp: false },
        { slot: 4 as Slot, faceUp: true, value: 8 },
      ],
      selected: [],
      testId: 'my-slot',
    });
    // 4 张牌全部有牌面/牌背 → 牌位号必须为 0
    expect(countClass(markup, 'slot-no')).toBe(0);
    expect(countClass(markup, 'cardface')).toBe(2);
    expect(countClass(markup, 'cardback')).toBe(2);
    // 逐个牌位核对：每个 slot 容器内不能同时出现 slot-no 与 cardface/cardback
    for (const slot of [1, 2, 3, 4]) {
      const block = slotBlock(markup, slot);
      const hasNo = countClass(block, 'slot-no') > 0;
      const hasCard = countClass(block, 'cardface') > 0 || countClass(block, 'cardback') > 0;
      expect(hasNo && hasCard).toBe(false);
    }
  });

  it('选中态通过 class 表达（供盲选阶段高亮）', () => {
    const markup = html({ blind: true, selected: [2 as Slot, 3 as Slot], testId: 'my-slot' });
    expect(countClass(markup, 'selected')).toBe(2);
  });
});
