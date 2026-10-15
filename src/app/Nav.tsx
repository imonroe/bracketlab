import Link from "next/link";
import styles from "./page.module.css";

export function Nav({ current }: { current: "single" | "batch" }) {
  return (
    <nav className={styles.nav} aria-label="Mode">
      <Link href="/" aria-current={current === "single" ? "page" : undefined}>
        One bracket
      </Link>
      <Link href="/batch" aria-current={current === "batch" ? "page" : undefined}>
        Batch
      </Link>
    </nav>
  );
}
