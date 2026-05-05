import { App, Dropdown, Flex } from "antd";
import type { MenuProps } from "antd";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGraphPaneState, useRuntime } from "../../app/runtime";
import { Hotkey, isMacos, useKeyPress } from "../../shared/misc/keys";
import { SearchBar } from "../search/search-bar";

const hotkeyMap: Record<
    string,
    "copy" | "paste" | "replace" | "insert" | "delete" | "undo" | "redo"
> = {
    [Hotkey.Copy]: "copy",
    [Hotkey.Replace]: "replace",
    [Hotkey.Paste]: "paste",
    [Hotkey.Insert]: "insert",
    [Hotkey.Enter]: "insert",
    [Hotkey.Delete]: "delete",
    [Hotkey.Backspace]: "delete",
    [Hotkey.Undo]: "undo",
    [Hotkey.Redo]: "redo",
};

const isEditableTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable ||
        Boolean(target.closest(".ant-select-dropdown")) ||
        Boolean(target.closest(".ant-picker-dropdown"))
    );
};

export const GraphPane: React.FC = () => {
    const runtime = useRuntime();
    const { message } = App.useApp();
    const { t } = useTranslation();
    const adapter = runtime.graphAdapter;
    const mountRef = useRef<HTMLDivElement | null>(null);
    const shellRef = useRef<HTMLDivElement | null>(null);
    const [searchFocusToken, setSearchFocusToken] = useState(0);
    const { selectedNode, selectedNodeRef, searchOpen, rootStableId } = useGraphPaneState();

    const structureLocked = Boolean(selectedNode?.subtreeNode || selectedNode?.data.path);
    const isRootSelected = Boolean(
        selectedNode &&
        rootStableId &&
        selectedNodeRef?.structuralStableId &&
        selectedNodeRef.structuralStableId === rootStableId
    );
    const canOpenSubtree = Boolean(
        selectedNode?.data.path || (selectedNodeRef?.subtreeStack.length ?? 0) > 0
    );

    const menuItems = useMemo<MenuProps["items"]>(() => {
        const renderItem = (label: string, shortcut?: string) => (
            <Flex justify="space-between" gap={24} style={{ minWidth: 180 }}>
                <span>{label}</span>
                <span>{shortcut ?? ""}</span>
            </Flex>
        );
        const renderCodicon = (name: string) => (
            <span
                className={`codicon codicon-${name} b3-v2-context-menu-icon`}
                aria-hidden="true"
            />
        );
        const createItem = (
            key: string,
            label: string,
            icon: React.ReactNode,
            shortcut?: string,
            disabled?: boolean
        ) => ({
            key,
            icon,
            label: renderItem(label, shortcut),
            disabled,
        });

        return [
            createItem(
                "copy",
                t("copy"),
                renderCodicon("copy"),
                isMacos ? "⌘+C" : "Ctrl+C",
                !selectedNode
            ),
            createItem(
                "paste",
                t("paste"),
                renderCodicon("files"),
                isMacos ? "⌘+V" : "Ctrl+V",
                !selectedNode || structureLocked
            ),
            createItem(
                "replace",
                t("replace"),
                renderCodicon("replace-all"),
                isMacos ? "⇧+⌘+V" : "Ctrl+Shift+V",
                !selectedNode || structureLocked
            ),
            createItem(
                "insert",
                t("insertNode"),
                renderCodicon("insert"),
                isMacos ? "⏎" : "Enter",
                !selectedNode || structureLocked
            ),
            createItem(
                "delete",
                t("deleteNode"),
                renderCodicon("trash"),
                isMacos ? "⌫" : "Delete",
                !selectedNode || selectedNode.subtreeNode || isRootSelected
            ),
            canOpenSubtree
                ? createItem("openSubtree", t("editSubtree"), renderCodicon("folder-opened"))
                : null,
            createItem(
                "saveAsSubtree",
                t("saveAsSubtree"),
                renderCodicon("save-as"),
                undefined,
                !selectedNode || structureLocked || isRootSelected
            ),
        ].filter(Boolean);
    }, [canOpenSubtree, isRootSelected, selectedNode, structureLocked, t]);

    const runMenuCommand = async (key: string) => {
        switch (key) {
            case "copy":
                await runtime.controller.copyNode();
                break;
            case "paste":
                await runtime.controller.pasteNode();
                break;
            case "replace":
                await runtime.controller.replaceNode();
                break;
            case "insert":
                await runtime.controller.insertNode();
                break;
            case "delete":
                await runtime.controller.deleteNode();
                break;
            case "openSubtree":
                await runtime.controller.openSelectedSubtree();
                break;
            case "saveAsSubtree":
                await runtime.controller.saveSelectedAsSubtree();
                break;
            default:
                break;
        }
    };

    useKeyPress([Hotkey.SearchNode, Hotkey.JumpNode], null, (event, key) => {
        if (isEditableTarget(event.target)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        setSearchFocusToken((value) => value + 1);
        void runtime.controller.openSearch(key === Hotkey.JumpNode ? "id" : "content");
    });

    useKeyPress(
        [
            Hotkey.Copy,
            Hotkey.Replace,
            Hotkey.Paste,
            Hotkey.Insert,
            Hotkey.Enter,
            Hotkey.Delete,
            Hotkey.Backspace,
            Hotkey.Undo,
            Hotkey.Redo,
        ],
        null,
        (event, key) => {
            if (isEditableTarget(event.target)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();

            const command = hotkeyMap[key];
            if (!command) {
                return;
            }

            switch (command) {
                case "copy":
                    void runtime.controller.copyNode();
                    break;
                case "paste":
                    void runtime.controller.pasteNode();
                    break;
                case "replace":
                    void runtime.controller.replaceNode();
                    break;
                case "insert":
                    void runtime.controller.insertNode();
                    break;
                case "delete":
                    void runtime.controller.deleteNode();
                    break;
                case "undo":
                    void runtime.controller.undo();
                    break;
                case "redo":
                    void runtime.controller.redo();
                    break;
                default:
                    break;
            }
        }
    );

    useKeyPress([Hotkey.Build, Hotkey.BuildDebug], null, (event, key) => {
        if (isEditableTarget(event.target)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        void runtime.controller.buildDocument({
            buildScriptDebug: key === Hotkey.BuildDebug,
        });
    });

    useEffect(() => {
        const container = mountRef.current;
        if (!container) {
            return;
        }

        void adapter.mount(container, {
            onCanvasSelected: () => void runtime.controller.selectTree(),
            onNodeSelected: (node, opts) =>
                void runtime.controller.selectNode(node.instanceKey, {
                    force: opts?.force,
                    clearVariableFocus: opts?.clearVariableFocus,
                }),
            onNodeDoubleClicked: () => void runtime.controller.openSelectedSubtree(),
            onVariableHotspotClicked: (_node, payload) =>
                void runtime.controller.focusVariable(payload.variableNames),
            onDropCommitted: async (intent) => {
                try {
                    await runtime.controller.performDrop(intent);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : String(error));
                }
            },
        });

        return () => adapter.unmount();
    }, [adapter, message, runtime.controller]);

    return (
        <div ref={shellRef} className="b3-v2-graph-shell" tabIndex={-1}>
            {searchOpen ? (
                <SearchBar
                    focusToken={searchFocusToken}
                    onClose={() => shellRef.current?.focus({ preventScroll: true })}
                />
            ) : null}
            <Dropdown
                menu={{ items: menuItems, onClick: ({ key }) => void runMenuCommand(String(key)) }}
                trigger={["contextMenu"]}
            >
                <div ref={mountRef} className="b3-v2-graph" tabIndex={-1} />
            </Dropdown>
        </div>
    );
};
