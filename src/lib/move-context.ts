import { createContext, useCallback, useContext } from "react";

type ChooseFolder = (initial: string) => Promise<string | null>;
export const MoveContext = createContext<ChooseFolder | null>(null);

export function useMoveDestination(): ChooseFolder {
  const choose = useContext(MoveContext);
  return useCallback((initial) => {
    if (!choose) return Promise.reject(new Error("Move dialog is unavailable"));
    return choose(initial);
  }, [choose]);
}

