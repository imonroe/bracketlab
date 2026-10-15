import { BracketApp } from "./BracketApp";
import { Nav } from "./Nav";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>BracketLab</h1>
        <Nav current="single" />
        <p className={styles.lede}>
          Merge three bracketed RAW exposures into one editable HDR DNG, plus a JPEG preview.
        </p>
      </header>

      <section className={styles.guidance} aria-labelledby="guidance-heading">
        <h2 id="guidance-heading">Before you upload</h2>
        <ul>
          <li>
            Use a tripod and a static scene. Keep aperture, ISO, focus, focal length and RAW mode
            fixed, and vary only the shutter speed. ±2 EV spacing works well.
          </li>
          <li>
            Moving foliage, water, clouds or people may ghost. BracketLab can&apos;t reliably detect
            or remove that.
          </li>
          <li>
            Supported now: Sony ARW from tested models (starting with the a6100). Output is DNG,
            not ARW.
          </li>
          <li>
            Your files stay on this server and are deleted automatically within 24 hours, or
            immediately when you choose Delete.
          </li>
        </ul>
      </section>

      <BracketApp />
    </main>
  );
}
