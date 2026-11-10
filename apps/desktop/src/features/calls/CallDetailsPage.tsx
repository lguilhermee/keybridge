import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type CallDetail } from "../../shared/api";
import { CallDetails } from "./CallDetails";
import { Card } from "../../shared/ui/Card";
import styles from "./CallDetailsPage.module.scss";
import { ScrollableContent } from "../../shared/virtual/ScrollableContent";

export function CallDetailsPage() {
  const { callId = "" } = useParams();
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void api.call(callId).then((value) => {
      if (!cancelled) setDetail(value);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const content = error
    ? <Card><div style={{ padding: 16 }}>{t("Unable to load call details")}: {error}</div></Card>
    : detail
      ? <CallDetails detail={detail} />
      : <Card><div style={{ padding: 16 }}>{t("Loading call details...")}</div></Card>;

  return <main className={styles.root}>
    <ScrollableContent className={styles.scroller} contentClassName={styles.content}>
      <h1>{detail?.call.display_name ?? t("Call details")}</h1>
      {content}
    </ScrollableContent>
  </main>;
}
