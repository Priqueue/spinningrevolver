import type { CardValue, Slot } from '@zuolun/shared';

interface BoardProps {
  /** bet 阶段：自己 4 张牌（明牌带点数，暗牌只有牌背） */
  cards?: { slot: Slot; faceUp: boolean; value?: CardValue }[];
  /** 是否可点击选择 */
  selectable?: boolean;
  /** 已选中的牌位（翻转选 1 个；易位选 2 个） */
  selected: Slot[];
  onPick?: (slot: Slot) => void;
  /** 盲选模式（翻转/易位阶段）：只显示牌位号，不显示任何牌信息 */
  blind?: boolean;
  /** 顶部说明 */
  title?: string;
  /** data-testid 前缀，便于 E2E 定位 */
  testId?: string;
}

/**
 * 牌桌棋盘。
 *
 * 隐藏信息规则（硬性）：
 *  - blind = true（翻转/易位阶段）：只渲染牌位号 1~4，不渲染任何牌背或牌面。
 *  - blind = false（下注阶段）：仅渲染**自己**的牌；明牌显示点数，暗牌显示牌背。
 */
export function Board({ cards, selectable = false, selected, onPick, blind = false, title, testId }: BoardProps) {
  const slots: Slot[] = [1, 2, 3, 4];
  const byslot = new Map<number, { faceUp: boolean; value?: CardValue }>();
  if (!blind && cards) {
    for (const c of cards) byslot.set(c.slot, { faceUp: c.faceUp, value: c.value });
  }

  return (
    <div>
      {title && <h3>{title}</h3>}
      <div className="board">
        {slots.map((slot) => {
          const info = byslot.get(slot);
          const isSelected = selected.includes(slot);
          const cls = [
            'slot',
            selectable ? 'selectable' : 'static',
            isSelected ? 'selected' : '',
            info ? 'revealed' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <div
              key={slot}
              className={cls}
              data-testid={`${testId ?? 'slot'}-${slot}`}
              data-slot={slot}
              data-face={info ? (info.faceUp ? 'up' : 'down') : blind ? 'blind' : 'empty'}
              onClick={selectable && onPick ? () => onPick(slot) : undefined}
              role={selectable ? 'button' : undefined}
              aria-label={`${slot} 号牌位`}
            >
              {info && info.faceUp && (
                <div className="cardface" data-testid={`${testId ?? 'slot'}-${slot}-face`}>
                  {info.value}
                </div>
              )}
              {info && !info.faceUp && (
                <div className="cardback" data-testid={`${testId ?? 'slot'}-${slot}-back`}>
                  <span className="cardback-mark">暗</span>
                </div>
              )}
              {/*
                牌位号只在「该牌位没有牌面信息」时显示（盲选阶段与空位）。
                翻牌/下注阶段若同时显示牌位号与牌面，数字会压在牌上导致看不清。
              */}
              {!info && <div className="slot-no">{slot}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
