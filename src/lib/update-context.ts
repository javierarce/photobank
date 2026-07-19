import { createContext, useContext } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdateContextValue = {
  /** The pending update, or null when up to date / still checking. */
  update: Update | null;
  /** Whether the install dialog is currently open. */
  isDialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /**
   * Record a freshly found update (e.g. from a manual check) and open the
   * install dialog straight away — a manual check is a deliberate action.
   */
  presentUpdate: (found: Update) => void;
};

const noop = () => {};

/**
 * Safe default so components that read the context — the header badge, the
 * command palette — still render outside an <UpdateProvider />, e.g. in unit
 * tests that mount them in isolation. With no pending update these are all
 * no-ops, so nothing update-related shows.
 */
const DEFAULT: UpdateContextValue = {
  update: null,
  isDialogOpen: false,
  openDialog: noop,
  closeDialog: noop,
  presentUpdate: noop,
};

export const UpdateContext = createContext<UpdateContextValue | null>(null);

export function useUpdate(): UpdateContextValue {
  return useContext(UpdateContext) ?? DEFAULT;
}
