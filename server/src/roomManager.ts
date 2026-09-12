/**
 * 房间与对局管理（内存实现，服务端权威）。
 *
 * 职责：
 *  - 房间生命周期（创建/加入/准备/开始/离开/清理）
 *  - 座位与令牌（断线重连）
 *  - 驱动规则引擎并广播**个性化**状态
 *  - 维护公开/私有日志
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  RECONNECT_TTL_MS,
  applyAction,
  advanceRound,
  createGame,
  getStateForPlayer,
  rematch as rematchGame,
  type GameAction,
  type GameState,
  type GameView,
  type LogEntry,
  type LogHint,
  type Mode,
  type PlayerBrief,
  type RoomStatePayload,
  type Seat,
} from '@zuolun/shared';
import { log } from './log';

/** 定时器句柄（与 Node / 浏览器实现均兼容） */
type TimerHandle = ReturnType<typeof setInterval>;

export interface SeatRecord {
  seat: Seat;
  name: string;
  playerToken: string;
  socketId: string | null;
  connected: boolean;
  ready: boolean;
  disconnectedAt: number | null;
}

export interface Room {
  roomId: string;
  mode: Mode;
  createdAt: number;
  /** 对局状态；未开局为 null */
  game: GameState | null;
  seats: (SeatRecord | null)[];
  logs: LogEntry[];
  nextLogId: number;
  /** 已处理的 actionId（幂等/防重放） */
  processedActions: Set<string>;
  processedOrder: string[];
  cleanupTimer: TimerHandle | null;
}

export interface SeatCredentials {
  roomId: string;
  playerToken: string;
  seat: Seat;
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: string };

const MAX_LOGS = 300;
const MAX_TRACKED_ACTIONS = 512;

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** playerToken → 房间号 */
  private tokenIndex = new Map<string, string>();

  constructor(private readonly options: { now?: () => number } = {}) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  get size(): number {
    return this.rooms.size;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId.toUpperCase());
  }

  /* ---------------- 房间生命周期 ---------------- */

  createRoom(mode: Mode, name: string): { room: Room; credentials: SeatCredentials } {
    const roomId = this.allocateRoomId();
    const room: Room = {
      roomId,
      mode,
      createdAt: this.now(),
      game: null,
      seats: [null, null],
      logs: [],
      nextLogId: 1,
      processedActions: new Set(),
      processedOrder: [],
      cleanupTimer: null,
    };
    this.rooms.set(roomId, room);
    const credentials = this.seatPlayer(room, 0, name);
    this.pushLog(room, 'public', 'room', `${name} 创建了房间 ${roomId}（${mode === 'normal' ? '正常' : '极限'}模式）`);
    log.info('room:create', { roomId, mode, name });
    return { room, credentials };
  }

  joinRoom(roomId: string, name: string): Result<{ room: Room; credentials: SeatCredentials }> {
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
    if (room.game) return { ok: false, code: 'ROOM_STARTED' };
    if (room.seats[0] && room.seats[1]) return { ok: false, code: 'ROOM_FULL' };
    const freeSeat: Seat = room.seats[0] ? 1 : 0;
    const credentials = this.seatPlayer(room, freeSeat, name);
    this.pushLog(room, 'public', 'room', `${name} 加入了房间`);
    log.info('room:join', { roomId: room.roomId, name, seat: freeSeat });
    return { ok: true, value: { room, credentials } };
  }

  /** 按 token 恢复座位（断线重连 / 刷新） */
  resume(roomId: string, playerToken: string): Result<{ room: Room; seatRecord: SeatRecord }> {
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, code: 'RESUME_FAILED' };
    const rec = room.seats.find((s) => s && s.playerToken === playerToken) ?? null;
    if (!rec) return { ok: false, code: 'RESUME_FAILED' };
    return { ok: true, value: { room, seatRecord: rec } };
  }

  findByToken(playerToken: string): { room: Room; seatRecord: SeatRecord } | null {
    const roomId = this.tokenIndex.get(playerToken);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const seatRecord = room.seats.find((s) => s && s.playerToken === playerToken) ?? null;
    if (!seatRecord) return null;
    return { room, seatRecord };
  }

  findBySocket(socketId: string): { room: Room; seatRecord: SeatRecord } | null {
    for (const room of this.rooms.values()) {
      const rec = room.seats.find((s) => s && s.socketId === socketId);
      if (rec) return { room, seatRecord: rec };
    }
    return null;
  }

  private seatPlayer(room: Room, seat: Seat, name: string): SeatCredentials {
    const playerToken = randomBytes(32).toString('base64url');
    const rec: SeatRecord = {
      seat,
      name,
      playerToken,
      socketId: null,
      connected: false,
      ready: false,
      disconnectedAt: null,
    };
    room.seats[seat] = rec;
    this.tokenIndex.set(playerToken, room.roomId);
    return { roomId: room.roomId, playerToken, seat };
  }

  private allocateRoomId(): string {
    for (let attempt = 0; attempt < 500; attempt++) {
      let id = '';
      const bytes = randomBytes(ROOM_ID_LENGTH);
      for (let i = 0; i < ROOM_ID_LENGTH; i++) {
        id += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length];
      }
      if (!this.rooms.has(id)) return id;
    }
    throw new Error('无法分配房间号');
  }

  /* ---------------- 连接与准备 ---------------- */

  bindSocket(room: Room, seat: Seat, socketId: string): { reconnected: boolean } {
    const rec = room.seats[seat]!;
    const wasConnected = rec.connected && rec.socketId !== null;
    rec.socketId = socketId;
    rec.connected = true;
    rec.disconnectedAt = null;
    this.cancelCleanup(room);
    return { reconnected: wasConnected };
  }

  markDisconnected(socketId: string): { room: Room; seatRecord: SeatRecord } | null {
    const found = this.findBySocket(socketId);
    if (!found) return null;
    const { room, seatRecord } = found;
    seatRecord.connected = false;
    seatRecord.socketId = null;
    seatRecord.disconnectedAt = this.now();
    this.scheduleCleanup(room);
    log.info('room:disconnect', { roomId: room.roomId, seat: seatRecord.seat });
    return found;
  }

  setReady(room: Room, seat: Seat, ready: boolean): void {
    const rec = room.seats[seat];
    if (rec) rec.ready = ready;
  }

  bothReady(room: Room): boolean {
    return !!(room.seats[0]?.ready && room.seats[1]?.ready);
  }

  bothPresent(room: Room): boolean {
    return !!(room.seats[0] && room.seats[1]);
  }

  startGame(room: Room, rng?: () => number): Result<GameState> {
    if (room.game) return { ok: false, code: 'ROOM_STARTED' };
    if (!this.bothPresent(room)) return { ok: false, code: 'NEED_TWO_PLAYERS' };
    if (!this.bothReady(room)) return { ok: false, code: 'NOT_READY' };
    const game = createGame({
      mode: room.mode,
      names: [room.seats[0]!.name, room.seats[1]!.name],
      rng,
    });
    room.game = game;
    this.pushLog(
      room,
      'public',
      'start',
      `对局开始：首轮先手为 ${room.seats[game.first]!.name}`,
    );
    log.info('room:start', { roomId: room.roomId, first: game.first });
    return { ok: true, value: game };
  }

  rematch(room: Room, rng?: () => number): Result<GameState> {
    if (!room.game) return { ok: false, code: 'GAME_OVER' };
    if (!this.bothPresent(room)) return { ok: false, code: 'NEED_TWO_PLAYERS' };
    const next = rematchGame(room.game, { rng });
    room.game = next;
    this.pushLog(room, 'public', 'start', '再来一局，牌局已重置');
    return { ok: true, value: next };
  }

  /* ---------------- 动作 ---------------- */

  /** 幂等：返回 false 表示该 actionId 已处理过 */
  private trackAction(room: Room, actionId: string | undefined): boolean {
    if (!actionId) return true;
    if (room.processedActions.has(actionId)) return false;
    room.processedActions.add(actionId);
    room.processedOrder.push(actionId);
    while (room.processedOrder.length > MAX_TRACKED_ACTIONS) {
      const old = room.processedOrder.shift()!;
      room.processedActions.delete(old);
    }
    return true;
  }

  applyGameAction(
    room: Room,
    seat: Seat,
    action: GameAction,
    actionId?: string,
  ): Result<{ logHints: LogHint[] }> {
    const game = room.game;
    if (!game) return { ok: false, code: 'NOT_PLAYING' };
    if (game.status === 'gameOver') return { ok: false, code: 'GAME_OVER' };
    if (!this.opponentOnline(room, seat)) return { ok: false, code: 'OPPONENT_OFFLINE' };
    if (!this.trackAction(room, actionId)) return { ok: true, value: { logHints: [] } };

    const res = applyAction(game, seat, action as never);
    if (!res.ok) return { ok: false, code: res.code };

    const state = res.state;
    room.game = state;
    this.consumeHints(room, res.logHints);

    // 结算已完成：写结算日志；若对局未结束则自动推进到下一轮
    if (state.settlementResult) {
      this.pushLog(room, 'public', 'settle', this.settlementText(state, room));
      if (state.status !== 'gameOver' && state.phase === 'settle') {
        const next = advanceRound(state);
        room.game = next;
        this.pushLog(
          room,
          'public',
          'round',
          `第 ${next.round} 轮开始，先手：${room.seats[next.first]?.name ?? '?'}`,
        );
      }
    }

    const finalState = room.game;
    if (finalState.status === 'gameOver' && finalState.gameOver) {
      this.pushLog(
        room,
        'public',
        'gameOver',
        `对局结束：${room.seats[finalState.gameOver.winner]?.name ?? '?'} 获胜（${this.reasonText(finalState.gameOver.reason)}）`,
      );
    }
    return { ok: true, value: { logHints: [] } };
  }

  private consumeHints(room: Room, hints: LogHint[]): void {
    for (const h of hints) {
      switch (h.kind) {
        case 'flipDone':
          // 不记录牌号，也不记录任何牌信息
          this.pushLog(room, 'public', 'flip', `${this.nameOf(room, h.actor)} 完成了翻转`);
          break;
        case 'swapApplied':
          this.pushLog(
            room,
            'public',
            'swap',
            `${this.nameOf(room, h.actor)} 易位了 ${h.slots[0]} 号与 ${h.slots[1]} 号牌`,
          );
          break;
        case 'swapRejected':
          this.pushLog(
            room,
            'public',
            'swap',
            `${this.nameOf(room, h.actor)} 尝试易位 ${h.slots[0]} 号与 ${h.slots[1]} 号牌 → 非法易位，需重新选择`,
          );
          break;
        case 'ante':
          this.pushLog(
            room,
            'public',
            'ante',
            `进入下注阶段：双方明牌共 ${h.faceUpTotal} 张，底注 ${h.ante} 枚`,
          );
          break;
        case 'call':
          this.pushLog(room, 'public', 'bet', `${this.nameOf(room, h.actor)} 跟注 ${h.amount}（总注 ${h.pot}）`);
          break;
        case 'raise':
          this.pushLog(room, 'public', 'bet', `${this.nameOf(room, h.actor)} 加注 ${h.amount}（总注 ${h.pot}）`);
          break;
        case 'stop':
          this.pushLog(room, 'public', 'bet', `${this.nameOf(room, h.actor)} 停注`);
          break;
        case 'settled':
          // 结算日志在 applyGameAction 中统一写入（避免重复）
          break;
        default:
          break;
      }
    }
  }

  private settlementText(state: GameState, room: Room): string {
    const r = state.settlementResult!;
    const loserName = this.nameOf(room, r.loser);
    const winnerName = this.nameOf(room, r.winner);
    const tie = r.tieBreak ? '（平局，按规则加一判定）' : '';
    return (
      `第 ${state.round} 轮结算${tie}：比分 ${r.scores[0]} : ${r.scores[1]}，` +
      `总注 ${r.pot}，${loserName} 告负支付 ${r.actualPaid}，${winnerName} 扣除 ${r.deduction} 实收 ${r.actualPaid - r.deduction}；` +
      `筹码 ${r.chipsAfter[0]} : ${r.chipsAfter[1]}`
    );
  }

  private reasonText(reason: string): string {
    if (reason === 'insolventAnte') return '无力支付底注';
    if (reason === 'insolventPayment') return '赔付时筹码不足';
    return reason;
  }

  /* ---------------- 视图与广播载荷 ---------------- */

  playerBrief(room: Room, seat: Seat): PlayerBrief {
    const rec = room.seats[seat]!;
    const chips = room.game ? room.game.players[seat].chips : room.mode === 'normal' ? 64 : 16;
    return {
      seat,
      name: rec.name,
      connected: rec.connected,
      ready: rec.ready,
      chips,
    };
  }

  gameViewFor(room: Room, seat: Seat): GameView | null {
    if (!room.game) return null;
    return getStateForPlayer(room.game, seat);
  }

  private logsFor(room: Room, seat: Seat): LogEntry[] {
    return room.logs.filter((e) => e.visibility === 'public' || e.seat === seat).slice(-120);
  }

  roomStatus(room: Room): RoomStatePayload['room']['status'] {
    if (room.game) {
      if (room.game.status === 'gameOver') return 'gameOver';
      if (!this.allOnline(room)) return 'paused';
      return 'playing';
    }
    return 'waiting';
  }

  allOnline(room: Room): boolean {
    return room.seats.every((s) => s === null || s.connected);
  }

  opponentOnline(room: Room, seat: Seat): boolean {
    const foe = room.seats[seat === 0 ? 1 : 0];
    return !!foe && foe.connected;
  }

  roomStatePayload(room: Room, seat: Seat | null): RoomStatePayload {
    return {
      room: {
        roomId: room.roomId,
        mode: room.mode,
        status: this.roomStatus(room),
        awaitingReconnect: !this.allOnline(room),
      },
      players: [0, 1].filter((s) => room.seats[s] !== null).map((s) => this.playerBrief(room, s as Seat)),
      you: seat,
      game: seat === null ? null : this.gameViewFor(room, seat),
      logs: seat === null ? room.logs.filter((e) => e.visibility === 'public').slice(-120) : this.logsFor(room, seat),
    };
  }

  /* ---------------- 日志 ---------------- */

  pushLog(room: Room, visibility: 'public' | 'private', kind: string, text: string, seat?: Seat): void {
    room.logs.push({
      id: room.nextLogId++,
      at: this.now(),
      visibility,
      seat,
      kind,
      text,
    });
    while (room.logs.length > MAX_LOGS) room.logs.shift();
  }

  private nameOf(room: Room, seat: Seat): string {
    return room.seats[seat]?.name ?? `座位${seat}`;
  }

  /* ---------------- 清理 ---------------- */

  private scheduleCleanup(room: Room): void {
    if (room.cleanupTimer) return;
    room.cleanupTimer = setInterval(() => {      const offline = room.seats.filter((s) => s && !s.connected);
      if (offline.length === 0) {
        this.cancelCleanup(room);
        return;
      }
      const now = this.now();
      const allExpired = offline.every((s) => s!.disconnectedAt !== null && now - s!.disconnectedAt! >= RECONNECT_TTL_MS);
      if (allExpired) {
        // 无人保持连接且均已超时 → 清理
        const stillConnected = room.seats.some((s) => s && s.connected);
        if (!stillConnected) {
          log.info('room:expire', { roomId: room.roomId });
          this.destroyRoom(room.roomId);
        }
      }
    }, 30_000);
    if (typeof room.cleanupTimer.unref === 'function') room.cleanupTimer.unref();
  }

  private cancelCleanup(room: Room): void {
    if (room.cleanupTimer) {
      clearInterval(room.cleanupTimer);
      room.cleanupTimer = null;
    }
  }

  destroyRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.cancelCleanup(room);
    for (const s of room.seats) {
      if (s) this.tokenIndex.delete(s.playerToken);
    }
    this.rooms.delete(roomId);
  }

  /** 手动移除某座位（主动离开） */
  leave(room: Room, seat: Seat): { roomDestroyed: boolean } {
    const rec = room.seats[seat];
    const hadBoth = this.bothPresent(room);
    if (rec) {
      this.tokenIndex.delete(rec.playerToken);
      room.seats[seat] = null;
    }
    // 若房间已开局且此前双方都在座，离开即视为该方弃权 → 对方获胜
    const g = room.game;
    if (g && hadBoth && g.status !== 'gameOver') {
      const winner = (seat === 0 ? 1 : 0) as Seat;
      g.status = 'gameOver';
      g.phase = 'gameOver';
      g.gameOver = {
        winner,
        reason: 'insolventAnte',
        chips: [g.players[0].chips, g.players[1].chips],
      };
      this.pushLog(room, 'public', 'gameOver', `${rec?.name ?? '对手'} 离开了房间，对局结束`);
    }
    if (!room.seats.some((s) => s !== null)) {
      this.destroyRoom(room.roomId);
      return { roomDestroyed: true };
    }
    return { roomDestroyed: false };
  }

  newActionId(): string {
    return randomUUID();
  }
}
