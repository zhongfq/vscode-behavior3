import { Alert, Button, Flex, Skeleton } from "antd";
import React from "react";
import { useTranslation } from "react-i18next";
import { useInspectorPaneState, useRuntime } from "../../app/runtime";
import { clearDocumentReloadConflict } from "../../stores/document-store";
import { NodeInspectorForm } from "./node-inspector-form";
import { TreeInspectorForm } from "./tree-inspector-form";

const InspectorSkeletonRow: React.FC = () => {
    return (
        <div className="b3-v2-inspector-skeleton-row">
            <Skeleton.Input active size="small" className="b3-v2-inspector-skeleton-label" />
            <Skeleton.Input
                active
                size="small"
                block
                className="b3-v2-inspector-skeleton-field"
            />
        </div>
    );
};

const InspectorSkeleton: React.FC = () => {
    return (
        <div className="b3-v2-inspector b3-v2-inspector-skeleton">
            <div className="b3-v2-inspector-header">
                <Skeleton.Input active size="small" className="b3-v2-inspector-skeleton-title" />
            </div>
            <div className="b3-v2-inspector-content b3-v2-inspector-skeleton-content">
                <InspectorSkeletonRow />
                <InspectorSkeletonRow />
                <InspectorSkeletonRow />
                <Skeleton.Input
                    active
                    size="small"
                    className="b3-v2-inspector-skeleton-section"
                />
                <InspectorSkeletonRow />
                <InspectorSkeletonRow />
            </div>
        </div>
    );
};

const InspectorReloadBanner: React.FC<{
    pendingExternalContent: string | null;
    onReload: () => void;
    onDismiss: () => void;
}> = ({ pendingExternalContent, onReload, onDismiss }) => {
    const { t } = useTranslation();

    return (
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
                        onClick={onReload}
                    >
                        {t("editor.reloadFromDisk")}
                    </Button>
                    <Button size="small" onClick={onDismiss}>
                        {t("editor.dismissConflict")}
                    </Button>
                </Flex>
            }
        />
    );
};

export const InspectorPane: React.FC = () => {
    const runtime = useRuntime();
    const { document, alertReload, pendingExternalContent, selectedNode } = useInspectorPaneState();

    if (!document) {
        return <InspectorSkeleton />;
    }

    return (
        <div className="b3-v2-inspector">
            {alertReload ? (
                <InspectorReloadBanner
                    pendingExternalContent={pendingExternalContent}
                    onReload={() => {
                        if (!pendingExternalContent) {
                            return;
                        }
                        void runtime.controller.reloadDocumentFromHost(pendingExternalContent, {
                            force: true,
                        });
                    }}
                    onDismiss={() => {
                        clearDocumentReloadConflict(runtime.documentStore);
                    }}
                />
            ) : null}

            {selectedNode ? <NodeInspectorForm /> : <TreeInspectorForm />}
        </div>
    );
};
