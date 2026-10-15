import type { Metadata } from "next";
import { Nav } from "../Nav";
import styles from "../page.module.css";
import { BatchApp } from "./BatchApp";

export const metadata: Metadata = {
  title: "BracketLab: batch",
  description: "Upload a whole shoot, match the brackets, and merge them all.",
};

export default function BatchPage() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>BracketLab</h1>
        <Nav current="batch" />
        <p className={styles.lede}>
          Upload a whole shoot. BracketLab matches the bracketed shots into sets of three,
          merges each set into an HDR DNG, and gives you one ZIP of the results.
        </p>
      </header>

      <section className={styles.guidance} aria-labelledby="guidance-heading">
        <h2 id="guidance-heading">How matching works</h2>
        <ul>
          <li>
            Shots are sorted by capture time and grouped into sets of three with the same ISO,
            aperture and focal length, three different shutter speeds, taken within a minute.
          </li>
          <li>
            Camera bracket mode and hand bracketing both work. Leave a pause between sets, as
            you naturally do when moving the tripod.
          </li>
          <li>
            Test shots and anything that doesn&apos;t fit a set are listed separately and not
            merged. You review the sets before anything is merged.
          </li>
          <li>Files are deleted automatically within 24 hours, or when you choose Delete.</li>
        </ul>
      </section>

      <BatchApp />
    </main>
  );
}
