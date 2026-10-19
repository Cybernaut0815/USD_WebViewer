import { UsdViewerElement } from './viewer.ts';

export type { LocalFile } from './files.ts';
export type * from './protocol.ts';
export { type Command, History, modifySelect, type OpenOptions, type SchemeOptions, selectUpWithSubtree, type SelectionSource, type SelectMode, type UsdSessionEventMap, UsdSession, type UsdStageApi } from './session.ts';
export { SelectTool, type Tool, type TransformMode, TransformTool } from './tools.ts';
export type { OpenSource, ToolName, UsdViewerEventMap } from './viewer.ts';
export { UsdViewerElement };

if (!customElements.get('usd-viewer')) customElements.define('usd-viewer', UsdViewerElement); // a second load (Vite hot update) keeps the first

declare global {
  interface HTMLElementTagNameMap {
    'usd-viewer': UsdViewerElement;
  }
}
