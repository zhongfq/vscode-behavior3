// Adapted from original: removed @electron/remote and Electron-specific imports
import _useKeyPress, { KeyFilter, KeyType, Options, Target } from "ahooks/lib/useKeyPress";
import { Key } from "ts-key-enum";

export const isMacos = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

const hotkey = (key: string) => {
    if (key.indexOf("ctrl") >= 0 && isMacos) {
        key = key.replace("ctrl", Key.Meta);
    }
    return key.toLowerCase();
};

export const useKeyPress = (
    keyFilter: KeyFilter,
    target: Target,
    eventHandler: (event: KeyboardEvent, key: KeyType) => void,
    option?: Options
) => {
    option = option || {};
    option.target = target;
    option.exactMatch = true;
    return _useKeyPress(keyFilter, (e, key) => !e.repeat && eventHandler(e, key), option);
};

export const Hotkey = {
    Backspace: Key.Backspace,
    Build: hotkey("ctrl.b"),
    BuildDebug: hotkey("shift.ctrl.b"),
    CloseEditor: hotkey("ctrl.w"),
    CloseAllOtherEditors: hotkey("ctrl.shift.w"),
    Copy: hotkey("ctrl.c"),
    Cut: hotkey("ctrl.x"),
    Delete: Key.Delete,
    Duplicate: hotkey("ctrl.d"),
    Enter: Key.Enter,
    Escape: Key.Escape,
    F2: Key.F2,
    Insert: Key.Insert,
    JumpNode: hotkey("ctrl.g"),
    MacDelete: isMacos ? hotkey("ctrl.backspace") : "",
    Paste: hotkey("ctrl.v"),
    Redo: isMacos ? hotkey("shift.ctrl.z") : hotkey("ctrl.y"),
    Replace: hotkey("shift.ctrl.v"),
    Save: hotkey("ctrl.s"),
    SearchTree: hotkey("ctrl.p"),
    SearchNode: hotkey("ctrl.f"),
    SelectAll: hotkey("ctrl.a"),
    Undo: hotkey("ctrl.z"),
};
