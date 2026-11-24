import { describe, expect, it } from 'vitest'
import type { GuideNote, PitchPoint } from '../../../shared/document'
import { analyzeTake } from './diagnosis'

const FRAME = 0.043

/** 按分段生成音高轨迹，每段持续到下一段开始 */
function track(segments: readonly [number, number | null][], end: number): PitchPoint[] {
  const points: PitchPoint[] = []
  for (let time = segments[0][0]; time < end - 1e-6; time += FRAME) {
    let midi: number | null = null
    for (let index = segments.length - 1; index >= 0; index--) {
      if (time >= segments[index][0] - 1e-6) {
        midi = segments[index][1]
        break
      }
    }
    points.push({ time, midi })
  }
  return points
}

/** 生成一段匀速滑音的分段点 */
function slide(from: number, to: number, startMidi: number, endMidi: number): [number, number][] {
  const points: [number, number][] = []
  for (let time = from; time < to - 1e-6; time += 0.05) {
    points.push([time, startMidi + (endMidi - startMidi) * (time - from) / (to - from)])
  }
  return points
}

// 四个不同音高的练习句
const line: GuideNote[] = [
  { start: 1, end: 1.7, midi: 60 },
  { start: 1.9, end: 2.6, midi: 62 },
  { start: 2.8, end: 3.5, midi: 64 },
  { start: 3.7, end: 4.4, midi: 67 },
]

// 带连续同音的练习句（第二、三音同高且紧接）
const repeatedLine: GuideNote[] = [
  { start: 1, end: 1.6, midi: 60 },
  { start: 1.8, end: 2.4, midi: 62 },
  { start: 2.65, end: 3.25, midi: 62 },
  { start: 3.45, end: 4.05, midi: 64 },
]

describe('逐音诊断：起音与达标的区分', () => {
  it('干净的演唱：全部准时', () => {
    const pitch = track([[1, null], [1.03, 60], [1.91, 62], [2.81, 64], [3.71, 67]], 4.4)
    const result = analyzeTake({ start: 1, end: 4.4, pitch }, line)
    expect(result.map(item => item.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(result.every(item => item.issues.length === 0)).toBe(true)
  })

  it('直接唱对却来得晚：只判起音晚，不判滑音慢', () => {
    // 第二音迟了约 0.3s 才出声，但一出来就是准的
    const pitch = track([[1, null], [1.03, 60], [2.2, 62], [2.81, 64], [3.71, 67]], 4.4)
    const result = analyzeTake({ start: 1, end: 4.4, pitch }, line)
    expect(result[1].issues).toEqual(['late-onset'])
    expect(result[1].onset).toBeGreaterThan(2.1)
    expect(result[1].reach).not.toBeNull()
    expect(result[1].reach! - result[1].onset!).toBeLessThan(0.2)
  })

  it('准时起音但滑得慢：只判滑音慢，不判起音晚', () => {
    // 第二音准点开始从 60 滑向 62，0.45s 后才到
    const pitch = track([
      [1, null], [1.03, 60],
      ...slide(1.9, 2.35, 60, 62),
      [2.35, 62], [2.81, 64], [3.71, 67],
    ], 4.4)
    const result = analyzeTake({ start: 1, end: 4.4, pitch }, line)
    expect(result[1].issues).toEqual(['slow-slide'])
    expect(result[1].onset).toBeLessThan(1.9 + 0.12)
    expect(result[1].reach! - result[1].onset!).toBeGreaterThan(0.2)
  })

  it('中途拖音移位：达标后离带判移位，且不误伤下一音的起音', () => {
    // 第三音唱准后滑到 64.9 停住，第四音准点跳到 67
    const pitch = track([[1, null], [1.03, 60], [1.91, 62], [2.81, 64], [3.1, 64.9], [3.7, 67]], 4.4)
    const result = analyzeTake({ start: 1, end: 4.4, pitch }, line)
    expect(result[2].issues).toEqual(['drift'])
    expect(result[2].drift).toBeGreaterThan(3.0)
    expect(result[2].drift).toBeLessThan(3.3)
    // 前一音的跑偏平台不能当成第四音的早起音
    expect(result[3].issues).toEqual([])
    expect(result[3].onset).toBeGreaterThan(3.6)
  })

  it('整句不唱到的音标为未检测到演唱', () => {
    const pitch = track([[1, null], [1.03, 60], [1.9, null], [2.81, 64], [3.71, 67]], 4.4)
    const result = analyzeTake({ start: 1, end: 4.4, pitch }, line)
    expect(result[1].status).toBe('missed')
    expect(result[1].onset).toBeNull()
  })
})

describe('逐音诊断：抖动跨音高边界', () => {
  it('容差边缘来回抖动不产生假移位，达标只算一次', () => {
    // 第二音在 62.45 / 62.62 之间逐帧抖动（跨越 0.5 半音容差边）
    const jitter: [number, number][] = []
    let flip = false
    for (let time = 1.9; time < 2.6; time += FRAME) {
      jitter.push([time, (flip = !flip) ? 62.45 : 62.62])
    }
    const pitch = track([[1, null], [1.03, 60], ...jitter, [2.81, 64], [3.71, 67]], 4.4)
    const result = analyzeTake({ start: 1, end: 4.4, pitch }, line)
    expect(result[1].status).toBe('ok')
    expect(result[1].issues).toEqual([])
    expect(result[1].drift).toBeNull()
    expect(result[1].reach).not.toBeNull()
  })

  it('检测掉帧穿插在抖动中也不影响判定', () => {
    const jitter: [number, number | null][] = []
    let flip = false
    let count = 0
    for (let time = 1.9; time < 2.6; time += FRAME) {
      count++
      jitter.push([time, count % 6 === 0 ? null : (flip = !flip) ? 62.4 : 62.63])
    }
    const pitch = track([[1, null], [1.03, 60], ...jitter, [2.81, 64], [3.71, 67]], 4.4)
    const result = analyzeTake({ start: 1, end: 4.4, pitch }, line)
    expect(result[1].status).toBe('ok')
    expect(result[1].issues).toEqual([])
  })
})

describe('逐音诊断：连续同音的归属', () => {
  it('边界下凹是再发声：归后一音，起音时刻为下凹起点', () => {
    const pitch = track([
      [1, null], [1.02, 60], [1.82, 62],
      [2.69, 61.1], // 边界附近下凹
      [2.82, 62],
      [3.45, 64],
    ], 4.05)
    const result = analyzeTake({ start: 1, end: 4.05, pitch }, repeatedLine)
    expect(result[2].status).toBe('ok')
    expect(result[2].onset).toBeGreaterThan(2.6)
    expect(result[2].onset).toBeLessThan(2.85)
    // 同一次起音不能给两个音打勾：第二音的起音仍是它自己的跳变点
    expect(result[1].onset).toBeLessThan(2.0)
    expect(result[1].issues).toEqual([])
  })

  it('边界断开后再发声：归后一音', () => {
    const pitch = track([
      [1, null], [1.02, 60], [1.82, 62],
      [2.63, null], // 边界附近断开
      [2.73, 62],
      [3.45, 64],
    ], 4.05)
    const result = analyzeTake({ start: 1, end: 4.05, pitch }, repeatedLine)
    expect(result[2].status).toBe('ok')
    expect(result[2].onset).toBeGreaterThan(2.6)
    expect(result[2].reach).not.toBeNull()
  })

  it('直着唱过去听不出第二次发声：标为无法可靠分配', () => {
    const pitch = track([[1, null], [1.02, 60], [1.82, 62], [3.45, 64]], 4.05)
    const result = analyzeTake({ start: 1, end: 4.05, pitch }, repeatedLine)
    expect(result[2].status).toBe('unreliable')
    expect(result[2].onset).toBeNull()
    expect(result[2].reach).toBeNull()
  })

  it('拍点前的下凹是前一音的滑尾：不能给后一音打勾', () => {
    const pitch = track([
      [1, null], [1.02, 60], [1.82, 62],
      [2.3, 61.1], // 明显早于拍点的下凹，属于前一音的滑尾
      [2.45, 62],
      [3.45, 64],
    ], 4.05)
    const result = analyzeTake({ start: 1, end: 4.05, pitch }, repeatedLine)
    // 事件归前一音的滑尾，后一音没有起音证据
    expect(result[2].status).toBe('unreliable')
    expect(result[2].onset).toBeNull()
    // 滑尾不算前一音的中途移位
    expect(result[1].issues).toEqual([])
    expect(result[1].status).toBe('ok')
  })

  it('滑尾和再发声同时接近拍点：各归各的，起音只算一次', () => {
    const pitch = track([
      [1, null], [1.02, 60], [1.82, 62],
      [2.42, 61.1], // 前一音的滑尾
      [2.55, 62],
      [2.68, 61.1], // 后一同音的重新发声
      [2.78, 62],
      [3.45, 64],
    ], 4.05)
    const result = analyzeTake({ start: 1, end: 4.05, pitch }, repeatedLine)
    // 滑尾归前一音，再发声归后一音，后一音起音准时
    expect(result[2].status).toBe('ok')
    expect(result[2].onset).toBeGreaterThan(2.6)
    expect(result[2].onset).toBeLessThan(2.85)
    // 前一音的起音仍是它自己的跳变点，滑尾不算它的移位
    expect(result[1].onset).toBeLessThan(2.0)
    expect(result[1].issues).toEqual([])
    // 两个事件没有让两个音共享同一次起音
    expect(result[1].onset).not.toBe(result[2].onset)
  })

  it('明显晚于拍点的再发声：归后一音并判起音晚', () => {
    const pitch = track([
      [1, null], [1.02, 60], [1.82, 62],
      [2.95, 61.1], // 晚很多的下凹仍是再发声
      [3.08, 62],
      [3.45, 64],
    ], 4.05)
    const result = analyzeTake({ start: 1, end: 4.05, pitch }, repeatedLine)
    expect(result[2].status).toBe('issues')
    expect(result[2].issues).toContain('late-onset')
    expect(result[2].onset).toBeGreaterThan(2.85)
  })
})

describe('逐音诊断：录音缺少末尾', () => {
  it('截断的音只展示有根据的诊断，未录到的音不做判断', () => {
    // 录音在第三音中途结束
    const pitch = track([[1, null], [1.03, 60], [1.91, 62], [2.81, 64]], 3.3)
    const result = analyzeTake({ start: 1, end: 3.3, pitch }, line)
    expect(result[0].status).toBe('ok')
    expect(result[1].status).toBe('ok')
    // 第三音起音和达标都有证据，但末尾未录到
    expect(result[2].truncated).toBe(true)
    expect(result[2].status).toBe('ok')
    expect(result[2].onset).not.toBeNull()
    expect(result[2].reach).not.toBeNull()
    expect(result[2].drift).toBeNull()
    // 第四音完全没录到
    expect(result[3].status).toBe('unrecorded')
    expect(result[3].onset).toBeNull()
  })

  it('达标驻留还没完成就被截断：证据不足，不判未达目标', () => {
    // 录音在第三音刚进入容差带时结束
    const pitch = track([[1, null], [1.03, 60], [1.91, 62], [2.83, 64]], 2.85)
    const result = analyzeTake({ start: 1, end: 2.85, pitch }, line)
    expect(result[2].truncated).toBe(true)
    expect(result[2].status).toBe('incomplete')
    expect(result[2].reach).toBeNull()
    expect(result[3].status).toBe('unrecorded')
  })
})
