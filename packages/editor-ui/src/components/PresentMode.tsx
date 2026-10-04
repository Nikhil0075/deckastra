"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentScene } from "@deckastra/renderer";
import { compileTransition, transitionSlideFromScene } from "@deckastra/animation-engine";
import type { OpenPresenterWindow, PresenterWindow } from "@deckastra/workspace-contracts";

import { fitToDisplay } from "../lib/display-fit";
import { clickSteps } from "../lib/presenter";
import { PresentChannel, type PresentState } from "../lib/presentSync";
import { browserPresenterWindow } from "../lib/presenter-window";
import { Icon, type IconName } from "../ui";
import { cx } from "../ui/cx";
import { SlideMotion, type SlideMotionHandle } from "./SlideMotion";
import { SlideTransition } from "./SlideTransition";
import { PresenterView } from "./PresenterView";
import { NarrationDirector, type SpeakingNow } from "./NarrationDirector";

/**
 * Present mode (Figma: "present mode", "present mode with notes").
 *
 * The audience view is deliberately empty of chrome: one slide, scaled by a
 * single transform on the root (doc 04 §4.2). Fitting each element to the
 * viewport individually is what produces blurry glyphs and geometry that drifts
 * as the window resizes. Its controls sit bottom-left and fade out when the
 * pointer is still; the squares at the bottom centre are the slide's click
 * reveals, filled as they play.
 *
 * Everything a presenter needs is in the presenter view instead — in this window
 * with `P`, or in a second window over a BroadcastChannel. The second window is
 * the arrangement that matters: a laptop screen and a projector showing
 * different things is the only setup that is any use in a real room.
 *
 * **The audience window is the authority on the talk.** It plays the slide's
 * motion, so it alone knows which reveal is showing; it broadcasts
 * `{index, step, blacked}` after every change. A presenter window sends
 * *commands* ("advance", "black") rather than moving itself, so Next on the
 * laptop reveals the next bullet on the projector instead of jumping past it.
 */

export interface PresentModeProps {
  scene: DocumentScene;
  onExit: () => void;
  initialSlide?: number;
  /** Renders only the presenter half, for the popped-out window. */
  presenterOnly?: boolean;
  /**
   * How an image becomes something `<img>` can load (`useAssetUrls`).
   *
   * Threaded rather than resolved here, because present mode has a scene and not
   * a document — and the deck it is presenting is the shell's to know about. A
   * deck whose pictures appear while editing and vanish on the projector would be
   * worse than one that never showed them.
   */
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** Shared channel name so the two windows find each other. */
  channelName?: string;
  /**
   * How the presenter view gets its own window.
   *
   * Defaults to `window.open`, which is right in a browser tab and wrong in a
   * packaged app: the desktop shell opens a real second window it can place on a
   * second display. Injected rather than branched on so this component never has
   * to know which shell it is mounted in.
   */
  openPresenter?: OpenPresenterWindow;
}

const IDLE_MS = 2500;

/**
 * How long a presenter window waits for the audience window to act on a
 * command before acting itself. With no audience window (it was closed, or
 * never opened) a Next that did nothing would strand the presenter; moving the
 * slide locally is the better failure.
 */
const COMMAND_FALLBACK_MS = 500;

export function PresentMode({
  scene,
  onExit,
  resolveAssetUrl,
  initialSlide = 0,
  presenterOnly = false,
  channelName,
  openPresenter = browserPresenterWindow,
}: PresentModeProps) {
  const [index, setIndex] = useState(initialSlide);
  const [step, setStep] = useState(0);
  const [idle, setIdle] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [presenter, setPresenter] = useState(presenterOnly);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [reducedMotion, setReducedMotion] = useState(false);
  // Doc 04 §26.3's `B`. One of the two keys every presenter reaches for, and the
  // one that has to work when something goes wrong on the laptop.
  const [blacked, setBlacked] = useState(false);
  const [motionPaused, setMotionPaused] = useState(false);
  // Narration (integration plan 01 §3.4): muted on the projector, and the line
  // being spoken, which the presenter view shows as a script.
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState<SpeakingNow | null>(null);
  // Whether the slide was entered forwards. Backwards means its final state,
  // never a replayed entrance (§26.3).
  const [enteredBackwards, setEnteredBackwards] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channel = useRef<PresentChannel | null>(null);
  // Read by the channel's handlers, which outlive any one render.
  const indexRef = useRef(initialSlide);
  const slideCountRef = useRef(scene.slides.length);
  const stateRef = useRef<PresentState>({ index: initialSlide, step: 0, blacked: false, motionPaused: false, muted: false, speaking: null });
  const popout = useRef<PresenterWindow | null>(null);
  const motion = useRef<SlideMotionHandle>(null);
  const startedAt = useRef(Date.now());
  const pendingCommand = useRef<ReturnType<typeof setTimeout> | null>(null);

  const slides = scene.slides;
  const slide = slides[index];
  const steps = useMemo(() => (slide ? clickSteps(slide, reducedMotion) : 0), [slide, reducedMotion]);

  // The slide being left, kept only while its successor is arriving. A morph
  // animates an element from where it was to where it now is, and where it was
  // is on this slide — so it has to still be mounted, which the old CSS-keyframe
  // arrangement never allowed for.
  const [leaving, setLeaving] = useState<number | null>(null);
  const previousIndex = useRef(initialSlide);

  indexRef.current = index;
  slideCountRef.current = scene.slides.length;
  const spoken = speaking ? { text: speaking.text, remainingMs: Math.round(speaking.remainingMs) } : null;
  stateRef.current = { index, step, blacked, motionPaused, muted, speaking: spoken };

  const setIndexSynced = useCallback((next: number | ((current: number) => number)) => {
    setIndex((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      channel.current?.post(resolved);
      return resolved;
    });
  }, []);

  /** Read the reveal the motion is on, once its effect has run. */
  const readStep = useCallback(() => {
    requestAnimationFrame(() => setStep(motion.current?.step?.() ?? 0));
  }, []);

  const go = useCallback(
    (delta: number) => {
      setEnteredBackwards(delta < 0);
      setIndexSynced((current) => Math.min(slides.length - 1, Math.max(0, current + delta)));
    },
    [setIndexSynced, slides.length],
  );

  /**
   * `→` and `←`: a segment if there is one, otherwise a slide (doc 04 §26.3).
   *
   * The order is the whole of click-to-reveal. A presenter pressing `→` means
   * "show me the next thing", and whether that thing is the next bullet or the
   * next slide is not something they should have to think about.
   */
  const advanceHere = useCallback(
    (delta: number) => {
      const stepped = delta > 0 ? motion.current?.next() : motion.current?.previous();
      if (stepped) {
        readStep();
        return;
      }
      go(delta);
    },
    [go, readStep],
  );

  /**
   * In a presenter window, an advance is a request to the audience window, which
   * owns the motion. If nothing answers — the audience window is gone — the
   * presenter window moves the slide itself rather than doing nothing.
   */
  const advance = useCallback(
    (delta: 1 | -1) => {
      if (!presenterOnly || !channel.current) {
        advanceHere(delta);
        return;
      }
      channel.current.command({ action: "advance", delta });
      if (pendingCommand.current !== null) clearTimeout(pendingCommand.current);
      pendingCommand.current = setTimeout(() => {
        pendingCommand.current = null;
        go(delta);
      }, COMMAND_FALLBACK_MS);
    },
    [advanceHere, go, presenterOnly],
  );

  const toggleBlack = useCallback(() => {
    if (presenterOnly && channel.current) channel.current.command({ action: "black" });
    else setBlacked((value) => !value);
  }, [presenterOnly]);

  const toggleMute = useCallback(() => {
    if (presenterOnly && channel.current) {
      channel.current.command({ action: "mute" });
      return;
    }
    setMuted((value) => !value);
  }, [presenterOnly]);

  const toggleMotion = useCallback(() => {
    if (presenterOnly && channel.current) {
      channel.current.command({ action: "motion" });
      return;
    }
    setMotionPaused((value) => !value);
  }, [presenterOnly]);

  useEffect(() => {
    if (motionPaused) motion.current?.pause();
    else motion.current?.resume();
  }, [motionPaused, index]);

  // ------------------------------------------------------------ preferences

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // ---------------------------------------------------------------- syncing

  // Handlers read through a ref so the channel is opened once for the whole
  // talk: reopening it on every slide change would drop messages.
  const commandRef = useRef<(delta: 1 | -1) => void>(advanceHere);
  commandRef.current = advanceHere;

  useEffect(() => {
    if (!channelName) return;

    const bus = new PresentChannel(channelName, {
      // Applied, never re-broadcast — two windows echoing each other never settle.
      onIndex: setIndex,
      currentIndex: () => indexRef.current,
      slideCount: () => slideCountRef.current,
      currentState: presenterOnly ? undefined : () => stateRef.current,
      // Presenter side: the audience window is the authority on step and blackout.
      onState: presenterOnly
        ? (state) => {
            if (pendingCommand.current !== null) {
              clearTimeout(pendingCommand.current);
              pendingCommand.current = null;
            }
            setIndex(state.index);
            setStep(state.step);
            setBlacked(state.blacked);
            setMotionPaused(state.motionPaused === true);
            setMuted(state.muted === true);
            setSpeaking(state.speaking ? { slideId: "", cueId: "", text: state.speaking.text, remainingMs: state.speaking.remainingMs } : null);
          }
        : undefined,
      // Audience side: carry out what the presenter asked for.
      onCommand: presenterOnly
        ? undefined
        : (command) => {
            // Acknowledge at once, before acting. The presenter window falls
            // back to moving the slide itself if nothing answers, and the real
            // answer (the state after the change) waits for an animation frame
            // a minimised projector window may throttle — a late answer there
            // would make the laptop skip the reveal it asked for.
            bus.postState(stateRef.current);
            if (command.action === "advance") commandRef.current(command.delta);
            else if (command.action === "black") setBlacked((value) => !value);
            else if (command.action === "mute") setMuted((value) => !value);
            else setMotionPaused((value) => !value);
          },
    });

    bus.open();
    channel.current = bus;

    return () => {
      bus.close();
      channel.current = null;
      if (pendingCommand.current !== null) clearTimeout(pendingCommand.current);
    };
  }, [channelName, presenterOnly]);

  // The audience window reports its state after every change it makes.
  useEffect(() => {
    if (presenterOnly) return;
    channel.current?.postState({ index, step, blacked, motionPaused, muted, speaking: spoken });
    // `spoken` changes as the remaining time counts down; posting it is what
    // keeps the presenter's script line live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, step, blacked, motionPaused, muted, spoken?.text, spoken?.remainingMs, presenterOnly]);

  // A new slide starts at its first reveal (or its last, entered backwards);
  // read it once the motion for that slide has mounted.
  useEffect(() => {
    if (presenterOnly) return;
    setStep(enteredBackwards ? steps : 0);
    readStep();
  }, [index, enteredBackwards, steps, presenterOnly, readStep]);

  const openPresenterWindow = useCallback(() => {
    if (!channelName) return;
    popout.current = openPresenter({ channelName });
    // Hand the new window the current position immediately; its own "hello"
    // covers the case where this message arrives before it is listening.
    channel.current?.post(index);
    channel.current?.postState(stateRef.current);
  }, [channelName, index, openPresenter]);

  // --------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A control inside present mode (the target field in the presenter view)
      // keeps its own keys.
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;

      switch (event.key) {
        case "ArrowRight":
        case " ":
        case "PageDown":
          event.preventDefault();
          advance(1);
          break;
        case "ArrowLeft":
        case "PageUp":
          event.preventDefault();
          advance(-1);
          break;
        // Down and up skip segments entirely (§26.3): the escape hatch for a
        // presenter who needs to get off this slide now.
        case "ArrowDown":
          event.preventDefault();
          go(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          go(-1);
          break;
        case "b":
        case "B":
          event.preventDefault();
          toggleBlack();
          break;
        case "Home":
          event.preventDefault();
          setIndexSynced(0);
          break;
        case "End":
          event.preventDefault();
          setIndexSynced(slides.length - 1);
          break;
        case "Escape":
          if (document.fullscreenElement) void document.exitFullscreen();
          else onExit();
          break;
        case "n":
        case "N":
          setShowNotes((v) => !v);
          break;
        case "p":
        case "P":
          event.preventDefault();
          setPresenter((value) => !value);
          break;
        case "l":
        case "L":
          event.preventDefault();
          toggleMotion();
          break;
        case "m":
        case "M":
          event.preventDefault();
          toggleMute();
          break;
        case "f":
        case "F":
          void toggleFullscreen();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, go, onExit, presenterOnly, setIndexSynced, slides.length, toggleBlack, toggleMotion, toggleMute]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) onExit();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [onExit]);

  // Resize-driven scale, measured from the container rather than the window so a
  // panel does not push the slide off-centre.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [presenter]);

  useEffect(() => {
    const wake = () => {
      setIdle(false);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  // Kiosk mode: a slide may advance itself (doc 02 §26). Cleared on every slide
  // change so a manual advance does not leave a stale timer running.
  useEffect(() => {
    if (presenterOnly) return;
    const autoAdvanceMs = (slide?.transition as { autoAdvanceMs?: number } | undefined)?.autoAdvanceMs;
    if (!autoAdvanceMs || index >= slides.length - 1) return;

    const id = setTimeout(() => go(1), autoAdvanceMs);
    return () => clearTimeout(id);
  }, [go, index, presenterOnly, slide, slides.length]);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await containerRef.current?.requestFullscreen?.();
  };

  // One factor for both axes: the deck is letterboxed into whatever the room's
  // hardware is, never stretched to fill it.
  const { scale } = fitToDisplay(scene.viewport, size);

  // Track which slide we came from, so the arriving one can transition out of it.
  // Recorded during render rather than in an effect: the effect would run after
  // the first painted frame of the new slide, which is one frame of the
  // transition already missed.
  if (!presenterOnly && previousIndex.current !== index) {
    setLeaving(previousIndex.current);
    previousIndex.current = index;
  }

  // Compiled here rather than inside the stage: this component shows what was
  // degraded, and two compiles of one transition is two answers that can
  // disagree. Backwards is the slide's final state and no transition (§26.3).
  // Above every early return, so the hooks run in the same order on every render.
  const outgoing = leaving !== null && !enteredBackwards ? slides[leaving] : undefined;
  const transition = useMemo(
    () =>
      slide
        ? compileTransition(
            slide.transition,
            outgoing ? transitionSlideFromScene(outgoing) : undefined,
            transitionSlideFromScene(slide),
            { motion: reducedMotion ? "reduced" : "full" },
          )
        : null,
    [slide, outgoing, reducedMotion],
  );

  if (!slide) {
    // Reachable only if the deck is empty. Rendering nothing at all would leave
    // a presenter staring at a black screen with no way to tell what went wrong.
    return (
      <div className="dk-present dk-present--empty">
        <p>This deck has no slides to present.</p>
        <button type="button" className="dk-present__chip" onClick={onExit}>
          Exit (Esc)
        </button>
      </div>
    );
  }

  const hasAudio = slides.some((one) => one.narration?.cues.length || one.soundCues?.length);
  const presenterProps = {
    scene,
    index,
    step,
    steps,
    blacked,
    muted,
    speaking: speaking ? { text: speaking.text, remainingMs: speaking.remainingMs } : null,
    hasAudio,
    onMute: toggleMute,
    resolveAssetUrl,
    onAdvance: advance,
    onJump: setIndexSynced,
    onBlack: toggleBlack,
    startedAt: startedAt.current,
  };

  if (presenterOnly) {
    return <PresenterView {...presenterProps} detached onExit={onExit} />;
  }

  return (
    <div
      className="dk-present"
      // Which slide is on screen, readable from outside the React tree. The
      // acceptance harness drives present mode through real key events and had
      // no way to check where it had arrived: two ArrowRights were assumed to
      // reach slide 4 and actually spent themselves on slide 2's click reveals,
      // so a morph gate ran against a slide with no morph on it. A harness that
      // cannot say which slide it is looking at is a harness making a claim
      // about a slide it never saw.
      data-present-slide-id={slide.slideId}
      data-present-slide-index={index}
      data-present-slide-count={slides.length}
      // How the deck moved *into* this slide, which is the thing a transition
      // gate is actually about. Without it a harness can only guess which
      // boundary it is standing on.
      data-present-slide-transition={slide.transition?.type ?? "none"}
      data-present-step={step}
      data-present-steps={steps}
      data-present-blacked={blacked ? "true" : "false"}
      data-present-motion-paused={motionPaused ? "true" : "false"}
      data-present-muted={muted ? "true" : "false"}
      data-present-playback={scene.playback?.mode ?? "manual"}
      data-present-locale={scene.locale}
      data-present-speaking={speaking?.cueId ?? ""}
    >
      <div
        ref={containerRef}
        className={cx("dk-present__stage", presenter && "dk-present__stage--split", idle && "present-idle")}
        onClick={(event) => {
          // Click-to-advance, left third goes back — the convention every remote
          // and every presenter already expects.
          const x = event.clientX / window.innerWidth;
          advance(x < 0.33 ? -1 : 1);
        }}
      >
        {scale > 0 && transition ? (
          <SlideTransition
            // A slide's transition describes how the deck moves INTO it, so
            // re-keying on slideId replays it on every arrival (doc 02 §26.1).
            key={slide.slideId}
            compiled={transition}
            to={slide}
            from={outgoing}
            width={scene.viewport.width * scale}
            height={scene.viewport.height * scale}
            scale={scale}
            onDone={() => setLeaving(null)}
            resolveAssetUrl={resolveAssetUrl}
          />
        ) : null}

        {/* Re-keyed on the slide so each arrival compiles and plays its own
            timeline; the key is what makes leaving a slide tear its motion down.

            Mounted only once the stage exists (same condition as the stage
            above). SlideMotion finds the elements it animates under
            `[data-present-stage]` in its mount effect and does not look again;
            mounted in the first render — before the container was measured and
            the stage drawn — it found nothing, so the slide a talk *started* on
            never played its entrances or its click reveals. On a slide whose
            elements rest invisible and fade in, the room saw a blank slide. */}
        {scale > 0 && transition ? (
          <SlideMotion
            // Distinct from the stage div's key: they are siblings, and React
            // treats two siblings with the same key as one element.
            key={`motion-${slide.slideId}`}
            scene={slide}
            rootSelector="[data-present-stage]"
            reducedMotion={reducedMotion}
            autoPlay={!enteredBackwards}
            paused={motionPaused}
            handle={motion}
          />
        ) : null}

        {/* The voice and sounds of the step on screen (plan 01 §3.4). Keyed on
            the slide like the motion, and mounted under the same condition, so
            a step's narration starts with its reveal and never before. */}
        {scale > 0 && transition && hasAudio ? (
          <NarrationDirector
            key={`narration-${slide.slideId}`}
            scene={scene}
            slide={slide}
            index={index}
            step={step}
            enteredBackwards={enteredBackwards}
            paused={blacked}
            muted={muted}
            reducedMotion={reducedMotion}
            resolveAssetUrl={resolveAssetUrl}
            onAdvance={() => advanceHere(1)}
            onSpeaking={setSpeaking}
          />
        ) : null}

        {blacked ? <div className="dk-present__black" aria-label="Screen blacked out" /> : null}

        <div
          className={cx("dk-present__controls", idle && "dk-present__controls--idle")}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="dk-present__cluster" role="toolbar" aria-label="Presentation controls">
            <ControlButton icon="chevronLeft" label="Previous" onClick={() => advance(-1)} disabled={index === 0 && step === 0} />
            <ControlButton icon="chevronRight" label="Next" onClick={() => advance(1)} disabled={index === slides.length - 1 && step >= steps} />
            <span className="dk-present__counter" aria-live="polite">
              {index + 1} / {slides.length}
            </span>
            <ControlButton icon="stop" label={blacked ? "Show slide (B)" : "Black screen (B)"} pressed={blacked} onClick={toggleBlack} />
            <ControlButton icon={motionPaused ? "play" : "pause"} label={motionPaused ? "Resume loops (L)" : "Pause loops (L)"} pressed={motionPaused} onClick={toggleMotion} />
            {hasAudio ? (
              <ControlButton icon={muted ? "mute" : "sound"} label={muted ? "Unmute narration (M)" : "Mute narration (M)"} pressed={muted} onClick={toggleMute} />
            ) : null}
            <ControlButton icon="list" label="Notes (N)" pressed={showNotes} onClick={() => setShowNotes((v) => !v)} />
            <ControlButton icon="present" label="Presenter view (P)" pressed={presenter} onClick={() => setPresenter((v) => !v)} />
            <ControlButton icon="fit" label="Fullscreen (F)" onClick={() => void toggleFullscreen()} />
            {channelName ? (
              // Worded, not an icon: it is the one control a presenter looks for
              // by name when setting up, and the acceptance harness finds it by
              // this text.
              <button type="button" className="dk-present__chip" onClick={openPresenterWindow}>
                Second screen
              </button>
            ) : null}
            <ControlButton icon="close" label="Exit (Esc)" onClick={onExit} />
          </div>

          {steps > 0 ? (
            <div className="dk-present__steps" aria-label={`Reveal ${step} of ${steps}`}>
              {Array.from({ length: steps }, (_, i) => (
                <span key={i} className={cx("dk-present__step", i < step && "dk-present__step--done")} />
              ))}
            </div>
          ) : null}
        </div>

        {transition?.degraded && !idle ? <div className="dk-present__degraded">{transition.degraded}</div> : null}

        {showNotes && slide.speakerNotes ? (
          <div className="dk-present__notes" onClick={(event) => event.stopPropagation()}>
            <div className="dk-present__notes-title">Speaker notes</div>
            {slide.speakerNotes}
          </div>
        ) : null}
      </div>

      {presenter ? (
        <div className="dk-present__panel">
          <PresenterView {...presenterProps} onExit={onExit} />
        </div>
      ) : null}
    </div>
  );
}

function ControlButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className="dk-present__control"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
