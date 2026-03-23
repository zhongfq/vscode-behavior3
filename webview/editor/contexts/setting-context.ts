/**
 * Simplified setting context for the webview.
 * Replaces the Electron-based setting-context.ts.
 * Only keeps the node layout preference (stored in localStorage).
 */
import { create } from "zustand";
import { NodeLayout } from "../../shared/misc/b3type";

const LAYOUT_KEY = "b3.nodeLayout";

export type SettingStore = {
  data: {
    layout: NodeLayout;
  };
  setLayout: (layout: NodeLayout) => void;
};

export const useSetting = create<SettingStore>((set) => ({
  data: {
    layout: (localStorage.getItem(LAYOUT_KEY) as NodeLayout) ?? "normal",
  },
  setLayout: (layout) => {
    localStorage.setItem(LAYOUT_KEY, layout);
    set({ data: { layout } });
  },
}));
