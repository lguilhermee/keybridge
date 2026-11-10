import type { ReactNode } from "react";
import { Card } from "../../shared/ui/Card";
import styles from "./SectionCard.module.scss";

/** Transitional settings section chrome; the Settings rewrite (Task C) restyles these sections. */
export function SectionCard({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return <Card as="section" className={styles.root}>
    <header className={styles.header}><div className={styles.title}>{title}</div>{action}</header>
    {children}
  </Card>;
}
