// Timeline panel: play button, scrubber and the current time code.
import { h } from './props.ts';
import type { UsdSession } from './session.ts';

export function timeline(session: UsdSession): HTMLElement {
  const play = h('button', { title: 'Play / pause' }, '▶') as HTMLButtonElement;
  const slider = h('input', { type: 'range', step: 'any' }) as HTMLInputElement;
  const label = h('output');
  const element = h('footer', { className: 'timeline', hidden: true }, play, slider, label);

  play.addEventListener('click', () => (session.playing ? session.pause() : session.play()));
  slider.addEventListener('input', () => {
    session.pause();
    session.time = Number(slider.value);
  });
  session.addEventListener('stageopen', (e) => {
    const info = (e as CustomEvent).detail;
    element.hidden = !info.hasTimeRange;
    slider.min = String(info.startTimeCode);
    slider.max = String(info.endTimeCode);
    slider.value = String(info.startTimeCode);
    label.textContent = info.hasTimeRange ? info.startTimeCode.toFixed(1) : '';
  });
  session.addEventListener('stageclose', () => (element.hidden = true));
  session.addEventListener('timechange', (e) => {
    const time = (e as CustomEvent).detail.time;
    slider.value = String(time);
    label.textContent = Number.isNaN(time) ? '' : time.toFixed(1);
  });
  session.addEventListener('playchange', () => (play.textContent = session.playing ? '⏸' : '▶'));
  return element;
}
