import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { LyricLine, Song, Take } from '../../../shared/document'
import { readTakes, writeTake } from '../lib/archive'
import { analyzeTake } from '../lib/diagnosis'

export function useReview(song: Ref<Song>, line: Ref<LyricLine | null>, beforeListen: () => void) {
  const takes = shallowRef<Take[]>([])
  const ids = ref<[string | null, string | null]>([null, null])
  const diagnosedId = ref<string | null>(null)
  const playingId = ref<string | null>(null)
  const position = ref<number | null>(null)
  const issue = ref('')
  const player = new Audio()
  let source: string | null = null
  let current: Take | undefined
  let frame = 0
  const visible = computed(() => takes.value.filter(take => take.songId === song.value.id && take.lineId === line.value?.id))
  const slots = computed(() => ids.value.map(id => visible.value.find(take => take.id === id)))
  const diagnosed = computed(() => visible.value.find(take => take.id === diagnosedId.value) ?? null)
  const diagnosis = computed(() => {
    const take = diagnosed.value
    const currentLine = line.value
    if (!take || !currentLine) return []
    const notes = song.value.notes.filter(note => note.end > currentLine.start && note.start < currentLine.end)
    return analyzeTake(take, notes)
  })

  function stop() {
    player.pause()
    cancelAnimationFrame(frame)
    if (source) {
      player.removeAttribute('src')
      player.load()
      URL.revokeObjectURL(source)
      source = null
    }
    current = undefined
    playingId.value = null
    position.value = null
  }

  function tick() {
    if (!current || player.paused) return
    position.value = Math.min(current.end, current.start + player.currentTime)
    frame = requestAnimationFrame(tick)
  }

  async function play(take: Take, offset: number) {
    beforeListen()
    issue.value = ''
    current = take
    playingId.value = take.id
    position.value = take.start + offset
    source = URL.createObjectURL(take.audio)
    const ownUrl = source
    player.src = source
    try {
      if (player.readyState === 0) {
        const loaded = await new Promise<boolean>(resolve => {
          const done = (ok: boolean) => {
            player.removeEventListener('loadedmetadata', onLoad)
            player.removeEventListener('error', onError)
            resolve(ok)
          }
          const onLoad = () => done(true)
          const onError = () => done(false)
          player.addEventListener('loadedmetadata', onLoad)
          player.addEventListener('error', onError)
        })
        if (source !== ownUrl) return
        if (!loaded) throw new Error('无法读取录音')
      }
      player.currentTime = offset
      await player.play()
      if (source === ownUrl) tick()
    } catch {
      if (source !== ownUrl) return
      stop()
      issue.value = '无法播放这条录音。'
    }
  }

  async function listen(take: Take) {
    const replay = playingId.value !== take.id
    stop()
    if (!replay) return
    await play(take, 0)
  }

  /** 从某个诊断时刻复听，提前一点开始以便听清起音 */
  async function listenFrom(take: Take, time: number) {
    stop()
    const span = take.end - take.start
    const offset = Math.max(0, Math.min(time - 0.25 - take.start, Math.max(0, span - 0.05)))
    await play(take, offset)
  }

  function choose(slot: 0 | 1, id: string) {
    const next = [...ids.value] as typeof ids.value
    const peer = slot === 0 ? 1 : 0
    if (id && next[peer] === id) next[peer] = null
    next[slot] = id || null
    ids.value = next
  }

  function diagnose(take: Take) {
    diagnosedId.value = diagnosedId.value === take.id ? null : take.id
  }

  watch([() => song.value.id, () => line.value?.id], () => { stop(); ids.value = [null, null]; diagnosedId.value = null })

  async function save(take: Take) {
    await writeTake(take)
    takes.value = [take, ...takes.value.filter(item => item.id !== take.id)]
    if (visible.value.some(item => item.id === take.id)) {
      diagnosedId.value = take.id
      if (!ids.value[0]) choose(0, take.id)
      else if (!ids.value[1]) choose(1, take.id)
    }
  }

  onMounted(async () => {
    try {
      const stored = await readTakes()
      const known = new Set(takes.value.map(take => take.id))
      takes.value = [...takes.value, ...stored.filter(take => !known.has(take.id))].sort((a, b) => b.createdAt - a.createdAt)
    } catch {
      issue.value = '无法读取本机练习记录。'
    }
  })
  player.addEventListener('ended', stop)
  onBeforeUnmount(() => { player.removeEventListener('ended', stop); stop() })
  return { visible, slots, playingId, position, issue, diagnosedId, diagnosed, diagnosis, save, choose, diagnose, listen, listenFrom, stop }
}
