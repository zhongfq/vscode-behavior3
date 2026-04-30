import { Alert, Button, Empty, Flex } from "antd";
import React from "react";
import { useTranslation } from "react-i18next";
import { useDocumentStore, useRuntime, useSelectionStore } from "../../app/runtime";
import { NodeInspectorForm } from "./node-inspector-form";
import { TreeInspectorForm } from "./tree-inspector-form";

export const InspectorPane: React.FC = () => {
    const runtime = useRuntime();
    const { t } = useTranslation();
    const document = useDocumentStore((state) => state.persistedTree);
    const alertReload = useDocumentStore((state) => state.alertReload);
    const pendingExternalContent = useDocumentStore((state) => state.pendingExternalContent);
    const selectedNode = useSelectionStore((state) => state.selectedNodeSnapshot);

    if (!document) {
        return (
            <div className="b3-v2-inspector">
                <Empty description="Waiting for host init" />
            </div>
        );
    }

    return (
        <div className="b3-v2-inspector">
            {alertReload ? (
                <Alert
                    type="warning"
                    showIcon
                    title={t("editor.externalChangeConflict")}
                    className="b3-v2-inspector-banner"
                    action={
                        <Flex gap={8}>
                            <Button
                                size="small"
                                type="primary"
                                disabled={!pendingExternalContent}
                                onClick={() => {
                                    if (!pendingExternalContent) {
                                        return;
                                    }
                                    void runtime.controller.reloadDocumentFromHost(
                                        pendingExternalContent,
                                        { force: true }
                                    );
                                }}
                            >
                                {t("editor.reloadFromDisk")}
                            </Button>
                            <Button
                                size="small"
                                onClick={() => {
                                    runtime.documentStore.setState((state) => ({
                                        ...state,
                                        alertReload: false,
                                        pendingExternalContent: null,
                                    }));
                                }}
                            >
                                {t("editor.dismissConflict")}
                            </Button>
                        </Flex>
                    }
                />
            ) : null}

            {selectedNode ? <NodeInspectorForm /> : <TreeInspectorForm />}
        </div>
    );
};
