import { App } from "antd";
import React, { useLayoutEffect } from "react";
import { useRuntime } from "./runtime";

export const GlobalHooksBridge = () => {
    const runtime = useRuntime();
    const appHooks = App.useApp();

    useLayoutEffect(() => {
        runtime.appHooks.bind({
            message: appHooks.message,
            modal: appHooks.modal,
            notification: appHooks.notification,
        });

        return () => {
            runtime.appHooks.reset();
        };
    }, [appHooks.message, appHooks.modal, appHooks.notification, runtime]);

    return null;
};
