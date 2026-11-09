import { useRef, useState, type ComponentProps } from "react";
import { Button } from "./Button";
import { TooltipTrigger } from "./TooltipTrigger";
import styles from "./TruncatedButton.module.scss";

/**
 * Button that shows the full text in a tooltip only when it is truncated by an ellipsis.
 * The button is a flex container and the ellipsis applies to the inner text span;
 * truncation is measured on hover/focus - fonts may not be loaded at mount time, so measuring earlier gives wrong results.
 */
export function TruncatedButton({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const measure = () => {
    const text = element.current;
    if (text) setTruncated(text.scrollWidth > text.clientWidth);
  };
  const button = <Button {...props} onPointerEnter={measure} onFocus={measure}>
    <span ref={element} className={styles.label}>{label}</span>
  </Button>;
  return truncated ? <TooltipTrigger label={label}>{button}</TooltipTrigger> : button;
}
