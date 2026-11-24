import type { GuideNote, PitchPoint } from '../../../shared/document'

export type Issue = 'late-onset' | 'slow-slide' | 'drift'

export type NoteStatus =
  | 'ok'          // 准时；若录音截断则表示已录部分正常
  | 'issues'      // 存在起音晚 / 滑音慢 / 中途移位
  | 'off-target'  // 有演唱证据但始终未稳定到目标音
  | 'missed'      // 未检测到演唱
  | 'unreliable'  // 同音相连且听不出再次发声，无法可靠分配
  | 'incomplete'  // 录音截断，证据不足
  | 'unrecorded'  // 音不在录音范围内

export interface NoteDiagnosis {
  index: number
  note: GuideNote
  repeated: boolean      // 与前一音同高且紧接
  truncated: boolean     // 录音在该音结束前停止
  onset: number | null   // 起音时刻（歌曲秒）
  reach: number | null   // 达到目标音的时刻
  drift: number | null   // 中途移位时刻
  issues: Issue[]
  status: NoteStatus
}

export interface TakeLike {
  start: number
  end: number
  pitch: PitchPoint[]
}

// 容差（半音）
const TOL_IN = 0.5         // 入带阈值，与命中率统计一致
const TOL_OUT = 0.7        // 滞回出带阈值，抖动要越过它才改变状态
const LEVEL_BAND = 0.18    // 处于前一音水平的判定带
const STEP_MIN = 0.7       // 单帧跳变视为起音的幅度
// 时长（秒）
const REACH_DWELL = 0.08   // 达标需在带内驻留的时长
const DRIFT_SPAN = 0.22    // 离带持续至此才算移位，短于此视为装饰或滑尾
const ONSET_LATE = 0.12    // 起音偏移超过此值判为晚
const SLIDE_SLOW = 0.2     // 起音到达标超过此值判为滑音慢
const GRACE = 0.18         // 起音搜索的拍点前窗口
const REPEAT_GAP = 0.3     // 同音相邻间隔上限，超出则不按同音相连处理
const GAP_MIN = 0.08       // 无声持续至此算作一次断开
const DIP_MIN = 0.06       // 同音边界下凹持续至此算作再发声
const BOUNDARY_PRE = 0.28  // 同音边界事件搜索窗（拍点前）
const BOUNDARY_POST = 0.55 // 同音边界事件搜索窗（拍点后）
const LATENCY_MATCH = 0.1  // 与全段典型起音延迟的匹配容差
const SLOPE_MIN = 1.5      // 判定开始移动的持续斜率（半音/秒）
const SLOPE_SPAN = 0.12    // 斜率需持续的时长
const ARRIVE_WITHIN = 0.5  // 移动后需在此时间内进入目标带
const EDGE = 0.03          // 范围判定的舍入余量

interface Gap { reVoice: number | null }

/** 三点中值滤波，压掉单帧跳点；无声点不参与 */
function smoothMidi(points: readonly PitchPoint[]): (number | null)[] {
  return points.map((point, index) => {
    if (point.midi == null) return null
    const values = [point.midi]
    const before = points[index - 1]?.midi
    const after = points[index + 1]?.midi
    if (before != null) values.push(before)
    if (after != null) values.push(after)
    values.sort((a, b) => a - b)
    return values[values.length >> 1]
  })
}

/** 无声断开（持续 GAP_MIN 以上），记录再发声时刻 */
function findGaps(points: readonly PitchPoint[]): Gap[] {
  const gaps: Gap[] = []
  let from: number | null = null
  for (const point of points) {
    if (point.midi == null) {
      if (from == null) from = point.time
    } else if (from != null) {
      if (point.time - from >= GAP_MIN) gaps.push({ reVoice: point.time })
      from = null
    }
  }
  return gaps
}

export function analyzeTake(take: TakeLike, notes: readonly GuideNote[]): NoteDiagnosis[] {
  const points = [...take.pitch].sort((a, b) => a.time - b.time)
  const smoothed = smoothMidi(points)
  const gaps = findGaps(points)
  const voiceEvents: number[] = []
  if (points[0]?.midi != null) voiceEvents.push(points[0].time)
  for (const gap of gaps) if (gap.reVoice != null) voiceEvents.push(gap.reVoice)

  const repeated = notes.map((note, index) =>
    index > 0 && notes[index - 1].midi === note.midi && note.start - notes[index - 1].end <= REPEAT_GAP)

  const onsets: (number | null)[] = notes.map(() => null)
  const reaches: (number | null)[] = notes.map(() => null)
  const drifts: (number | null)[] = notes.map(() => null)

  const valueAt = (index: number) => smoothed[index]

  function prevVoicedValue(index: number): number | null {
    for (let i = index - 1; i >= 0; i--) {
      const value = valueAt(i)
      if (value != null) return value
    }
    return null
  }

  /** 达标：进入容差带并驻留 REACH_DWELL；带内抖动不越过 TOL_OUT 就不算出带 */
  function detectReach(index: number, from: number, limit: number): number | null {
    const midi = notes[index].midi
    let runStart: number | null = null
    for (let i = 0; i < points.length; i++) {
      const time = points[i].time
      if (time < from) continue
      if (time >= limit) break
      const value = valueAt(i)
      if (value == null) continue
      const distance = Math.abs(value - midi)
      if (runStart == null) {
        if (distance <= TOL_IN) runStart = time
      } else if (distance > TOL_OUT) {
        runStart = null
      } else if (time - runStart >= REACH_DWELL) {
        return runStart
      }
    }
    return null
  }

  /** 从某时刻起，音高是否在 ARRIVE_WITHIN 内进入目标带 */
  function arrives(note: GuideNote, from: number): boolean {
    const deadline = from + ARRIVE_WITHIN
    for (let i = 0; i < points.length; i++) {
      const time = points[i].time
      if (time < from) continue
      if (time > deadline) break
      const value = valueAt(i)
      if (value == null) continue
      if (Math.abs(value - note.midi) <= TOL_OUT) return true
    }
    return false
  }

  /** 从某点起，斜率是否同向持续 SLOPE_SPAN（颤音方向来回会被排除） */
  function slopePersists(index: number, direction: number): boolean {
    const start = points[index].time
    let lastTime = start
    let lastValue = valueAt(index)
    if (lastValue == null) return false
    for (let i = index + 1; i < points.length; i++) {
      const time = points[i].time
      if (time - start >= SLOPE_SPAN) return true
      const value = valueAt(i)
      if (value == null) continue
      if ((value - lastValue) / (time - lastTime) * direction < SLOPE_MIN) return false
      lastTime = time
      lastValue = value
    }
    return true
  }

  /** 起音：音高离开前一音水平、朝目标音移动的时刻（滑音起点或跳变点） */
  function movementOnset(index: number, reach: number | null): number | null {
    const note = notes[index]
    const prev = notes[index - 1]
    if (!prev || prev.midi === note.midi) return null
    if (note.start - prev.end > REPEAT_GAP + 0.05) return null
    const limit = Math.min(reach ?? note.end, take.end)
    const direction = Math.sign(note.midi - prev.midi)
    let level = false
    for (let i = 0; i < points.length; i++) {
      const time = points[i].time
      if (time < prev.start) continue
      if (time > limit) break
      const value = valueAt(i)
      if (value == null) continue
      if (Math.abs(value - prev.midi) <= LEVEL_BAND) { level = true; continue }
      if (!level) continue
      const before = prevVoicedValue(i)
      if (before != null && (value - before) * direction >= STEP_MIN && arrives(note, time)) return time
      if ((value - prev.midi) * direction > LEVEL_BAND && slopePersists(i, direction) && arrives(note, time)) return time
    }
    return null
  }

  /** 起音：无声之后的再发声时刻 */
  function voiceOnset(index: number): number | null {
    const note = notes[index]
    const lo = note.start - GRACE
    const hi = Math.min(note.end - 0.05, note.start + 0.7, take.end)
    for (const time of voiceEvents) {
      if (time >= lo && time <= hi) return time
    }
    return null
  }

  /** 起音兜底：到达目标前最后一次进入 TOL_OUT 带的时刻 */
  function approachOnset(index: number, reach: number): number {
    const note = notes[index]
    const prev = notes[index - 1]
    const lo = Math.max(note.start - GRACE, prev?.end ?? Number.NEGATIVE_INFINITY, take.start)
    let entry: number | null = null
    for (let i = 0; i < points.length; i++) {
      const time = points[i].time
      if (time < lo) continue
      if (time >= reach) break
      const value = valueAt(i)
      if (value == null) continue
      if (Math.abs(value - note.midi) > TOL_OUT) entry = null
      else if (entry == null) entry = time
    }
    return entry ?? lo
  }

  /** 中途移位：达标后离带持续 DRIFT_SPAN；音尾收束与截断未录到的部分不做判断 */
  function detectDrift(index: number, reach: number, truncated: boolean): number | null {
    const note = notes[index]
    const midi = note.midi
    const end = Math.min(note.end, take.end)
    const tailGrace = Math.min(0.3, Math.max(0.15, (note.end - note.start) * 0.35))
    const guard = truncated ? end : Math.min(end, note.end - tailGrace)
    let outStart: number | null = null
    for (let i = 0; i < points.length; i++) {
      const time = points[i].time
      if (time <= reach) continue
      if (time >= end) break
      const value = valueAt(i)
      if (value == null) continue
      const distance = Math.abs(value - midi)
      if (distance > TOL_OUT) {
        if (outStart == null) outStart = time
        if (time - outStart >= DRIFT_SPAN) return outStart <= guard ? outStart : null
      } else if (distance <= TOL_IN) {
        outStart = null
      }
    }
    return null
  }

  /** 同音边界的再发声候选：断开后再发声，或下凹后回带（事件时刻为可闻的起音点） */
  function boundaryEvents(index: number): number[] {
    const note = notes[index]
    const lo = note.start - BOUNDARY_PRE
    const hi = Math.min(note.start + BOUNDARY_POST, note.end - 0.05, take.end)
    const events: number[] = []
    for (const gap of gaps) {
      if (gap.reVoice != null && gap.reVoice >= lo && gap.reVoice <= hi) events.push(gap.reVoice)
    }
    let outStart: number | null = null
    for (let i = 0; i < points.length; i++) {
      const time = points[i].time
      if (time < lo) continue
      if (time > hi) break
      const value = valueAt(i)
      if (value == null) continue
      const distance = Math.abs(value - note.midi)
      if (outStart == null) {
        if (distance > TOL_OUT) outStart = time
      } else if (distance <= TOL_IN) {
        if (time - outStart >= DIP_MIN) events.push(outStart)
        outStart = null
      }
    }
    return events.sort((a, b) => a - b)
  }

  /**
   * 同音边界归属：一次起音事件只能归一个音。
   * 用全段典型起音延迟做证据：明显早于延迟的事件归前一音的滑尾，
   * 其余事件里离延迟最近的才归后一音（再发声）。
   */
  function attributeBoundary(index: number, latency: number): number | null {
    const events = boundaryEvents(index)
    const expected = notes[index].start + latency
    const candidates = events.filter(time => time - expected >= -LATENCY_MATCH)
    if (!candidates.length) return null
    let best = candidates[0]
    for (const time of candidates) {
      if (Math.abs(time - expected) < Math.abs(best - expected)) best = time
    }
    return best
  }

  function voicedRatio(index: number): number {
    const note = notes[index]
    const end = Math.min(note.end, take.end)
    let voiced = 0
    let total = 0
    for (let i = 0; i < points.length; i++) {
      const time = points[i].time
      if (time < note.start) continue
      if (time >= end) break
      total++
      if (valueAt(i) != null) voiced++
    }
    return total ? voiced / total : 0
  }

  const reachLimit = (index: number) => Math.min(
    notes[index].end + REACH_DWELL + 0.02,
    notes[index + 1]?.start ?? Number.POSITIVE_INFINITY,
    take.end,
  )

  // 第一遍：非同音相连的音，起音证据直接可靠
  for (let index = 0; index < notes.length; index++) {
    if (repeated[index]) continue
    const note = notes[index]
    if (note.start >= take.end - EDGE) continue
    reaches[index] = detectReach(index, note.start - GRACE, reachLimit(index))
    onsets[index] = movementOnset(index, reaches[index]) ?? voiceOnset(index)
      ?? (reaches[index] != null ? approachOnset(index, reaches[index]!) : null)
    if (reaches[index] != null) {
      drifts[index] = detectDrift(index, reaches[index]!, note.end > take.end + EDGE)
    }
  }

  // 全段典型起音延迟，作为同音边界归属的整段证据
  const latencies = onsets
    .map((onset, index) => (onset == null || repeated[index] ? null : onset - notes[index].start))
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)
  const latency = latencies.length
    ? Math.min(0.25, Math.max(-0.05, latencies[latencies.length >> 1]))
    : 0.06

  // 第二遍：同音相连的音，边界事件按整段证据决定归属
  for (let index = 0; index < notes.length; index++) {
    if (!repeated[index]) continue
    const note = notes[index]
    if (note.start >= take.end - EDGE) continue
    onsets[index] = attributeBoundary(index, latency)
    if (onsets[index] != null) {
      reaches[index] = detectReach(index, onsets[index]!, reachLimit(index))
      if (reaches[index] != null) {
        drifts[index] = detectDrift(index, reaches[index]!, note.end > take.end + EDGE)
      }
    }
  }

  return notes.map((note, index) => {
    const truncated = note.end > take.end + EDGE
    const onset = onsets[index]
    const reach = reaches[index]
    const drift = drifts[index]
    const issues: Issue[] = []
    if (onset != null && onset - note.start > ONSET_LATE) issues.push('late-onset')
    if (onset != null && reach != null && reach - onset > SLIDE_SLOW) issues.push('slow-slide')
    if (drift != null) issues.push('drift')
    let status: NoteStatus
    if (note.start >= take.end - EDGE) {
      status = 'unrecorded'
    } else if (repeated[index] && onset == null) {
      status = truncated ? 'incomplete' : voicedRatio(index) >= 0.2 ? 'unreliable' : 'missed'
    } else if (onset == null) {
      status = truncated ? 'incomplete' : voicedRatio(index) >= 0.2 ? 'off-target' : 'missed'
    } else if (reach == null) {
      status = truncated ? 'incomplete' : 'off-target'
    } else {
      status = issues.length ? 'issues' : 'ok'
    }
    return { index, note, repeated: repeated[index], truncated, onset, reach, drift, issues, status }
  })
}

export function issueLabel(issue: Issue): string {
  switch (issue) {
    case 'late-onset': return '起音晚'
    case 'slow-slide': return '滑音慢'
    case 'drift': return '中途移位'
  }
}
