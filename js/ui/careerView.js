// Career UI pieces (HTML strings) used by the title, race setup, results and hangar
// screens. Styles live in css/career.css.

import { escapeHtml } from '../core/util.js';
import { MEDALS, MEDAL_TIER, loadCareer, medalTargets, rankInfo, medalOn } from '../core/career.js';

/** 83.4 -> "1:23.4" */
export function fmtTarget(sec) {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export const LOCK_ICON = '<svg class="lock-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 7V5.2a3.5 3.5 0 0 1 7 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="7" width="10" height="7.5" rx="2.2" fill="currentColor"/></svg>';

export function medalIcon(id, size = '') {
  return `<i class="medal ${size}" data-m="${id}" aria-hidden="true"></i>`;
}


/** Title screen: rank, name and progress to the next rank. */
export function rankPill(career = loadCareer()) {
  const r = rankInfo(career.xp);
  const pct = Math.round(r.progress * 100);
  const sub = r.next == null ? `${r.xp.toLocaleString()} XP · top rank` : `${r.toNext.toLocaleString()} XP to rank ${r.rank + 1}`;
  return `<span class="pilot-rank" aria-label="Pilot rank ${r.rank}, ${escapeHtml(r.name)}. ${sub}">
    <span class="rank-num">${r.rank}</span>
    <span class="rank-body"><b>${escapeHtml(r.name)}</b><span class="xp-bar"><i style="width:${pct}%"></i></span><small>${sub}</small></span>
  </span>`;
}

/** Course card: the best medal held there (nothing if none yet). */
export function courseMedal(courseId, career = loadCareer()) {
  const t = medalOn(courseId, career);
  if (!t) return '';
  const m = MEDALS[t - 1];
  return `<span class="track-medal" title="${m.label} medal">${medalIcon(m.id, 'lg')}<span class="sr">${m.label} medal</span></span>`;
}

/** Race setup: the targets for the chosen course and lap count, earned ones ticked. */
export function targetsPanel(def, laps, career = loadCareer()) {
  const held = medalOn(def.id, career);
  const rows = medalTargets(def, laps)
    .filter((t) => !t.hidden || held >= MEDAL_TIER.gold)
    .map((t) => {
      const got = held >= MEDAL_TIER[t.id];
      return `<li class="${got ? 'got' : ''}">${medalIcon(t.id)}<span>${t.label}${got ? '<i class="sr"> (earned)</i>' : ''}</span><b>${fmtTarget(t.time)}</b></li>`;
    }).join('');
  return `<div class="mt-head"><span>Medal times</span><small>${escapeHtml(def.name)} · ${laps} lap${laps > 1 ? 's' : ''}</small></div><ol class="mt-list">${rows}</ol>`;
}

/** Results: medal, XP breakdown, rank progress and anything newly unlocked. */
export function resultsPanel(award) {
  if (!award) return '';
  const { before, after } = award;
  let medal = '';
  if (award.targets) {
    const m = MEDALS.find((x) => x.id === award.medal);
    const next = award.next;
    const nextLine = next ? (next.hidden && award.medal !== 'gold' ? '' : `${next.gap.toFixed(1)} s off ${next.hidden ? 'the Starwake medal' : next.label.toLowerCase()}`) : 'The fastest medal there is';
    const fresh = award.newMedals.includes(award.medal);
    medal = m
      ? `<div class="res-medal ${fresh ? 'fresh' : ''}">${medalIcon(m.id, 'xl')}<div><b>${m.label} medal</b><small>${fresh ? 'New on this course' : 'Already earned here'}${nextLine ? ' · ' + nextLine : ''}</small></div></div>`
      : `<div class="res-medal none">${medalIcon('none', 'xl')}<div><b>No medal</b><small>${next ? `${next.gap.toFixed(1)} s off bronze` : 'Finish the race to earn one'}</small></div></div>`;
  }
  const items = award.items.map((x) => `<li><span>${escapeHtml(x.label)}</span><b>+${x.xp}</b></li>`).join('');
  const up = after.rank > before.rank;
  const from = up ? 0 : Math.round(before.progress * 100), to = Math.round(after.progress * 100);
  const unlocked = award.unlocked.length
    ? `<div class="res-unlocks"><span class="ul-head">Unlocked</span>${award.unlocked.map((u) => `<span class="ul-chip">${escapeHtml(u.label)}</span>`).join('')}<small>Find ${award.unlocked.length > 1 ? 'them' : 'it'} in the hangar</small></div>`
    : '';
  return `<div class="res-career ${medal ? '' : 'no-medal'}">
    ${medal}
    <div class="res-xp">
      <div class="xp-head"><b>+${award.total} XP</b>${up ? `<span class="rank-up">Rank up</span>` : ''}</div>
      <ul class="xp-items">${items}</ul>
      <div class="res-rank"><span class="rank-num sm">${after.rank}</span><span class="rank-body"><b>${escapeHtml(after.name)}</b><span class="xp-bar"><i style="--from:${from}%;--to:${to}%"></i></span><small>${after.next == null ? 'Top rank' : `${after.toNext.toLocaleString()} XP to rank ${after.rank + 1}`}</small></span></div>
    </div>
    ${unlocked}
  </div>`;
}

