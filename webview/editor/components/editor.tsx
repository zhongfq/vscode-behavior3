// Adapted from original editor.tsx: removed fs/Electron imports
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined } from "@ant-design/icons";
import { useSize } from "ahooks";
import { Button, Dropdown, Flex, FlexProps, Input, InputRef, MenuProps } from "antd";
import React, { FC, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FiDelete } from "react-icons/fi";
import { IoMdReturnLeft } from "react-icons/io";
import { RiFocus3Line } from "react-icons/ri";
import { VscCaseSensitive } from "react-icons/vsc";
import { useDebounceCallback } from "usehooks-ts";
import { useShallow } from "zustand/react/shallow";
import i18n from "../../shared/misc/i18n";
import { Hotkey, isMacos, useKeyPress } from "../../shared/misc/keys";
import { mergeClassNames } from "../../shared/misc/util";
import { EditEvent, EditNode, EditorStore, EditTree, useWorkspace } from "../contexts/workspace-context";
import { FilterOption, Graph } from "./graph";
import { Inspector } from "./inspector";
import * as vscodeApi from "../vscodeApi";
import "./register-node";

/** Same as desktop `workspace.tsx` hotkeyMap — tree canvas editing shortcuts */
const hotkeyMap: Record<string, EditEvent> = {
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

export interface EditorProps extends React.HTMLAttributes<HTMLElement> {
  data: EditorStore;
  onChange: () => void;
}

const createMenu = (showEditSubtree: boolean) => {
  const t = i18n.t;
  const MenuItem: FC<FlexProps> = (itemProps) => {
    return (
      <Flex
        gap="50px"
        style={{ minWidth: "200px", justifyContent: "space-between", alignItems: "center" }}
        {...itemProps}
      ></Flex>
    );
  };

  const arr: MenuProps["items"] = [
    {
      label: (
        <MenuItem>
          <div>{t("copy")}</div>
          <div>{isMacos ? "⌘ C" : "Ctrl+C"}</div>
        </MenuItem>
      ),
      key: "copy",
    },
    {
      label: (
        <MenuItem>
          <div>{t("paste")}</div>
          <div>{isMacos ? "⌘ V" : "Ctrl+V"}</div>
        </MenuItem>
      ),
      key: "paste",
    },
    {
      label: (
        <MenuItem>
          <div>{t("replace")}</div>
          <div>{isMacos ? "⇧ ⌘ V" : "Ctrl+Shift+V"}</div>
        </MenuItem>
      ),
      key: "replace",
    },
    {
      label: (
        <MenuItem>
          <div>{t("insertNode")}</div>
          <div>{isMacos ? <IoMdReturnLeft /> : "Enter"}</div>
        </MenuItem>
      ),
      key: "insert",
    },
    {
      label: (
        <MenuItem>
          <div>{t("deleteNode")}</div>
          <div>{isMacos ? <FiDelete /> : "Backspace"}</div>
        </MenuItem>
      ),
      key: "delete",
    },
    ...(showEditSubtree
      ? [
          {
            label: (
              <MenuItem>
                <div>{t("editSubtree")}</div>
                <div></div>
              </MenuItem>
            ),
            key: "editSubtree",
          },
        ]
      : []),
    {
      label: (
        <MenuItem>
          <div>{t("saveAsSubtree")}</div>
          <div></div>
        </MenuItem>
      ),
      key: "saveAsSubtree",
    },
  ];
  return arr;
};

export const Editor: FC<EditorProps> = ({ onChange, data: editor, ...props }) => {
  const workspace = useWorkspace(
    useShallow((state) => ({
      editor: state.editor,
      usingVars: state.usingVars,
      usingGroups: state.usingGroups,
      hostSubtreeRefreshSeq: state.hostSubtreeRefreshSeq,
      theme: state.theme,
    }))
  );

  const keysRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<InputRef>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);
  const editorSize = useSize(sizeRef);
  const { t } = useTranslation();
  const [menuShowEditSubtree, setMenuShowEditSubtree] = useState(false);
  const menuItems = useMemo(() => createMenu(menuShowEditSubtree), [t, menuShowEditSubtree]);
  const [graph, setGraph] = useState<Graph>(null!);
  const graphInstanceRef = useRef<Graph | null>(null);
  graphInstanceRef.current = graph;

  const [showingSearch, setShowingSearch] = useState(false);
  const [filterOption, setFilterOption] = useState<FilterOption>({
    results: [],
    index: 0,
    filterStr: "",
    filterCase: false,
    filterFocus: true,
    filterType: "content",
    placeholder: "",
  });

  const onSearchChange = async (option: FilterOption) => {
    option.results.length = 0;
    graph.hightlightSearch(option, graph.data.root);
    setFilterOption({ ...option });
    if (option.results.length > 0) {
      const idx = option.index < option.results.length ? option.index : 0;
      graph.expandElement();
      graph.focusNode(option.results[idx]);
    } else {
      graph.selectNode(null);
    }
  };

  const updateSearchState = () => {
    const option = { ...filterOption };
    option.results.length = 0;
    graph.hightlightSearch(option, graph.data.root);
    setFilterOption({ ...option });
  };

  const onDebounceSearchChange = useDebounceCallback(onSearchChange, 100);

  const nextResult = () => {
    const { results, index } = filterOption;
    if (results.length > 0) {
      const idx = (index + 1) % results.length;
      setFilterOption({ ...filterOption, index: idx });
      graph.expandElement();
      graph.focusNode(results[idx]);
    }
  };

  const prevResult = () => {
    const { results, index } = filterOption;
    if (results.length > 0) {
      const idx = (index + results.length - 1) % results.length;
      setFilterOption({ ...filterOption, index: idx });
      graph.expandElement();
      graph.focusNode(results[idx]);
    }
  };

  const searchByType = (type: FilterOption["filterType"]) => {
    let placeholder = "";
    const filterType = type;
    switch (type) {
      case "id":
        placeholder = t("jumpNode");
        break;
      default:
        placeholder = t("searchNode");
        break;
    }
    if (!showingSearch) {
      setFilterOption({ ...filterOption, placeholder, filterType });
      setShowingSearch(true);
      return;
    }
    if (filterOption.filterType === type) {
      return searchInputRef.current?.focus();
    }
    setShowingSearch(false);
    setTimeout(() => {
      setShowingSearch(true);
      setFilterOption({ ...filterOption, placeholder, filterType });
      searchInputRef.current?.focus();
    }, 50);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.code === Hotkey.Enter) {
      nextResult();
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyF") {
      searchByType("content");
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyG") {
      searchByType("id");
    }
    e.stopPropagation();
  };

  editor.dispatch = async (event: EditEvent, data: unknown) => {
    if (event === "rename") {
      editor.path = data as string;
      return;
    }
    const graph = graphInstanceRef.current;
    if (!graph) {
      return;
    }
    if (event === "close") {
      graph.destroy();
    } else if (event === "copy") {
      graph.copyNode();
    } else if (event === "paste") {
      await graph.pasteNode();
    } else if (event === "delete") {
      await graph.deleteNode();
    } else if (event === "insert") {
      await graph.createNode();
    } else if (event === "replace") {
      graph.replaceNode();
    } else if (event === "save") {
      await graph.save();
      onChange();
      editor.changed = false;
      updateSearchState();
    } else if (event === "undo") {
      await graph.undo();
      updateSearchState();
    } else if (event === "redo") {
      await graph.redo();
      updateSearchState();
    } else if (event === "refresh") {
      const preserve =
        data &&
        typeof data === "object" &&
        (data as { preserveSelection?: boolean }).preserveSelection === true;
      await graph.refresh(preserve ? { preserveSelection: true } : undefined);
    } else if (event === "reload") {
      graph.reload();
      editor.changed = false;
    } else if (event === "updateTree") {
      graph.updateTree(data as EditTree);
    } else if (event === "updateNode") {
      graph.updateNode(data as EditNode);
    } else if (event === "searchNode") {
      searchByType("content");
    } else if (event === "jumpNode") {
      searchByType("id");
    } else if (event === "editSubtree") {
      graph.editSubtree();
    } else if (event === "saveAsSubtree") {
      graph.saveAsSubtree();
    } else if (event === "clickVar") {
      graph.clickVar(data as string);
    }
  };

  // Tree canvas shortcuts: copy/paste/insert/delete/undo/redo + in-tree search (Ctrl/Cmd+F,G).
  // Save/Close/QuickOpen: VS Code host. Build: editor title bar command; webview mirrors Ctrl/Cmd+B via postMessage when iframe has focus.
  useKeyPress(Hotkey.SearchNode, null, (event) => {
    event.preventDefault();
    editor.dispatch?.("searchNode");
  });

  useKeyPress(Hotkey.JumpNode, null, (event) => {
    event.preventDefault();
    editor.dispatch?.("jumpNode");
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
    ],
    null,
    (e, key) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      editor.dispatch?.(hotkeyMap[key]);
    }
  );

  useKeyPress([Hotkey.Undo, Hotkey.Redo], null, (e, key) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    e.stopPropagation();
    editor.dispatch?.(hotkeyMap[key]);
  });

  /**
   * When focus is inside the webview iframe, VS Code keybindings may not run — mirror title-bar Build (Ctrl/Cmd+B).
   */
  useKeyPress(Hotkey.Build, null, (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    vscodeApi.postMessage({ type: "build" });
  });

  if (graph) {
    graph.onChange = () => {
      editor.changed = true;
      onChange();
    };
    graph.onUpdateSearch = () => {
      if (filterOption.filterStr) {
        onSearchChange({
          ...filterOption,
          filterType: "content",
        });
      }
    };
  }

  const refreshGraph = async () => {
    if (graph.hasSubtreeUpdated()) {
      await graph.refreshSubtree();
    } else {
      await graph.refresh({ preserveSelection: true });
    }
    if (editor.focusId) {
      graph.focusNode(editor.focusId);
      editor.focusId = null;
    }
  };

  useEffect(() => {
    if (!editorSize || (editorSize.width === 0 && editorSize.height === 0)) {
      return;
    }
    if (!graph) {
      setGraph(new Graph(editor, graphRef));
    }
    if (graph && workspace.editor === editor) {
      graph.setSize(editorSize.width, editorSize.height);
      refreshGraph();
    }
  }, [editorSize, workspace.editor, graph]);

  useEffect(() => {
    if (graph) {
      void graph.refresh({ preserveSelection: true });
    }
  }, [t]);

  /** usingVars/Groups 变而图未整页 refresh 时（如 varDeclLoaded），补一次节点绘制以更新红框 */
  useEffect(() => {
    if (graph) {
      graph.repaint();
    }
  }, [graph, workspace.usingVars, workspace.usingGroups]);

  // Subtree file edited/saved in another tab → extension bumps seq → reload merged subtree view
  useEffect(() => {
    if (!graph || workspace.hostSubtreeRefreshSeq === 0) return;
    void graph.refresh({ preserveSelection: true });
  }, [graph, workspace.hostSubtreeRefreshSeq]);

  /** Restore focus to tree hotkey layer when closing search (same idea as desktop workspace keysRef) */
  useEffect(() => {
    if (!showingSearch) {
      keysRef.current?.focus({ preventScroll: true });
    }
  }, [showingSearch]);

  return (
    <div
      {...props}
      ref={keysRef}
      className="b3-editor"
      tabIndex={-1}
      style={{ display: "flex", width: "100%", height: "100%", ...props.style }}
    >
      {/* Graph area */}
      <div
        ref={sizeRef}
        style={{ flex: 1, minWidth: 0, height: "100%", position: "relative" }}
      >
        {showingSearch && (
          <Flex
            style={{
              position: "absolute",
              width: "100%",
              justifyContent: "end",
              paddingRight: "10px",
              paddingTop: "10px",
              zIndex: 100,
            }}
          >
            <Flex
              style={{
                backgroundColor: "var(--b3-search-bg)",
                padding: "4px 10px 4px 10px",
                borderRadius: "4px",
                borderLeft: "3px solid var(--b3-search-border-accent)",
                boxShadow: "0 0 8px 2px var(--b3-search-shadow)",
                alignItems: "center",
              }}
            >
              <Input
                ref={searchInputRef}
                placeholder={filterOption.placeholder}
                autoFocus
                size="small"
                style={{ borderRadius: "2px", paddingTop: "1px", paddingBottom: "1px" }}
                onChange={(e) =>
                  onDebounceSearchChange({
                    ...filterOption,
                    filterStr: e.currentTarget.value,
                    index: 0,
                  })
                }
                onKeyDownCapture={handleKeyDown}
                suffix={
                  <Flex gap="2px" style={{ alignItems: "center" }}>
                    {filterOption.filterType !== "id" && (
                      <Button
                        type="text"
                        size="small"
                        className={mergeClassNames(
                          "b3-editor-filter",
                          filterOption.filterCase && "b3-editor-filter-selected"
                        )}
                        icon={<VscCaseSensitive style={{ width: "18px", height: "18px" }} />}
                        onClick={() =>
                          onSearchChange({ ...filterOption, filterCase: !filterOption.filterCase })
                        }
                      />
                    )}
                    <Button
                      type="text"
                      size="small"
                      className={mergeClassNames(
                        "b3-editor-filter",
                        filterOption.filterFocus && "b3-editor-filter-selected"
                      )}
                      icon={<RiFocus3Line />}
                      onClick={() =>
                        onSearchChange({ ...filterOption, filterFocus: !filterOption.filterFocus })
                      }
                    />
                  </Flex>
                }
              />
              <div style={{ padding: "0 10px 0 5px", minWidth: "40px", color: "var(--b3-text-muted)" }}>
                {filterOption.results.length
                  ? `${filterOption.index + 1}/${filterOption.results.length}`
                  : ""}
              </div>
              {filterOption.filterType !== "id" && (
                <Button
                  icon={<ArrowDownOutlined />}
                  type="text"
                  size="small"
                  style={{ width: "30px" }}
                  disabled={filterOption.results.length === 0}
                  onClick={nextResult}
                />
              )}
              {filterOption.filterType !== "id" && (
                <Button
                  icon={<ArrowUpOutlined />}
                  type="text"
                  size="small"
                  style={{ width: "30px" }}
                  disabled={filterOption.results.length === 0}
                  onClick={prevResult}
                />
              )}
              <Button
                icon={<CloseOutlined />}
                type="text"
                size="small"
                style={{ width: "30px" }}
                onClick={() => {
                  setShowingSearch(false);
                  onSearchChange({
                    results: [],
                    index: 0,
                    filterCase: false,
                    filterFocus: true,
                    filterStr: "",
                    filterType: "content",
                    placeholder: "",
                  });
                }}
              />
            </Flex>
          </Flex>
        )}

        <Dropdown
          menu={{ items: menuItems, onClick: (info) => editor.dispatch?.(info.key as EditEvent) }}
          trigger={["contextMenu"]}
          onOpenChange={(open) => {
            if (open) {
              const g = graphInstanceRef.current;
              setMenuShowEditSubtree(!!g?.canShowEditSubtreeMenu());
            } else {
              setMenuShowEditSubtree(false);
            }
          }}
        >
          <div tabIndex={-1} style={{ width: "100%", height: "100%" }} ref={graphRef} />
        </Dropdown>
      </div>

      {/* Inspector panel */}
      <div
        style={{
          width: 360,
          minWidth: 360,
          height: "100%",
          borderLeft: "1px solid var(--b3-inspector-divider)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Inspector />
      </div>
    </div>
  );
};
