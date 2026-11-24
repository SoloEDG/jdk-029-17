<script setup lang="ts">
import { AudioLines, Crosshair, GitCompareArrows, Headphones, Play, Square } from '@lucide/vue'
import { computed } from 'vue'
import type { GuideNote, LyricLine, Take } from '../../../shared/document'
import { noteName } from '../../../shared/music'
import { clockLabel } from '../../../shared/time'
import { issueLabel, type NoteDiagnosis } from '../lib/diagnosis'
import { accuracy } from '../lib/summary'

const props = defineProps<{
  takes: Take[]; slots: (Take | undefined)[]; activeId: string | null; selected: LyricLine | null
  notes: GuideNote[]; issue: string; diagnosis: NoteDiagnosis[]; diagnosedId: string | null
}>()
const emit = defineEmits<{
  listen: [Take]; choose: [0 | 1, string]; diagnose: [Take]; listenFrom: [Take, number]
}>()
const slotIndices = [0, 1] as const
const diagnosedTake = computed(() => props.takes.find(take => take.id === props.diagnosedId) ?? null)

function chip(item: NoteDiagnosis) {
  switch (item.status) {
    case 'ok': return item.truncated ? '已录部分正常' : '准时'
    case 'issues': return item.issues.map(issueLabel).join(' · ')
    case 'off-target': return '未稳定到目标音'
    case 'missed': return '未检测到演唱'
    case 'unreliable': return '无法可靠分配'
    case 'incomplete': return '录音截断，证据不足'
    case 'unrecorded': return '未录到'
  }
}

function hasMoments(item: NoteDiagnosis) {
  return item.onset != null || item.reach != null || item.drift != null
}

function lateBy(item: NoteDiagnosis) {
  return item.onset == null ? 0 : Math.max(0, item.onset - item.note.start)
}

function slideFor(item: NoteDiagnosis) {
  return item.onset == null || item.reach == null ? 0 : item.reach - item.onset
}
</script>

<template>
  <section class="review" aria-labelledby="review-title">
    <h2 class="rail-title" id="review-title"><Headphones :size="17" /> 练习回顾 <span class="mono">{{ takes.length }}</span></h2>
    <div class="review-line">{{ selected?.text ?? '未选择练习句' }}</div>
    <div v-if="!takes.length" class="empty-takes"><AudioLines :size="23" /><span>本句暂无录音</span></div>
    <ol v-else class="take-list">
      <li v-for="(take, index) in takes" :key="take.id">
        <button class="icon-button listen-button" :aria-label="`${activeId === take.id ? '停止' : '播放'}录音 ${takes.length - index}`"
          @click="emit('listen', take)">
          <Square v-if="activeId === take.id" :size="13" fill="currentColor" /><Play v-else :size="13" fill="currentColor" />
        </button>
        <div class="take-info"><strong>录音 {{ takes.length - index }}</strong>
          <small class="mono">{{ clockLabel(take.start, true) }}–{{ clockLabel(take.end, true) }}</small></div>
        <span class="mono take-score" title="检测到的音高中命中参考音的占比">{{ accuracy(take, notes) ?? '—' }}<template v-if="accuracy(take, notes) !== null">%</template></span>
        <button class="icon-button diag-toggle" :class="{ on: diagnosedId === take.id }"
          :aria-pressed="diagnosedId === take.id" title="逐音诊断"
          :aria-label="`${diagnosedId === take.id ? '关闭' : '查看'}录音 ${takes.length - index} 的逐音诊断`"
          @click="emit('diagnose', take)">
          <Crosshair :size="13" />
        </button>
      </li>
    </ol>
    <div v-if="diagnosedTake && diagnosis.length" class="diagnosis">
      <p><Crosshair :size="16" /> 逐音诊断</p>
      <ol>
        <li v-for="item in diagnosis" :key="item.index" :class="`diag-${item.status}`">
          <div class="diag-row">
            <strong>{{ noteName(item.note.midi) }}</strong>
            <span class="mono diag-time">{{ clockLabel(item.note.start, true) }}</span>
            <span class="diag-chip">{{ chip(item) }}</span>
            <span v-if="item.truncated && item.status !== 'incomplete'" class="diag-tag">截断</span>
          </div>
          <div v-if="item.status === 'unreliable'" class="diag-hint">同音相连，听不出再次发声</div>
          <div v-if="hasMoments(item) && diagnosedTake" class="diag-moments">
            <template v-if="item.onset != null">
              <button type="button" :aria-label="`从 ${noteName(item.note.midi)} 起音时刻复听`"
                @click="emit('listenFrom', diagnosedTake, item.onset!)">
                起音 {{ clockLabel(item.onset!, true) }}<Play :size="9" fill="currentColor" />
              </button>
              <small v-if="item.issues.includes('late-onset')">晚 {{ lateBy(item).toFixed(2) }}s</small>
            </template>
            <template v-if="item.reach != null">
              <button type="button" :aria-label="`从 ${noteName(item.note.midi)} 达标时刻复听`"
                @click="emit('listenFrom', diagnosedTake, item.reach!)">
                达标 {{ clockLabel(item.reach!, true) }}<Play :size="9" fill="currentColor" />
              </button>
              <small v-if="item.issues.includes('slow-slide')">滑 {{ slideFor(item).toFixed(2) }}s</small>
            </template>
            <button v-if="item.drift != null" type="button" :aria-label="`从 ${noteName(item.note.midi)} 移位时刻复听`"
              @click="emit('listenFrom', diagnosedTake, item.drift!)">
              移位 {{ clockLabel(item.drift!, true) }}<Play :size="9" fill="currentColor" />
            </button>
          </div>
        </li>
      </ol>
    </div>
    <div v-if="takes.length" class="compare-tools">
      <p><GitCompareArrows :size="16" /> 音高对比</p>
      <label v-for="slot in slotIndices" :key="slot"><span :class="slot === 0 ? 'slot-a' : 'slot-b'">{{ slot === 0 ? 'A' : 'B' }}</span>
        <select :aria-label="slot === 0 ? '对比录音 A' : '对比录音 B'" :value="slots[slot]?.id ?? ''"
          @change="emit('choose', slot, ($event.target as HTMLSelectElement).value)">
          <option value="">未选择</option>
          <option v-for="(take, index) in takes" :key="take.id" :value="take.id">录音 {{ takes.length - index }}</option>
        </select>
      </label>
    </div>
    <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
  </section>
</template>
