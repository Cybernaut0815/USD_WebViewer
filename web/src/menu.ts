// Context menus on the native popover API (top layer, no positioning library).
import { h } from './props.ts';

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

/** Shows a menu at a client-space point; it closes on choice, outside click or Escape. */
export function showMenu(host: Node, x: number, y: number, items: MenuItem[]): void {
  const menu = h('div', { className: 'popup', popover: 'manual' });
  menu.style.left = `${Math.min(x, innerWidth - 240)}px`;
  menu.style.top = `${Math.min(y, innerHeight - items.length * 28 - 8)}px`;
  const close = () => {
    menu.hidePopover();
    menu.remove();
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', escape, true);
  };
  const outside = (event: Event) => !event.composedPath().includes(menu) && close();
  const escape = (event: KeyboardEvent) => event.key === 'Escape' && close();
  for (const item of items) {
    const button = h('button', { disabled: !!item.disabled }, item.label);
    button.addEventListener('click', () => {
      close();
      item.action();
    });
    menu.append(button);
  }
  host.appendChild(menu);
  menu.showPopover();
  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', escape, true);
}

/** Puts text on the clipboard; falls back to a hidden textarea where the API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { value: text }) as HTMLTextAreaElement;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
