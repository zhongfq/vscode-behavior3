import { Image as GImage, Path as GPath, Rect as GRect, Text as GText } from "@antv/g";
import { DisplayObject, Group } from "@antv/g-lite";
import {
    Badge,
    CommonEvent,
    ExtensionCategory,
    NodeData as G6NodeData,
    Rect,
    RectStyleProps,
    UpsertHooks,
    register,
} from "@antv/g6";
import { NodeStyle } from "@antv/g6/lib/spec/element/node";
import actionIconUrl from "../../../public/icons/Action.svg";
import compositeIconUrl from "../../../public/icons/Composite.svg";
import conditionIconUrl from "../../../public/icons/Condition.svg";
import debugIconUrl from "../../../public/icons/Debug.svg";
import decoratorIconUrl from "../../../public/icons/Decorator.svg";
import disabledIconUrl from "../../../public/icons/Disabled.svg";
import errorIconUrl from "../../../public/icons/Error.svg";
import otherIconUrl from "../../../public/icons/Other.svg";
import status000IconUrl from "../../../public/icons/status000.svg";
import status001IconUrl from "../../../public/icons/status001.svg";
import status010IconUrl from "../../../public/icons/status010.svg";
import status011IconUrl from "../../../public/icons/status011.svg";
import status100IconUrl from "../../../public/icons/status100.svg";
import status101IconUrl from "../../../public/icons/status101.svg";
import status110IconUrl from "../../../public/icons/status110.svg";
import status111IconUrl from "../../../public/icons/status111.svg";
import i18n from "../../shared/misc/i18n";
import { isMacos } from "../../shared/misc/keys";
import type { GraphNodeVM } from "../../shared/contracts";
import { stringifyCompactJson5 } from "../../shared/json5-display";

export const G6_VECTOR_TREE_NODE_TYPE = "b3-v2-tree-node";
export const G6_VECTOR_NODE_WIDTH = 260;
export const G6_VECTOR_NODE_MIN_HEIGHT = 52;
export const G6_VECTOR_NODE_H_GAP = 30;
export const G6_VECTOR_NODE_V_GAP = 10;

export interface VectorTreeNodeDatum extends Record<string, unknown> {
    vm: GraphNodeVM;
    width: number;
    height: number;
}

export type VectorTreeNodeState =
    | "dragdown"
    | "dragright"
    | "dragsrc"
    | "dragup"
    | "focused"
    | "highlightargs"
    | "highlightgray"
    | "highlightinput"
    | "highlightoutput"
    | "selected";

type ShapeName =
    | "args-bg"
    | "args-text"
    | "debug"
    | "desc-text"
    | "disabled"
    | "collapse"
    | "drag-down"
    | "drag-right"
    | "drag-src"
    | "drag-up"
    | "focus-halo"
    | "icon"
    | "id-text"
    | "input-bg"
    | "input-text"
    | "key-shape"
    | "name-bg"
    | "name-line"
    | "name-text"
    | "override-bar"
    | "output-bg"
    | "output-text"
    | "path-text"
    | "selection-halo"
    | "status"
    | "subtree"
    | "warn-text";

type Constructor<T> = new (...args: any[]) => T;

const CONTENT_X = 46;
const CONTENT_Y = 28;
const CONTENT_WIDTH = 220;
const ROW_HEIGHT = 20;
const LEFT_RAIL_WIDTH = 40;
const RADIUS = 4;

const readThemeCssVariable = (name: string, fallback: string): string => {
    if (typeof document === "undefined") {
        return fallback;
    }

    for (const element of [document.body, document.documentElement]) {
        if (!element) {
            continue;
        }

        const value = getComputedStyle(element).getPropertyValue(name).trim();
        if (value) {
            return value;
        }
    }

    return fallback;
};

const readThemeCssNumber = (name: string, fallback: number): number => {
    const rawValue = readThemeCssVariable(name, `${fallback}`);
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : fallback;
};

export const getGraphThemeColor = (name: string, fallback: string): string =>
    readThemeCssVariable(name, fallback);

const getVectorTreeNodePalette = () => ({
    // Keep the collapse control aligned with the V1 editor look instead of
    // inheriting a themed dark pill from VS Code widget colors.
    collapseBg: "#ffffff",
    collapseBorder: "#666666",
    collapseText: "#666666",
    divider: readThemeCssVariable("--b3-node-divider", "#666666"),
    dragSource: readThemeCssVariable("--b3-drag-source", "#ffa500"),
    dropChild: readThemeCssVariable("--b3-drop-child", "#ff4d4f"),
    focusColor: readThemeCssVariable("--b3-node-focus-color", "#ffab00"),
    focusOpacity: readThemeCssNumber("--b3-node-focus-opacity", 0.45),
    grayBorder: readThemeCssVariable("--b3-node-gray-border", "#30363d"),
    grayFill: readThemeCssVariable("--b3-node-gray-fill", "#0d1117"),
    grayRail: readThemeCssVariable("--b3-node-gray-rail", "#30363d"),
    grayText: readThemeCssVariable("--b3-node-gray-text", "#666666"),
    highlightBg: readThemeCssVariable("--b3-node-highlight-bg", "#0d1117"),
    highlightText: readThemeCssVariable("--b3-node-highlight-text", "#ffffff"),
    idStroke: readThemeCssVariable("--b3-node-id-stroke", "#000000"),
    idText: readThemeCssVariable("--b3-node-id-text", "#ffffff"),
    nodeBg: readThemeCssVariable("--b3-node-content-bg", "#ffffff"),
    nodeText: readThemeCssVariable("--b3-node-text", "#111827"),
    overrideBar: readThemeCssVariable("--b3-override-bar", "#d87a16"),
    subtreeOutline: readThemeCssVariable("--b3-subtree-outline", "#a5b1be"),
    warningText: readThemeCssVariable("--b3-warning-text", "#b42318"),
});

type VectorTreeNodePalette = ReturnType<typeof getVectorTreeNodePalette>;

const accentColorMap: Record<GraphNodeVM["nodeStyleKind"], string> = {
    Action: "#1769dd",
    Composite: "#34d800",
    Condition: "#f72585",
    Decorator: "#b2eb35",
    Error: "#ff0000",
    Other: "#707070",
};

const fallbackNodeIconMap: Record<GraphNodeVM["nodeStyleKind"], string> = {
    Action: actionIconUrl,
    Composite: compositeIconUrl,
    Condition: conditionIconUrl,
    Decorator: decoratorIconUrl,
    Error: errorIconUrl,
    Other: otherIconUrl,
};

const statusIconMap: Record<number, string> = {
    0: status000IconUrl,
    1: status001IconUrl,
    2: status010IconUrl,
    3: status011IconUrl,
    4: status100IconUrl,
    5: status101IconUrl,
    6: status110IconUrl,
    7: status111IconUrl,
};

let textMeasureContext: CanvasRenderingContext2D | null = null;
let defaultFontSize = "";
let defaultFontFamily = "";
const textWidthCache = new Map<string, number>();
const textLineCache = new Map<string, string[]>();
let didRegisterVectorTreeNode = false;

const getMeasureHost = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(".b3-v2-shell") ?? document.body;

const ensureMeasureStyle = (fontSize?: string) => {
    const host = getMeasureHost();
    const css = host ? getComputedStyle(host) : null;

    if (!defaultFontSize) {
        defaultFontSize = css?.fontSize || "13px";
    }
    if (!defaultFontFamily) {
        defaultFontFamily = css?.fontFamily || "sans-serif";
    }

    return {
        fontSize: fontSize ?? defaultFontSize,
        fontFamily: defaultFontFamily,
    };
};

const calcTextWidth = (text: string, fontSize?: string) => {
    const { fontSize: resolvedFontSize, fontFamily } = ensureMeasureStyle(fontSize);
    const key = `${text}-${resolvedFontSize}-${fontFamily}`;
    const cachedWidth = textWidthCache.get(key);
    if (cachedWidth !== undefined) {
        return cachedWidth;
    }

    textMeasureContext ||= document.createElement("canvas").getContext("2d");
    if (!textMeasureContext) {
        return text.length * 13;
    }

    textMeasureContext.font = `${resolvedFontSize} ${fontFamily}`;
    textMeasureContext.wordSpacing = "0px";
    textMeasureContext.letterSpacing = "-0.5px";

    let width = textMeasureContext.measureText(text).width;
    width *= isMacos ? 0.88 : 0.98;
    textWidthCache.set(key, width);

    return width;
};

const calcTextLines = (value: string, maxWidth: number, fontSize?: string): string[] => {
    const key = `${value}-${maxWidth}-${fontSize ?? ""}`;
    const cachedLines = textLineCache.get(key);
    if (cachedLines) {
        return cachedLines;
    }

    const lines: string[] = [];
    let remaining = value;

    while (remaining.length > 0) {
        let left = 0;
        let right = remaining.length;

        while (left < right) {
            const middle = Math.floor((left + right + 1) / 2);
            const chunk = remaining.slice(0, middle);
            if (calcTextWidth(chunk, fontSize) <= maxWidth) {
                left = middle;
            } else {
                right = middle - 1;
            }
        }

        if (left > 0) {
            lines.push(remaining.slice(0, left));
            remaining = remaining.slice(left);
            continue;
        }

        lines.push(remaining.slice(0, 1));
        remaining = remaining.slice(1);
    }

    textLineCache.set(key, lines);
    return lines;
};

const cutWordTo = (value: string, maxWidth: number, fontSize?: string) => {
    const lines = calcTextLines(value, maxWidth, fontSize);
    if (lines.length > 1) {
        return `${lines[0].slice(0, -1)}...`;
    }
    return lines[0] ?? "";
};

const toBreakWord = (value: string, maxWidth: number, fontSize?: string) => {
    const lines = calcTextLines(value, maxWidth, fontSize);
    return {
        str: lines.join("\n"),
        line: lines.length,
    };
};

const getInputText = (node: GraphNodeVM) => {
    const labels = node.inputs.map((entry) => entry.label).filter(Boolean);
    if (labels.length === 0) {
        return { str: "", line: 0 };
    }
    return toBreakWord(`${i18n.t("regnode.input")}${stringifyCompactJson5(labels) ?? "[]"}`, 200);
};

const getOutputText = (node: GraphNodeVM) => {
    const labels = node.outputs.map((entry) => entry.label).filter(Boolean);
    if (labels.length === 0) {
        return { str: "", line: 0 };
    }
    return toBreakWord(`${i18n.t("regnode.output")}${stringifyCompactJson5(labels) ?? "[]"}`, 200);
};

export const measureVectorTreeNode = (node: GraphNodeVM) => {
    let height = 50 + 2;

    if (node.subtreePath) {
        height += ROW_HEIGHT;
    }
    if (node.argsText) {
        height += toBreakWord(`${i18n.t("regnode.args")}${node.argsText}`, 200).line * ROW_HEIGHT;
    }

    const inputText = getInputText(node);
    if (inputText.line > 0) {
        height += inputText.line * ROW_HEIGHT;
    }

    const outputText = getOutputText(node);
    if (outputText.line > 0) {
        height += outputText.line * ROW_HEIGHT;
    }

    if (node.warningText) {
        height += toBreakWord(node.warningText, 200).line * ROW_HEIGHT;
    }

    return {
        width: G6_VECTOR_NODE_WIDTH,
        height: Math.max(G6_VECTOR_NODE_MIN_HEIGHT, height),
    };
};

export type VectorTreeNodeStateStyleMap = {
    [s in VectorTreeNodeState]?: { [n in ShapeName]?: NodeStyle };
};

export const getVectorTreeNodeStateStyle = (): VectorTreeNodeStateStyleMap => {
    const palette = getVectorTreeNodePalette();

    return {
        dragsrc: {
            "drag-src": { visibility: "visible" },
        },
        dragup: {
            "drag-up": { visibility: "visible" },
        },
        dragdown: {
            "drag-down": { visibility: "visible" },
        },
        dragright: {
            "drag-right": { visibility: "visible" },
        },
        focused: {
            "focus-halo": { visibility: "visible" },
        },
        highlightargs: {
            "args-bg": { visibility: "visible" },
            "args-text": { fill: palette.highlightText },
        },
        highlightinput: {
            "input-bg": { visibility: "visible" },
            "input-text": { fill: palette.highlightText },
        },
        highlightoutput: {
            "output-bg": { visibility: "visible" },
            "output-text": { fill: palette.highlightText },
        },
        highlightgray: {
            collapse: { opacity: 0.45 },
            "desc-text": { fill: palette.grayText },
            debug: { opacity: 0.45 },
            disabled: { opacity: 0.45 },
            icon: { opacity: 0.45 },
            "id-text": { fill: palette.grayText, stroke: palette.idStroke },
            "input-text": { fill: palette.grayText },
            "key-shape": { fill: palette.grayFill, stroke: palette.grayBorder },
            "name-bg": { fill: palette.grayRail },
            "name-line": { stroke: palette.divider },
            "name-text": { fill: palette.grayText },
            "override-bar": { opacity: 0.45 },
            "output-text": { fill: palette.grayText },
            "path-text": { fill: palette.grayText },
            status: { opacity: 0.45 },
            "warn-text": { fill: palette.grayText },
            "args-text": { fill: palette.grayText },
        },
        selected: {
            "selection-halo": { visibility: "visible" },
        },
    };
};

class VectorTreeNode extends Rect {
    private width = G6_VECTOR_NODE_WIDTH;
    private height = G6_VECTOR_NODE_MIN_HEIGHT;
    private radius = RADIUS;
    private node!: GraphNodeVM;
    private accent = accentColorMap.Other;
    private contentY = CONTENT_Y;
    private states: VectorTreeNodeState[] = [];
    private palette: VectorTreeNodePalette = getVectorTreeNodePalette();

    protected override getKeyStyle(attributes: Required<RectStyleProps>) {
        const style = super.getKeyStyle(attributes);
        if (style) {
            style.x = 0;
            style.y = 0;
        }
        return style;
    }

    protected override getHaloStyle(attributes: Required<RectStyleProps>) {
        const style = super.getHaloStyle(attributes);
        if (style) {
            style.x = 0;
            style.y = 0;
        }
        return style;
    }

    private drawSelectionHalo(container: Group) {
        this.upsert(
            "selection-halo",
            GRect,
            {
                x: -6,
                y: -6,
                width: this.width + 12,
                height: this.height + 12,
                lineWidth: 6,
                radius: this.radius + 6,
                stroke: this.accent,
                strokeOpacity: 0.28,
                fill: this.accent,
                fillOpacity: 0,
                visibility: "hidden",
            },
            container
        );
    }

    private drawFocusHalo(container: Group) {
        this.upsert(
            "focus-halo",
            GRect,
            {
                x: -8,
                y: -8,
                width: this.width + 16,
                height: this.height + 16,
                lineWidth: 4,
                radius: this.radius + 8,
                stroke: this.palette.focusColor,
                strokeOpacity: this.palette.focusOpacity,
                fill: this.palette.focusColor,
                fillOpacity: 0,
                visibility: "hidden",
            },
            container
        );
    }

    private drawBackground(attributes: Required<RectStyleProps>, container: Group) {
        const style = {
            ...attributes,
            size: [this.width, this.height] as [number, number],
            lineWidth: 2,
            radius: this.radius,
        };
        this.applyStyle("key-shape", style);
        this.drawKeyShape(style as Required<RectStyleProps>, container);
    }

    private drawNameBackground(container: Group) {
        this.upsert(
            "name-bg",
            GRect,
            {
                width: LEFT_RAIL_WIDTH,
                height: this.height,
                fill: this.accent,
                radius: [this.radius, 0, 0, this.radius],
            },
            container
        );

        this.upsert(
            "name-line",
            GPath,
            {
                d: [
                    ["M", 46, 23],
                    ["L", this.width - 40, 23],
                ],
                stroke: this.palette.divider,
                lineWidth: 1,
            },
            container
        );
    }

    private drawIdText(container: Group) {
        this.upsert(
            "id-text",
            GText,
            {
                fill: this.palette.idText,
                fontSize: 20,
                lineHeight: 20,
                lineWidth: 2,
                stroke: this.palette.idStroke,
                text: this.node.renderedIdLabel,
                textAlign: "right",
                textBaseline: "top",
                x: -3,
                y: this.height / 2 - 8,
            },
            container
        );
    }

    private drawTypeIcon(container: Group) {
        this.upsert(
            "icon",
            GImage,
            {
                x: 5,
                y: this.height / 2 - 16,
                height: 30,
                opacity: 1,
                width: 30,
                src: this.node.icon?.trim() || fallbackNodeIconMap[this.node.nodeStyleKind],
            },
            container
        );
    }

    private drawStatusIcon(container: Group) {
        this.upsert(
            "status",
            GImage,
            {
                x: this.width - 18,
                y: 3,
                height: 20,
                opacity: 1,
                width: 20,
                src: statusIconMap[this.node.statusBits] ?? status000IconUrl,
            },
            container
        );
    }

    private drawDebugIcon(container: Group) {
        this.upsert(
            "debug",
            GImage,
            {
                x: this.width - 30,
                y: 4,
                height: 16,
                opacity: 1,
                width: 16,
                src: debugIconUrl,
                visibility: this.node.debug ? "visible" : "hidden",
            },
            container
        );
    }

    private drawDisabledIcon(container: Group) {
        this.upsert(
            "disabled",
            GImage,
            {
                x: this.width - 30 - (this.node.debug ? 18 : 0),
                y: 4,
                height: 16,
                opacity: 1,
                width: 16,
                src: disabledIconUrl,
                visibility: this.node.disabled ? "visible" : "hidden",
            },
            container
        );
    }

    private drawOverrideBar(container: Group) {
        this.upsert(
            "override-bar",
            GRect,
            {
                x: this.width - 17,
                y: 1,
                width: 16,
                height: this.height - 2,
                fill: this.palette.overrideBar,
                lineWidth: 2,
                opacity: 1,
                radius: [0, this.radius - 1, this.radius - 1, 0],
                visibility: this.node.hasOverride ? "visible" : "hidden",
            },
            container
        );
    }

    private drawNameText(container: Group) {
        this.upsert(
            "name-text",
            GText,
            {
                fill: this.palette.nodeText,
                fontSize: 14,
                fontWeight: "bolder",
                text: this.node.title,
                textBaseline: "top",
                x: CONTENT_X,
                y: isMacos ? 3 : 2,
            },
            container
        );
    }

    private drawDescText(container: Group) {
        const text = this.node.subtitle
            ? cutWordTo(`${i18n.t("regnode.mark")}${this.node.subtitle}`, CONTENT_WIDTH - 15)
            : "";

        this.upsert(
            "desc-text",
            GText,
            {
                fill: this.palette.nodeText,
                fontSize: 12,
                fontWeight: "bolder",
                lineHeight: ROW_HEIGHT,
                text: text,
                textBaseline: "top",
                x: CONTENT_X,
                y: this.contentY,
                visibility: text ? "visible" : "hidden",
            },
            container
        );
    }

    private drawArgsText(container: Group) {
        const { str, line } = this.node.argsText
            ? toBreakWord(`${i18n.t("regnode.args")}${this.node.argsText}`, 200)
            : { str: "", line: 0 };

        this.upsert(
            "args-bg",
            GRect,
            {
                x: CONTENT_X - 2,
                y: this.contentY + 21,
                width: CONTENT_WIDTH - 6,
                height: 18,
                fill: this.palette.highlightBg,
                radius: this.radius,
                visibility: "hidden",
            },
            container
        );

        this.upsert(
            "args-text",
            GText,
            {
                fill: this.palette.nodeText,
                fontSize: 12,
                fontWeight: "normal",
                lineHeight: ROW_HEIGHT,
                text: str,
                textBaseline: "top",
                x: CONTENT_X,
                y: this.contentY + ROW_HEIGHT,
                visibility: str ? "visible" : "hidden",
            },
            container
        );

        this.contentY += ROW_HEIGHT * line;
    }

    private drawInputText(container: Group) {
        const { str, line } = getInputText(this.node);

        this.upsert(
            "input-bg",
            GRect,
            {
                fill: this.palette.highlightBg,
                height: 18,
                radius: this.radius,
                visibility: "hidden",
                width: CONTENT_WIDTH - 6,
                x: CONTENT_X - 2,
                y: this.contentY + 21,
            },
            container
        );

        this.upsert(
            "input-text",
            GText,
            {
                fill: this.palette.nodeText,
                fontSize: 12,
                fontWeight: "normal",
                lineHeight: ROW_HEIGHT,
                text: str,
                textBaseline: "top",
                x: CONTENT_X,
                y: this.contentY + ROW_HEIGHT,
                visibility: str ? "visible" : "hidden",
            },
            container
        );

        this.contentY += ROW_HEIGHT * line;
    }

    private drawOutputText(container: Group) {
        const { str, line } = getOutputText(this.node);

        this.upsert(
            "output-bg",
            GRect,
            {
                fill: this.palette.highlightBg,
                height: 18,
                radius: this.radius,
                visibility: "hidden",
                width: CONTENT_WIDTH - 6,
                x: CONTENT_X - 2,
                y: this.contentY + 21,
            },
            container
        );

        this.upsert(
            "output-text",
            GText,
            {
                fill: this.palette.nodeText,
                fontSize: 12,
                fontWeight: "normal",
                lineHeight: ROW_HEIGHT,
                text: str,
                textBaseline: "top",
                x: CONTENT_X,
                y: this.contentY + ROW_HEIGHT,
                visibility: str ? "visible" : "hidden",
            },
            container
        );

        this.contentY += ROW_HEIGHT * line;
    }

    private drawSubtreeText(container: Group) {
        const isSubtree = Boolean(this.node.subtreePath) && this.id !== "1";
        const text = isSubtree
            ? cutWordTo(`${i18n.t("regnode.subtree")}${this.node.subtreePath}`, CONTENT_WIDTH - 15)
            : "";

        this.upsert(
            "subtree",
            GRect,
            {
                x: -10,
                y: -10,
                width: this.width + 20,
                height: this.height + 20,
                stroke: this.palette.subtreeOutline,
                lineWidth: 2.5,
                lineDash: [6, 6],
                radius: this.radius,
                visibility: isSubtree ? "visible" : "hidden",
            },
            container
        );

        this.upsert(
            "path-text",
            GText,
            {
                fill: this.palette.nodeText,
                fontSize: 12,
                lineHeight: ROW_HEIGHT,
                text,
                textBaseline: "top",
                x: CONTENT_X,
                y: this.contentY + ROW_HEIGHT,
                visibility: text ? "visible" : "hidden",
            },
            container
        );

        this.contentY += text ? ROW_HEIGHT : 0;
    }

    private drawWarningText(container: Group) {
        const { str, line } = this.node.warningText
            ? toBreakWord(this.node.warningText, 200)
            : { str: "", line: 0 };

        this.upsert(
            "warn-text",
            GText,
            {
                fill: this.palette.warningText,
                fontSize: 12,
                fontWeight: "normal",
                lineHeight: ROW_HEIGHT,
                text: str,
                textBaseline: "top",
                x: CONTENT_X,
                y: this.contentY + ROW_HEIGHT,
                visibility: str ? "visible" : "hidden",
            },
            container
        );

        this.contentY += ROW_HEIGHT * line;
    }

    private drawCollapseBadge(attributes: Required<RectStyleProps>, container: Group) {
        const badge = this.upsert(
            "collapse",
            Badge,
            {
                backgroundFill: this.palette.collapseBg,
                backgroundHeight: 14,
                backgroundLineWidth: 1,
                backgroundRadius: 7,
                backgroundStroke: this.palette.collapseBorder,
                backgroundWidth: 14,
                cursor: "pointer",
                fill: this.palette.collapseText,
                fontSize: 16,
                opacity: 1,
                text: attributes.collapsed ? "+" : "-",
                textAlign: "center",
                textBaseline: "middle",
                visibility: this.node.childKeys.length > 0 ? "visible" : "hidden",
                x: this.width,
                y: this.height / 2,
            },
            container
        );

        if (badge && !Reflect.has(badge, "__bind__")) {
            Reflect.set(badge, "__bind__", true);
            badge.addEventListener(CommonEvent.CLICK, () => {
                const graph = this.context.graph;
                if (this.attributes.collapsed) {
                    graph.expandElement(this.id);
                } else {
                    graph.collapseElement(this.id);
                }
            });
        }
    }

    private drawDragShapes(container: Group) {
        this.upsert(
            "drag-src",
            GRect,
            {
                width: this.width,
                height: this.height,
                lineWidth: 0,
                fillOpacity: 0.8,
                fill: this.palette.dragSource,
                radius: this.radius,
                visibility: "hidden",
            },
            container
        );

        this.upsert(
            "drag-up",
            GRect,
            {
                width: this.width,
                height: this.height / 2,
                lineWidth: 2,
                stroke: this.palette.dropChild,
                strokeOpacity: 0.8,
                fill: this.palette.dropChild,
                fillOpacity: 0.8,
                radius: [this.radius, this.radius, 0, 0],
                visibility: "hidden",
            },
            container
        );

        this.upsert(
            "drag-down",
            GRect,
            {
                y: this.height / 2,
                width: this.width,
                height: this.height / 2,
                lineWidth: 2,
                stroke: this.palette.dropChild,
                strokeOpacity: 0.8,
                fill: this.palette.dropChild,
                fillOpacity: 0.8,
                radius: [0, 0, this.radius, this.radius],
                visibility: "hidden",
            },
            container
        );

        this.upsert(
            "drag-right",
            GRect,
            {
                x: this.width / 2,
                width: this.width / 2,
                height: this.height,
                lineWidth: 2,
                stroke: this.palette.dropChild,
                strokeOpacity: 0.8,
                fill: this.palette.dropChild,
                fillOpacity: 0.8,
                radius: [0, this.radius, this.radius, 0],
                visibility: "hidden",
            },
            container
        );
    }

    render(attributes?: Required<RectStyleProps>, container?: Group): void {
        const node = this.context.model.getNodeLikeDatum(this.id) as G6NodeData;
        const data = node.data as unknown as VectorTreeNodeDatum;

        this.node = data.vm;
        this.palette = getVectorTreeNodePalette();
        this.width = data.width;
        this.height = data.height;
        this.accent =
            this.node.accentColor ??
            accentColorMap[this.node.nodeStyleKind] ??
            accentColorMap.Other;
        this.contentY = CONTENT_Y;
        this.states = this.context.graph.getElementState(this.id) as VectorTreeNodeState[];
        this.resetStyle();

        if (!attributes || !container) {
            return;
        }

        attributes.fill = this.palette.nodeBg;
        attributes.stroke = this.accent;

        this.drawSelectionHalo(container);
        this.drawFocusHalo(container);
        this.drawBackground(attributes, container);
        this.drawNameBackground(container);
        this.drawOverrideBar(container);
        this.drawNameText(container);
        this.drawTypeIcon(container);
        this.drawStatusIcon(container);
        this.drawDebugIcon(container);
        this.drawDisabledIcon(container);
        this.drawDescText(container);
        this.drawArgsText(container);
        this.drawInputText(container);
        this.drawOutputText(container);
        this.drawSubtreeText(container);
        this.drawWarningText(container);
        this.drawDragShapes(container);
        this.drawCollapseBadge(attributes, container);
        this.drawIdText(container);
    }

    protected upsert<T extends DisplayObject>(
        name: ShapeName,
        Ctor: Constructor<T>,
        style: T["attributes"] | false,
        container: DisplayObject,
        hooks?: UpsertHooks
    ): T | undefined {
        this.applyStyle(name, style);
        return super.upsert(name, Ctor, style, container, hooks);
    }

    private applyStyle(name: ShapeName, style: DisplayObject["attributes"] | false) {
        if (!style) {
            return;
        }

        const shapeStyle =
            ((this.attributes as Record<string, unknown>)[name] as Record<string, unknown>) ?? {};

        for (const key in shapeStyle) {
            (style as Record<string, unknown>)[key] = shapeStyle[key];
        }
    }

    private resetStyle() {
        const style = this.context.graph.getOptions().node?.state as
            | VectorTreeNodeStateStyleMap
            | undefined;
        if (!style) {
            return;
        }

        const keys: Set<string> = new Set();
        Object.keys(style).forEach((state) => {
            for (const key in style[state as VectorTreeNodeState]) {
                keys.add(key);
            }
        });

        this.states.forEach((state) => {
            const stateStyle = style[state];
            if (!stateStyle) {
                return;
            }
            for (const key in stateStyle) {
                keys.delete(key);
            }
        });

        for (const key of keys) {
            (this.attributes as Record<string, unknown>)[key] = undefined;
        }
    }
}

export const registerVectorTreeNode = () => {
    if (didRegisterVectorTreeNode) {
        return;
    }

    register(ExtensionCategory.NODE, G6_VECTOR_TREE_NODE_TYPE, VectorTreeNode);
    didRegisterVectorTreeNode = true;
};
