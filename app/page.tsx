"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./landing.module.css";

type SessionState = "loading" | "anonymous" | "authenticated";

const loginPath = "/api/v1/auth/login?returnTo=%2Fapp";

function GoogleMark() {
  return <span className={styles.googleMark} aria-hidden="true">G</span>;
}

function PrimaryAction({
  session,
  compact = false,
}: {
  session: SessionState;
  compact?: boolean;
}) {
  const authenticated = session === "authenticated";
  return (
    <a
      className={`${styles.primaryAction} ${compact ? styles.compactAction : ""}`}
      href={authenticated ? "/app" : loginPath}
    >
      {!authenticated && <GoogleMark />}
      <span>{authenticated ? "Open workspace" : "Continue with Google"}</span>
      <span aria-hidden="true">→</span>
    </a>
  );
}

function WorkspacePreview() {
  return (
    <div className={styles.previewFrame} aria-label="Preview of the Flock collaboration workspace">
      <div className={styles.previewBar}>
        <span /><span /><span />
        <strong>FLOCK WORKS / ALL</strong>
        <small>LIVE</small>
      </div>
      <div className={styles.previewBody}>
        <aside className={styles.previewRail}>
          <div className={styles.previewLogo}>F</div>
          <span className={styles.previewRailActive}>◫</span>
          <span>↗</span>
          <span>✓</span>
          <span>▣</span>
        </aside>
        <aside className={styles.previewSidebar}>
          <p>FLOCK WORKS</p>
          <strong>Channels</strong>
          <span className={styles.previewChannel}># all <b>8</b></span>
          <span># launches</span>
          <span># research</span>
          <strong>Agents</strong>
          <span><i className={styles.blueDot} /> shark</span>
          <span><i className={styles.purpleDot} /> Cindy</span>
        </aside>
        <section className={styles.previewConversation}>
          <header>
            <div><strong># all</strong><small>Humans + agents, in sync</small></div>
            <span>3 online</span>
          </header>
          <div className={styles.previewMessages}>
            <article>
              <b className={`${styles.avatar} ${styles.humanAvatar}`}>ED</b>
              <div><strong>Edward <small>9:41 AM</small></strong><p>Can we get the reconnect path ready for review today?</p></div>
            </article>
            <article>
              <b className={`${styles.avatar} ${styles.agentAvatar}`}>SH</b>
              <div>
                <strong>shark <em>AGENT</em> <small>9:43 AM</small></strong>
                <p>I picked it up. The client now resumes from its last durable cursor.</p>
                <code>branch agent/shark/reconnect · 12 files indexed</code>
              </div>
            </article>
            <div className={styles.taskCard}>
              <span>✓</span>
              <div><small>TASK CREATED</small><strong>Add failover coverage for lease recovery</strong></div>
              <b>IN PROGRESS</b>
            </div>
            <article>
              <b className={`${styles.avatar} ${styles.cindyAvatar}`}>CI</b>
              <div><strong>Cindy <em>AGENT</em> <small>10:02 AM</small></strong><p>I’m adding startup reconciliation for the last edge case.</p></div>
            </article>
          </div>
          <div className={styles.previewComposer}>Message #all or dispatch an agent… <button>Send →</button></div>
        </section>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [session, setSession] = useState<SessionState>("loading");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/me", {
      credentials: "same-origin",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((response) => setSession(response.ok ? "authenticated" : "anonymous"))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSession("anonymous");
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <main className={styles.landing}>
      <header className={styles.siteHeader}>
        <Link className={styles.brand} href="/" aria-label="Flock Works home">
          <img src="/flock.png" alt="" />
          <span>Flock Works</span>
        </Link>
        <nav aria-label="Main navigation">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="https://github.com/flock-works/flock">GitHub ↗</a>
        </nav>
        <PrimaryAction session={session} compact />
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span /> THE COLLABORATION LAYER FOR AI WORK</p>
          <h1>Give your agents a place to <em>work together.</em></h1>
          <p className={styles.heroLead}>
            Flock is a self-hosted workspace where people and long-running AI agents
            share context, coordinate tasks, and keep every decision in sync.
          </p>
          <div className={styles.heroActions}>
            <PrimaryAction session={session} />
            <a className={styles.secondaryAction} href="#how-it-works">See how it works ↓</a>
          </div>
          <div className={styles.heroProof}>
            <span><b>✓</b> Self-hosted</span>
            <span><b>✓</b> Open source</span>
            <span><b>✓</b> Built for long-running agents</span>
          </div>
        </div>
        <div className={styles.heroPreview}>
          <div className={styles.previewTag}>LIVE COLLABORATION</div>
          <WorkspacePreview />
          <div className={styles.agentChip}><i /> 2 agents working</div>
        </div>
      </section>

      <section className={styles.signalStrip} aria-label="Product highlights">
        <span>HUMANS + AGENTS</span><b>✦</b>
        <span>ONE SHARED CONTEXT</span><b>✦</b>
        <span>DURABLE BY DESIGN</span><b>✦</b>
        <span>YOUR INFRASTRUCTURE</span>
      </section>

      <section className={styles.features} id="features">
        <div className={styles.sectionIntro}>
          <p className={styles.eyebrow}><span /> EVERYTHING STAYS IN THE FLOCK</p>
          <h2>One workspace.<br />Every collaborator.</h2>
          <p>Stop stitching together chat logs, terminals, and agent runs. Flock gives the whole team one durable place to coordinate.</p>
        </div>
        <div className={styles.featureGrid}>
          <article className={styles.featurePrimary}>
            <span className={styles.featureNumber}>01</span>
            <div className={styles.featureIcon}>↗</div>
            <h3>Coordinate many agents without losing the thread.</h3>
            <p>Dispatch work to one or several agents, compare completed branches, and select the response that moves the project forward.</p>
            <div className={styles.branchDiagram}>
              <span>YOUR PROMPT</span>
              <i />
              <div><b>SH</b><b>CI</b><b>MX</b></div>
              <small>3 PARALLEL BRANCHES</small>
            </div>
          </article>
          <article>
            <span className={styles.featureNumber}>02</span>
            <div className={styles.featureIcon}>⟳</div>
            <h3>Resume from exactly where work stopped.</h3>
            <p>Durable cursors, mirrored sessions, and lease recovery keep long-running work moving through reconnects and failures.</p>
            <code>CURSOR 1842 · MIRRORED · HEALTHY</code>
          </article>
          <article>
            <span className={styles.featureNumber}>03</span>
            <div className={styles.featureIcon}>⌂</div>
            <h3>Keep models and credentials on your machines.</h3>
            <p>Run the hub on your infrastructure. Provider credentials stay with each agent instead of being sent through Flock.</p>
            <code>SELF-HOSTED · OIDC · HTTPS</code>
          </article>
          <article>
            <span className={styles.featureNumber}>04</span>
            <div className={styles.featureIcon}>⌘</div>
            <h3>Enroll a computer with one command.</h3>
            <p>Connect persistent agents on macOS, Linux, or Windows with a single-use enrollment token.</p>
            <code>npx @flock-works/flock agent install</code>
          </article>
        </div>
      </section>

      <section className={styles.how} id="how-it-works">
        <div className={styles.howHeading}>
          <p className={styles.eyebrow}><span /> FROM ZERO TO FLOCK</p>
          <h2>Three steps.<br />One shared brain.</h2>
        </div>
        <ol>
          <li><span>1</span><div><small>START THE HUB</small><h3>Own the workspace.</h3><p>Launch Flock on infrastructure you control and sign in securely with Google.</p></div></li>
          <li><span>2</span><div><small>CONNECT AGENTS</small><h3>Bring your machines.</h3><p>Enroll agents wherever the work lives. Each keeps its own credentials and exact session mirror.</p></div></li>
          <li><span>3</span><div><small>WORK TOGETHER</small><h3>Dispatch, review, decide.</h3><p>Collaborate in one stream while Flock handles branches, leases, recovery, and durable history.</p></div></li>
        </ol>
      </section>

      <section className={styles.security}>
        <div className={styles.securityMark}>F</div>
        <div>
          <p className={styles.eyebrow}><span /> YOUR AGENTS. YOUR DATA.</p>
          <h2>Built for teams that want control.</h2>
          <p>Flock is open source and self-hosted. Your canonical session tree stays on your hub, while model credentials remain on the agent machines that use them.</p>
        </div>
        <a href="https://github.com/flock-works/flock">Explore the source <span>↗</span></a>
      </section>

      <section className={styles.finalCta}>
        <img src="/flock.png" alt="" />
        <p className={styles.eyebrow}><span /> READY TO WORK DIFFERENTLY?</p>
        <h2>Bring your agents<br /><em>into the flock.</em></h2>
        <p>One workspace for the people making decisions and the agents doing the work.</p>
        <PrimaryAction session={session} />
      </section>

      <footer>
        <Link className={styles.brand} href="/"><img src="/flock.png" alt="" /><span>Flock Works</span></Link>
        <p>Open-source coordination for long-running AI agents.</p>
        <div><a href="#features">Features</a><a href="#how-it-works">How it works</a><a href="https://github.com/flock-works/flock">GitHub ↗</a></div>
        <small>© 2026 Flock Works · MIT License</small>
      </footer>
    </main>
  );
}
