// Timeline panel: transport buttons, scrubber, the current frame and the stage's range.
import { h } from './props.ts';
import type { UsdSession } from './session.ts';

export function timeline(session: UsdSession): HTMLElement {
  const button = (label: string, title: string, action: () => void) => {
    const b = h('button', { title }, label) as HTMLButtonElement;
    b.addEventListener('click', action);
    return b;
  };
  const range = () => session.stage!;
  const go = (time: number) => {
    session.pause();
    const { startTimeCode, endTimeCode } = range();
    session.time = Math.min(Math.max(time, startTimeCode), endTimeCode);
  };
  const current = () => (Number.isNaN(session.time) ? range().startTimeCode : session.time);
  const play = button('▶', 'Play / pause (Space)', () => (session.playing ? session.pause() : session.play()));
  const buttons = [
    button('⏮', 'First frame', () => go(range().startTimeCode)),
    button('|◀', 'Previous frame (,)', () => go(Math.ceil(current()) - 1)),
    play,
    button('▶|', 'Next frame (.)', () => go(Math.floor(current()) + 1)),
    button('⏭', 'Last frame', () => go(range().endTimeCode)),
  ];
  const slider = h('input', { type: 'range', step: 'any' }) as HTMLInputElement;
  const frame = h('input', { type: 'number', step: '1', title: 'Current frame' }) as HTMLInputElement;
  const loop = h('input', { type: 'checkbox', checked: session.loop }) as HTMLInputElement;
  const info = h('span', { className: 'range' });
  const element = h('footer', { className: 'timeline' }, ...buttons, slider, frame, info, h('label', { title: 'Loop playback' }, loop, ' Loop'));

  slider.addEventListener('input', () => {
    session.pause();
    session.time = Number(slider.value);
  });
  frame.addEventListener('change', () => go(Number(frame.value)));
  loop.addEventListener('change', () => (session.loop = loop.checked));

  const reset = () => {
    const stage = session.stage;
    const animated = !!stage?.hasTimeRange;
    for (const control of [...buttons, slider, frame, loop]) control.disabled = !animated;
    element.classList.toggle('static', !animated);
    if (!stage || !animated) {
      info.textContent = stage ? 'No animation' : '';
      frame.value = '';
      slider.value = '0';
      return;
    }
    slider.min = frame.min = String(stage.startTimeCode);
    slider.max = frame.max = String(stage.endTimeCode);
    slider.value = frame.value = String(Number.isNaN(session.time) ? stage.startTimeCode : session.time);
    info.textContent = `${stage.startTimeCode}–${stage.endTimeCode} @ ${stage.timeCodesPerSecond} fps`;
  };
  reset();
  session.addEventListener('stageopen', reset);
  session.addEventListener('stageclose', reset);
  session.addEventListener('timechange', (e) => {
    const time = (e as CustomEvent).detail.time;
    if (Number.isNaN(time)) return;
    slider.value = String(time);
    frame.value = String(+time.toFixed(2));
  });
  session.addEventListener('playchange', () => (play.textContent = session.playing ? '⏸' : '▶'));
  return element;
}
