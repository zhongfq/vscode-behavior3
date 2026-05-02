import { Alert, Button, Flex, Skeleton } from "antd";
import React from "react";
import { useTranslation } from "react-i18next";
import { useInspectorPaneState, useRuntime } from "../../app/runtime";
import { clearDocumentReloadConflict } from "../../stores/document-store";
import { NodeInspectorForm } from "./node-inspector-form";
import { TreeInspectorForm } from "./tree-inspector-form";

export const InspectorPane: React.FC = () => {
    const runtime = useRuntime();
    const { t } = useTranslation();
    const { document, alertReload, pendingExternalContent, selectedNode } = useInspectorPaneState();

    if (!document) {
        return (
            <div className="b3-v2-inspector b3-v2-inspector-skeleton">
                <div className="b3-v2-inspector-header">
                    <Skeleton.Input
                        active
                        size="small"
                        className="b3-v2-inspector-skeleton-title"
                    />
                </div>
                <div className="b3-v2-inspector-content b3-v2-inspector-skeleton-content">
                    <div className="b3-v2-inspector-skeleton-row">
                        <Skeleton.Input
                            active
                            size="small"
                            className="b3-v2-inspector-skeleton-label"
                        />
                        <Skeleton.Input
                            active
                            size="small"
                            block
                            className="b3-v2-inspector-skeleton-field"
                        />
                    </div>
                    <div className="b3-v2-inspector-skeleton-row">
                        <Skeleton.Input
                            active
                            size="small"
                            className="b3-v2-inspector-skeleton-label"
                        />
                        <Skeleton.Input
                            active
                            size="small"
                            block
                            className="b3-v2-inspector-skeleton-field"
                        />
                    </div>
                    <div className="b3-v2-inspector-skeleton-row">
                        <Skeleton.Input
                            active
                            size="small"
                            className="b3-v2-inspector-skeleton-label"
                        />
                        <Skeleton.Input
                            active
                            size="small"
                            block
                            className="b3-v2-inspector-skeleton-field"
                        />
                    </div>
                    <Skeleton.Input
                        active
                        size="small"
                        className="b3-v2-inspector-skeleton-section"
                    />
                    <div className="b3-v2-inspector-skeleton-row">
                        <Skeleton.Input
                            active
                            size="small"
                            className="b3-v2-inspector-skeleton-label"
                        />
                        <Skeleton.Input
                            active
                            size="small"
                            block
                            className="b3-v2-inspector-skeleton-field"
                        />
                    </div>
                    <div className="b3-v2-inspector-skeleton-row">
                        <Skeleton.Input
                            active
                            size="small"
                            className="b3-v2-inspector-skeleton-label"
                        />
                        <Skeleton.Input
                            active
                            size="small"
                            block
                            className="b3-v2-inspector-skeleton-field"
                        />
                    </div>
                </div>
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
                                    clearDocumentReloadConflict(runtime.documentStore);
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
