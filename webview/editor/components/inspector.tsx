/**
 * Inspector panel — embedded directly in the editor webview.
 * Reads state from the Zustand workspace store and dispatches changes
 * via editor.dispatch() instead of postMessage.
 */
import {
  AimOutlined,
  EditOutlined,
  MinusCircleOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import {
  AutoComplete,
  Button,
  Divider,
  Flex,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
} from "antd";
import TextArea from "antd/es/input/TextArea";
import { DefaultOptionType } from "antd/es/select";
import React, { FC, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import { useShallow } from "zustand/react/shallow";
import { useDebounceCallback } from "usehooks-ts";
import { ExpressionEvaluator } from "../../../behavior3/src/behavior3/evaluator";
import {
  hasArgOptions,
  isBoolType,
  isExprType,
  isFloatType,
  isIntType,
  isJsonType,
  isStringType,
  NodeArg,
  NodeData,
  NodeDef,
  TreeData,
  VarDecl,
} from "../../shared/misc/b3type";
import { logger } from "../../shared/misc/logger";
import { EditTree } from "../contexts/workspace-context";
import {
  checkNodeArgValue,
  checkOneof,
  dfs,
  getNodeArgOptions,
  getNodeArgRawType,
  isNodeArgArray,
  isNodeArgOptional,
  isValidChildren,
  isValidVariableName,
  isVariadic,
  NodeDefs,
  parseExpr,
} from "../../shared/misc/b3util";
import i18n from "../../shared/misc/i18n";
import { useWorkspace } from "../contexts/workspace-context";

interface OptionType extends DefaultOptionType {
  value: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const updateFormWithNode = (
  form: ReturnType<typeof Form.useForm>[0],
  node: NodeData,
  defs: NodeDefs,
  checkExpr: boolean
) => {
  const def = defs.get(node.name);
  const t = i18n.t;
  form.resetFields();
  form.setFieldValue("id", node.id);
  form.setFieldValue("name", node.name);
  form.setFieldValue("type", def.type);
  form.setFieldValue("desc", node.desc ?? def.desc);
  form.setFieldValue("debug", node.debug);
  form.setFieldValue("disabled", node.disabled);
  form.setFieldValue("path", node.path);
  form.setFieldValue(
    "group",
    (def as NodeDef & { group?: string[] }).group?.map((g) => ({ label: g, value: g }))
  );
  if (def.children === undefined || def.children === -1) {
    form.setFieldValue("children", t("node.children.unlimited"));
  } else {
    form.setFieldValue("children", def.children);
  }
  def.args?.forEach((arg) => {
    const type = getNodeArgRawType(arg);
    const value = node.args?.[arg.name];
    const name = `args.${arg.name}`;
    if (isNodeArgArray(arg)) {
      form.setFieldValue(
        name,
        (Array.isArray(value) ? value : []).map((item) => {
          if (isJsonType(type)) {
            return item === null ? "null" : JSON.stringify(item ?? arg.default, null, 2);
          }
          return item;
        })
      );
    } else if (isJsonType(type)) {
      form.setFieldValue(
        name,
        value === null ? "null" : JSON.stringify(value ?? arg.default, null, 2)
      );
    } else {
      form.setFieldValue(name, value ?? arg.default);
    }
  });
  def.input?.forEach((_, i) => {
    if (isVariadic(def.input!, i)) {
      form.setFieldValue(`input.${i}`, node.input?.slice(i) ?? []);
    } else {
      form.setFieldValue(`input.${i}`, node.input?.[i]);
    }
  });
  def.output?.forEach((_, i) => {
    if (isVariadic(def.output!, i)) {
      form.setFieldValue(`output.${i}`, node.output?.slice(i) ?? []);
    } else {
      form.setFieldValue(`output.${i}`, node.output?.[i]);
    }
  });
};

const createNodeFromForm = (
  form: ReturnType<typeof Form.useForm>[0],
  node: NodeData,
  defs: NodeDefs
): NodeData => {
  const values = form.getFieldsValue() as Record<string, unknown>;
  const nameFromForm =
    (((values.name as string) ?? node.name) || "").trim() || node.name;
  const def = defs.get(nameFromForm);
  const data = {} as NodeData;
  data.$id = node.$id;
  data.id = node.id;
  data.name = nameFromForm;
  data.debug = (values.debug as boolean) || undefined;
  data.disabled = (values.disabled as boolean) || undefined;
  const descVal = values.desc as string | undefined;
  data.desc = descVal && descVal !== def.desc ? descVal : undefined;
  data.path = (values.path as string | undefined) || undefined;

  if (def.args?.length) {
    def.args.forEach((arg) => {
      const value = values[`args.${arg.name}`];
      if (value !== null && value !== undefined && value !== "") {
        data.args ||= {};
        const type = getNodeArgRawType(arg);
        if (isNodeArgArray(arg)) {
          const arr: unknown[] = [];
          if (Array.isArray(value)) {
            value.forEach((item) => {
              if (isJsonType(type)) {
                try { arr.push(item === "null" ? null : JSON.parse(item as string)); } catch { /* ignore */ }
              } else if (item !== null && item !== undefined) {
                arr.push(item);
              }
            });
          }
          data.args[arg.name] = !isNodeArgOptional(arg) ? arr : arr.length ? arr : undefined;
        } else if (isJsonType(type)) {
          const sv = value as string;
          try { data.args[arg.name] = sv === "null" ? null : JSON.parse(sv); } catch { /* ignore */ }
        } else {
          data.args[arg.name] = value;
        }
      }
    });
  } else {
    data.args = {};
  }

  if (def.input?.length) {
    def.input.forEach((_, i) => {
      data.input ||= [];
      if (isVariadic(def.input!, i)) {
        const arr = (values[`input.${i}`] ?? []) as string[];
        data.input.push(...arr.filter((v) => typeof v === "string"));
      } else {
        data.input.push((values[`input.${i}`] as string | undefined) ?? "");
      }
    });
  } else {
    data.input = [];
  }

  if (def.output?.length) {
    def.output.forEach((_, i) => {
      data.output ||= [];
      if (isVariadic(def.output!, i)) {
        const arr = (values[`output.${i}`] ?? []) as string[];
        data.output.push(...arr.filter((v) => typeof v === "string"));
      } else {
        data.output.push((values[`output.${i}`] as string | undefined) ?? "");
      }
    });
  } else {
    data.output = [];
  }

  return data;
};

const validateArg = (
  node: NodeData,
  arg: NodeArg,
  value: unknown,
  usingVars: Record<string, { name: string; desc: string }> | null,
  checkExpr: boolean
): Promise<unknown> => {
  const type = getNodeArgRawType(arg);
  const required = !isNodeArgOptional(arg);

  if (isExprType(type) && value) {
    for (const v of parseExpr(value as string)) {
      if (usingVars && !usingVars[v]) {
        return Promise.reject(new Error(i18n.t("node.undefinedVariable", { variable: v })));
      }
    }
    if (checkExpr) {
      try {
        if (!new ExpressionEvaluator(value as string).dryRun()) {
          return Promise.reject(new Error(i18n.t("node.invalidExpression")));
        }
      } catch {
        return Promise.reject(new Error(i18n.t("node.invalidExpression")));
      }
    }
  }

  if (value && isJsonType(type)) {
    try {
      if (value !== "null") JSON.parse(value as string);
    } catch {
      return Promise.reject(new Error(i18n.t("node.invalidValue")));
    }
  } else if (value === null && !required) {
    value = undefined;
  }

  if (!checkNodeArgValue(node, arg, value, logger.error)) {
    return Promise.reject(new Error(i18n.t("node.invalidValue")));
  }

  return Promise.resolve(value);
};

const createInOutOptions = (
  usingVars: Record<string, { name: string; desc: string }> | null,
  editingTree: TreeData | null,
  defs: NodeDefs
): OptionType[] => {
  const options: OptionType[] = [];
  const seen: Record<string, boolean> = {};

  if (usingVars) {
    Object.values(usingVars).forEach((v) => {
      if (!seen[v.name]) {
        options.push({ label: `${v.name}(${v.desc})`, value: v.name });
        seen[v.name] = true;
      }
    });
  } else if (editingTree?.root) {
    const collect = (node: NodeData) => {
      const def = defs.get(node.name);
      node.input?.forEach((v, i) => {
        const inputDef = def.input;
        const desc =
          inputDef?.length && i >= inputDef.length && isVariadic(inputDef, -1)
            ? inputDef[inputDef.length - 1]
            : inputDef?.[i] ?? "<unknown>";
        if (v && !seen[v]) {
          options.push({ label: `${v}(${desc})`, value: v });
          seen[v] = true;
        }
      });
      node.output?.forEach((v, i) => {
        const outputDef = def.output;
        const desc =
          outputDef?.length && i >= outputDef.length && isVariadic(outputDef, -1)
            ? outputDef[outputDef.length - 1]
            : outputDef?.[i] ?? "<unknown>";
        if (v && !seen[v]) {
          options.push({ label: `${v}(${desc})`, value: v });
          seen[v] = true;
        }
      });
    };
    dfs(editingTree.root as NodeData & { children?: NodeData[] }, collect);
  }

  return options;
};

// ─── VarDeclItem ──────────────────────────────────────────────────────────────

interface VarItem extends VarDecl {
  count?: number;
}

interface VarDeclItemProps {
  value?: VarItem;
  onChange?: (value: VarItem) => void;
  onRemove?: () => void;
  onSubmit?: () => void;
  disabled?: boolean;
}

const VarDeclItem: FC<VarDeclItemProps> = ({ value, onChange, onRemove, onSubmit, disabled }) => {
  const { t } = useTranslation();
  const [local, setLocal] = useState<VarItem>(value ?? { name: "", desc: "" });

  useEffect(() => {
    setLocal(value ?? { name: "", desc: "" });
  }, [value]);

  const commit = (next: VarItem) => {
    onChange?.(next);
    onSubmit?.();
  };

  return (
    <Flex gap={4} style={{ width: "100%" }}>
      <Space.Compact style={{ width: "100%" }}>
        <div
          style={{
            display: "flex",
            cursor: "pointer",
            alignItems: "center",
            paddingLeft: "8px",
            paddingRight: "8px",
            maxWidth: "52px",
            minWidth: "52px",
            borderTopLeftRadius: "4px",
            borderBottomLeftRadius: "4px",
            borderLeft: "1px solid #3d506c",
            borderTop: "1px solid #3d506c",
            borderBottom: "1px solid #3d506c",
          }}
          onClick={() => local.name && useWorkspace.getState().editor?.dispatch?.("clickVar", local.name)}
        >
          <AimOutlined />
          <span style={{ marginLeft: 4 }}>{local.count ?? 0}</span>
        </div>
        <Input
          disabled={disabled}
          value={local.name}
          placeholder={t("tree.vars.name")}
          onBlur={() => commit(local)}
          onChange={(e) => setLocal({ ...local, name: e.target.value })}
        />
        <Input
          disabled={disabled}
          value={local.desc}
          placeholder={t("tree.vars.desc")}
          onBlur={() => commit(local)}
          onChange={(e) => setLocal({ ...local, desc: e.target.value })}
        />
      </Space.Compact>
      {!disabled && (
        <MinusCircleOutlined
          style={{ marginBottom: "6px" }}
          onClick={() => onRemove?.()}
        />
      )}
      {disabled && <div style={{ width: 20 }} />}
    </Flex>
  );
};

const VarDeclItemFormWrapper: FC<{
  value?: VarItem;
  onChange?: (v: VarItem) => void;
  onRemove?: () => void;
  onSubmit?: () => void;
  disabled?: boolean;
}> = ({ value, onChange, onRemove, onSubmit, disabled }) => (
  <VarDeclItem
    value={value}
    onChange={onChange}
    onRemove={onRemove}
    onSubmit={onSubmit}
    disabled={disabled}
  />
);

// ─── NodeInspector ────────────────────────────────────────────────────────────

const NodeInspector: FC<{
  node: NodeData;
  nodeDefs: NodeDefs;
  editingTree: TreeData | null;
  checkExpr: boolean;
  allFiles: string[];
  usingVars: Record<string, { name: string; desc: string }> | null;
  /** 全局可选分组名（来自 node-config），用于是否显示「节点分组」一行 */
  groupDefs: string[];
  /** 当前行为树已启用的分组，与 register-node / checkNodeData 一致；用于校验 def.group */
  usingGroups: Record<string, boolean> | null;
  disabled: boolean;
  /** When false, subtree path field is read-only (node is under an external subtree). */
  subtreeEditable: boolean;
}> = ({
  node,
  nodeDefs,
  editingTree,
  checkExpr,
  allFiles,
  usingVars,
  groupDefs,
  usingGroups,
  disabled,
  subtreeEditable,
}) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  /** 与画布 node.name 解耦：正在编辑的节点名以表单为准（修复从 unknow 改为合法名仍报「不存在」） */
  const watchedName = Form.useWatch("name", form) as string | undefined;
  const effectiveName = (watchedName ?? node.name ?? "").trim() || node.name;
  const def = nodeDefs.get(effectiveName);

  const [nodeArgs, setNodeArgs] = useState<Record<string, unknown>>(node.args ?? {});

  const validateFieldsLater = useDebounceCallback(
    () => form.validateFields({ recursive: true }),
    100
  );

  useEffect(() => {
    updateFormWithNode(form, node, nodeDefs, checkExpr);
    setNodeArgs(node.args ?? {});
    validateFieldsLater();
  }, [node, nodeDefs, checkExpr]);

  // usingVars / groupDefs / usingGroups 变时补校验（与画布红框、原版 Inspector 一致）
  useEffect(() => {
    validateFieldsLater();
  }, [usingVars, groupDefs, usingGroups]);

  const submit = () => {
    setNodeArgs(createNodeFromForm(form, node, nodeDefs).args ?? {});
    if (form.isFieldsValidating()) {
      setTimeout(submit, 10);
      return;
    }
    form.submit();
  };

  const finish = () => {
    const data = createNodeFromForm(form, node, nodeDefs);
    const ws = useWorkspace.getState();
    ws.editor?.dispatch?.("updateNode", {
      data: {...data, id: data.id },
      prefix: ws.editor.data.prefix,
      disabled: false,
    });
  };

  /**
   * 与原版 `changeSubtree` 一致：仅子树路径变化时直接 `finish()`，不走 `form.submit()`，
   * 避免 unknown/非法节点名等其它字段校验挡住子树引用更新。
   */
  const changeSubtree = (pathOverride?: string) => {
    const raw = pathOverride ?? (form.getFieldValue("path") as string | undefined);
    const nextPath = (raw ?? "").trim() || undefined;
    const prevPath = (node.path ?? "").trim() || undefined;
    if (nextPath !== prevPath) {
      finish();
    } else {
      submit();
    }
  };

  const nodeOptions = useMemo(
    () =>
      Array.from(nodeDefs.entries()).map(([name, d]) => ({
        label: `${name}(${d.desc})`,
        value: name,
      })),
    [nodeDefs]
  );

  const inoutVarOptions = useMemo(
    () => createInOutOptions(usingVars, editingTree, nodeDefs),
    [usingVars, editingTree]
  );

  const subtreeOptions = useMemo(
    () => allFiles.map((f) => ({ label: f, value: f })),
    [allFiles]
  );

  const filterOption = (input: string, option?: OptionType) => {
    const label = option!.label as string;
    return label.toUpperCase().includes(input.toUpperCase());
  };

  return (
    <>
      <div style={{ padding: "12px 24px" }}>
        <span style={{ fontSize: "18px", fontWeight: 600 }}>{def.desc}</span>
      </div>
      <div className="b3-inspector-content" style={{ overflow: "auto", height: "100%" }}>
        <Form
          form={form}
          labelCol={{ span: "auto" }}
          wrapperCol={{ span: "auto" }}
          onFinish={finish}
        >
          {/* ── Meta (read-only) ── */}
          <Form.Item name="id" label={t("node.id")}>
            <Input disabled />
          </Form.Item>
          <Form.Item name="type" label={t("node.type")}>
            <Input disabled />
          </Form.Item>
          {groupDefs.length > 0 && (def as NodeDef & { group?: string[] }).group?.length ? (
            <Form.Item
              name="group"
              label={t("node.group")}
              rules={[
                {
                  validator() {
                    const g = (def as NodeDef & { group?: string[] }).group;
                    // 原版：def.group 中至少有一个须在「当前树已启用分组」usingGroups 中为 true
                    if (g && !g.some((name) => usingGroups?.[name])) {
                      return Promise.reject(
                        new Error(t("node.groupNotEnabled", { group: g }))
                      );
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <Select style={{ fontSize: "13px" }} mode="multiple" suffixIcon={null} disabled />
            </Form.Item>
          ) : null}
          <Form.Item
            name="children"
            label={t("node.children")}
            rules={[
              {
                validator() {
                  if (!isValidChildren(node)) {
                    return Promise.reject(new Error(t("node.invalidChildren")));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input disabled />
          </Form.Item>

          {/* ── Editable fields ── */}
          <Form.Item
            label={t("node.name")}
            name="name"
            rules={[
              {
                validator(_, value: string) {
                  const n = (value ?? "").trim();
                  if (!n || !nodeDefs.has(n)) {
                    return Promise.reject(
                      new Error(t("node.notFound", { name: n || node.name }))
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <AutoComplete
              disabled={disabled}
              options={nodeOptions}
              onBlur={() => submit()}
              onSelect={(_v: string) => submit()}
              filterOption={filterOption as unknown as boolean}
            />
          </Form.Item>
          <Form.Item name="desc" label={t("node.desc")}>
            <TextArea autoSize disabled={disabled} onBlur={submit} />
          </Form.Item>
          <Form.Item label={t("node.debug")} name="debug" valuePropName="checked">
            <Switch disabled={disabled && !node.path} onChange={submit} />
          </Form.Item>
          <Form.Item label={t("node.disabled")} name="disabled" valuePropName="checked">
            <Switch disabled={disabled && !node.path} onChange={submit} />
          </Form.Item>
          <Form.Item label={t("node.subtree")} name="path">
            <AutoComplete
              disabled={disabled && !subtreeEditable}
              options={subtreeOptions}
              onBlur={() => changeSubtree()}
              onSelect={(v: string) => changeSubtree(v)}
              filterOption={filterOption as unknown as boolean}
            />
          </Form.Item>

          {/* ── Doc ── */}
          <Markdown className="b3-markdown">{def.doc}</Markdown>

          {/* ── Input Variables ── */}
          {def.input && def.input.length > 0 && (
            <>
              <Divider orientation="left">
                <h4>{t("node.inputVariable")}</h4>
              </Divider>
              {def.input.map((v, i) => {
                const required = !v.includes("?");
                const desc = v.replace("?", "");
                if (isVariadic(def.input!, i)) {
                  return (
                    <Form.Item label={desc} key={`input.${i}`}>
                      <Form.List name={`input.${i}`}>
                        {(fields, { add, remove }, { errors }) => (
                          <div style={{ display: "flex", rowGap: 0, flexDirection: "column" }}>
                            {fields.map((field) => (
                              <Flex key={field.key} gap={4}>
                                <Form.Item
                                  name={field.name}
                                  validateTrigger={["onChange", "onBlur"]}
                                  style={{ width: "100%", marginBottom: 5 }}
                                  rules={[
                                    {
                                      validator(_, value) {
                                        if (value && usingVars && !usingVars[value]) {
                                          return Promise.reject(
                                            new Error(t("node.undefinedVariable", { variable: value }))
                                          );
                                        }
                                        if (value && !isValidVariableName(value)) {
                                          return Promise.reject(new Error(t("node.invalidVariableName")));
                                        }
                                        return Promise.resolve();
                                      },
                                    },
                                  ]}
                                >
                                  <AutoComplete
                                    disabled={disabled}
                                    options={inoutVarOptions}
                                    onBlur={submit}
                                    filterOption={filterOption as unknown as boolean}
                                  />
                                </Form.Item>
                                <MinusCircleOutlined
                                  style={{ marginBottom: "6px" }}
                                  onClick={() => { remove(field.name); submit(); }}
                                />
                              </Flex>
                            ))}
                            <Form.Item>
                              <Button
                                type="dashed"
                                onClick={() => { add(""); }}
                                style={{ width: fields.length === 0 ? "100%" : "200px" }}
                                icon={<PlusOutlined />}
                              >
                                {t("add")}
                              </Button>
                              <Form.ErrorList errors={errors} />
                            </Form.Item>
                          </div>
                        )}
                      </Form.List>
                    </Form.Item>
                  );
                }
                return (
                  <Form.Item
                    label={desc}
                    name={`input.${i}`}
                    key={`input.${i}`}
                    rules={[
                      { required, message: t("fieldRequired", { field: desc }) },
                      ({ getFieldValue, setFieldValue, isFieldValidating, validateFields }) => ({
                        validator(_, value) {
                          if (value && usingVars && !usingVars[value]) {
                            return Promise.reject(
                              new Error(t("node.undefinedVariable", { variable: value }))
                            );
                          }
                          if (value && !isValidVariableName(value)) {
                            return Promise.reject(new Error(t("node.invalidVariableName")));
                          }
                          const arg = def.args?.find((a) => a.oneof && v.replace("?", "") === a.oneof);
                          if (arg) {
                            const argName = `args.${arg.name}`;
                            if (!isFieldValidating(argName)) {
                              setFieldValue(`input.${i}`, value);
                              validateFields([argName]);
                            }
                            if (!checkOneof(arg, getFieldValue(argName), value)) {
                              return Promise.reject(
                                new Error(t("node.oneof.error", { input: v, arg: arg.name, desc: arg.desc ?? "" }))
                              );
                            }
                          }
                          return Promise.resolve();
                        },
                      }),
                    ]}
                  >
                    <AutoComplete
                      disabled={disabled}
                      options={inoutVarOptions}
                      onBlur={submit}
                      filterOption={filterOption as unknown as boolean}
                    />
                  </Form.Item>
                );
              })}
            </>
          )}

          {/* ── Const Args ── */}
          {def.args && def.args.length > 0 && (
            <>
              <Divider orientation="left">
                <h4>{t("node.args")}</h4>
              </Divider>
              {def.args.map((arg) => {
                const required = !isNodeArgOptional(arg);
                const type = getNodeArgRawType(arg);

                if (isNodeArgArray(arg)) {
                  return (
                    <Form.List
                      key={`args.${arg.name}`}
                      name={`args.${arg.name}`}
                      rules={[
                        {
                          validator(_, value: unknown[]) {
                            if (!arg.oneof) return Promise.resolve();
                            const idx = def.input?.findIndex(
                              (input) => input.replace("?", "") === arg.oneof
                            );
                            if (idx === undefined || idx < 0) {
                              return Promise.reject(
                                new Error(t("node.oneof.inputNotfound", { input: arg.oneof }))
                              );
                            }
                            const inputName = `input.${idx}`;
                            if (!form.isFieldValidating(inputName)) {
                              form.setFieldValue(`args.${arg.name}`, value);
                              form.validateFields([inputName]);
                            }
                            if (!checkOneof(arg, value, form.getFieldValue(inputName))) {
                              return Promise.reject(
                                new Error(t("node.oneof.error", {
                                  input: def.input![idx], arg: arg.name, desc: arg.desc ?? "",
                                }))
                              );
                            }
                            return Promise.resolve();
                          },
                        },
                      ]}
                    >
                      {(items, { add, remove }, { errors }) => (
                        <div style={{ display: "flex", rowGap: 0, flexDirection: "column" }}>
                          {items.map((item, idx) => (
                            <Flex key={item.key} gap={4}>
                              <Form.Item
                                name={item.name}
                                label={idx === 0 ? `${arg.desc}[${idx}]` : `[${idx}]`}
                                validateTrigger={["onChange", "onBlur"]}
                                style={{ width: "100%", marginBottom: 5 }}
                                initialValue={isBoolType(type) ? (arg.default ?? false) : arg.default}
                                valuePropName={isBoolType(type) ? "checked" : undefined}
                                rules={[
                                  { required, message: t("fieldRequired", { field: arg.desc }) },
                                  () => ({
                                    validator(_, value) {
                                      return validateArg(
                                        createNodeFromForm(form, node, nodeDefs),
                                        arg,
                                        value,
                                        usingVars,
                                        checkExpr
                                      );
                                    },
                                  }),
                                ]}
                              >
                                {!hasArgOptions(arg) && isStringType(type) && (
                                  <TextArea autoSize disabled={disabled} onBlur={submit} />
                                )}
                                {!hasArgOptions(arg) && isJsonType(type) && (
                                  <TextArea autoSize disabled={disabled} onBlur={submit} />
                                )}
                                {!hasArgOptions(arg) && isIntType(type) && (
                                  <InputNumber disabled={disabled} onBlur={submit} precision={0} />
                                )}
                                {!hasArgOptions(arg) && isFloatType(type) && (
                                  <InputNumber disabled={disabled} onBlur={submit} />
                                )}
                                {!hasArgOptions(arg) && isBoolType(type) && (
                                  <Switch disabled={disabled} onChange={submit} />
                                )}
                                {!hasArgOptions(arg) && isExprType(type) && (
                                  <Input disabled={disabled} onBlur={submit} />
                                )}
                                {hasArgOptions(arg) && (
                                  <Select
                                    showSearch
                                    disabled={disabled}
                                    onBlur={submit}
                                    onChange={submit}
                                    options={(getNodeArgOptions(arg, nodeArgs) ?? []).map((o) => ({
                                      value: o.value,
                                      label: `${o.name}(${o.value})`,
                                    }))}
                                    filterOption={(v, opt) =>
                                      !!opt?.label.toLocaleUpperCase().includes(v.toUpperCase())
                                    }
                                  />
                                )}
                              </Form.Item>
                              <MinusCircleOutlined
                                style={{ marginBottom: "6px" }}
                                onClick={() => { remove(item.name); submit(); }}
                              />
                            </Flex>
                          ))}
                          <Form.Item
                            label={items.length === 0 ? arg.desc : undefined}
                            style={{
                              marginLeft: items.length === 0 ? undefined : "100px",
                              marginRight: items.length === 0 ? undefined : "18px",
                              alignItems: "end",
                            }}
                          >
                            <Button
                              type="dashed"
                              onClick={() => {
                                add(arg.default ?? (isBoolType(type) ? false : ""));
                                if (isBoolType(type)) submit();
                              }}
                              style={{ width: "100%" }}
                              icon={<PlusOutlined />}
                              danger={items.length === 0 && !isNodeArgOptional(arg)}
                            >
                              {t("add")}
                            </Button>
                            <Form.ErrorList errors={errors} />
                          </Form.Item>
                        </div>
                      )}
                    </Form.List>
                  );
                }

                return (
                  <Form.Item
                    name={`args.${arg.name}`}
                    key={`args.${arg.name}`}
                    label={arg.desc}
                    initialValue={isBoolType(type) ? (arg.default ?? false) : arg.default}
                    valuePropName={isBoolType(type) ? "checked" : undefined}
                    rules={[
                      { required, message: t("fieldRequired", { field: arg.desc }) },
                      ({ getFieldValue, setFieldValue, isFieldValidating, validateFields }) => ({
                        async validator(_, value) {
                          return validateArg(
                            createNodeFromForm(form, node, nodeDefs),
                            arg,
                            value,
                            usingVars,
                            checkExpr
                          ).then((result) => {
                            value = result as typeof value;
                            if (!arg.oneof) return Promise.resolve();
                            const idx = def.input?.findIndex(
                              (input) => input.replace("?", "") === arg.oneof
                            );
                            if (idx === undefined || idx < 0) {
                              return Promise.reject(
                                new Error(t("node.oneof.inputNotfound", { input: arg.oneof }))
                              );
                            }
                            const inputName = `input.${idx}`;
                            if (!isFieldValidating(inputName)) {
                              setFieldValue(`args.${arg.name}`, value);
                              validateFields([inputName]);
                            }
                            if (!checkOneof(arg, value, form.getFieldValue(inputName))) {
                              return Promise.reject(
                                new Error(t("node.oneof.error", {
                                  input: def.input![idx], arg: arg.name, desc: arg.desc ?? "",
                                }))
                              );
                            }
                            return Promise.resolve();
                          });
                        },
                      }),
                    ]}
                  >
                    {!hasArgOptions(arg) && isStringType(type) && (
                      <TextArea autoSize disabled={disabled} onBlur={submit} />
                    )}
                    {!hasArgOptions(arg) && isJsonType(type) && (
                      <TextArea autoSize disabled={disabled} onBlur={submit} />
                    )}
                    {!hasArgOptions(arg) && isIntType(type) && (
                      <InputNumber disabled={disabled} onBlur={submit} precision={0} />
                    )}
                    {!hasArgOptions(arg) && isFloatType(type) && (
                      <InputNumber disabled={disabled} onBlur={submit} />
                    )}
                    {!hasArgOptions(arg) && isBoolType(type) && (
                      <Switch disabled={disabled} onChange={submit} />
                    )}
                    {!hasArgOptions(arg) && isExprType(type) && (
                      <Input disabled={disabled} onBlur={submit} />
                    )}
                    {hasArgOptions(arg) && (
                      <Select
                        showSearch
                        disabled={disabled}
                        onBlur={submit}
                        onChange={submit}
                        options={(getNodeArgOptions(arg, nodeArgs) ?? []).map((o) => ({
                          value: o.value,
                          label: `${o.name}(${o.value})`,
                        }))}
                        filterOption={(v, opt) =>
                          !!opt?.label.toLocaleUpperCase().includes(v.toUpperCase())
                        }
                      />
                    )}
                  </Form.Item>
                );
              })}
            </>
          )}

          {/* ── Output Variables ── */}
          {def.output && def.output.length > 0 && (
            <>
              <Divider orientation="left">
                <h4>{t("node.outputVariable")}</h4>
              </Divider>
              {def.output.map((v, i) => {
                const required = !v.includes("?");
                const desc = v.replace("?", "");
                if (isVariadic(def.output!, i)) {
                  return (
                    <Form.Item label={desc} key={`output.${i}`}>
                      <Form.List name={`output.${i}`}>
                        {(fields, { add, remove }, { errors }) => (
                          <div style={{ display: "flex", rowGap: 0, flexDirection: "column" }}>
                            {fields.map((field) => (
                              <Flex key={field.key} gap={4}>
                                <Form.Item
                                  name={field.name}
                                  validateTrigger={["onChange", "onBlur"]}
                                  style={{ width: "100%", marginBottom: 5 }}
                                  rules={[
                                    {
                                      validator(_, value) {
                                        if (value && usingVars && !usingVars[value]) {
                                          return Promise.reject(
                                            new Error(t("node.undefinedVariable", { variable: value }))
                                          );
                                        }
                                        if (value && !isValidVariableName(value)) {
                                          return Promise.reject(new Error(t("node.invalidVariableName")));
                                        }
                                        return Promise.resolve();
                                      },
                                    },
                                  ]}
                                >
                                  <AutoComplete
                                    disabled={disabled}
                                    options={inoutVarOptions}
                                    onBlur={submit}
                                    filterOption={filterOption as unknown as boolean}
                                  />
                                </Form.Item>
                                <MinusCircleOutlined
                                  style={{ marginBottom: "6px" }}
                                  onClick={() => { remove(field.name); submit(); }}
                                />
                              </Flex>
                            ))}
                            <Form.Item>
                              <Button
                                type="dashed"
                                onClick={() => add("")}
                                style={{ width: fields.length === 0 ? "100%" : "200px" }}
                                icon={<PlusOutlined />}
                              >
                                {t("add")}
                              </Button>
                              <Form.ErrorList errors={errors} />
                            </Form.Item>
                          </div>
                        )}
                      </Form.List>
                    </Form.Item>
                  );
                }
                return (
                  <Form.Item
                    label={desc}
                    name={`output.${i}`}
                    key={`output.${i}`}
                    rules={[
                      { required, message: t("fieldRequired", { field: desc }) },
                      {
                        validator(_, value) {
                          if (value && usingVars && !usingVars[value]) {
                            return Promise.reject(
                              new Error(t("node.undefinedVariable", { variable: value }))
                            );
                          }
                          if (value && !isValidVariableName(value)) {
                            return Promise.reject(new Error(t("node.invalidVariableName")));
                          }
                          return Promise.resolve();
                        },
                      },
                    ]}
                  >
                    <AutoComplete
                      disabled={disabled}
                      options={inoutVarOptions}
                      onBlur={submit}
                      filterOption={filterOption as unknown as boolean}
                    />
                  </Form.Item>
                );
              })}
            </>
          )}
        </Form>
        {disabled && (
          <Flex style={{ paddingTop: 30 }}>
            <Button
              type="primary"
              style={{ width: "100%" }}
              icon={<EditOutlined />}
              onClick={() => useWorkspace.getState().editor?.dispatch?.("editSubtree")}
            >
              {t("editSubtree")}
            </Button>
          </Flex>
        )}
      </div>
    </>
  );
};

// ─── TreeInspector ────────────────────────────────────────────────────────────

const TreeInspector: FC<{
  tree: EditTree;
  nodeDefs: NodeDefs;
  groupDefs: string[];
  allFiles: string[];
  usingVars: Record<string, { name: string; desc: string }> | null;
}> = ({ tree, nodeDefs, groupDefs, allFiles }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();

  const usingCount = useMemo<Record<string, number>>(() => {
    const count: Record<string, number> = {};
    const collect = (node: NodeData) => {
      const def = nodeDefs.get(node.name);
      if (def.input) {
        node.input?.forEach((v) => { if (v) count[v] = (count[v] ?? 0) + 1; });
      }
      if (def.output) {
        node.output?.forEach((v) => { if (v) count[v] = (count[v] ?? 0) + 1; });
      }
      if (def.args) {
        def.args.forEach((arg) => {
          const expr = node.args?.[arg.name] as string | string[] | undefined;
          if (!isExprType(arg.type) || !expr) return;
          if (Array.isArray(expr)) {
            expr.forEach((str) => { parseExpr(str).forEach((v) => { count[v] = (count[v] ?? 0) + 1; }); });
          } else {
            parseExpr(expr).forEach((v) => { count[v] = (count[v] ?? 0) + 1; });
          }
        });
      }
    };
    if (tree.root) {
      dfs(tree.root as NodeData & { children?: NodeData[] }, collect);
    }
    return count;
  }, [tree, nodeDefs]);

  // Sync form from store when `tree` changes only. Do not depend on `usingCount` here:
  // otherwise blur→updateTree→usingCount change re-runs resetFields with stale `tree.vars`
  // before Zustand editingTree sync, and inputs snap back to old values.
  useEffect(() => {
    form.resetFields();
    form.setFieldValue("name", tree.name);
    form.setFieldValue("desc", tree.desc);
    form.setFieldValue("export", tree.export !== false);
    form.setFieldValue("prefix", tree.prefix);
    form.setFieldValue("group", tree.group);
    form.setFieldValue(
      "vars",
      (tree.vars ?? []).map((v) => ({
        name: v.name,
        desc: v.desc,
        count: usingCount[v.name] ?? 0,
      }))
    );
    form.setFieldValue(
      "import",
      (tree.import ?? []).map((entry) => ({
        path: entry.path,
        vars: (entry.vars ?? []).map((v) => ({
          name: v.name,
          desc: v.desc,
          count: usingCount[v.name] ?? 0,
        })),
      }))
    );
    form.setFieldValue(
      "subtree",
      (tree.subtree ?? []).map((entry) => ({
        path: entry.path,
        vars: (entry.vars ?? []).map((v) => ({
          name: v.name,
          desc: v.desc,
          count: usingCount[v.name] ?? 0,
        })),
      }))
    );
  }, [tree]);

  // Update reference-count badges only (no full reset).
  useEffect(() => {
    const patchRows = (basePath: (string | number)[], rows: VarItem[] | undefined) => {
      (rows ?? []).forEach((row, i) => {
        if (!row?.name) return;
        const c = usingCount[row.name] ?? 0;
        if (row.count === c) return;
        const p = [...basePath, i];
        const cur = form.getFieldValue(p) as VarItem | undefined;
        if (cur) {
          form.setFieldValue(p, { ...cur, count: c });
        }
      });
    };

    const vars = form.getFieldValue("vars") as VarItem[] | undefined;
    patchRows(["vars"], vars);

    const imports = form.getFieldValue("import") as Array<{ vars?: VarItem[] }> | undefined;
    (imports ?? []).forEach((imp, i) => {
      patchRows(["import", i, "vars"], imp.vars);
    });

    const subs = form.getFieldValue("subtree") as Array<{ vars?: VarItem[] }> | undefined;
    (subs ?? []).forEach((_sub, i) => {
      const rows = form.getFieldValue(["subtree", i, "vars"]) as VarItem[] | undefined;
      patchRows(["subtree", i, "vars"], rows);
    });
  }, [usingCount, form]);

  const finish = (values: Record<string, unknown>) => {
    const vars = ((values.vars ?? []) as VarItem[])
      .filter((v) => v && v.name)
      .map((v) => ({ name: v.name, desc: v.desc }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const importArr = ((values.import ?? []) as Array<{ path?: string; vars?: VarItem[] }>)
      .filter((v) => v?.path)
      .sort((a, b) => a.path!.localeCompare(b.path!))
      .map((v) => ({
        path: v.path!,
        vars: (v.vars ?? []).map((v1) => ({ name: v1.name, desc: v1.desc })),
      }));

    const group = ((values.group ?? []) as string[])
      .filter((g) => g)
      .sort((a, b) => a.localeCompare(b));

    useWorkspace.getState().editor?.dispatch?.("updateTree", {
      name: values.name as string,
      desc: values.desc as string | undefined,
      export: values.export as boolean | undefined,
      prefix: values.prefix as string | undefined,
      group,
      vars,
      import: importArr,
    });
  };

  const subtreeOptions = useMemo(
    () => allFiles.map((f) => ({ label: f, value: f })),
    [allFiles]
  );

  return (
    <>
      <div style={{ padding: "12px 24px" }}>
        <span style={{ fontSize: "18px", fontWeight: 600 }}>{t("tree.overview")}</span>
      </div>
      <div className="b3-inspector-content" style={{ overflow: "auto", height: "100%" }}>
        <Form
          form={form}
          labelCol={{ span: "auto" }}
          wrapperCol={{ span: "auto" }}
          onFinish={finish}
        >
          <Form.Item name="name" label={t("tree.name")}>
            <Input disabled />
          </Form.Item>
          <Form.Item name="desc" label={t("tree.desc")}>
            <TextArea autoSize onBlur={form.submit} />
          </Form.Item>
          <Form.Item name="prefix" label={t("tree.prefix")}>
            <Input onBlur={form.submit} />
          </Form.Item>
          <Form.Item name="export" label={t("tree.export")} valuePropName="checked">
            <Switch onChange={form.submit} />
          </Form.Item>

          {groupDefs.length > 0 && (
            <>
              <Divider orientation="left">
                <h4>{t("tree.group")}</h4>
              </Divider>
              <Form.Item name="group">
                <Select
                  mode="multiple"
                  suffixIcon={null}
                  onChange={form.submit}
                  placeholder={t("tree.group.placeholder")}
                  options={groupDefs.map((g) => ({ label: g, value: g }))}
                />
              </Form.Item>
            </>
          )}

          {/* ── Define Variables ── */}
          <Divider orientation="left">
            <h4>{t("tree.vars")}</h4>
          </Divider>
          <Form.List name="vars">
            {(fields, { add, remove }, { errors }) => (
              <div style={{ display: "flex", flexDirection: "column", rowGap: 0 }}>
                {fields.map((item) => (
                  <Form.Item
                    key={item.key}
                    name={item.name}
                    validateTrigger={["onChange", "onBlur"]}
                    style={{ marginBottom: 2 }}
                    rules={[
                      {
                        validator(_, value: VarItem) {
                          if (!value.name || !isValidVariableName(value.name)) {
                            return Promise.reject(new Error(t("tree.vars.invalidName")));
                          }
                          if (!value.desc) {
                            return Promise.reject(
                              new Error(t("fieldRequired", { field: t("tree.vars.desc") }))
                            );
                          }
                          return Promise.resolve();
                        },
                      },
                    ]}
                  >
                    <VarDeclItemFormWrapper
                      onRemove={() => { remove(item.name); form.submit(); }}
                      onSubmit={form.submit}
                    />
                  </Form.Item>
                ))}
                <Form.Item
                  style={{
                    marginRight: fields.length === 0 ? undefined : "18px",
                    marginTop: 4,
                    alignItems: "end",
                  }}
                >
                  <Button
                    type="dashed"
                    onClick={() => add({})}
                    style={{ width: "100%" }}
                    icon={<PlusOutlined />}
                  >
                    {t("add")}
                  </Button>
                  <Form.ErrorList errors={errors} />
                </Form.Item>
              </div>
            )}
          </Form.List>

          {/* ── Subtree Variables (read-only) ── */}
          {(tree.subtree ?? []).length > 0 && (
            <>
              <Divider orientation="left">
                <h4>{t("tree.vars.subtree")}</h4>
              </Divider>
              <Form.List name="subtree">
                {(items) => (
                  <div style={{ display: "flex", flexDirection: "column", rowGap: 4 }}>
                    {items.map((item) => (
                      <Space.Compact
                        key={item.key}
                        direction="vertical"
                        style={{ marginBottom: 5 }}
                      >
                        <Flex gap={4} style={{ width: "100%" }}>
                          <Form.Item
                            name={[item.name, "path"]}
                            style={{ width: "100%", marginBottom: 2 }}
                          >
                            <AutoComplete
                              disabled
                              options={subtreeOptions}
                              filterOption={(v, opt) =>
                                (opt?.label as string)?.toUpperCase().includes(v.toUpperCase()) ?? false
                              }
                            />
                          </Form.Item>
                          <div style={{ width: 20 }} />
                        </Flex>
                        <Form.List name={[item.name, "vars"]}>
                          {(vars) => (
                            <div style={{ display: "flex", flexDirection: "column", rowGap: 0 }}>
                              {vars.map((v) => (
                                <Form.Item key={v.key} name={v.name} style={{ marginBottom: 2 }}>
                                  <VarDeclItemFormWrapper disabled />
                                </Form.Item>
                              ))}
                            </div>
                          )}
                        </Form.List>
                      </Space.Compact>
                    ))}
                  </div>
                )}
              </Form.List>
            </>
          )}

          {/* ── Import Variables ── */}
          <Divider orientation="left">
            <h4>{t("tree.vars.imports")}</h4>
          </Divider>
          <Form.List name="import">
            {(items, { add, remove }, { errors }) => (
              <div style={{ display: "flex", flexDirection: "column", rowGap: 4 }}>
                {items.map((item) => (
                  <Space.Compact
                    key={item.key}
                    direction="vertical"
                    style={{ marginBottom: 5 }}
                  >
                    <Flex gap={4} style={{ width: "100%" }}>
                      <Form.Item
                        name={[item.name, "path"]}
                        style={{ width: "100%", marginBottom: 2 }}
                      >
                        <AutoComplete
                          showSearch
                          options={subtreeOptions}
                          onBlur={form.submit}
                          filterOption={(v, opt) =>
                            (opt?.label as string)?.toUpperCase().includes(v.toUpperCase()) ?? false
                          }
                        />
                      </Form.Item>
                      <MinusCircleOutlined
                        style={{ marginBottom: "6px" }}
                        onClick={() => { remove(item.name); form.submit(); }}
                      />
                    </Flex>
                    <Form.List name={[item.name, "vars"]}>
                      {(vars) => (
                        <div style={{ display: "flex", flexDirection: "column", rowGap: 0 }}>
                          {vars.map((v) => (
                            <Form.Item key={v.key} name={v.name} style={{ marginBottom: 2 }}>
                              <VarDeclItemFormWrapper disabled />
                            </Form.Item>
                          ))}
                        </div>
                      )}
                    </Form.List>
                  </Space.Compact>
                ))}
                <Form.Item
                  style={{ marginRight: items.length === 0 ? undefined : "18px", alignItems: "end" }}
                >
                  <Button
                    type="dashed"
                    onClick={() => add({ path: "", vars: [] })}
                    style={{ width: "100%" }}
                    icon={<PlusOutlined />}
                  >
                    {t("add")}
                  </Button>
                  <Form.ErrorList errors={errors} />
                </Form.Item>
              </div>
            )}
          </Form.List>
        </Form>
      </div>
    </>
  );
};

// ─── Main Inspector ───────────────────────────────────────────────────────────

export const Inspector: FC = () => {
  const { t } = useTranslation();

  const {
    editingNode,
    editingTree,
    nodeDefs,
    groupDefs,
    usingGroups,
    checkExpr,
    allFiles,
    usingVars,
    editor,
  } = useWorkspace(
    useShallow((s) => ({
      editingNode: s.editingNode,
      editingTree: s.editingTree,
      nodeDefs: s.nodeDefs,
      groupDefs: s.groupDefs,
      usingGroups: s.usingGroups,
      checkExpr: s.checkExpr,
      allFiles: s.allFiles,
      usingVars: s.usingVars,
      editor: s.editor,
    }))
  );

  // Convert usingVars array/map → Record for NodeInspector/TreeInspector
  const usingVarsRecord = useMemo(() => {
    if (!usingVars) return null;
    const rec: Record<string, { name: string; desc: string }> = {};
    Object.values(usingVars).forEach((v) => { rec[v.name] = v; });
    return rec;
  }, [usingVars]);

  if (editingNode) {
    const rawDefs = Array.from(nodeDefs.values());
    const defs = new NodeDefs();
    rawDefs.forEach((d) => {
      if (
        d.args &&
        d.args.some(
          (arg) =>
            arg.options &&
            !Array.isArray((arg.options as Array<{ source: unknown }>)[0]?.source)
        )
      ) {
        d = { ...d, args: d.args.map((arg) => {
          if (
            arg.options &&
            !Array.isArray((arg.options as Array<{ source: unknown }>)[0]?.source)
          ) {
            return {
              ...arg,
              options: [{ source: arg.options as unknown as Array<{ name: string; value: unknown }> }],
            };
          }
          return arg;
        })};
      }
      defs.set(d.name, d);
    });

    return (
      <div className="b3-inspector" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <NodeInspector
          key={editingNode.data.id}
          node={editingNode.data}
          nodeDefs={defs}
          editingTree={editor?.data ?? null}
          checkExpr={checkExpr}
          allFiles={allFiles}
          usingVars={usingVarsRecord}
          groupDefs={groupDefs}
          usingGroups={usingGroups}
          disabled={editingNode.disabled}
          subtreeEditable={editingNode.subtreeEditable ?? true}
        />
      </div>
    );
  }

  if (editingTree) {
    const rawDefs = Array.from(nodeDefs.values());
    const defs = new NodeDefs();
    rawDefs.forEach((d) => defs.set(d.name, d));

    return (
      <div className="b3-inspector" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <TreeInspector
          tree={editingTree}
          nodeDefs={defs}
          groupDefs={groupDefs}
          allFiles={allFiles}
          usingVars={usingVarsRecord}
        />
      </div>
    );
  }

  return (
    <div className="b3-inspector" style={{ height: "100%" }}>
      <div
        style={{
          padding: 16,
          color: "#666",
          fontSize: 13,
          textAlign: "center",
          marginTop: 40,
        }}
      >
        {t("node.noNodeSelected")}
      </div>
    </div>
  );
};
