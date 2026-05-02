import { App } from "antd";
import { setGlobalHooks } from "../shared/misc/hooks";

export const GlobalHooksBridge = () => {
    setGlobalHooks();
    return null;
};
