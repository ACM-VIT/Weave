import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { authSessionLifecycle } from '../api/session-lifecycle';
import { TypewriterCompletionCache } from '../services/typewriterCompletion';

type TypewriterOptions = {
  delay?: number;
  duration?: number;
  enabled?: boolean;
  maxAnimatedCharacters?: number;
  reducedMotion?: boolean;
  completionKey?: string;
};

type TypewriterState = {
  count: number;
  source: string;
  tick: number;
  generation: number;
  key?: string;
};

const completions = new TypewriterCompletionCache();
authSessionLifecycle.subscribe(() => completions.clear());
const subscribe = (listener: () => void) => authSessionLifecycle.subscribe(listener);
const getGeneration = () => authSessionLifecycle.currentGeneration();

function avoidSplitSurrogate(text: string, count: number) {
  const boundedCount = Math.min(count, text.length);
  const finalCodeUnit = text.charCodeAt(boundedCount - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff
    ? Math.min(boundedCount + 1, text.length)
    : boundedCount;
}

export function useTypewriterText(
  source: string,
  {
    delay = 0,
    duration = 900,
    enabled = true,
    maxAnimatedCharacters = source.length,
    reducedMotion = false,
    completionKey,
  }: TypewriterOptions = {},
) {
  const generation = useSyncExternalStore(subscribe, getGeneration, getGeneration);
  const [state, setState] = useState<TypewriterState>(() => ({
    count: 0, source, tick: 0, generation, key: completionKey,
  }));
  const progress = useRef(state);
  const completed = completionKey !== undefined && completions.has(completionKey, source);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const matches = progress.current.source === source
      && progress.current.key === completionKey && progress.current.generation === generation;
    if (!matches) progress.current = { count: 0, tick: 0, source, generation, key: completionKey };
    const finish = () => {
      if (completionKey !== undefined && authSessionLifecycle.isCurrent(generation)) {
        completions.complete(completionKey, source);
      }
    };
    if (reducedMotion || source.length === 0 || completed) {
      finish();
      return;
    }
    if (!enabled) return;
    const animatedCharacters = Math.min(Math.max(Math.floor(maxAnimatedCharacters), 1), source.length);
    const frameCount = Math.max(1, Math.ceil(duration / 30));
    const charactersPerFrame = Math.max(1, Math.ceil(animatedCharacters / frameCount));
    if (progress.current.count >= source.length) return;
    timeout = setTimeout(() => {
      interval = setInterval(() => {
        if (cancelled || !authSessionLifecycle.isCurrent(generation)) return;
        const count = avoidSplitSurrogate(source, Math.min(progress.current.count + charactersPerFrame, animatedCharacters));
        const done = count >= animatedCharacters;
        progress.current = { source, generation, key: completionKey,
          count: done ? source.length : count, tick: progress.current.tick + 1 };
        if (done) {
          clearInterval(interval);
          finish();
        }
        setState(progress.current);
      }, 30);
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [completionKey, completed, delay, duration, enabled, generation, maxAnimatedCharacters, reducedMotion, source]);

  const current = state.source === source && state.generation === generation && state.key === completionKey;
  const currentCount = reducedMotion || completed ? source.length : current ? state.count : 0;
  return {
    cursorVisible: state.tick % 14 < 9,
    isTyping: enabled && !reducedMotion && currentCount < source.length,
    text: source.slice(0, currentCount),
  };
}
