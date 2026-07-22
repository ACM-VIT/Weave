import { useEffect, useState } from 'react';

type TypewriterOptions = {
  delay?: number;
  duration?: number;
  enabled?: boolean;
  maxAnimatedCharacters?: number;
  reducedMotion?: boolean;
};

type TypewriterState = {
  count: number;
  source: string;
  tick: number;
};

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
  }: TypewriterOptions = {},
) {
  const [state, setState] = useState<TypewriterState>(() => ({
    count: reducedMotion ? source.length : 0,
    source,
    tick: 0,
  }));

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (!enabled) {
      timeout = setTimeout(() => {
        setState({ count: 0, source, tick: 0 });
      }, 0);
      return () => clearTimeout(timeout);
    }

    if (reducedMotion || source.length === 0) {
      timeout = setTimeout(() => {
        setState({ count: source.length, source, tick: 0 });
      }, 0);
      return () => clearTimeout(timeout);
    }

    const animatedCharacters = Math.min(
      Math.max(Math.floor(maxAnimatedCharacters), 1),
      source.length,
    );
    const frameDuration = 30;
    const frameCount = Math.max(1, Math.ceil(duration / frameDuration));
    const charactersPerFrame = Math.max(1, Math.ceil(animatedCharacters / frameCount));
    let count = 0;
    let tick = 0;

    timeout = setTimeout(() => {
      interval = setInterval(() => {
        tick += 1;
        count = avoidSplitSurrogate(
          source,
          Math.min(count + charactersPerFrame, animatedCharacters),
        );

        if (count >= animatedCharacters) {
          if (interval) clearInterval(interval);
          setState({ count: source.length, source, tick });
          return;
        }

        setState({ count, source, tick });
      }, frameDuration);
    }, delay);

    return () => {
      if (timeout) clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [delay, duration, enabled, maxAnimatedCharacters, reducedMotion, source]);

  const currentCount = state.source === source ? state.count : 0;
  const isTyping = enabled && !reducedMotion && currentCount < source.length;

  return {
    cursorVisible: state.tick % 14 < 9,
    isTyping,
    text: source.slice(0, currentCount),
  };
}
