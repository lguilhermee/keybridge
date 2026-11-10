import { useCallback, type ReactNode } from "react";
import { VirtualList } from "../../shared/virtual/VirtualListEngine";
import type { VirtualListApi } from "../../shared/virtual/virtualTypes";
import styles from "./VirtualPage.module.scss";

export type VirtualPageSection = {
  key: string;
  estimatedHeight: number;
  content: ReactNode;
};

export function VirtualPage({ sections, className, contentClassName, onReady }: { sections: VirtualPageSection[]; className?: string; contentClassName?: string; onReady?: (api: VirtualListApi) => void }) {
  const getKey = useCallback((section: VirtualPageSection) => section.key, []);
  const estimateSize = useCallback((section: VirtualPageSection) => section.estimatedHeight, []);
  const renderItem = useCallback((section: VirtualPageSection) => <section className={styles.section}>
    {section.content}
  </section>, []);

  return <VirtualList
    items={sections}
    getKey={getKey}
    estimateSize={estimateSize}
    renderItem={renderItem}
    overscan={2}
    itemGap={16}
    scrollbarSize={7}
    className={[styles.root, "scroll-shadow-top", className].filter(Boolean).join(" ")}
    contentClassName={[styles.content, contentClassName].filter(Boolean).join(" ")}
    onReady={onReady}
  />;
}
